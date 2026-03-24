import * as THREE from 'three';
import type { EntitySnapshot, EntityBuffSnapshot } from '@gtr/shared';
import type {
  S2C_GameState, S2C_GameStateUpdate, S2C_GameStateSnapshot,
  S2C_CombatEvent, S2C_Flinch, S2C_AbilityEffect, S2C_CooldownUpdate,
  S2C_GasCloudSpawn, S2C_ChemPoolSpawn, S2C_AutoAttackSwing,
} from '@gtr/shared';
import type { CharacterId } from '@gtr/shared';
import { yardsToUnits, getCharacterStats } from '@gtr/shared';
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
  type GasCloudVisual, type ChemPoolVisual, type FullRetardAuraVisual,
  POOL_CONSUME_DURATION,
  createGasCloud, updateGasCloud,
  createChemPool, updateChemPool,
  createFullRetardAura, updateFullRetardAura as updateFullRetardAuraVisual,
  createChannelBeam, updateChannelBeam as updateChannelBeamVisual, removeChannelBeam,
  disposeGroup,
} from '../engine/effects/VisualEffects';
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
  targetable: Targetable;
  targetEntityId: string | null;
  disconnected: boolean;
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

  private animationFrameId: number | null = null;
  private static readonly SEND_RATE = 1000 / 20; // 20 Hz
  private sendAccumulator = 0;
  private lastSentPosition = { x: NaN, y: NaN, z: NaN, rotationY: NaN, isMoving: false };

  // Visual effects
  private gasClouds = new Map<string, GasCloudVisual & { elapsed: number; duration: number }>();
  private chemPools = new Map<string, ChemPoolVisual & {
    elapsed: number; duration: number;
    activationDelay: number; consumed: boolean; consumeElapsed: number;
  }>();

  // Cooldowns (local tracking from server updates)
  private cooldowns = new Map<string, { remaining: number; total: number }>();

  // Local entity casting state (from server snapshots)
  private localCastingAbilityId: string | null = null;
  private localCastingElapsed = 0;
  private localCastingTotalTime = 0;
  private localCastingIsChannel = false;
  private localTargetEntityId: string | null = null;

  // Local entity buffs (from server snapshots)
  private localBuffs: EntityBuffSnapshot['buffs'] = [];

  // Sweep charge (local player only — client-side movement during charge)
  private sweepCharge: { elapsed: number; duration: number; direction: THREE.Vector3; speed: number } | null = null;

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

    // Set the correct character and team for the local player
    if (localSnap) {
      this.playerController.setCharacter(localSnap.characterId as CharacterId);
      (this.playerController as any).team = localSnap.team;
      (this.playerController as any).name = localSnap.name;
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
      targetable: null!, // Set below
      targetEntityId: snap.targetEntityId,
      disconnected: snap.disconnected ?? false,
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
        const ability = stats.abilities.find(a => a.id === entity.castingAbilityId);
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
    // the buffer needs continuous timestamps for adaptive delay & interpolation.
    this.snapshotBuffer.pushPositions(msg.tick, msg.timestamp, msg.positions);

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
      case 'entity_died': break; // handled via game state (dead flag)
    }
  }

  /** Handle full keyframe snapshot — resets all state. */
  handleGameStateSnapshot(msg: S2C_GameStateSnapshot): void {
    // Load full state into the snapshot buffer
    this.snapshotBuffer.loadKeyframe(msg.entities, msg.buffs, msg.gasClouds, msg.chemicalPools);
    this.snapshotBuffer.pushPositions(msg.tick, msg.timestamp, msg.entities.map(e => ({
      id: e.id, x: e.x, y: e.y, z: e.z, rotationY: e.rotationY, isMoving: e.isMoving,
    })));

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

    // Sync arena countdown timer from server keyframe
    if (msg.arenaTimeRemaining !== undefined && msg.arenaTimeRemaining > 0) {
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
          if (delta.dead && !pc.dead) pc.die();
          else if (!delta.dead && pc.dead) pc.respawn();
          pc.dead = delta.dead;
        }
        if (delta.inCombat !== undefined) {
          if (delta.inCombat && !pc.inCombat) this.onEnterCombat?.(delta.id);
          else if (!delta.inCombat && pc.inCombat) this.onLeaveCombat?.(delta.id);
          pc.inCombat = delta.inCombat;
        }
        if (delta.stunned !== undefined) { pc.stunned = delta.stunned; pc.setStunned(delta.stunned); }
        if (delta.charging !== undefined) pc.charging = delta.charging;
        if (delta.isAutoAttacking !== undefined) pc.setAutoAttacking(delta.isAutoAttacking);
        if ('castingAbilityId' in delta) this.localCastingAbilityId = delta.castingAbilityId!;
        if (delta.castingElapsed !== undefined) this.localCastingElapsed = delta.castingElapsed;
        if (delta.castingTotalTime !== undefined) this.localCastingTotalTime = delta.castingTotalTime;
        if (delta.castingIsChannel !== undefined) this.localCastingIsChannel = delta.castingIsChannel;
        if ('targetEntityId' in delta) this.localTargetEntityId = delta.targetEntityId!;
        continue;
      }

      const entity = this.remoteEntities.get(delta.id);
      if (!entity) continue;

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
        this.playerController.setDiscombobulated(this.localBuffs.some(b => b.id === 'discombobulate'));
        continue;
      }
      const entity = this.remoteEntities.get(buffSnap.entityId);
      if (entity) {
        entity.buffs = buffSnap.buffs;
        const hasBuff = (id: string) => buffSnap.buffs.some(b => b.id === id);
        entity.model.setAbilityBuffActive('crash-out', hasBuff('crash-out'));
        entity.model.setAbilityBuffActive('retard-strength', hasBuff('retard-strength'));
        entity.model.setAbilityBuffActive('full-retard', hasBuff('full-retard'));
        entity.model.setResting(hasBuff('resting'));
      }
    }
  }

  handleCombatEvent(msg: S2C_CombatEvent): void {
    this.onCombatText?.(msg.sourceEntityId, msg.targetEntityId, msg.amount, msg.combatType);

    // Auto-target attacker when player has no target
    if (msg.targetEntityId === this.localEntityId && !this.selectedTargetId && msg.combatType !== 'heal') {
      const attacker = this.remoteEntities.get(msg.sourceEntityId);
      if (attacker) {
        this.selectTarget(attacker.targetable);
      }
    }
  }

  handleAbilityEffect(msg: S2C_AbilityEffect): void {
    // Ground-targeted abilities use the ground position for the projectile animation
    const groundPos = msg.groundTargetX !== undefined && msg.groundTargetZ !== undefined
      ? new THREE.Vector3(msg.groundTargetX, 0, msg.groundTargetZ)
      : undefined;

    if (msg.entityId === this.localEntityId) {
      const targetPos = groundPos ?? (this.selectedTargetId ? this.getEntityMesh(this.selectedTargetId)?.position.clone() : undefined);
      this.playerController.triggerAbilityAnimation(msg.abilityId, targetPos);
      // Start sweep charge for local player
      if (msg.abilityId === 'sweep') {
        this.startSweepCharge();
      }
    } else {
      const entity = this.remoteEntities.get(msg.entityId);
      if (entity) {
        const targetPos = groundPos ?? (entity.targetEntityId ? this.getEntityMesh(entity.targetEntityId)?.position.clone() : undefined);
        entity.model.triggerAbilityAnimation(msg.abilityId, targetPos);
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
    this.cooldowns.set(msg.abilityId, { remaining: msg.remaining, total: msg.total });
    this.onCooldownUpdate?.(msg.abilityId, msg.remaining, msg.total);
  }

  handleGasCloudSpawn(msg: S2C_GasCloudSpawn): void {
    const visual = createGasCloud(this.scene, msg.x, msg.z, msg.radius);
    this.gasClouds.set(msg.id, { ...visual, elapsed: 0, duration: msg.duration });
  }

  handleChemPoolSpawn(msg: S2C_ChemPoolSpawn): void {
    const visual = createChemPool(this.scene, msg.x, msg.z, msg.radius);
    this.chemPools.set(msg.id, {
      ...visual, elapsed: 0, duration: msg.duration,
      activationDelay: msg.activationDelay, consumed: false, consumeElapsed: 0,
    });
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

  getLocalCastingState(): { abilityId: string; elapsed: number; totalTime: number; isChannel: boolean } | null {
    if (!this.localCastingAbilityId) return null;
    return {
      abilityId: this.localCastingAbilityId,
      elapsed: this.localCastingElapsed,
      totalTime: this.localCastingTotalTime,
      isChannel: this.localCastingIsChannel,
    };
  }

  getLocalBuffs(): EntityBuffSnapshot['buffs'] {
    return this.localBuffs;
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

  sendAbility(abilityId: string, targetEntityId: string | null, groundTarget?: { x: number; z: number }): void {
    const serverTimestamp = this.snapshotBuffer.getCurrentRenderServerTimestamp();
    this.network.send({
      type: 'use_ability',
      abilityId,
      targetEntityId,
      ...(groundTarget ? { groundTargetX: groundTarget.x, groundTargetZ: groundTarget.z } : {}),
      ...(serverTimestamp !== null ? { serverTimestamp } : {}),
    });
  }

  sendSetTarget(targetEntityId: string | null): void {
    this.network.send({ type: 'set_target', targetEntityId });
  }

  /** Programmatically select a target (e.g. from nameplate click). */
  selectTarget(target: Targetable | null): void {
    this.targetingSystem.currentTarget = target;
    const newTargetId = this.findEntityIdByTargetable(target);
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

    // Sweep charge — if we were mid-charge when backgrounded, it's certainly
    // finished by now.  Clear it so the player isn't stuck in a charge state.
    if (this.sweepCharge) {
      this.sweepCharge = null;
      this.playerController.charging = false;
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
    this.playerController.movementSpeedModifier = moveMult * (this.godMode ? 4 : 1);

    // Update local player using the real PlayerController (same as playground)
    this.playerController.update(dt);

    // Locally advance casting elapsed so animations run at render framerate (60fps)
    // instead of server tickrate (20fps). Server corrections (pushback, interrupt)
    // override via applyEntityStateDeltas / applyLocalEntityState.
    if (this.localCastingAbilityId) {
      this.localCastingElapsed += dt;
    }
    for (const entity of this.remoteEntities.values()) {
      if (entity.castingAbilityId) {
        entity.castingElapsed += dt;
      }
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

    // Send local position to server at tick rate
    this.sendAccumulator += dt * 1000;
    if (this.sendAccumulator >= ClientEngine.SEND_RATE) {
      this.sendAccumulator -= ClientEngine.SEND_RATE;
      this.sendPositionUpdate();
    }

    // Update cooldowns
    for (const [id, cd] of this.cooldowns) {
      cd.remaining = Math.max(0, cd.remaining - dt);
      if (cd.remaining <= 0) this.cooldowns.delete(id);
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

    // Interpolate remote entity positions using snapshot buffer
    // (linear interpolation between two known server states, ~100ms behind real-time)
    for (const entity of this.remoteEntities.values()) {
      const interp = this.snapshotBuffer.getInterpolatedPosition(entity.id);
      if (interp) {
        entity.isMoving = interp.isMoving;
        entity.mesh.position.set(interp.x, interp.y, interp.z);
        entity.mesh.rotation.y = interp.rotationY;
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

      entity.model.update(dt, {
        isMoving: entity.isMoving,
        isGrounded: true,
        velocityY: 0,
        turnSpeed: 0,
        speedMultiplier: 1,
        strafeDirection: 0,
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

    // Update channel beam visual
    this.updateChannelBeam(dt);

    // Update Full Retard aura visuals
    this.updateFullRetardAuras(dt);

    // Update map script (e.g., gate animations)
    this.mapManager.update(dt);

    // Tab targeting — nearest hostile in front within 30 yards
    const tabDown = this.input.isBindDown(keybindManager.getCode('target_nearest_enemy'));
    if (tabDown && !this.tabKeyWasDown) {
      const hostiles = this.getAllRemoteEntities().map(e => e.targetable);
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
      if (totId && totId !== this.selectedTargetId) {
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

    // Process left click for target selection (same as playground: InputManager captures on mousedown)
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

    // Process right click for auto-attack (same as playground: InputManager captures on mousedown)
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
    this.targetingSystem.updateHoverCursor(this.input.getMouseScreenPos(), this.input.getMouseScreenPosAlways());

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
    });
  }

  // ── Sweep charge ──────────────────────────────────────────────────────

  private startSweepCharge(): void {
    const rotY = this.playerController.mesh.rotation.y;
    this.playerController.charging = true;
    this.sendStopAutoAttack();
    this.sweepCharge = {
      elapsed: 0,
      duration: 1.0,
      direction: new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY)),
      speed: yardsToUnits(20),
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
      this.playerController.charging = false;
      this.sweepCharge = null;
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

  destroy(): void {
    this.stop();
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
    for (const entity of this.remoteEntities.values()) this.scene.remove(entity.mesh);
    this.remoteEntities.clear();
    this.scene.remove(this.playerController.mesh);
  }
}
