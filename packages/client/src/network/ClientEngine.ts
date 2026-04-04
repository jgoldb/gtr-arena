import * as THREE from 'three';
import type { EntitySnapshot, EntityBuffSnapshot } from '@gtr/shared';
import type {
  S2C_GameState, S2C_GameStateUpdate, S2C_GameStateSnapshot,
  S2C_CombatEvent, S2C_Flinch, S2C_AbilityEffect, S2C_CooldownUpdate,
  S2C_AutoAttackSwing, S2C_Knockback,
  S2C_EntityDied, S2C_PositionRelay, S2C_PositionUpdate,
} from '@gtr/shared';
import type { CharacterId } from '@gtr/shared';
import { getCharacterStats } from '@gtr/shared';
import type { NetworkManager } from './NetworkManager';
import { SnapshotBuffer } from './SnapshotBuffer';
import { Renderer } from '../engine/renderer/Renderer';
import { InputManager } from '../engine/input/InputManager';
import { MapManager } from '../engine/map/MapManager';
import { ThirdPersonCamera } from '../engine/camera/ThirdPersonCamera';
import { PlayerController } from '../engine/player/PlayerController';
import { TargetingSystem } from '../engine/targeting/TargetingSystem';
import { createCharacter, type CharacterModel } from '../engine/player/characters';
import type { Targetable } from '../engine/types';
import { createTargetingHitArea } from '../engine/targeting/targetingHitArea';
import { BlindEffect } from '../engine/effects/BlindEffect';
import { ClientEffects } from './ClientEffects';
import { ClientChargeSystem } from './ClientChargeSystem';
import { ClientSoundManager } from './ClientSoundManager';
import { PositionSync } from './PositionSync';
import { RemoteEntityRenderer } from './RemoteEntityRenderer';
import { DeadReckoning } from './DeadReckoning';
import { ClientInputHandler } from './ClientInputHandler';
import { ClientStateSync } from './ClientStateSync';
import { ClientAbilitySystem } from './ClientAbilitySystem';

interface RemoteEntity {
  id: string;
  characterId: CharacterId;
  team: number;
  name: string;
  model: CharacterModel;
  mesh: THREE.Group;  // Wrapper group (like PlayerController.mesh) — rotation goes here
  // Snapshot data (maintained incrementally from server deltas)
  hp: number; maxHp: number; mana: number; maxMana: number;
  dead: boolean; inCombat: boolean; stunned: boolean; charging: boolean;
  isMoving: boolean; isAutoAttacking: boolean;
  castingAbilityId: string | null;
  castingElapsed: number; castingTotalTime: number; castingIsChannel: boolean;
  buffs: EntityBuffSnapshot['buffs'];
  drTimers: EntityBuffSnapshot['drTimers'];
  targetable: Targetable;
  targetEntityId: string | null;
  disconnected: boolean;
  godMode: boolean;
  // Previous frame rotation for computing turn speed
  prevRotationY: number;
}

export class ClientEngine {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private renderer: Renderer;
  readonly input: InputManager;
  readonly mapManager: MapManager;
  private thirdPersonCamera: ThirdPersonCamera;
  private network: NetworkManager;

  // Local player uses the same PlayerController as playground mode
  readonly playerController: PlayerController;
  private localEntityId: string;

  // Targeting system — same class as playground mode
  readonly targetingSystem: TargetingSystem;
  selectedTargetId: string | null = null;

  // Remote entities (other players) — interpolated from server state
  private remoteEntities = new Map<string, RemoteEntity>();

  // Snapshot interpolation buffer — smoothly interpolates remote entity positions
  // between two known server states instead of exponential chase lerp
  private snapshotBuffer = new SnapshotBuffer();
  private deadReckoning = new DeadReckoning();

  private animationFrameId: number | null = null;

  // Extracted subsystems
  private readonly effects: ClientEffects;
  private readonly charges: ClientChargeSystem;
  private readonly sound: ClientSoundManager;
  private readonly positionSync: PositionSync;
  private readonly remoteRenderer: RemoteEntityRenderer;

  // Extracted subsystem: ability prediction, cooldowns, queue
  readonly abilitySystem: ClientAbilitySystem;

  // Local entity casting state (from server snapshots, or predicted locally)
  private localCastingAbilityId: string | null = null;
  private localCastingElapsed = 0;
  private localCastingTotalTime = 0;
  private localCastingIsChannel = false;
  private localTargetEntityId: string | null = null;

  // Local entity buffs (from server snapshots)
  private localBuffs: EntityBuffSnapshot['buffs'] = [];
  private localDRTimers: EntityBuffSnapshot['drTimers'] = undefined;

  // Blind state (blur + sand specks + eyelid blinks + targeting prevention)
  private readonly blindEffect = new BlindEffect();

  // Track tab visibility for fast-forwarding client-side timers on restore
  private wasHidden = false;
  private hiddenAt = 0;
  private onVisibilityChange: (() => void) | null = null;

  /** Round-trip latency in ms — sourced from NetworkManager ping/pong. */
  get latency(): number {
    return this.network.rtt;
  }


  // Resting state
  private resting = false;
  private restingSentAt = 0; // timestamp when resting was requested, to ignore stale server updates

  // Extracted subsystems
  private readonly inputHandler: ClientInputHandler;
  private readonly stateSync: ClientStateSync;

  // God mode (admin only)
  isAdmin = false;
  godMode = false;
  onGodModeToggle?: (active: boolean) => void;

