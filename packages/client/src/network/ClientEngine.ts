import * as THREE from 'three';
import type { EntitySnapshot, EntityBuffSnapshot } from '@gtr/shared';
import type {
  S2C_GameState, S2C_GameStateUpdate, S2C_GameStateSnapshot,
  S2C_CombatEvent, S2C_Flinch, S2C_AbilityEffect, S2C_CooldownUpdate,
  S2C_GasCloudSpawn, S2C_ChemPoolSpawn, S2C_AutoAttackSwing, S2C_Knockback,
  S2C_EntityDied, S2C_PositionRelay, S2C_PositionUpdate,
} from '@gtr/shared';
import type { CharacterId } from '@gtr/shared';
import { yardsToUnits, getCharacterStats, Sweep, TweakerSprint, GLOBAL_COOLDOWN } from '@gtr/shared';
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
import {
  type GasCloudVisual, type ChemPoolVisual, type FullRetardAuraVisual, type CrotchRotVisual,
  POOL_CONSUME_DURATION,
  createGasCloud, updateGasCloud,
  createChemPool, updateChemPool,
  createFullRetardAura, updateFullRetardAura as updateFullRetardAuraVisual,
  createCrotchRotCloud, updateCrotchRotCloud,
  createChannelBeam, updateChannelBeam as updateChannelBeamVisual, removeChannelBeam,
  disposeGroup,
} from '../engine/effects/VisualEffects';
import { BlindEffect } from '../engine/effects/BlindEffect';
import { DeadReckoning } from './DeadReckoning';
import { keybindManager } from '../ui/KeybindManager';

interface RemoteEntity {
  id: string;
  characterId: string;
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
  private static readonly SEND_RATE = 1000 / 30; // 30 Hz — higher rate feeds fresher data to dead reckoning
  private sendAccumulator = 0;
  private lastSentPosition = { x: NaN, y: NaN, z: NaN, rotationY: NaN, isMoving: false };
  private prevSendPosition = { x: 0, y: 0, z: 0 };
  private prevSendTime = 0;

  // ── Movement state change detection ────────────────────────────────
  // Sends position updates immediately on start/stop/direction change
  // instead of waiting for the next 30Hz tick, reducing perceived latency
  // for other players by up to 33ms.
  private lastImmediateSendTime = 0;
  private prevMoving = false;
  private prevMoveFlags = 0;
  private prevMoveAngle = 0;
  private static readonly IMMEDIATE_SEND_MIN_INTERVAL = 30; // ms — rate limit for immediate sends
  private static readonly DIRECTION_CHANGE_THRESHOLD = 0.2; // radians (~11°) — detect turns faster for smoother dead reckoning

  // Visual effects
  private gasClouds = new Map<string, GasCloudVisual & { elapsed: number; duration: number }>();
  private chemPools = new Map<string, ChemPoolVisual & {
    elapsed: number; duration: number;
    activationDelay: number; consumed: boolean; consumeElapsed: number;
  }>();

  // Cooldowns (local tracking from server updates)
  private cooldowns = new Map<string, { remaining: number; total: number }>();
  private gcd: { remaining: number; total: number } | null = null;

  // Ability queue — fires the queued ability the instant GCD/cast ends (like WoW's SpellQueueWindow)
  private static readonly QUEUE_WINDOW = 0.4; // 400ms — ability can be queued during the last 400ms of GCD/cast
  private queuedAbility: { abilityId: string; targetEntityId: string | null; groundTarget?: { x: number; z: number } } | null = null;
  /** Callback invoked when a queued ability is ready to fire. Set by main.ts to handle targeting/validation. */
  onQueuedAbilityReady: ((abilityId: string) => void) | null = null;

  // Client-side ability prediction — apply GCD/cooldown/animation immediately, reconcile on server response
  private static readonly PREDICTION_TIMEOUT = 0.5; // revert prediction if no server response within 500ms
  private pendingPrediction: {
    abilityId: string;
    predictedAt: number; // performance.now()
    cooldownPredicted: boolean;
    castPredicted: boolean;
  } | null = null;

  // Local entity casting state (from server snapshots, or predicted locally)
  private localCastingAbilityId: string | null = null;
  private localCastingElapsed = 0;
  private localCastingTotalTime = 0;
  private localCastingIsChannel = false;
  private localTargetEntityId: string | null = null;

  // Local entity buffs (from server snapshots)
  private localBuffs: EntityBuffSnapshot['buffs'] = [];
  private localDRTimers: EntityBuffSnapshot['drTimers'] = undefined;

  // Sweep charge (local player only — client-side movement during charge)
  private sweepCharge: { elapsed: number; duration: number; direction: THREE.Vector3; speed: number; savedAutoAttackTargetId: string | null } | null = null;

  // Tweaker Sprint charge (local player only — dash to target)
  private tweakerSprintCharge: { elapsed: number; duration: number; direction: THREE.Vector3; speed: number; savedAutoAttackTargetId: string | null } | null = null;

  // Active knockbacks (visual displacement on client)
  private activeKnockbacks: { entityId: string; dirX: number; dirZ: number; distance: number; duration: number; elapsed: number; startY: number }[] = [];

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

  // Channel beam visual
  private channelBeam: THREE.Mesh | null = null;
  private channelBeamElapsed = 0;

  // Full Retard aura visual (per entity)
  private fullRetardAuras = new Map<string, FullRetardAuraVisual & { elapsed: number }>();

  // Crotch Rot cloud visual (per entity)
  private crotchRotVisuals = new Map<string, CrotchRotVisual & { elapsed: number }>();

  // Entities fading out before removal
  private static readonly ENTITY_FADE_DURATION = 1.5;
  private fadingEntities = new Map<string, { model: CharacterModel; mesh: THREE.Group; elapsed: number }>();