  // Event callbacks for UI
  onCombatText?: (sourceEntityId: string, targetEntityId: string, amount: number, type: string) => void;
  onCooldownUpdate?: (abilityId: string, remaining: number, total: number) => void;
  onError?: (message: string) => void;
  onTargetChanged?: (entityId: string | null) => void;
  onGroundTargetConfirmed?: () => void;
  onEnterCombat?: (entityId: string) => void;
  onLeaveCombat?: (entityId: string) => void;
  onBuffApplied?: (entityId: string, buff: { name: string; type: 'buff' | 'debuff' }) => void;
  onBuffExpired?: (entityId: string, buff: { name: string; type: 'buff' | 'debuff' }) => void;
  onAbilitySuccess?: (abilityId: string) => void;
  onManaDrained?: (amount: number) => void;
  onAbilityEffect?: (entityId: string, abilityId: string) => void;
  /** Callback invoked when a queued ability is ready to fire. Set by MultiplayerUI. */
  onQueuedAbilityReady: ((abilityId: string) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, network: NetworkManager, mapId: string, localEntityId: string, initialEntities: EntitySnapshot[]) {
    this.network = network;
    this.localEntityId = localEntityId;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
    this.renderer = new Renderer(canvas);
    this.input = new InputManager(canvas);
    this.mapManager = new MapManager(this.scene);
    this.mapManager.loadMap(mapId);

    // Find local entity snapshot
    const localSnap = initialEntities.find(e => e.id === localEntityId);

    // Create ThirdPersonCamera first, then PlayerController (same pattern as Engine.ts)
    this.thirdPersonCamera = new ThirdPersonCamera(
      this.camera, this.input,
      () => this.playerController.getPosition(),
      this.scene,
    );

    // Use the real PlayerController — same class as playground mode
    this.playerController = new PlayerController(
      this.scene, this.input, this.mapManager,
      () => this.thirdPersonCamera.getAzimuth(),
      (a: number) => this.thirdPersonCamera.setAzimuth(a),
      () => this.thirdPersonCamera.getElevation(),
    );

    // Targeting system — same class as playground, handles raycasting + selection ring
    this.targetingSystem = new TargetingSystem(
      this.camera, this.scene, canvas,
      () => this.playerController,
    );
    this.targetingSystem.isUntargetable = (target) => {
      const id = this.findEntityIdByTargetable(target);
      return id ? this.isEntityInvisibleToLocal(id) : false;
    };

    // Set the correct character and team for the local player
    if (localSnap) {
      this.playerController.setCharacter(localSnap.characterId as CharacterId);
      (this.playerController as any).team = localSnap.team;
      this.playerController.name = localSnap.name;
      this.playerController.model.addTeamFlag(localSnap.team);
      this.playerController.mesh.position.set(localSnap.x, localSnap.y, localSnap.z);
      this.playerController.mesh.rotation.y = localSnap.rotationY;
      (this.playerController as any).targetRotation = localSnap.rotationY;
      (this.playerController as any).movementAzimuth = localSnap.rotationY + Math.PI;
      this.thirdPersonCamera.azimuth = localSnap.rotationY + Math.PI;
      const camDist = this.thirdPersonCamera.distance;
      this.camera.position.set(
        localSnap.x - Math.sin(localSnap.rotationY) * camDist,
        localSnap.y + 8,
        localSnap.z - Math.cos(localSnap.rotationY) * camDist,
      );
    }

    // Create remote entities for other players
    for (const snap of initialEntities) {
      if (snap.id === localEntityId) continue;
      this.createRemoteEntity(snap);
    }

    // Seed the snapshot buffer with initial entity positions
    this.snapshotBuffer.loadKeyframe(initialEntities, [], [], []);
    this.snapshotBuffer.pushPositions(0, Date.now(), initialEntities.map(e => ({
      id: e.id, x: e.x, y: e.y, z: e.z, rotationY: e.rotationY, isMoving: e.isMoving,
      vx: 0, vz: 0,
    })));

    // Initialize extracted subsystems
    this.effects = new ClientEffects(this.scene, {
      localEntityId: this.localEntityId,
      remoteEntities: this.remoteEntities as ReadonlyMap<string, import('./ClientEffects').EffectEntityView>,
      getLocalBuffs: () => this.localBuffs,
      getLocalCastingAbilityId: () => this.localCastingAbilityId,
      isLocalCastingChannel: () => this.localCastingIsChannel,
      getLocalTargetEntityId: () => this.localTargetEntityId,
      getPlayerMesh: () => this.playerController.mesh,
      getPlayerCharacterId: () => this.playerController.characterId as CharacterId,
      getPlayerAutoAttackRange: () => this.playerController.autoAttackRange,
      getEntityMesh: (id) => this.getEntityMesh(id),
      distToEntity: (id) => this.distToEntity(id),
      panToEntity: (id) => this.panToEntity(id),
      distToPosition: (pos) => this.distToPosition(pos),
      panToPosition: (pos) => this.panToPosition(pos),
    });

    this.charges = new ClientChargeSystem({
      localEntityId: this.localEntityId,
      playerController: this.playerController,
      getSelectedTargetId: () => this.selectedTargetId,
      getEntityMesh: (id) => this.getEntityMesh(id),
      sendStopAutoAttack: () => this.sendStopAutoAttack(),
      sendAutoAttack: (id) => this.sendAutoAttack(id),
    });

    this.sound = new ClientSoundManager({
      localEntityId: this.localEntityId,
      getLocalCharacterId: () => this.playerController.characterId as CharacterId,
      getEntityCharacterId: (id) => this.remoteEntities.get(id)?.characterId as CharacterId | undefined,
      distToEntity: (id) => this.distToEntity(id),
      panToEntity: (id) => this.panToEntity(id),
    });

    this.positionSync = new PositionSync(network, () => this.playerController);
    this.remoteRenderer = new RemoteEntityRenderer(this.deadReckoning, () => this.mapManager.collision);

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const engine = this;
    this.inputHandler = new ClientInputHandler({
      input: this.input,
      targetingSystem: this.targetingSystem,
      isPlayerDead: () => this.playerController.dead,
      isPlayerStunned: () => this.playerController.stunned,
      isPlayerInCombat: () => this.playerController.inCombat,
      isPlayerGrounded: () => this.playerController.grounded,
      getSelectedTargetId: () => this.selectedTargetId,
      getLocalEntityId: () => this.localEntityId,
      isResting: () => this.resting,
      isAdmin: () => this.isAdmin,
      isCasting: () => !!this.localCastingAbilityId,
      isBlinded: () => this.blindEffect.isActive(),
      startResting: () => this.startResting(),
      stopResting: () => this.stopResting(),
      selectTarget: (t) => this.selectTarget(t),
      sendCancelCast: () => this.sendCancelCast(),
      sendGodModeToggle: () => this.network.send({ type: 'toggle_god_mode' }),
      rightClickAttack: (id) => { if (this.resting) this.stopResting(); this.sendAutoAttack(id); },
      getVisibleHostileTargetables: () =>
        this.getAllRemoteEntities().filter(e => !this.isEntityInvisibleToLocal(e.id)).map(e => e.targetable),
      findEntityIdByTargetable: (t) => this.findEntityIdByTargetable(t),
      isEntityInvisibleToLocal: (id) => this.isEntityInvisibleToLocal(id),
      isHostileToLocal: (t) => t.isHostileTo(this.playerController),
      getRemoteEntityTargetId: (id) => this.remoteEntities.get(id)?.targetEntityId ?? null,
      getTargetableById: (id) => id === this.localEntityId
        ? (this.playerController as unknown as import('../engine/types').Targetable)
        : this.remoteEntities.get(id)?.targetable ?? null,
      get onGroundTargetConfirmed() { return engine.onGroundTargetConfirmed; },
    });

    this.stateSync = new ClientStateSync({
      localEntityId: this.localEntityId,
      playerController: this.playerController,
      sound: this.sound,
      getRemoteEntity: (id) => this.remoteEntities.get(id),
      get localCastingAbilityId() { return engine.localCastingAbilityId; },
      set localCastingAbilityId(v) { engine.localCastingAbilityId = v; },
      get localCastingElapsed() { return engine.localCastingElapsed; },
      set localCastingElapsed(v) { engine.localCastingElapsed = v; },
      get localCastingTotalTime() { return engine.localCastingTotalTime; },
      set localCastingTotalTime(v) { engine.localCastingTotalTime = v; },
      get localCastingIsChannel() { return engine.localCastingIsChannel; },
      set localCastingIsChannel(v) { engine.localCastingIsChannel = v; },
      get localTargetEntityId() { return engine.localTargetEntityId; },
      set localTargetEntityId(v) { engine.localTargetEntityId = v; },
      get localBuffs() { return engine.localBuffs; },
      set localBuffs(v) { engine.localBuffs = v; },
      get localDRTimers() { return engine.localDRTimers; },
      set localDRTimers(v) { engine.localDRTimers = v; },
      get resting() { return engine.resting; },
      set resting(v) { engine.resting = v; },
      get restingSentAt() { return engine.restingSentAt; },
      get selectedTargetId() { return engine.selectedTargetId; },
      isPredictingCast: (abilityId) => engine.abilitySystem.isPredictingCast(abilityId),
      clearPendingPrediction: () => engine.abilitySystem.clearPendingPrediction(),
      clearQueuedAbility: () => engine.abilitySystem.clearAbilityQueue(),
      selectTarget: (t) => engine.selectTarget(t),
      activateBlind: (canvas) => engine.blindEffect.activate(canvas),
      deactivateBlind: () => engine.blindEffect.deactivate(),
      isBlinded: () => engine.blindEffect.isActive(),
      getRendererCanvas: () => engine.renderer.getCanvas(),
      getLocalTeam: () => (engine.playerController as any).team,
      get onEnterCombat() { return engine.onEnterCombat; },
      get onLeaveCombat() { return engine.onLeaveCombat; },
      get onBuffApplied() { return engine.onBuffApplied; },
      get onBuffExpired() { return engine.onBuffExpired; },
    });

    this.abilitySystem = new ClientAbilitySystem({
      localEntityId: this.localEntityId,
      sound: this.sound,
      getPlayerCharacterId: () => this.playerController.characterId as CharacterId,
      getPlayerMana: () => this.playerController.mana,
      setPlayerMana: (v) => { (this.playerController as any).mana = v; },
      isPlayerMoving: () => this.playerController.isMoving,
      isPlayerGrounded: () => this.playerController.grounded,
      isPlayerDead: () => this.playerController.dead,
      isPlayerStunned: () => this.playerController.stunned,
      isPlayerCharging: () => this.playerController.charging,
      triggerAbilityAnimation: (id, pos) => this.playerController.triggerAbilityAnimation(id, pos),
      getEntityMeshPosition: (id) => this.getEntityMesh(id)?.position.clone(),
      get localCastingAbilityId() { return engine.localCastingAbilityId; },
      set localCastingAbilityId(v) { engine.localCastingAbilityId = v; },
      get localCastingElapsed() { return engine.localCastingElapsed; },
      set localCastingElapsed(v) { engine.localCastingElapsed = v; },
      get localCastingTotalTime() { return engine.localCastingTotalTime; },
      set localCastingTotalTime(v) { engine.localCastingTotalTime = v; },
      get localCastingIsChannel() { return engine.localCastingIsChannel; },
      set localCastingIsChannel(v) { engine.localCastingIsChannel = v; },
      getLocalBuffEffects: () => engine.localBuffs,
      get onCooldownUpdate() { return engine.onCooldownUpdate; },
      get onQueuedAbilityReady() { return engine.onQueuedAbilityReady; },
    });

    // Dumpster Dive emerge SFX (local Crackhead player)
    if ('onDumpsterEmerge' in this.playerController.model) {
      (this.playerController.model as any).onDumpsterEmerge = (phase: 1 | 2) => {
        this.sound.playDumpsterEmerge(this.localEntityId, this.playerController.characterId as CharacterId, phase);
      };
    }

    // Track tab visibility so we can fast-forward client-side timers on restore
    this.onVisibilityChange = () => {
      if (document.hidden) {
        this.wasHidden = true;
        this.hiddenAt = performance.now();
      }
    };
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private createRemoteEntity(snap: EntitySnapshot): RemoteEntity {
    const model = createCharacter(snap.characterId as CharacterId);
    model.addTeamFlag(snap.team);
    // Wrap model in a parent group (same pattern as PlayerController.mesh)
    // so rotation on the wrapper doesn't overwrite CharacterModel's built-in π offset
    const mesh = new THREE.Group();
    mesh.add(model.group);
    mesh.add(createTargetingHitArea());
    mesh.position.set(snap.x, snap.y, snap.z);
    mesh.rotation.y = snap.rotationY;
    this.scene.add(mesh);

    // Dumpster Dive emerge SFX (remote Crackhead players)
    if ('onDumpsterEmerge' in model) {
      (model as any).onDumpsterEmerge = (phase: 1 | 2) => {
        this.sound.playDumpsterEmerge(snap.id, snap.characterId as CharacterId, phase);
      };
    }

    const entity: RemoteEntity = {
      id: snap.id,
      characterId: snap.characterId,
      team: snap.team,
      name: snap.name,
      model,
      mesh,
      hp: snap.hp, maxHp: snap.maxHp, mana: snap.mana, maxMana: snap.maxMana,
      dead: snap.dead, inCombat: snap.inCombat, stunned: snap.stunned, charging: snap.charging,
      isMoving: snap.isMoving, isAutoAttacking: snap.isAutoAttacking,
      castingAbilityId: snap.castingAbilityId,
      castingElapsed: snap.castingElapsed, castingTotalTime: snap.castingTotalTime,
      castingIsChannel: snap.castingIsChannel,
      buffs: [],
      drTimers: undefined,
      targetable: null!, // Set below
      targetEntityId: snap.targetEntityId,
      disconnected: snap.disconnected ?? false,
      godMode: false,
      prevRotationY: snap.rotationY,
    };

    // Create a Targetable wrapper with live getters so it always reflects current state
    const targetable: Targetable = {
      get name() { return entity.name; },
      get modelName() { return entity.model.displayName; },
      get characterId() { return entity.characterId as CharacterId; },
      get team() { return entity.team; },
      get hp() { return entity.hp; },
      set hp(v) { entity.hp = v; },
      get maxHp() { return entity.maxHp; },
      set maxHp(v) { entity.maxHp = v; },
      get mana() { return entity.mana; },
      set mana(v) { entity.mana = v; },
      get maxMana() { return entity.maxMana; },
      set maxMana(v) { entity.maxMana = v; },
      get inCombat() { return entity.inCombat; },
      set inCombat(v) { entity.inCombat = v; },
      get dead() { return entity.dead; },
      set dead(v) { entity.dead = v; },
      get critChance() { return 0; },
      get dodgeChance() { return 0; },
      get autoAttackRange() { return getCharacterStats(entity.characterId as CharacterId).autoAttackRange; },
      mesh,
      isHostileTo(other: Targetable) { return entity.team !== other.team; },
      die() { /* server-authoritative */ },
      get castingAbilityName() {
        if (!entity.castingAbilityId) return null;
        const stats = getCharacterStats(entity.characterId as CharacterId);
        const ability = stats.abilities.find(a => a !== null && a.id === entity.castingAbilityId);
        return ability?.name ?? entity.castingAbilityId;
      },
      set castingAbilityName(_v) { /* read-only */ },
      get castingElapsed() { return entity.castingElapsed; },
      set castingElapsed(_v) { /* read-only */ },
      get castingTotalTime() { return entity.castingTotalTime; },
      set castingTotalTime(_v) { /* read-only */ },
      get castingIsChannel() { return entity.castingIsChannel; },
      set castingIsChannel(_v) { /* read-only */ },
      get disconnected() { return entity.disconnected; },
    };
    entity.targetable = targetable;
    mesh.userData.targetRef = targetable;

    this.remoteEntities.set(snap.id, entity);
    return entity;
  }

  start(): void {
    if (this.animationFrameId) return;
    this.loop();
  }

  stop(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.onVisibilityChange) {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.onVisibilityChange = null;
    }
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.renderer.setSize(width, height);
  }

  // ── Server message handlers ──────────────────────────────────────────

  /** Handle delta updates (every tick) — positions only when changed, state/buffs only when changed. */
  handleGameStateUpdate(msg: S2C_GameStateUpdate): void {
    // Always feed into the snapshot buffer — even when no positions changed,
    // the buffer needs continuous timestamps for adaptive delay & lag compensation.
    this.snapshotBuffer.pushPositions(msg.tick, msg.timestamp, msg.positions);

    // Feed dead reckoning for remote entities
    for (const pos of msg.positions) {
      if (pos.id !== this.localEntityId) {
        this.deadReckoning.updateEntity(pos.id, pos);
      }
    }

    // Apply state deltas (only present for entities whose state changed)
    if (msg.states) {
      this.snapshotBuffer.applyStateDeltas(msg.states);
      this.stateSync.applyEntityStateDeltas(msg.states);
    }

    // Apply buff updates (only present for entities whose buffs changed)
    if (msg.buffs) {
      this.snapshotBuffer.applyBuffUpdates(msg.buffs);
      this.stateSync.applyBuffUpdates(msg.buffs);
    }

    // Update world effects
    if (msg.gasClouds || msg.chemicalPools) {
      this.snapshotBuffer.updateWorldEffects(msg.gasClouds, msg.chemicalPools);
    }
    if (msg.chemicalPools) {
      this.effects.syncChemPoolState(msg.chemicalPools);
    }

    // Process bundled events (avoids separate WebSocket frames per event)
    if (msg.events) {
      for (const event of msg.events) {
        this.handleBundledEvent(event);
      }
    }
  }