  // Resting state
  private resting = false;
  private rKeyWasDown = false;
  private tabKeyWasDown = false;
  private fKeyWasDown = false;
  private gKeyWasDown = false;
  private restingSentAt = 0; // timestamp when resting was requested, to ignore stale server updates

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
      this.applyEntityStateDeltas(msg.states);
    }

    // Apply buff updates (only present for entities whose buffs changed)
    if (msg.buffs) {
      this.snapshotBuffer.applyBuffUpdates(msg.buffs);
      this.applyBuffUpdates(msg.buffs);
    }

    // Update world effects
    if (msg.gasClouds || msg.chemicalPools) {
      this.snapshotBuffer.updateWorldEffects(msg.gasClouds, msg.chemicalPools);
    }
    if (msg.chemicalPools) {
      for (const cpSnap of msg.chemicalPools) {
        const pool = this.chemPools.get(cpSnap.id);
        if (pool && cpSnap.consumed && !pool.consumed) {
          pool.consumed = true;
        }
      }
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
      case 'gas_cloud_spawn': this.handleGasCloudSpawn(event); break;
      case 'chem_pool_spawn': this.handleChemPoolSpawn(event); break;
      case 'knockback': this.handleKnockback(event); break;
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
        this.applyLocalEntityState(snap);
        continue;
      }
      let entity = this.remoteEntities.get(snap.id);
      if (!entity) {
        entity = this.createRemoteEntity(snap);
      }
      this.applyRemoteEntityState(entity, snap);
    }

    // Apply all buffs
    this.applyBuffUpdates(msg.buffs);

    // Update chemical pool consumed state
    for (const cpSnap of msg.chemicalPools) {
      const pool = this.chemPools.get(cpSnap.id);
      if (pool && cpSnap.consumed && !pool.consumed) {
        pool.consumed = true;
      }
    }

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
    this.fadingEntities.set(entityId, {
      model: entity.model,
      mesh: entity.mesh,
      elapsed: 0,
    });

    this.remoteEntities.delete(entityId);
    this.snapshotBuffer.removeEntity(entityId);
    this.deadReckoning.removeEntity(entityId);
  }

  /** Apply state deltas to local player and remote entities. */
  private applyEntityStateDeltas(deltas: import('@gtr/shared').EntityStateDelta[]): void {
    for (const delta of deltas) {
      if (delta.id === this.localEntityId) {
        const pc = this.playerController;
        if (delta.hp !== undefined) pc.hp = delta.hp;
        if (delta.maxHp !== undefined) pc.maxHp = delta.maxHp;
        if (delta.mana !== undefined) pc.mana = delta.mana;
        if (delta.maxMana !== undefined) pc.maxMana = delta.maxMana;
        if (delta.dead !== undefined) {
          if (delta.dead && !pc.dead) { pc.die(); this.queuedAbility = null; }
          else if (!delta.dead && pc.dead) pc.respawn();
          pc.dead = delta.dead;
        }
        if (delta.inCombat !== undefined) {
          if (delta.inCombat && !pc.inCombat) this.onEnterCombat?.(delta.id);
          else if (!delta.inCombat && pc.inCombat) this.onLeaveCombat?.(delta.id);
          pc.inCombat = delta.inCombat;
        }
        if (delta.stunned !== undefined) { pc.stunned = delta.stunned; pc.setStunned(delta.stunned); if (delta.stunned) this.queuedAbility = null; }
        if (delta.charging !== undefined) pc.charging = delta.charging;
        if (delta.isAutoAttacking !== undefined) pc.setAutoAttacking(delta.isAutoAttacking);
        if ('castingAbilityId' in delta) {
          // Server confirmed the cast we predicted — clear prediction so it won't timeout/revert
          if (this.pendingPrediction?.castPredicted && delta.castingAbilityId === this.pendingPrediction.abilityId) {
            this.pendingPrediction = null;
          }
          this.localCastingAbilityId = delta.castingAbilityId!;
        }
        if (delta.castingElapsed !== undefined) this.localCastingElapsed = delta.castingElapsed;
        if (delta.castingTotalTime !== undefined) this.localCastingTotalTime = delta.castingTotalTime;
        if (delta.castingIsChannel !== undefined) this.localCastingIsChannel = delta.castingIsChannel;
        if ('targetEntityId' in delta) this.localTargetEntityId = delta.targetEntityId!;
        continue;
      }

      const entity = this.remoteEntities.get(delta.id);
      if (!entity) continue;

      // Detect cast start for auto-targeting
      const wasCasting = entity.castingAbilityId;

      if (delta.hp !== undefined) entity.hp = delta.hp;
      if (delta.maxHp !== undefined) entity.maxHp = delta.maxHp;
      if (delta.mana !== undefined) entity.mana = delta.mana;
      if (delta.maxMana !== undefined) entity.maxMana = delta.maxMana;
      if (delta.dead !== undefined) entity.dead = delta.dead;
      if (delta.inCombat !== undefined) entity.inCombat = delta.inCombat;
      if (delta.stunned !== undefined) entity.stunned = delta.stunned;
      if (delta.charging !== undefined) entity.charging = delta.charging;
      if (delta.isAutoAttacking !== undefined) entity.isAutoAttacking = delta.isAutoAttacking;
      if ('castingAbilityId' in delta) entity.castingAbilityId = delta.castingAbilityId!;
      if (delta.castingElapsed !== undefined) entity.castingElapsed = delta.castingElapsed;
      if (delta.castingTotalTime !== undefined) entity.castingTotalTime = delta.castingTotalTime;
      if (delta.castingIsChannel !== undefined) entity.castingIsChannel = delta.castingIsChannel;
      if ('targetEntityId' in delta) entity.targetEntityId = delta.targetEntityId!;
      if (delta.disconnected !== undefined) entity.disconnected = delta.disconnected;

      // Auto-target hostile entity that begins casting on us (not while blinded)
      if (!wasCasting && entity.castingAbilityId && entity.targetEntityId === this.localEntityId
          && !this.selectedTargetId && entity.team !== this.playerController.team && !this.blindEffect.isActive()) {
        this.selectTarget(entity.targetable);
      }
    }
  }

  /** Apply full state from a keyframe snapshot to the local player. */
  private applyLocalEntityState(snap: EntitySnapshot): void {
    const pc = this.playerController;
    pc.hp = snap.hp;
    pc.maxHp = snap.maxHp;
    pc.mana = snap.mana;
    pc.maxMana = snap.maxMana;
    if (snap.dead && !pc.dead) pc.die();
    else if (!snap.dead && pc.dead) pc.respawn();
    pc.dead = snap.dead;
    pc.inCombat = snap.inCombat;
    pc.stunned = snap.stunned;
    pc.charging = snap.charging;
    pc.setAutoAttacking(snap.isAutoAttacking);
    pc.setStunned(snap.stunned);
    this.localCastingAbilityId = snap.castingAbilityId;
    this.localCastingElapsed = snap.castingElapsed;
    this.localCastingTotalTime = snap.castingTotalTime;
    this.localCastingIsChannel = snap.castingIsChannel;
    this.localTargetEntityId = snap.targetEntityId;
  }

  /** Apply full state from a keyframe snapshot to a remote entity. */
  private applyRemoteEntityState(entity: RemoteEntity, snap: EntitySnapshot): void {
    entity.hp = snap.hp;
    entity.maxHp = snap.maxHp;
    entity.mana = snap.mana;
    entity.maxMana = snap.maxMana;
    entity.dead = snap.dead;
    entity.inCombat = snap.inCombat;
    entity.stunned = snap.stunned;
    entity.charging = snap.charging;
    entity.isMoving = snap.isMoving;
    entity.isAutoAttacking = snap.isAutoAttacking;
    entity.castingAbilityId = snap.castingAbilityId;
    entity.castingElapsed = snap.castingElapsed;
    entity.castingTotalTime = snap.castingTotalTime;
    entity.castingIsChannel = snap.castingIsChannel;
    entity.targetEntityId = snap.targetEntityId;
    entity.disconnected = snap.disconnected ?? false;
  }

  /** Apply buff updates to local player and remote entity visuals. */
  private applyBuffUpdates(buffSnapshots: EntityBuffSnapshot[]): void {
    for (const buffSnap of buffSnapshots) {
      if (buffSnap.entityId === this.localEntityId) {
        // Detect buff transitions for combat text
        const oldIds = new Set(this.localBuffs.map(b => b.id));
        const newIds = new Set(buffSnap.buffs.map(b => b.id));
        for (const b of buffSnap.buffs) {
          if (!oldIds.has(b.id)) this.onBuffApplied?.(buffSnap.entityId, b);
        }
        for (const b of this.localBuffs) {
          if (!newIds.has(b.id)) this.onBuffExpired?.(buffSnap.entityId, b);
        }

        this.localBuffs = buffSnap.buffs;
        this.localDRTimers = buffSnap.drTimers;
        // Sync resting state from server — but ignore stale updates that arrive
        // before the server has processed our resting request (grace period 500ms)
        const restingGraceExpired = performance.now() - this.restingSentAt > 500;
        if (this.resting && restingGraceExpired && !this.localBuffs.some(b => b.id === 'resting')) {
          this.resting = false;
          this.playerController.setResting(false);
        }
        const hasBuff = (id: string) => this.localBuffs.some(b => b.id === id);
        this.playerController.setAbilityBuffActive('crash-out', hasBuff('crash-out'));
        this.playerController.setAbilityBuffActive('retard-strength', hasBuff('retard-strength'));
        this.playerController.setAbilityBuffActive('full-retard', hasBuff('full-retard'));
        this.playerController.setAbilityBuffActive('dumpster-diving', hasBuff('dumpster-diving'));
        this.playerController.setAbilityBuffActive('overdosing', hasBuff('overdosing'));
        this.playerController.setDiscombobulated(this.localBuffs.some(b => b.id === 'discombobulate'));

        // Blind: activate/deactivate effect, clear target on first application
        const isNowBlinded = this.localBuffs.some(b => b.id === 'blinded');
        if (isNowBlinded && !this.blindEffect.isActive()) {
          this.blindEffect.activate(this.renderer.getCanvas());
          this.selectTarget(null);
        } else if (!isNowBlinded && this.blindEffect.isActive()) {
          this.blindEffect.deactivate();
        }
        continue;
      }
      const entity = this.remoteEntities.get(buffSnap.entityId);
      if (entity) {
        entity.buffs = buffSnap.buffs;
        entity.drTimers = buffSnap.drTimers;
        const hasBuff = (id: string) => buffSnap.buffs.some(b => b.id === id);
        entity.model.setAbilityBuffActive('crash-out', hasBuff('crash-out'));
        entity.model.setAbilityBuffActive('retard-strength', hasBuff('retard-strength'));
        entity.model.setAbilityBuffActive('full-retard', hasBuff('full-retard'));
        const dumpsterDiving = hasBuff('dumpster-diving');
        if ('dumpsterDiveHostile' in entity.model) {
          (entity.model as any).dumpsterDiveHostile = dumpsterDiving && entity.team !== (this.playerController as any).team;
        }
        entity.model.setAbilityBuffActive('dumpster-diving', dumpsterDiving);
        entity.model.setAbilityBuffActive('overdosing', hasBuff('overdosing'));
        entity.model.setResting(hasBuff('resting'));
      }
    }
  }

  handleCombatEvent(msg: S2C_CombatEvent): void {
    this.onCombatText?.(msg.sourceEntityId, msg.targetEntityId, msg.amount, msg.combatType);

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

    if (msg.entityId === this.localEntityId) {
      // If we predicted this ability, clear prediction state
      const predicted = this.pendingPrediction?.abilityId === msg.abilityId;
      if (predicted) {
        this.pendingPrediction = null;
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
        this.startSweepCharge();
      }
      // Start tweaker sprint charge for local player
      if (msg.abilityId === 'tweaker-sprint') {
        this.startTweakerSprintCharge();
      }
      if (msg.abilityId === 'kaboom') {
        this.spawnKaboomGust(this.playerController.mesh.position, this.playerController.mesh.rotation.y);
      }
    } else {
      const entity = this.remoteEntities.get(msg.entityId);
      if (entity) {
        const targetPos = groundPos ?? (entity.targetEntityId ? this.getEntityMesh(entity.targetEntityId)?.position.clone() : undefined);
        entity.model.triggerAbilityAnimation(msg.abilityId, targetPos);
        if (msg.abilityId === 'kaboom') {
          this.spawnKaboomGust(entity.mesh.position, entity.mesh.rotation.y);
        }
      }
    }
  }

  handleFlinch(msg: S2C_Flinch): void {
    if (msg.entityId === this.localEntityId) {
      this.playerController.triggerFlinch();
    } else {
      const entity = this.remoteEntities.get(msg.entityId);
      if (entity) entity.model.triggerFlinch();
    }
  }

  handleAutoAttackSwing(msg: S2C_AutoAttackSwing): void {
    if (msg.entityId === this.localEntityId) {
      this.playerController.triggerSwing();
    } else {
      const entity = this.remoteEntities.get(msg.entityId);
      if (entity) entity.model.triggerSwing();
    }
  }

  handleCooldownUpdate(msg: S2C_CooldownUpdate): void {
    if (msg.abilityId === '__gcd__') {
      this.gcd = { remaining: msg.remaining, total: msg.total };
      return;
    }
    this.cooldowns.set(msg.abilityId, { remaining: msg.remaining, total: msg.total });
    this.onCooldownUpdate?.(msg.abilityId, msg.remaining, msg.total);
  }

  handleGasCloudSpawn(msg: S2C_GasCloudSpawn): void {
    const visual = createGasCloud(this.scene, msg.x, msg.z, msg.radius, msg.y);
    this.gasClouds.set(msg.id, { ...visual, elapsed: 0, duration: msg.duration });
  }

  handleChemPoolSpawn(msg: S2C_ChemPoolSpawn): void {
    const visual = createChemPool(this.scene, msg.x, msg.z, msg.radius, msg.y);
    this.chemPools.set(msg.id, {
      ...visual, elapsed: 0, duration: msg.duration,
      activationDelay: msg.activationDelay, consumed: false, consumeElapsed: 0,
    });
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
    // Capture the entity's current Y so the arc is relative to their actual height
    let startY = 0;
    if (msg.entityId === this.localEntityId) {
      startY = this.playerController.mesh.position.y;
    } else {
      const entity = this.remoteEntities.get(msg.entityId);
      if (entity) startY = entity.mesh.position.y;
    }
    this.activeKnockbacks.push({
      entityId: msg.entityId,
      dirX: msg.dirX,
      dirZ: msg.dirZ,
      distance: msg.distance,
      duration: msg.duration,
      elapsed: 0,
      startY,
    });
  }

  /** Server rejected our position — snap local player back to the corrected position. */
  handlePositionCorrection(msg: { x: number; y: number; z: number; rotationY: number }): void {
    this.playerController.mesh.position.set(msg.x, msg.y, msg.z);
    this.playerController.mesh.rotation.y = msg.rotationY;
  }

  private updateKnockbacks(dt: number): void {
    for (let i = this.activeKnockbacks.length - 1; i >= 0; i--) {
      const kb = this.activeKnockbacks[i];
      kb.elapsed += dt;
      const t = Math.min(1, kb.elapsed / kb.duration);

      const speed = kb.distance / kb.duration;
      const height = 3.0 * 4 * t * (1 - t); // parabolic arc (relative offset)

      if (kb.entityId === this.localEntityId) {
        this.playerController.mesh.position.x += kb.dirX * speed * dt;
        this.playerController.mesh.position.z += kb.dirZ * speed * dt;
        this.playerController.mesh.position.y = kb.startY + height;
      } else {
        const entity = this.remoteEntities.get(kb.entityId);
        if (entity) {
          entity.mesh.position.x += kb.dirX * speed * dt;
          entity.mesh.position.z += kb.dirZ * speed * dt;
          entity.mesh.position.y = kb.startY + height;
        }
      }

      if (t >= 1) {
        if (kb.entityId === this.localEntityId) {
          // Return to starting height — PlayerController physics will handle
          // the fall if knocked off a ledge (gravity, grounded detection, etc.)
          this.playerController.mesh.position.y = kb.startY;
          (this.playerController as any).grounded = false;
          this.playerController.velocityY = 0;
          (this.playerController as any).fallPeakY = kb.startY;
        } else {
          const entity = this.remoteEntities.get(kb.entityId);
          if (entity) entity.mesh.position.y = kb.startY;
        }
        this.activeKnockbacks.splice(i, 1);
      }
    }
  }

  private spawnKaboomGust(origin: THREE.Vector3, rotY: number): void {
    const halfAngle = Math.PI / 6;
    const range = yardsToUnits(8);
    const particleCount = 30;
    const group = new THREE.Group();
    group.position.set(origin.x, 0, origin.z);

    const particles: { mesh: THREE.Mesh; vx: number; vz: number; speed: number; life: number }[] = [];

    for (let i = 0; i < particleCount; i++) {
      const angle = rotY - halfAngle + Math.random() * 2 * halfAngle;
      const speed = range * (0.8 + Math.random() * 0.4);
      const size = 0.08 + Math.random() * 0.12;

      const geo = new THREE.SphereGeometry(size, 4, 4);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xccddee,
        transparent: true,
        opacity: 0.5 + Math.random() * 0.3,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, 0.3 + Math.random() * 1.0, 0);

      group.add(mesh);
      particles.push({ mesh, vx: Math.sin(angle), vz: Math.cos(angle), speed, life: 0 });
    }

    this.scene.add(group);

    const duration = 0.4;
    const startTime = performance.now();

    const animate = () => {
      const elapsed = (performance.now() - startTime) / 1000;
      const t = elapsed / duration;

      if (t >= 1) {
        this.scene.remove(group);
        for (const p of particles) {
          (p.mesh.geometry as THREE.BufferGeometry).dispose();
          (p.mesh.material as THREE.Material).dispose();
        }
        return;
      }

      for (const p of particles) {
        p.life += 1 / 60;
        const dist = p.speed * p.life;
        p.mesh.position.x = p.vx * dist;
        p.mesh.position.z = p.vz * dist;
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * (0.5 + Math.random() * 0.1);
        p.mesh.position.y += 0.01;
        const scale = 1 + t * 1.5;
        p.mesh.scale.setScalar(scale);
      }

      requestAnimationFrame(animate);
    };

    requestAnimationFrame(animate);
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
    return this.cooldowns.get(abilityId)?.remaining ?? 0;
  }

  getCooldownTotal(abilityId: string): number {
    return this.cooldowns.get(abilityId)?.total ?? 0;
  }

  getGcdRemaining(): number {
    return this.gcd?.remaining ?? 0;
  }

  getGcdTotal(): number {
    return this.gcd?.total ?? 0;
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

  // ── Ability queue ────────────────────────────────────────────────────

  /** Queue an ability to fire the instant GCD/cast ends. Replaces any existing queue. */
  queueAbility(abilityId: string, targetEntityId: string | null, groundTarget?: { x: number; z: number }): void {
    this.queuedAbility = { abilityId, targetEntityId, groundTarget };
  }

  clearAbilityQueue(): void {
    this.queuedAbility = null;
  }

  getQueuedAbilityId(): string | null {
    return this.queuedAbility?.abilityId ?? null;
  }

  /** Returns true if the remaining time is within the queue window. */
  isWithinQueueWindow(remaining: number): boolean {
    return remaining > 0 && remaining <= ClientEngine.QUEUE_WINDOW;
  }

  // ── Client-side ability prediction ──────────────────────────────────

  /**
   * Optimistically predict ability effects locally before server confirms.
   * Call immediately before sendAbility(). Applies GCD, cooldown, mana, animation/cast bar.
   * Server response reconciles via handleCooldownUpdate/handleAbilityEffect/state deltas.
   */
  predictAbility(abilityId: string, targetEntityId: string | null): void {
    const stats = getCharacterStats(this.playerController.characterId as CharacterId);
    const ability = stats.abilities.find(a => a !== null && a.id === abilityId);
    if (!ability) return;

    const pc = this.playerController as any;

    // Predict GCD (CC-immune abilities bypass GCD)
    if (!ability.usableWhileCCd) {
      this.gcd = { remaining: GLOBAL_COOLDOWN, total: GLOBAL_COOLDOWN };
    }

    // Predict ability cooldown
    let cooldownPredicted = false;
    if (ability.cooldown > 0) {
      this.cooldowns.set(abilityId, { remaining: ability.cooldown, total: ability.cooldown });
      this.onCooldownUpdate?.(abilityId, ability.cooldown, ability.cooldown);
      cooldownPredicted = true;
    }

    // Predict mana deduction
    const effectiveCost = Math.round(ability.manaCost * this.getManaCostMultiplier());
    if (effectiveCost > 0) {
      pc.mana = Math.max(0, pc.mana - effectiveCost);
    }

    // Predict cast bar for cast-time abilities (only if not moving — server rejects casts while moving)
    let castPredicted = false;
    if (ability.castTime && !pc.isMoving) {
      this.localCastingAbilityId = abilityId;
      this.localCastingElapsed = 0;
      this.localCastingTotalTime = ability.castTime;
      this.localCastingIsChannel = !!ability.isChannel;
      castPredicted = true;
    }

    // Predict animation for instant-cast abilities (cast animations are driven by casting state)
    if (!ability.castTime) {
      const targetPos = targetEntityId ? this.getEntityMesh(targetEntityId)?.position.clone() : undefined;
      this.playerController.triggerAbilityAnimation(abilityId, targetPos);
    }

    this.pendingPrediction = {
      abilityId,
      predictedAt: performance.now(),
      cooldownPredicted,
      castPredicted,
    };
  }

  /**
   * Predict GCD/cooldown/mana for a ground-targeted ability (skip animation — projectile
   * animations are complex and rely on server-provided ground position).
   */
  predictGroundAbility(abilityId: string): void {
    const stats = getCharacterStats(this.playerController.characterId as CharacterId);
    const ability = stats.abilities.find(a => a !== null && a.id === abilityId);
    if (!ability) return;

    const pc = this.playerController as any;

    if (!ability.usableWhileCCd) {
      this.gcd = { remaining: GLOBAL_COOLDOWN, total: GLOBAL_COOLDOWN };
    }

    let cooldownPredicted = false;
    if (ability.cooldown > 0) {
      this.cooldowns.set(abilityId, { remaining: ability.cooldown, total: ability.cooldown });
      this.onCooldownUpdate?.(abilityId, ability.cooldown, ability.cooldown);
      cooldownPredicted = true;
    }

    const effectiveCost = Math.round(ability.manaCost * this.getManaCostMultiplier());
    if (effectiveCost > 0) {
      pc.mana = Math.max(0, pc.mana - effectiveCost);
    }

    this.pendingPrediction = {
      abilityId,
      predictedAt: performance.now(),
      cooldownPredicted,
      castPredicted: false,
    };
  }

  /**
   * Revert a pending prediction (called when server sends an error or prediction times out).
   * Mana and cooldowns are corrected naturally by server deltas within 1-2 ticks.
   * GCD and casting state need explicit revert since no server update will clear them.
   */
  revertPrediction(): void {
    if (!this.pendingPrediction) return;
    const pred = this.pendingPrediction;
    this.pendingPrediction = null;

    // Revert predicted GCD — server didn't trigger one
    this.gcd = null;

    // Revert predicted cooldown — server didn't set one
    if (pred.cooldownPredicted) {
      this.cooldowns.delete(pred.abilityId);
    }

    // Revert predicted cast bar
    if (pred.castPredicted && this.localCastingAbilityId === pred.abilityId) {
      this.localCastingAbilityId = null;
      this.localCastingElapsed = 0;
      this.localCastingTotalTime = 0;
      this.localCastingIsChannel = false;
    }

    // Mana: let server's next state delta correct it (within 50-100ms)
  }

  getLocalBuffs(): EntityBuffSnapshot['buffs'] {
    return this.localBuffs;
  }

  getLocalDRTimers(): EntityBuffSnapshot['drTimers'] {
    return this.localDRTimers;
  }

  getManaCostMultiplier(): number {
    let mult = 1;
    for (const buff of this.localBuffs) {
      if (buff.effects) {
        for (const effect of buff.effects) {
          if (effect.type === 'manaCostPercent') mult += effect.value / 100;
        }
      }
    }
    return Math.max(0, mult);
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

  /** Check if the queued ability can fire (GCD done, not casting, not incapacitated). */
  private processAbilityQueue(): void {
    if (!this.queuedAbility) return;

    const pc = this.playerController as any;

    // Clear queue if player can't act
    if (pc.dead || pc.stunned || pc.charging) {
      this.queuedAbility = null;
      return;
    }

    // Still on GCD
    if (this.gcd && this.gcd.remaining > 0) return;

    // Still casting (non-channel blocks queue; channel doesn't block action bar)
    if (this.localCastingAbilityId && !this.localCastingIsChannel) return;

    // Ready to fire — use callback so main.ts handles target resolution & validation
    const { abilityId } = this.queuedAbility;
    this.queuedAbility = null;
    this.onQueuedAbilityReady?.(abilityId);
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
    const dt = Math.min((now - this.lastFrameTime) / 1000, 0.1);
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
    // Cooldowns
    for (const [id, cd] of this.cooldowns) {
      cd.remaining = Math.max(0, cd.remaining - gap);
      if (cd.remaining <= 0) this.cooldowns.delete(id);
    }
    if (this.gcd) {
      this.gcd.remaining -= gap;
      if (this.gcd.remaining <= 0) this.gcd = null;
    }

    // Buff remaining timers (local + remote)
    for (const b of this.localBuffs) {
      if (b.duration > 0) b.remaining = Math.max(0, b.remaining - gap);
    }
    for (const entity of this.remoteEntities.values()) {
      for (const b of entity.buffs) {
        if (b.duration > 0) b.remaining = Math.max(0, b.remaining - gap);
      }
    }

    // Gas cloud visuals
    for (const [id, cloud] of this.gasClouds) {
      cloud.elapsed += gap;
    }

    // Chem pool visuals
    for (const [id, pool] of this.chemPools) {
      pool.elapsed += gap;
      if (pool.consumed) pool.consumeElapsed += gap;
    }

    // Sweep/sprint charge — if we were mid-charge when backgrounded, it's certainly
    // finished by now.  Clear it so the player isn't stuck in a charge state.
    if (this.sweepCharge) {
      this.sweepCharge = null;
      this.playerController.charging = false;
    }
    if (this.tweakerSprintCharge) {
      this.tweakerSprintCharge = null;
      this.playerController.charging = false;
      this.playerController.chargeAnimSpeed = 1;
    }
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

    // Resting toggle
    const rKeyDown = this.input.isBindDown(keybindManager.getCode('rest'));
    if (rKeyDown && !this.rKeyWasDown) {
      if (this.resting) {
        this.stopResting();
      } else {
        this.startResting();
      }
    }
    this.rKeyWasDown = rKeyDown;

    // God mode toggle — "G" key (admin only, sends to server)
    const gKeyDown = this.input.isKeyDown('KeyG');
    if (gKeyDown && !this.gKeyWasDown && this.isAdmin) {
      this.network.send({ type: 'toggle_god_mode' });
    }
    this.gKeyWasDown = gKeyDown;

    // Cancel casting on jump
    if (this.localCastingAbilityId && this.input.isBindDown(keybindManager.getCode('jump'))) {
      this.sendCancelCast();
    }

    // Cancel resting on movement or jump
    if (this.resting) {
      const wDown = this.input.isBindDown(keybindManager.getCode('move_forward'));
      const sDown = this.input.isBindDown(keybindManager.getCode('move_backward'));
      const aDown = this.input.isBindDown(keybindManager.getCode('move_left'));
      const dDown = this.input.isBindDown(keybindManager.getCode('move_right'));
      const bothMouse = this.input.isMouseButtonDown('left') && this.input.isMouseButtonDown('right');
      const jumping = this.input.isBindDown(keybindManager.getCode('jump'));
      if (wDown || sDown || aDown || dDown || bothMouse || jumping) {
        this.stopResting();
      }
    }

    // Cancel resting on entering combat or taking damage
    if (this.resting && this.playerController.inCombat) {
      this.stopResting();
    }

    // Cancel resting on stun or death
    if (this.resting && (this.playerController.stunned || this.playerController.dead)) {
      this.stopResting();
    }

    // Update camera (same as playground)
    this.thirdPersonCamera.update(dt);
    this.playerController.setOpacity(this.thirdPersonCamera.getPlayerModelOpacity());

    // ── Movement state change → immediate send ──
    // Detect start/stop/direction changes and send position right away
    // instead of waiting for the next 30Hz tick. This reduces perceived
    // latency for remote players by up to 33ms per state change.
    const isMovingNow = this.playerController.isMoving ?? false;
    const currentMoveFlags = this.playerController.moveFlags;
    const now = performance.now();
    let immediateNeeded = false;

    // Compute current movement direction (before any send updates prevSendPosition)
    let currentMoveAngle = this.prevMoveAngle;
    if (isMovingNow) {
      const pos = this.playerController.getPosition();
      const dx = pos.x - this.prevSendPosition.x;
      const dz = pos.z - this.prevSendPosition.z;
      if (dx * dx + dz * dz > 0.001) {
        currentMoveAngle = Math.atan2(dx, dz);
      }
    }

    if (isMovingNow !== this.prevMoving || currentMoveFlags !== this.prevMoveFlags) {
      // Start, stop, or flag change (e.g. W→W+A) — always send immediately
      immediateNeeded = true;
    } else if (isMovingNow) {
      // Still moving — check for significant direction change
      let angleDelta = currentMoveAngle - this.prevMoveAngle;
      while (angleDelta > Math.PI) angleDelta -= Math.PI * 2;
      while (angleDelta < -Math.PI) angleDelta += Math.PI * 2;
      if (Math.abs(angleDelta) > ClientEngine.DIRECTION_CHANGE_THRESHOLD) {
        immediateNeeded = true;
      }
    }

    if (immediateNeeded && (now - this.lastImmediateSendTime) >= ClientEngine.IMMEDIATE_SEND_MIN_INTERVAL) {
      this.prevMoveAngle = currentMoveAngle;
      this.sendPositionUpdate();
      this.lastImmediateSendTime = now;
      this.sendAccumulator = 0; // reset so the periodic tick stays evenly spaced
    }
    this.prevMoving = isMovingNow;
    this.prevMoveFlags = currentMoveFlags;

    // Periodic 30Hz position updates — drift correction between state changes
    this.sendAccumulator += dt * 1000;
    if (this.sendAccumulator >= ClientEngine.SEND_RATE) {
      this.sendAccumulator -= ClientEngine.SEND_RATE;
      this.prevMoveAngle = currentMoveAngle;
      this.sendPositionUpdate();
    }

    // Update cooldowns
    for (const [id, cd] of this.cooldowns) {
      cd.remaining = Math.max(0, cd.remaining - dt);
      if (cd.remaining <= 0) this.cooldowns.delete(id);
    }
    if (this.gcd) {
      this.gcd.remaining -= dt;
      if (this.gcd.remaining <= 0) this.gcd = null;
    }

    // Process ability queue — fire queued ability the instant GCD/cast ends
    this.processAbilityQueue();

    // Revert prediction if server hasn't responded within timeout.
    // Cast-time predictions skip this — they're confirmed by ability_effect on completion
    // or reverted by server error. The timeout only applies to instant abilities.
    if (this.pendingPrediction &&
        !this.pendingPrediction.castPredicted &&
        performance.now() - this.pendingPrediction.predictedAt > ClientEngine.PREDICTION_TIMEOUT * 1000) {
      this.revertPrediction();
    }

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

    // Dead-reckon remote entity positions — predict current position from
    // last known server state + velocity, with smooth error correction.
    for (const entity of this.remoteEntities.values()) {
      const dr = this.deadReckoning.getPosition(entity.id, dt);
      let interpVx = 0;
      let interpVz = 0;
      if (dr) {
        entity.isMoving = dr.isMoving;

        if (entity.disconnected) {
          // Disconnected entities: freeze X/Z exactly where they are.
          // Use the server-sent Y from dead reckoning so gravity-simulated
          // falls are visible to remote players. Fall back to collision
          // resolution only when vy is zero (tracking moving surfaces).
          if (dr.vy !== 0) {
            // Server is simulating gravity — use its Y position
            entity.mesh.position.y = dr.y;
          } else {
            const baseY = entity.mesh.position.y;
            const groundY = this.mapManager.collision.resolve(
              entity.mesh.position.x, entity.mesh.position.z, baseY + 1, 0.4,
            ).groundY;
            const diff = groundY - baseY;
            if (Math.abs(diff) < 2) {
              entity.mesh.position.y = groundY;
            }
          }
        } else {
          // When grounded (vy=0), resolve Y against the client's collision system
          // so remote players track animated surfaces like the Celestial Ballroom
          // elevator and Cage pillars.  We resolve from the entity's last rendered
          // Y (which was on the platform surface last frame) rather than the stale
          // DR Y.  This way the boost only needs to cover one frame of platform
          // movement (~0.44u at 60fps, max) instead of the full network lag,
          // avoiding false snaps to distant surfaces (e.g. a pillar top when the
          // entity is at ground level).
          let finalY = dr.y;
          if (dr.vy === 0 && !entity.godMode) {
            const baseY = entity.mesh.position.y;
            const groundY = this.mapManager.collision.resolve(dr.x, dr.z, baseY + 1, 0.4).groundY;
            const diff = groundY - baseY;
            if (Math.abs(diff) < 2) {
              finalY = groundY;
            }
          }
          entity.mesh.position.set(dr.x, finalY, dr.z);
          entity.mesh.rotation.y = dr.rotationY;
          interpVx = dr.vx;
          interpVz = dr.vz;
        }
      }

      // Update model animation state
      entity.model.setAutoAttacking(entity.isAutoAttacking);
      entity.model.setStunned(entity.stunned);

      if (entity.castingAbilityId) {
        if (entity.castingIsChannel) {
          const progress = entity.castingTotalTime > 0
            ? Math.min(1, entity.castingElapsed / entity.castingTotalTime)
            : 0;
          entity.model.setChannelAnimation(entity.castingAbilityId, progress);
          entity.model.setCastAnimation(null, 0);
        } else {
          const progress = entity.castingTotalTime > 0
            ? Math.min(1, entity.castingElapsed / entity.castingTotalTime)
            : 0;
          entity.model.setCastAnimation(entity.castingAbilityId, progress);
          entity.model.setChannelAnimation(null, 0);
        }
      } else {
        entity.model.setCastAnimation(null, 0);
        entity.model.setChannelAnimation(null, 0);
      }

      // Handle death animation
      if (entity.dead && !entity.model.isDying) {
        entity.model.startDeath();
      } else if (!entity.dead && entity.model.isDying) {
        entity.model.resetDeath();
      }

      // ── Derive animation params from interpolated velocity ──

      // Speed multiplier: ratio of actual speed to base walk speed (5.6 units/sec)
      const speed = Math.sqrt(interpVx * interpVx + interpVz * interpVz);
      const speedMultiplier = entity.isMoving && speed > 0.1 ? speed / 5.6 : 1;

      // Strafe direction: project velocity onto the entity's right vector.
      // Uses a continuous [-1, 1] value so the animation blends smoothly
      // between forward run and side-shuffle, including diagonal movement.
      let strafeDirection = 0;
      if (entity.isMoving && speed > 0.1) {
        const facingSin = Math.sin(entity.mesh.rotation.y);
        const facingCos = Math.cos(entity.mesh.rotation.y);
        // Forward dot: positive = moving forward, negative = backpedaling
        const forwardDot = facingSin * interpVx + facingCos * interpVz;
        // Right dot: positive = moving right, negative = moving left
        const rightDot = -facingCos * interpVx + facingSin * interpVz;
        // Strafe amount = right component / speed, but only when not mostly moving forward/back
        // atan2 gives us the angle between velocity and facing direction
        const moveAngle = Math.atan2(rightDot, forwardDot);
        // Map the angle to strafe: 0 = forward, ±π/2 = pure strafe, ±π = backward
        // Use sin of the angle — peaks at ±π/2 (pure strafe), zero at forward/back
        strafeDirection = Math.sin(moveAngle);
        // Suppress very small values to avoid jitter in the animation blend
        if (Math.abs(strafeDirection) < 0.15) strafeDirection = 0;
      }

      // Turn speed: angular velocity in rad/sec, computed from frame-to-frame rotation delta
      let turnSpeed = 0;
      if (dt > 0) {
        let rotDiff = entity.mesh.rotation.y - entity.prevRotationY;
        // Normalize to [-π, π]
        while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
        while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
        turnSpeed = rotDiff / dt;
      }
      entity.prevRotationY = entity.mesh.rotation.y;

      entity.model.update(dt, {
        isMoving: entity.isMoving,
        isGrounded: (dr?.vy ?? 0) === 0,
        velocityY: dr?.vy ?? 0,
        turnSpeed,
        speedMultiplier,
        strafeDirection,
      });
    }

    // Update fading-out entities
    for (const [id, fading] of this.fadingEntities) {
      fading.elapsed += dt;
      const t = fading.elapsed / ClientEngine.ENTITY_FADE_DURATION;
      if (t >= 1) {
        this.scene.remove(fading.mesh);
        this.fadingEntities.delete(id);
      } else {
        fading.model.setOpacity(1 - t);
      }
    }

    // Update gas cloud visuals
    for (const [id, cloud] of this.gasClouds) {
      cloud.elapsed += dt;
      if (updateGasCloud(cloud, cloud.elapsed, cloud.duration, dt)) {
        disposeGroup(this.scene, cloud.group);
        this.gasClouds.delete(id);
      }
    }

    // Update chem pool visuals
    for (const [id, pool] of this.chemPools) {
      pool.elapsed += dt;
      if (pool.consumed) pool.consumeElapsed += dt;
      if (updateChemPool(pool, pool.elapsed, pool.duration, pool.activationDelay, pool.consumed, pool.consumeElapsed, dt)) {
        disposeGroup(this.scene, pool.group);
        this.chemPools.delete(id);
      }
    }

    // Update sweep charge (local player movement during charge)
    this.updateSweepCharge(dt);
    this.updateTweakerSprintCharge(dt);

    // Update knockbacks (visual displacement)
    this.updateKnockbacks(dt);

    // Update channel beam visual
    this.updateChannelBeam(dt);

    // Update Full Retard aura visuals
    this.updateFullRetardAuras(dt);

    // Update Crotch Rot cloud visuals
    this.updateCrotchRotVisuals(dt);

    // Tab targeting — nearest hostile in front within 30 yards (blocked while blinded)
    const tabDown = this.input.isBindDown(keybindManager.getCode('target_nearest_enemy'));
    if (tabDown && !this.tabKeyWasDown && !this.blindEffect.isActive()) {
      const hostiles = this.getAllRemoteEntities().filter(e => !this.isEntityInvisibleToLocal(e.id)).map(e => e.targetable);
      this.targetingSystem.selectNearestHostileInFront(hostiles, yardsToUnits(30));
      const newTargetId = this.findEntityIdByTargetable(this.targetingSystem.currentTarget);
      if (newTargetId !== this.selectedTargetId) {
        this.selectedTargetId = newTargetId;
        this.sendSetTarget(newTargetId);
        this.onTargetChanged?.(newTargetId);
      }
    }
    this.tabKeyWasDown = tabDown;

    // Target of target key
    const fDown = this.input.isBindDown(keybindManager.getCode('target_of_target'));
    if (fDown && !this.fKeyWasDown && this.selectedTargetId) {
      const isSelf = this.selectedTargetId === this.localEntityId;
      const totId = isSelf
        ? this.selectedTargetId
        : this.getRemoteEntity(this.selectedTargetId)?.targetEntityId ?? null;
      if (totId && totId !== this.selectedTargetId && !this.isEntityInvisibleToLocal(totId)) {
        const totTargetable = totId === this.localEntityId
          ? (this.playerController as unknown as Targetable)
          : this.getRemoteEntity(totId)?.targetable ?? null;
        if (totTargetable) {
          this.targetingSystem.currentTarget = totTargetable;
          this.selectedTargetId = totId;
          this.sendSetTarget(totId);
          this.onTargetChanged?.(totId);
        }
      }
    }
    this.fKeyWasDown = fDown;

    // Process left click for target selection
    const leftClick = this.input.getLeftClick();
    if (leftClick) {
      if (this.targetingSystem.groundTargetActive) {
        if (!this.targetingSystem.groundTargetBlocked) {
          this.onGroundTargetConfirmed?.();
        }
      } else if (!this.input.isMouseButtonDown('right')) {
        // Only process target selection on normal left clicks — not while
        // right-click drag (pointer lock) is active, to avoid accidentally
        // clearing the current target.
        this.targetingSystem.processClick(leftClick.x, leftClick.y);
        const newTargetId = this.findEntityIdByTargetable(this.targetingSystem.currentTarget);
        if (newTargetId !== this.selectedTargetId) {
          this.selectedTargetId = newTargetId;
          this.sendSetTarget(newTargetId);
          this.onTargetChanged?.(newTargetId);
        }
      }
    }

    // Process right click for auto-attack
    const rightClick = this.input.getRightClick();
    if (rightClick) {
      const target = this.targetingSystem.processRightClick(rightClick.x, rightClick.y);
      if (target) {
        const targetId = this.findEntityIdByTargetable(target);
        if (targetId && targetId !== this.selectedTargetId) {
          this.selectedTargetId = targetId;
          this.sendSetTarget(targetId);
          this.onTargetChanged?.(targetId);
        }
        if (targetId && target.isHostileTo(this.playerController) && !target.dead) {
          if (this.resting) this.stopResting();
          this.sendAutoAttack(targetId);
        }
      }
    }

    // Update cursor for hover detection (only when pointer is unlocked)
    this.targetingSystem.updateHoverCursor(this.input.getMouseScreenPos(), this.input.isMouseButtonDown('right'));

    // Update targeting ring animation + target highlight
    this.targetingSystem.update(dt);

    // Consume input deltas so they don't accumulate
    this.input.resetDeltas();
  }

  private static readonly POSITION_EPSILON = 0.001;
  private static readonly ROTATION_EPSILON = 0.001;

  private sendPositionUpdate(): void {
    const pos = this.playerController.getPosition();
    const rotationY = this.playerController.mesh.rotation.y;
    const isMoving = this.playerController.isMoving ?? false;
    const prev = this.lastSentPosition;

    // Skip sending if nothing changed
    if (
      Math.abs(prev.x - pos.x) < ClientEngine.POSITION_EPSILON
      && Math.abs(prev.y - pos.y) < ClientEngine.POSITION_EPSILON
      && Math.abs(prev.z - pos.z) < ClientEngine.POSITION_EPSILON
      && Math.abs(prev.rotationY - rotationY) < ClientEngine.ROTATION_EPSILON
      && prev.isMoving === isMoving
    ) {
      return;
    }

    // Compute horizontal velocity from position delta between sends
    const now = performance.now();
    let vx = 0;
    let vz = 0;
    if (this.prevSendTime > 0) {
      const dtSec = (now - this.prevSendTime) / 1000;
      if (dtSec > 0) {
        vx = (pos.x - this.prevSendPosition.x) / dtSec;
        vz = (pos.z - this.prevSendPosition.z) / dtSec;
      }
    }
    this.prevSendPosition.x = pos.x;
    this.prevSendPosition.y = pos.y;
    this.prevSendPosition.z = pos.z;
    this.prevSendTime = now;

    prev.x = pos.x;
    prev.y = pos.y;
    prev.z = pos.z;
    prev.rotationY = rotationY;
    prev.isMoving = isMoving;

    this.network.send({
      type: 'player_state',
      x: pos.x,
      y: pos.y,
      z: pos.z,
      rotationY,
      isMoving,
      vx,
      vz,
      moveFlags: this.playerController.moveFlags,
      moveSpeed: this.playerController.currentMoveSpeed,
      vy: this.playerController.velocityY,
      turnSpeed: this.playerController.turnSpeed,
    });
  }

  // ── Sweep charge ──────────────────────────────────────────────────────

  private startSweepCharge(): void {
    const rotY = this.playerController.mesh.rotation.y;
    this.playerController.charging = true;
    const savedAutoAttackTargetId = this.selectedTargetId;
    this.sendStopAutoAttack();
    this.sweepCharge = {
      elapsed: 0,
      duration: Sweep.chargeDuration!,
      direction: new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY)),
      speed: Sweep.chargeSpeed!,
      savedAutoAttackTargetId,
    };
  }

  private updateSweepCharge(dt: number): void {
    if (!this.sweepCharge) return;
    this.sweepCharge.elapsed += dt;
    // Move player forward (client-authoritative movement)
    this.playerController.mesh.position.addScaledVector(
      this.sweepCharge.direction, this.sweepCharge.speed * dt
    );
    if (this.sweepCharge.elapsed >= this.sweepCharge.duration) {
      // Re-engage auto-attack if we were auto-attacking before sweep
      const targetId = this.sweepCharge.savedAutoAttackTargetId;
      if (targetId) {
        this.sendAutoAttack(targetId);
      }

      this.playerController.charging = false;
      this.sweepCharge = null;
    }
  }

  // ── Tweaker Sprint charge ───────────────────────────────────────────

  private startTweakerSprintCharge(): void {
    // Dash toward the selected target
    const targetId = this.selectedTargetId;
    const targetMesh = targetId ? this.getEntityMesh(targetId) : null;
    if (!targetMesh) return;

    const dx = targetMesh.position.x - this.playerController.mesh.position.x;
    const dz = targetMesh.position.z - this.playerController.mesh.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01) return;

    const direction = new THREE.Vector3(dx / dist, 0, dz / dist);
    // Face the target
    this.playerController.mesh.rotation.y = Math.atan2(direction.x, direction.z);

    const speed = TweakerSprint.chargeSpeed!;
    const chargeDist = Math.max(0, dist - yardsToUnits(1)); // stop 1 yard short
    const duration = chargeDist / speed;

    const savedAutoAttackTargetId = this.selectedTargetId;
    this.sendStopAutoAttack();
    this.playerController.charging = true;
    this.playerController.chargeAnimSpeed = 3; // fast frantic run
    this.tweakerSprintCharge = {
      elapsed: 0,
      duration,
      direction,
      speed,
      savedAutoAttackTargetId,
    };
  }

  private updateTweakerSprintCharge(dt: number): void {
    if (!this.tweakerSprintCharge) return;
    this.tweakerSprintCharge.elapsed += dt;
    this.playerController.mesh.position.addScaledVector(
      this.tweakerSprintCharge.direction, this.tweakerSprintCharge.speed * dt
    );
    if (this.tweakerSprintCharge.elapsed >= this.tweakerSprintCharge.duration) {
      const targetId = this.tweakerSprintCharge.savedAutoAttackTargetId;
      if (targetId) {
        this.sendAutoAttack(targetId);
      }

      this.playerController.charging = false;
      this.playerController.chargeAnimSpeed = 1;
      this.tweakerSprintCharge = null;
    }
  }

  // ── Channel beam visual ─────────────────────────────────────────────

  private updateChannelBeam(dt: number): void {
    // Find any entity that is channeling and has a target
    let casterPos: THREE.Vector3 | null = null;
    let targetPos: THREE.Vector3 | null = null;

    // Check local player — use server-authoritative target, not current UI selection
    if (this.localCastingAbilityId && this.localCastingIsChannel && this.localTargetEntityId) {
      casterPos = this.playerController.mesh.position;
      const targetMesh = this.getEntityMesh(this.localTargetEntityId);
      if (targetMesh) targetPos = targetMesh.position;
    }

    // Check remote entities (find first channeling remote)
    if (!casterPos) {
      for (const entity of this.remoteEntities.values()) {
        if (entity.castingAbilityId && entity.castingIsChannel && entity.targetEntityId) {
          casterPos = entity.mesh.position;
          const targetMesh = this.getEntityMesh(entity.targetEntityId);
          if (targetMesh) targetPos = targetMesh.position;
          break;
        }
      }
    }

    if (!casterPos || !targetPos) {
      if (this.channelBeam) {
        removeChannelBeam(this.scene, this.channelBeam);
        this.channelBeam = null;
      }
      this.channelBeamElapsed = 0;
      return;
    }

    this.channelBeamElapsed += dt;
    if (!this.channelBeam) {
      this.channelBeam = createChannelBeam(this.scene);
    }
    updateChannelBeamVisual(this.channelBeam, casterPos, targetPos, this.channelBeamElapsed);
  }

  // ── Full Retard aura visuals ────────────────────────────────────────

  private updateFullRetardAuras(dt: number): void {
    // Check all entities (local + remote) for full-retard buff
    const activeIds = new Set<string>();

    // Local player
    if (this.localBuffs.some(b => b.id === 'full-retard')) {
      activeIds.add(this.localEntityId);
      if (!this.fullRetardAuras.has(this.localEntityId)) {
        const pos = this.playerController.mesh.position;
        const visual = createFullRetardAura(this.scene, pos.x, pos.z, this.playerController.autoAttackRange);
        this.fullRetardAuras.set(this.localEntityId, { ...visual, elapsed: 0 });
      }
    }

    // Remote entities
    for (const entity of this.remoteEntities.values()) {
      if (entity.buffs.some(b => b.id === 'full-retard')) {
        activeIds.add(entity.id);
        if (!this.fullRetardAuras.has(entity.id)) {
          const visual = createFullRetardAura(this.scene, entity.mesh.position.x, entity.mesh.position.z, 1.5);
          this.fullRetardAuras.set(entity.id, { ...visual, elapsed: 0 });
        }
      }
    }

    // Update existing auras
    for (const [entityId, aura] of this.fullRetardAuras) {
      if (!activeIds.has(entityId)) {
        disposeGroup(this.scene, aura.group);
        this.fullRetardAuras.delete(entityId);
        continue;
      }

      aura.elapsed += dt;
      const mesh = this.getEntityMesh(entityId);
      const followX = mesh ? mesh.position.x : aura.group.position.x;
      const followZ = mesh ? mesh.position.z : aura.group.position.z;
      updateFullRetardAuraVisual(aura, aura.elapsed, dt, followX, followZ);
    }
  }

  // ── Crotch Rot cloud visuals ─────────────────────────────────────────

  private updateCrotchRotVisuals(dt: number): void {
    const activeIds = new Set<string>();

    // Local player
    if (this.localBuffs.some(b => b.id === 'crotch-rot')) {
      activeIds.add(this.localEntityId);
      if (!this.crotchRotVisuals.has(this.localEntityId)) {
        const visual = createCrotchRotCloud();
        this.playerController.mesh.add(visual.group);
        this.crotchRotVisuals.set(this.localEntityId, { ...visual, elapsed: 0 });
      }
    }

    // Remote entities
    for (const entity of this.remoteEntities.values()) {
      if (entity.buffs.some(b => b.id === 'crotch-rot')) {
        activeIds.add(entity.id);
        if (!this.crotchRotVisuals.has(entity.id)) {
          const visual = createCrotchRotCloud();
          entity.mesh.add(visual.group);
          this.crotchRotVisuals.set(entity.id, { ...visual, elapsed: 0 });
        }
      }
    }

    // Update existing visuals and remove expired ones
    for (const [entityId, visual] of this.crotchRotVisuals) {
      if (!activeIds.has(entityId)) {
        const mesh = this.getEntityMesh(entityId);
        if (mesh) mesh.remove(visual.group);
        visual.group.traverse(child => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            (child.material as THREE.Material).dispose();
          }
        });
        this.crotchRotVisuals.delete(entityId);
        continue;
      }

      visual.elapsed += dt;
      // Group is parented to entity mesh, so pass 0,0,0 for follow position
      updateCrotchRotCloud(visual, visual.elapsed, 0, 0, 0);
    }
  }

  destroy(): void {
    this.stop();
    this.blindEffect.deactivate();
    this.input.dispose();
    this.targetingSystem.dispose();
    this.mapManager.dispose();
    this.renderer.dispose();
    for (const cloud of this.gasClouds.values()) disposeGroup(this.scene, cloud.group);
    this.gasClouds.clear();
    for (const pool of this.chemPools.values()) disposeGroup(this.scene, pool.group);
    this.chemPools.clear();
    if (this.channelBeam) removeChannelBeam(this.scene, this.channelBeam);
    for (const aura of this.fullRetardAuras.values()) disposeGroup(this.scene, aura.group);
    this.fullRetardAuras.clear();
    for (const visual of this.crotchRotVisuals.values()) {
      visual.group.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
    }
    this.crotchRotVisuals.clear();
    for (const entity of this.remoteEntities.values()) this.scene.remove(entity.mesh);
    this.remoteEntities.clear();
    this.deadReckoning.clear();
    this.scene.remove(this.playerController.mesh);
  }
}