  /** Handle an immediate position relay — feeds dead reckoning between tick broadcasts. */
  handlePositionRelay(msg: S2C_PositionRelay): void {
    if (msg.id === this.localEntityId) return; // should never happen, but guard
    this.deadReckoning.updateEntity(msg.id, msg);
  }

  /** Handle unreliable position update from WebRTC DataChannel.
   *  Arrives faster than the reliable game_state_update since it bypasses TCP. */
  handlePositionUpdate(msg: S2C_PositionUpdate): void {
    // Feed snapshot buffer for lag compensation timestamp tracking
    this.snapshotBuffer.pushPositions(msg.tick, msg.timestamp, msg.positions);

    // Feed dead reckoning for remote entities
    for (const pos of msg.positions) {
      if (pos.id !== this.localEntityId) {
        this.deadReckoning.updateEntity(pos.id, pos);
      }
    }
  }

  /** Dispatch a bundled event from the tick update. */
  private handleBundledEvent(event: import('@gtr/shared').GameTickEvent): void {
    switch (event.type) {
      case 'combat_event': this.handleCombatEvent(event); break;
      case 'flinch': this.handleFlinch(event); break;
      case 'ability_effect': this.handleAbilityEffect(event); break;
      case 'cooldown_update': this.handleCooldownUpdate(event); break;
      case 'auto_attack_swing': this.handleAutoAttackSwing(event); break;
      case 'gas_cloud_spawn': this.effects.handleGasCloudSpawn(event); break;
      case 'chem_pool_spawn': this.effects.handleChemPoolSpawn(event); break;
      case 'knockback': this.charges.handleKnockback(event); break;
      case 'entity_died': this.handleEntityDied(event); break;
    }
  }

  /** Handle full keyframe snapshot — resets all state. */
  handleGameStateSnapshot(msg: S2C_GameStateSnapshot): void {
    // Load full state into the snapshot buffer
    this.snapshotBuffer.loadKeyframe(msg.entities, msg.buffs, msg.gasClouds, msg.chemicalPools);
    this.snapshotBuffer.pushPositions(msg.tick, msg.timestamp, msg.entities.map(e => ({
      id: e.id, x: e.x, y: e.y, z: e.z, rotationY: e.rotationY, isMoving: e.isMoving,
      vx: 0, vz: 0, // keyframes don't carry velocity — entities re-acquire it on next delta
    })));

    // Don't snap dead reckoning from keyframes — the 30Hz position updates
    // and position relays already keep DR state current with velocity and
    // movement flags. Snapping resets all of that, causing a visible stutter
    // every 5 seconds for moving entities.

    // Apply full entity state
    for (const snap of msg.entities) {
      if (snap.id === this.localEntityId) {
        this.stateSync.applyLocalEntityState(snap);
        continue;
      }
      let entity = this.remoteEntities.get(snap.id);
      if (!entity) {
        entity = this.createRemoteEntity(snap);
      }
      this.stateSync.applyRemoteEntityState(entity, snap);
    }

    // Apply all buffs
    this.stateSync.applyBuffUpdates(msg.buffs);

    // Update chemical pool consumed state
    this.effects.syncChemPoolState(msg.chemicalPools);

    // Sync elapsed time from server keyframe — gameElapsed is authoritative
    if (msg.gameElapsed !== undefined) {
      this.mapManager.setElapsed(msg.gameElapsed);
      const script = this.mapManager.getScript();
      const openTime = (script && 'OPEN_TIME' in script) ? (script as any).OPEN_TIME as number : 30;
      if (msg.gameElapsed >= openTime && script && 'opened' in script && !(script as any).opened) {
        this.mapManager.forceOpenDoors();
      }
    } else if (msg.arenaTimeRemaining !== undefined && msg.arenaTimeRemaining > 0) {
      const script = this.mapManager.getScript();
      const openTime = (script && 'OPEN_TIME' in script) ? (script as any).OPEN_TIME as number : 30;
      this.mapManager.setElapsed(openTime - msg.arenaTimeRemaining);
    } else if (msg.arenaTimeRemaining === undefined || msg.arenaTimeRemaining <= 0) {
      // No arenaTimeRemaining means doors are already open — ensure client matches
      const script = this.mapManager.getScript();
      if (script && 'opened' in script && !(script as any).opened) {
        this.mapManager.forceOpenDoors();
      }
    }
  }

  /** Legacy handler for backward compat with old S2C_GameState messages. */
  handleGameState(msg: S2C_GameState): void {
    // Convert to keyframe format
    this.handleGameStateSnapshot({
      type: 'game_state_snapshot',
      tick: msg.tick,
      timestamp: msg.timestamp,
      entities: msg.entities,
      buffs: msg.buffs,
      gasClouds: msg.gasClouds,
      chemicalPools: msg.chemicalPools,
    });
  }

  handlePlayerDisconnected(entityId: string): void {
    const entity = this.remoteEntities.get(entityId);
    if (entity) {
      entity.disconnected = true;
      entity.isMoving = false;
    }
    // Immediately freeze dead reckoning — zero all velocities and error so the
    // entity stops exactly where it is with no residual extrapolation drift.
    this.deadReckoning.freezeEntity(entityId);
  }

  handlePlayerReconnected(entityId: string): void {
    const entity = this.remoteEntities.get(entityId);
    if (entity) {
      entity.disconnected = false;
    }
  }

  isEntityDisconnected(entityId: string): boolean {
    return this.remoteEntities.get(entityId)?.disconnected ?? false;
  }

  /** Remove a remote entity from the game world entirely (grace period expired). */
  handleEntityRemoved(entityId: string): void {
    const entity = this.remoteEntities.get(entityId);
    if (!entity) return;

    // Clear target if we were targeting this entity
    if (this.selectedTargetId === entityId) {
      this.selectTarget(null);
    }

    // Start fade-out — mesh stays in scene until fade completes
    this.effects.addFadingEntity(entityId, entity.model, entity.mesh);

    this.remoteEntities.delete(entityId);
    this.snapshotBuffer.removeEntity(entityId);
    this.deadReckoning.removeEntity(entityId);
  }


  handleCombatEvent(msg: S2C_CombatEvent): void {
    this.onCombatText?.(msg.sourceEntityId, msg.targetEntityId, msg.amount, msg.combatType);

    // Sound effects (auto-attack hits, ability hits, dodge)
    this.sound.playCombatEventSfx(msg);

    // Dodge animation on the target
    if (msg.combatType === 'dodge') {
      if (msg.targetEntityId === this.localEntityId) {
        this.playerController.triggerDodge();
      } else {
        this.remoteEntities.get(msg.targetEntityId)?.model.triggerDodge();
      }
    }

    // Auto-target attacker when player has no target (not while blinded)
    if (msg.targetEntityId === this.localEntityId && !this.selectedTargetId && msg.combatType !== 'heal' && !this.blindEffect.isActive() && !msg.suppressAutoTarget) {
      const attacker = this.remoteEntities.get(msg.sourceEntityId);
      if (attacker) {
        this.selectTarget(attacker.targetable);
      }
    }
  }

  handleAbilityEffect(msg: S2C_AbilityEffect): void {
    this.onAbilityEffect?.(msg.entityId, msg.abilityId);

    // Ground-targeted abilities use the ground position for the projectile animation
    const groundPos = msg.groundTargetX !== undefined && msg.groundTargetZ !== undefined
      ? new THREE.Vector3(msg.groundTargetX, msg.groundTargetY ?? 0, msg.groundTargetZ)
      : undefined;

    // Sound effects
    this.sound.playAbilityEffectSfx(msg);

    if (msg.entityId === this.localEntityId) {
      // If we predicted this ability, clear prediction state
      const predicted = this.abilitySystem.getPendingPredictionAbilityId() === msg.abilityId;
      if (predicted) {
        this.abilitySystem.clearPendingPrediction();
      }
      // Play animation if not predicted, OR if it was a ground-targeted prediction
      // (ground predictions skip animation during prediction, deferring to server confirmation)
      if (!predicted || groundPos) {
        const targetPos = groundPos ?? (this.selectedTargetId ? this.getEntityMesh(this.selectedTargetId)?.position.clone() : undefined);
        this.playerController.triggerAbilityAnimation(msg.abilityId, targetPos);
      }
      this.onAbilitySuccess?.(msg.abilityId);
      if (msg.manaStolen) this.onManaDrained?.(msg.manaStolen);
      // Optimistically update local buff stacks (server will confirm in next snapshot)
      if (msg.abilityId === 'shank' || msg.abilityId === 'pocket-sand' || msg.abilityId === 'sticky-fingers' || msg.abilityId === 'tweaker-sprint' || msg.abilityId === 'gank') {
        const buff = this.localBuffs.find(b => b.id === 'tweaking');
        if (buff && buff.stacks !== undefined) {
          buff.stacks = Math.min(buff.stacks + 15, buff.maxStacks ?? Infinity);
        }
      }
      if (msg.abilityId === 'crack-rock') {
        const buff = this.localBuffs.find(b => b.id === 'tweaking');
        if (buff && buff.stacks !== undefined) {
          buff.stacks = Math.min(buff.stacks + 25, buff.maxStacks ?? Infinity);
        }
      }
      // Start sweep charge for local player
      if (msg.abilityId === 'sweep') {
        this.charges.startSweepCharge();
      }
      // Start tweaker sprint charge for local player
      if (msg.abilityId === 'tweaker-sprint') {
        this.charges.startTweakerSprintCharge();
      }
      if (msg.abilityId === 'kaboom') {
        this.effects.spawnKaboomGust(this.playerController.mesh.position, this.playerController.mesh.rotation.y);
      }
    } else {
      const entity = this.remoteEntities.get(msg.entityId);
      if (entity) {
        const targetPos = groundPos ?? (entity.targetEntityId ? this.getEntityMesh(entity.targetEntityId)?.position.clone() : undefined);
        entity.model.triggerAbilityAnimation(msg.abilityId, targetPos);
        if (msg.abilityId === 'kaboom') {
          this.effects.spawnKaboomGust(entity.mesh.position, entity.mesh.rotation.y);
        }
      }
    }
  }

  handleFlinch(msg: S2C_Flinch): void {
    this.sound.playFlinchSfx(msg);
    if (msg.entityId === this.localEntityId) {
      this.playerController.triggerFlinch();
    } else {
      this.remoteEntities.get(msg.entityId)?.model.triggerFlinch();
    }
  }

  handleAutoAttackSwing(msg: S2C_AutoAttackSwing): void {
    // Resolve target position for ranged bullet visuals
    const targetPos = this.getEntityWorldPos(msg.targetEntityId);
    const isCrit = !!msg.isCrit;

    if (msg.entityId === this.localEntityId) {
      if (targetPos) this.playerController.model.swingTargetWorldPos = targetPos;
      this.playerController.triggerSwing(isCrit);
    } else {
      const entity = this.remoteEntities.get(msg.entityId);
      if (entity) {
        if (targetPos) entity.model.swingTargetWorldPos = targetPos;
        entity.model.triggerSwing(isCrit);
      }
    }
  }

  private getEntityWorldPos(entityId: string): THREE.Vector3 | null {
    if (entityId === this.localEntityId) {
      return this.playerController.mesh.position.clone();
    }
    const remote = this.remoteEntities.get(entityId);
    return remote ? remote.mesh.position.clone() : null;
  }

  /** Distance from local player to an entity (0 if it's the local player). */
  private distToEntity(entityId: string): number {
    if (entityId === this.localEntityId) return 0;
    const remote = this.remoteEntities.get(entityId);
    if (!remote) return 0;
    return this.playerController.mesh.position.distanceTo(remote.mesh.position);
  }

  /** Stereo pan (-1 left, +1 right) for an entity relative to the player's facing. */
  private panToEntity(entityId: string): number {
    if (entityId === this.localEntityId) return 0;
    const remote = this.remoteEntities.get(entityId);
    if (!remote) return 0;
    const pos = this.playerController.mesh.position;
    const rotY = this.playerController.mesh.rotation.y;
    const dx = remote.mesh.position.x - pos.x;
    const dz = remote.mesh.position.z - pos.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.001) return 0;
    // Dot product of normalized direction with player's right vector
    return (Math.cos(rotY) * dx - Math.sin(rotY) * dz) / len;
  }

  private distToPosition(worldPos: THREE.Vector3): number {
    return this.playerController.mesh.position.distanceTo(worldPos);
  }

  private panToPosition(worldPos: THREE.Vector3): number {
    const pos = this.playerController.mesh.position;
    const rotY = this.playerController.mesh.rotation.y;
    const dx = worldPos.x - pos.x;
    const dz = worldPos.z - pos.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.001) return 0;
    return (Math.cos(rotY) * dx - Math.sin(rotY) * dz) / len;
  }

  handleGasCloudSpawn(msg: import('@gtr/shared').S2C_GasCloudSpawn): void {
    this.effects.handleGasCloudSpawn(msg);
  }

  handleChemPoolSpawn(msg: import('@gtr/shared').S2C_ChemPoolSpawn): void {
    this.effects.handleChemPoolSpawn(msg);
  }

  handleCooldownUpdate(msg: S2C_CooldownUpdate): void {
    this.abilitySystem.handleCooldownUpdate(msg);
  }


  handleEntityDied(msg: S2C_EntityDied): void {
    const killerTeam = this.getEntityTeam(msg.killerEntityId);
    const victimTeam = this.getEntityTeam(msg.entityId);
    if (killerTeam !== null && victimTeam !== null) {
      this.mapManager.onKillingBlow(killerTeam, victimTeam);
    }
  }

  private getEntityTeam(entityId: string | null): number | null {
    if (!entityId) return null;
    if (entityId === this.localEntityId) {
      return (this.playerController as any).team ?? null;
    }
    const remote = this.remoteEntities.get(entityId);
    return remote?.team ?? null;
  }

  handleForceClearTarget(): void {
    this.selectedTargetId = null;
    this.localTargetEntityId = null;
    this.targetingSystem.currentTarget = null;
    this.onTargetChanged?.(null);
  }

  handleKnockback(msg: S2C_Knockback): void {
    this.charges.handleKnockback(msg);
  }

  /** Server rejected our position — snap local player back to the corrected position. */
  handlePositionCorrection(msg: { x: number; y: number; z: number; rotationY: number }): void {
    this.playerController.mesh.position.set(msg.x, msg.y, msg.z);
    this.playerController.mesh.rotation.y = msg.rotationY;
  }

  // ── Accessors for UI ─────────────────────────────────────────────────

  getLocalEntity(): PlayerController {
    return this.playerController;
  }

  getRemoteEntity(id: string): RemoteEntity | undefined {
    return this.remoteEntities.get(id);
  }

  /** Get either the local player or a remote entity by ID */
  getEntity(id: string): RemoteEntity | PlayerController | undefined {
    if (id === this.localEntityId) return this.playerController;
    return this.remoteEntities.get(id);
  }

  getAllRemoteEntities(): RemoteEntity[] {
    return Array.from(this.remoteEntities.values());
  }

  getCooldownRemaining(abilityId: string): number {
    return this.abilitySystem.getCooldownRemaining(abilityId);
  }

  getCooldownTotal(abilityId: string): number {
    return this.abilitySystem.getCooldownTotal(abilityId);
  }

  getGcdRemaining(): number {
    return this.abilitySystem.getGcdRemaining();
  }

  getGcdTotal(): number {
    return this.abilitySystem.getGcdTotal();
  }

  getLocalCastingState(): { abilityId: string; elapsed: number; totalTime: number; isChannel: boolean } | null {
    if (!this.localCastingAbilityId) return null;
    return {
      abilityId: this.localCastingAbilityId,
      elapsed: this.localCastingElapsed,
      totalTime: this.localCastingTotalTime,
      isChannel: this.localCastingIsChannel,
    };
  }

  // ── Ability queue / prediction (delegated to abilitySystem) ──────

  queueAbility(abilityId: string, targetEntityId: string | null, groundTarget?: { x: number; z: number }): void {
    this.abilitySystem.queueAbility(abilityId, targetEntityId, groundTarget);
  }

  clearAbilityQueue(): void { this.abilitySystem.clearAbilityQueue(); }
  getQueuedAbilityId(): string | null { return this.abilitySystem.getQueuedAbilityId(); }
  isWithinQueueWindow(remaining: number): boolean { return this.abilitySystem.isWithinQueueWindow(remaining); }

  predictAbility(abilityId: string, targetEntityId: string | null): void {
    this.abilitySystem.predictAbility(abilityId, targetEntityId);
  }

  predictGroundAbility(abilityId: string): void { this.abilitySystem.predictGroundAbility(abilityId); }
  revertPrediction(): void { this.abilitySystem.revertPrediction(); }
  getManaCostMultiplier(): number { return this.abilitySystem.getManaCostMultiplier(); }

  getLocalBuffs(): EntityBuffSnapshot['buffs'] {
    return this.localBuffs;
  }

  getLocalDRTimers(): EntityBuffSnapshot['drTimers'] {
    return this.localDRTimers;
  }

  /** Get the Three.js group for an entity (for raycasting/combat text positioning) */
  getEntityMesh(entityId: string): THREE.Group | undefined {
    if (entityId === this.localEntityId) return this.playerController.mesh;
    return this.remoteEntities.get(entityId)?.mesh;
  }

  get localId(): string {
    return this.localEntityId;
  }

  handleGodModeUpdate(entityId: string, active: boolean): void {
    if (entityId === this.localEntityId) {
      this.godMode = active;
      this.playerController.godMode = active;
      this.onGodModeToggle?.(active);
    } else {
      const entity = this.remoteEntities.get(entityId);
      if (entity) entity.godMode = active;
    }
  }

  /** Look up entity ID from a Targetable reference */
  private findEntityIdByTargetable(target: Targetable | null): string | null {
    if (!target) return null;
    if (target === (this.playerController as unknown as Targetable)) return this.localEntityId;
    for (const [id, entity] of this.remoteEntities) {
      if (entity.targetable === target) return id;
    }
    return null;
  }

  // ── Network commands ──────────────────────────────────────────────────

  sendAbility(abilityId: string, targetEntityId: string | null, groundTarget?: { x: number; y: number; z: number }): void {
    const clockOffset = this.network.clockSync.synced ? this.network.clockSync.offset : undefined;
    const serverTimestamp = this.snapshotBuffer.getCurrentRenderServerTimestamp(clockOffset);
    this.network.send({
      type: 'use_ability',
      abilityId,
      targetEntityId,
      ...(groundTarget ? { groundTargetX: groundTarget.x, groundTargetY: groundTarget.y, groundTargetZ: groundTarget.z } : {}),
      ...(serverTimestamp !== null ? { serverTimestamp } : {}),
    });
  }

  sendSetTarget(targetEntityId: string | null): void {
    this.network.send({ type: 'set_target', targetEntityId });
  }

  /** Returns true if the entity is hostile and currently untargetable (e.g. dumpster-diving). */
  isEntityInvisibleToLocal(entityId: string): boolean {
    const entity = this.remoteEntities.get(entityId);
    if (!entity) return false;
    const localTeam = (this.playerController as any).team;
    if (entity.team === localTeam) return false;
    return entity.buffs.some(b => b.id === 'dumpster-diving');
  }

  /** Programmatically select a target (e.g. from nameplate click). */
  selectTarget(target: Targetable | null): void {
    const newTargetId = this.findEntityIdByTargetable(target);
    // Block targeting hostile entities that are currently untargetable
    if (newTargetId && this.isEntityInvisibleToLocal(newTargetId)) return;
    this.targetingSystem.currentTarget = target;
    if (newTargetId !== this.selectedTargetId) {
      this.selectedTargetId = newTargetId;
      this.sendSetTarget(newTargetId);
      this.onTargetChanged?.(newTargetId);
    }
  }

  /** Right-click target: select + engage auto-attack if hostile. */
  rightClickTarget(target: Targetable): void {
    this.selectTarget(target);
    const targetId = this.findEntityIdByTargetable(target);
    if (targetId && target.isHostileTo(this.playerController) && !target.dead) {
      if (this.resting) this.stopResting();
      this.sendAutoAttack(targetId);
    }
  }

  sendAutoAttack(targetEntityId: string): void {
    this.network.send({ type: 'auto_attack', targetEntityId });
  }

  sendStopAutoAttack(): void {
    this.network.send({ type: 'stop_auto_attack' });
  }

  sendCancelCast(): void {
    this.network.send({ type: 'cancel_cast' });
  }

  sendCancelBuff(buffId: string): void {
    this.network.send({ type: 'cancel_buff', buffId });
  }

  // ── Resting ─────────────────────────────────────────────────────────

  startResting(): boolean {
    if (this.playerController.dead) return false;
    if (this.playerController.inCombat) {
      this.onError?.('You are in combat');
      return false;
    }
    if (this.playerController.isMoving) return false;
    if (this.playerController.stunned) return false;
    if (this.localCastingAbilityId) return false;

    this.resting = true;
    this.restingSentAt = performance.now();
    this.sendStopAutoAttack();
    this.playerController.setResting(true);
    this.network.send({ type: 'set_resting', resting: true });
    return true;
  }

  stopResting(): void {
    if (!this.resting) return;
    this.resting = false;
    this.playerController.setResting(false);
    this.network.send({ type: 'set_resting', resting: false });
  }

  isResting(): boolean {
    return this.resting;
  }

  // ── Main loop ────────────────────────────────────────────────────────

  private lastFrameTime = performance.now();

  private loop = (): void => {
    this.animationFrameId = requestAnimationFrame(this.loop);
    const now = performance.now();

    // Throttle to ~30 FPS when tab is visible but not focused
    const focused = document.hasFocus();
    if (!focused && now - this.lastFrameTime < 33) return;

    const dt = Math.min((now - this.lastFrameTime) / 1000, focused ? 0.1 : 0.2);
    this.lastFrameTime = now;

    // When the tab was backgrounded, RAF was paused and dt was clamped to 0.1s.
    // Fast-forward all client-side timers by the real elapsed gap so they don't
    // appear frozen when the tab is restored.
    if (this.wasHidden) {
      this.wasHidden = false;
      const gap = (now - this.hiddenAt) / 1000;
      if (gap > 0.2) this.fastForwardTimers(gap);
    }

    this.update(dt);
    this.renderer.renderer.render(this.scene, this.camera);
  };

  /**
   * Fast-forward client-side timers after the tab was backgrounded.
   * The arena countdown is wall-clock-based (ArenaScript getter) so it self-
   * corrects automatically — we only need to catch up cooldowns, buff
   * remaining timers, gas cloud / chem pool visuals, and sweep charge.
   */
  private fastForwardTimers(gap: number): void {
    // Cooldowns and GCD
    this.abilitySystem.fastForward(gap);

    // Buff remaining timers (local + remote)
    for (const b of this.localBuffs) {
      if (b.duration > 0) b.remaining = Math.max(0, b.remaining - gap);
    }
    for (const entity of this.remoteEntities.values()) {
      for (const b of entity.buffs) {
        if (b.duration > 0) b.remaining = Math.max(0, b.remaining - gap);
      }
    }

    // Fast-forward visual effects and charge systems
    this.effects.fastForward(gap);
    this.charges.fastForward();
  }

  private update(dt: number): void {
    // Compute movement speed modifier from local buffs + god mode
    let moveMult = 1;
    for (const b of this.localBuffs) {
      if (b.effects) {
        for (const effect of b.effects) {
          if (effect.type === 'movementSpeedPercent') moveMult += effect.value / 100;
        }
      }
    }
    this.playerController.movementSpeedModifier = Math.max(0, moveMult) * (this.godMode ? 4 : 1);

    // Update map script (platform colliders, shader uniforms, etc.) BEFORE entity
    // physics so that moving surfaces like the Celestial Ballroom elevator and Cage
    // pillars have their collision data current for this frame.  Previously this ran
    // after entity updates, causing a one-frame visual lag on moving platforms.
    this.mapManager.update(dt);

    // If a moving platform jumped (tab was backgrounded), snap the player to it
    // so they don't fall from the sky.
    const snapY = this.mapManager.getMovingPlatformSnapY(
      this.playerController.mesh.position.x,
      this.playerController.mesh.position.z,
    );
    if (snapY !== undefined) {
      this.playerController.mesh.position.y = snapY;
      this.playerController.velocityY = 0;
    }

    // Update local player using the real PlayerController (same as playground)
    this.playerController.update(dt);

    // Locally advance casting elapsed so animations run at render framerate (60fps)
    // instead of server tickrate (30fps). Server corrections (pushback, interrupt)
    // override via applyEntityStateDeltas / applyLocalEntityState.
    if (this.localCastingAbilityId) {
      this.localCastingElapsed += dt;
    }
    for (const entity of this.remoteEntities.values()) {
      if (entity.castingAbilityId) {
        entity.castingElapsed += dt;
      }
    }

    // Sync local casting state to PlayerController so the target frame cast bar works when targeting self
    if (this.localCastingAbilityId) {
      const stats = getCharacterStats(this.playerController.characterId as CharacterId);
      const ability = stats.abilities.find(a => a !== null && a.id === this.localCastingAbilityId);
      this.playerController.castingAbilityName = ability?.name ?? this.localCastingAbilityId;
      this.playerController.castingElapsed = this.localCastingElapsed;
      this.playerController.castingTotalTime = this.localCastingTotalTime;
      this.playerController.castingIsChannel = this.localCastingIsChannel;
    } else {
      this.playerController.castingAbilityName = null;
      this.playerController.castingElapsed = 0;
      this.playerController.castingTotalTime = 0;
      this.playerController.castingIsChannel = false;
    }

    // Update local player cast/channel animations
    if (this.localCastingAbilityId) {
      if (this.localCastingIsChannel) {
        const progress = this.localCastingTotalTime > 0
          ? Math.min(1, this.localCastingElapsed / this.localCastingTotalTime) : 0;
        this.playerController.setChannelAnimation(this.localCastingAbilityId, progress);
        this.playerController.setCastAnimation(null, 0);
      } else {
        const progress = this.localCastingTotalTime > 0
          ? Math.min(1, this.localCastingElapsed / this.localCastingTotalTime) : 0;
        this.playerController.setCastAnimation(this.localCastingAbilityId, progress);
        this.playerController.setChannelAnimation(null, 0);
      }
    } else {
      this.playerController.setCastAnimation(null, 0);
      this.playerController.setChannelAnimation(null, 0);
    }

    // Process action keys (resting, god mode, cancel cast)
    this.inputHandler.updateActions();

    // Update camera (same as playground)
    this.thirdPersonCamera.update(dt);
    this.playerController.setOpacity(this.thirdPersonCamera.getPlayerModelOpacity());

    // Send position updates (30Hz + immediate on state change)
    this.positionSync.update(dt);

    // Update cooldowns, ability queue, and prediction timeout
    this.abilitySystem.update(dt);

    // Locally decrement buff remaining timers so UI stays smooth between
    // server updates (server only sends buff changes on add/remove/shield change)
    for (const b of this.localBuffs) {
      if (b.duration > 0) b.remaining = Math.max(0, b.remaining - dt);
    }
    for (const entity of this.remoteEntities.values()) {
      for (const b of entity.buffs) {
        if (b.duration > 0) b.remaining = Math.max(0, b.remaining - dt);
      }
    }

    // Blind screen effect — update eyelid blink animation
    if (this.blindEffect.isActive()) {
      this.blindEffect.update(dt);
    }

    // Update spatial audio positions so sounds track entity movement
    this.sound.updateSpatialPositions();

    // Dead-reckon remote entity positions, resolve collisions, update animations
    this.remoteRenderer.updateAll(this.remoteEntities.values(), dt);


    // Update visual effects (gas clouds, chem pools, auras, beams, etc.)
    this.effects.update(dt);

    // Update charge systems (sweep, tweaker sprint, knockbacks)
    this.charges.update(dt);

    // Process targeting keys and mouse clicks (tab, focus target, left/right click)
    this.inputHandler.updateTargeting();

    // Update targeting ring animation + target highlight
    this.targetingSystem.update(dt);

    // Consume input deltas so they don't accumulate
    this.input.resetDeltas();
  }


  destroy(): void {
    this.stop();
    this.blindEffect.deactivate();
    this.sound.destroy();
    this.effects.destroy();
    this.input.dispose();
    this.targetingSystem.dispose();
    this.mapManager.dispose();
    this.renderer.dispose();
    for (const entity of this.remoteEntities.values()) this.scene.remove(entity.mesh);
    this.remoteEntities.clear();
    this.deadReckoning.clear();
    this.scene.remove(this.playerController.mesh);
  }
}
