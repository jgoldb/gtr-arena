import type { EntitySnapshot, EntityBuffSnapshot, GasCloudSnapshot, ChemicalPoolSnapshot, CooldownSnapshot } from '@gtr/shared';
import type {
  S2C_GameStateUpdate, S2C_GameStateSnapshot,
  S2C_PositionUpdate,
  EntityPositionData, EntityStateDelta,
  ServerMessage,
} from '@gtr/shared';
import { getBuffDescription } from '@gtr/shared';
import type { ServerEntity } from './ServerEntity.js';
import type { ServerCombatSystem } from './ServerCombatSystem.js';
import type { ServerBuffSystem } from './ServerBuffSystem.js';
import type { ServerCastingSystem } from './ServerCastingSystem.js';
import type { GasCloudSystem, ChemicalPoolSystem } from '@gtr/shared';

export class ServerBroadcast {
  // Position tracking — only send when entity actually moved
  private lastBroadcastPosition = new Map<string, {
    x: number; y: number; z: number; rotationY: number; isMoving: boolean;
    vx: number; vz: number;
  }>();
  private static readonly POSITION_EPSILON = 0.001;
  private static readonly ROTATION_EPSILON = 0.001;

  // Delta tracking — previous broadcast state per entity
  private lastBroadcastState = new Map<string, {
    hp: number; maxHp: number; mana: number; maxMana: number;
    dead: boolean; inCombat: boolean; stunned: boolean; charging: boolean;
    isAutoAttacking: boolean;
    castingAbilityId: string | null; castingElapsed: number;
    castingTotalTime: number; castingIsChannel: boolean;
    targetEntityId: string | null;
    disconnected: boolean;
  }>();
  private lastBroadcastBuffs = new Map<string, string>(); // entityId -> buff signature
  // Track world effect IDs + consumed state to only send when actually changed
  private lastBroadcastGasCloudIds = '';
  private lastBroadcastChemPoolSig = '';

  private midTickCounter = 0;

  onBroadcast?: (msg: ServerMessage) => void;
  onBroadcastUnreliable?: (msg: ServerMessage) => void;

  removeEntity(entityId: string): void {
    this.lastBroadcastPosition.delete(entityId);
    this.lastBroadcastState.delete(entityId);
    this.lastBroadcastBuffs.delete(entityId);
  }

  broadcastMidTickPositions(tick: number, entities: readonly ServerEntity[]): void {
    if (!this.onBroadcastUnreliable) return;

    this.midTickCounter++;
    const positions: EntityPositionData[] = [];
    for (const e of entities) {
      if (!e.isMoving && e.turnSpeed === 0) continue;
      positions.push({
        id: e.id, x: e.x, y: e.y, z: e.z,
        rotationY: e.rotationY, isMoving: e.isMoving,
        vx: e.vx, vz: e.vz,
        moveFlags: e.moveFlags, moveSpeed: e.moveSpeed, vy: e.vy, turnSpeed: e.turnSpeed,
      });
    }

    if (positions.length === 0) return;

    const posMsg: S2C_PositionUpdate = {
      type: 'position_update',
      tick,
      timestamp: Date.now(),
      positions,
    };
    this.onBroadcastUnreliable(posMsg);
  }

  broadcastGameState(
    tick: number,
    keyframeInterval: number,
    serverTimestamp: number,
    entities: readonly ServerEntity[],
    pendingEvents: ServerMessage[],
    castingSystem: ServerCastingSystem,
    buffSystem: ServerBuffSystem,
    combatSystem: ServerCombatSystem,
    gasCloudSystem: GasCloudSystem<ServerEntity>,
    chemPoolSystem: ChemicalPoolSystem<ServerEntity>,
    targets: Map<string, string | null>,
  ): void {
    const isKeyframe = tick % keyframeInterval === 0;

    if (isKeyframe) {
      this.broadcastKeyframe(tick, serverTimestamp, entities, castingSystem, buffSystem, gasCloudSystem, chemPoolSystem, targets);
      // On keyframe ticks, flush events separately (keyframe msg type has no events field)
      for (const event of pendingEvents) {
        this.onBroadcast?.(event);
      }
    } else {
      this.broadcastDelta(tick, serverTimestamp, entities, pendingEvents, castingSystem, buffSystem, gasCloudSystem, chemPoolSystem, targets);
    }
  }

  /** Full keyframe — sent periodically and used by clients to reset state. */
  private broadcastKeyframe(
    tick: number,
    serverTimestamp: number,
    entities: readonly ServerEntity[],
    castingSystem: ServerCastingSystem,
    buffSystem: ServerBuffSystem,
    gasCloudSystem: GasCloudSystem<ServerEntity>,
    chemPoolSystem: ChemicalPoolSystem<ServerEntity>,
    targets: Map<string, string | null>,
  ): void {
    const snapshots: EntitySnapshot[] = entities.map(e => {
      const snapshot = e.toSnapshot();
      const casting = castingSystem.getState(e);
      if (casting) {
        snapshot.castingAbilityId = casting.ability.id;
        snapshot.castingElapsed = casting.elapsed;
        snapshot.castingTotalTime = casting.totalTime;
        snapshot.castingIsChannel = casting.isChannel;
      }
      // While channeling, lock targetEntityId to the channel target so the
      // beam doesn't follow UI re-targets.
      snapshot.targetEntityId = (casting?.isChannel && casting.target)
        ? casting.target.id
        : (targets.get(e.id) ?? null);
      return snapshot;
    });

    const buffs = this.buildBuffSnapshots(entities, buffSystem);
    const gasClouds = ServerBroadcast.buildGasCloudSnapshots(gasCloudSystem);
    const chemicalPools = ServerBroadcast.buildChemPoolSnapshots(chemPoolSystem);

    const msg: S2C_GameStateSnapshot = {
      type: 'game_state_snapshot',
      tick,
      timestamp: serverTimestamp,
      entities: snapshots,
      buffs,
      gasClouds,
      chemicalPools,
    };

    this.onBroadcast?.(msg);

    // Update last-broadcast tracking to match keyframe
    for (const e of snapshots) {
      this.lastBroadcastState.set(e.id, {
        hp: e.hp, maxHp: e.maxHp, mana: e.mana, maxMana: e.maxMana,
        dead: e.dead, inCombat: e.inCombat, stunned: e.stunned, charging: e.charging,
        isAutoAttacking: e.isAutoAttacking,
        castingAbilityId: e.castingAbilityId, castingElapsed: e.castingElapsed,
        castingTotalTime: e.castingTotalTime, castingIsChannel: e.castingIsChannel,
        targetEntityId: e.targetEntityId,
        disconnected: e.disconnected ?? false,
      });
    }
    for (const b of buffs) {
      this.lastBroadcastBuffs.set(b.entityId, b.buffs.map(buf => `${buf.id}:${buf.shieldRemaining ?? ''}`).join(','));
    }
    this.lastBroadcastGasCloudIds = gasClouds.map(gc => gc.id).join(',');
    this.lastBroadcastChemPoolSig = chemicalPools.map(cp => `${cp.id}:${cp.consumed}`).join(',');
  }

  /** Delta update — positions always, state/buffs only when changed. */
  private broadcastDelta(
    tick: number,
    serverTimestamp: number,
    entities: readonly ServerEntity[],
    pendingEvents: ServerMessage[],
    castingSystem: ServerCastingSystem,
    buffSystem: ServerBuffSystem,
    gasCloudSystem: GasCloudSystem<ServerEntity>,
    chemPoolSystem: ChemicalPoolSystem<ServerEntity>,
    targets: Map<string, string | null>,
  ): void {
    // Positions: only include entities whose position/rotation actually changed
    const positions: EntityPositionData[] = [];
    for (const e of entities) {
      const prev = this.lastBroadcastPosition.get(e.id);
      if (!prev
        || Math.abs(prev.x - e.x) > ServerBroadcast.POSITION_EPSILON
        || Math.abs(prev.y - e.y) > ServerBroadcast.POSITION_EPSILON
        || Math.abs(prev.z - e.z) > ServerBroadcast.POSITION_EPSILON
        || Math.abs(prev.rotationY - e.rotationY) > ServerBroadcast.ROTATION_EPSILON
        || prev.isMoving !== e.isMoving
      ) {
        positions.push({
          id: e.id, x: e.x, y: e.y, z: e.z,
          rotationY: e.rotationY, isMoving: e.isMoving,
          vx: e.vx, vz: e.vz,
          moveFlags: e.moveFlags, moveSpeed: e.moveSpeed, vy: e.vy, turnSpeed: e.turnSpeed,
        });
        this.lastBroadcastPosition.set(e.id, {
          x: e.x, y: e.y, z: e.z,
          rotationY: e.rotationY, isMoving: e.isMoving,
          vx: e.vx, vz: e.vz,
        });
      }
    }

    // State deltas: only entities whose combat/status state changed
    const states: EntityStateDelta[] = [];
    for (const e of entities) {
      const casting = castingSystem.getState(e);
      const castingAbilityId = casting?.ability.id ?? null;
      const castingElapsed = casting?.elapsed ?? 0;
      const castingTotalTime = casting?.totalTime ?? 0;
      const castingIsChannel = casting?.isChannel ?? false;
      // Lock to channel target while channeling (same as keyframe)
      const targetEntityId = (casting?.isChannel && casting?.target)
        ? casting.target.id
        : (targets.get(e.id) ?? null);

      const prev = this.lastBroadcastState.get(e.id);
      if (!prev) {
        // First time seeing this entity — send full state
        const delta: EntityStateDelta = {
          id: e.id,
          hp: e.hp, maxHp: e.maxHp, mana: e.mana, maxMana: e.maxMana,
          dead: e.dead, inCombat: e.inCombat, stunned: e.stunned, charging: e.charging,
          isAutoAttacking: e.isAutoAttacking,
          castingAbilityId, castingElapsed, castingTotalTime, castingIsChannel,
          targetEntityId,
          disconnected: e.disconnected,
        };
        states.push(delta);
        this.lastBroadcastState.set(e.id, {
          hp: e.hp, maxHp: e.maxHp, mana: e.mana, maxMana: e.maxMana,
          dead: e.dead, inCombat: e.inCombat, stunned: e.stunned, charging: e.charging,
          isAutoAttacking: e.isAutoAttacking,
          castingAbilityId, castingElapsed, castingTotalTime, castingIsChannel,
          targetEntityId,
          disconnected: e.disconnected,
        });
        continue;
      }

      // Build delta of only changed fields
      const delta: EntityStateDelta = { id: e.id };
      let hasChanges = false;

      if (prev.hp !== e.hp) { delta.hp = e.hp; prev.hp = e.hp; hasChanges = true; }
      if (prev.maxHp !== e.maxHp) { delta.maxHp = e.maxHp; prev.maxHp = e.maxHp; hasChanges = true; }
      if (prev.mana !== e.mana) { delta.mana = e.mana; prev.mana = e.mana; hasChanges = true; }
      if (prev.maxMana !== e.maxMana) { delta.maxMana = e.maxMana; prev.maxMana = e.maxMana; hasChanges = true; }
      if (prev.dead !== e.dead) { delta.dead = e.dead; prev.dead = e.dead; hasChanges = true; }
      if (prev.inCombat !== e.inCombat) { delta.inCombat = e.inCombat; prev.inCombat = e.inCombat; hasChanges = true; }
      if (prev.stunned !== e.stunned) { delta.stunned = e.stunned; prev.stunned = e.stunned; hasChanges = true; }
      if (prev.charging !== e.charging) { delta.charging = e.charging; prev.charging = e.charging; hasChanges = true; }
      if (prev.isAutoAttacking !== e.isAutoAttacking) { delta.isAutoAttacking = e.isAutoAttacking; prev.isAutoAttacking = e.isAutoAttacking; hasChanges = true; }
      if (prev.castingAbilityId !== castingAbilityId) { delta.castingAbilityId = castingAbilityId; prev.castingAbilityId = castingAbilityId; hasChanges = true; }
      // Only send castingElapsed on significant events (cast start, pushback, interrupt),
      // not every tick. Clients advance it locally at 60fps for smooth animation.
      // Detect significant change: abilityId changed OR totalTime changed (pushback) OR elapsed reset
      const castingEvent = prev.castingAbilityId !== castingAbilityId
        || prev.castingTotalTime !== castingTotalTime
        || (castingElapsed < prev.castingElapsed && castingAbilityId !== null);
      if (castingEvent && prev.castingElapsed !== castingElapsed) { delta.castingElapsed = castingElapsed; hasChanges = true; }
      prev.castingElapsed = castingElapsed;
      if (prev.castingTotalTime !== castingTotalTime) { delta.castingTotalTime = castingTotalTime; prev.castingTotalTime = castingTotalTime; hasChanges = true; }
      if (prev.castingIsChannel !== castingIsChannel) { delta.castingIsChannel = castingIsChannel; prev.castingIsChannel = castingIsChannel; hasChanges = true; }
      if (prev.targetEntityId !== targetEntityId) { delta.targetEntityId = targetEntityId; prev.targetEntityId = targetEntityId; hasChanges = true; }
      if (prev.disconnected !== e.disconnected) { delta.disconnected = e.disconnected; prev.disconnected = e.disconnected; hasChanges = true; }

      if (hasChanges) states.push(delta);
    }

    // Buffs: only include entities whose buff list changed in a meaningful way.
    // Use a lightweight signature (buff ids + shield values + remaining rounded up)
    // instead of JSON.stringify. Remaining is rounded to avoid sending every tick,
    // but still detects duration refreshes (e.g. 0.3s → 8s).
    const allBuffs = this.buildBuffSnapshots(entities, buffSystem);
    const changedBuffs: EntityBuffSnapshot[] = [];
    for (const b of allBuffs) {
      const drSig = b.drTimers ? b.drTimers.map(dr => `dr:${dr.category}:${dr.count}:${Math.ceil(dr.remaining)}`).join(',') : '';
      const sig = b.buffs.map(buf => `${buf.id}:${buf.shieldRemaining ?? ''}:${Math.ceil(buf.remaining)}`).join(',') + '|' + drSig;
      const prevSig = this.lastBroadcastBuffs.get(b.entityId);
      if (sig !== prevSig) {
        changedBuffs.push(b);
        this.lastBroadcastBuffs.set(b.entityId, sig);
      }
    }

    // World effects: only include when the set of active effects actually changed
    // (spawn/despawn/consumed state change), not every tick while they exist
    const gasClouds = ServerBroadcast.buildGasCloudSnapshots(gasCloudSystem);
    const chemPools = ServerBroadcast.buildChemPoolSnapshots(chemPoolSystem);
    const gasIdSig = gasClouds.map(gc => gc.id).join(',');
    const chemSig = chemPools.map(cp => `${cp.id}:${cp.consumed}`).join(',');
    const gasChanged = gasIdSig !== this.lastBroadcastGasCloudIds;
    const chemChanged = chemSig !== this.lastBroadcastChemPoolSig;
    if (gasChanged) this.lastBroadcastGasCloudIds = gasIdSig;
    if (chemChanged) this.lastBroadcastChemPoolSig = chemSig;

    // Always send at least a heartbeat so clients keep their interpolation
    // buffer calibrated — skipping ticks causes jitter spikes in the adaptive delay.
    const hasStates = states.length > 0;
    const hasBuffs = changedBuffs.length > 0;
    const hasEvents = pendingEvents.length > 0;

    // ── Unreliable channel: positions only ──
    // Sent via WebRTC DataChannel to bypass TCP head-of-line blocking.
    // If unreliable callback isn't wired, positions are included in the reliable msg below.
    if (this.onBroadcastUnreliable) {
      const posMsg: S2C_PositionUpdate = {
        type: 'position_update',
        tick,
        timestamp: serverTimestamp,
        positions,
      };
      this.onBroadcastUnreliable(posMsg);
    }

    // ── Reliable channel: state deltas, buffs, events ──
    // Positions are always included for clients without a DataChannel (fallback)
    // and for the snapshot buffer's tick/timestamp calibration. Clients with a DC
    // get positions twice — unreliable arrives first, reliable is a harmless no-op.
    const msg: S2C_GameStateUpdate = {
      type: 'game_state_update',
      tick,
      timestamp: serverTimestamp,
      positions,
    };

    if (hasStates) msg.states = states;
    if (hasBuffs) msg.buffs = changedBuffs;
    if (gasChanged) msg.gasClouds = gasClouds;
    if (chemChanged) msg.chemicalPools = chemPools;
    if (hasEvents) msg.events = pendingEvents as S2C_GameStateUpdate['events'];

    this.onBroadcast?.(msg);
  }

  buildBuffSnapshots(entities: readonly ServerEntity[], buffSystem: ServerBuffSystem): EntityBuffSnapshot[] {
    return entities.map(e => {
      const drTimers = buffSystem.getDRTimers(e);
      return {
        entityId: e.id,
        buffs: buffSystem.getAllBuffs(e).map(b => ({
          id: b.definition.id,
          name: b.definition.name,
          icon: b.definition.icon,
          type: b.definition.type,
          remaining: b.remaining,
          duration: b.definition.duration,
          description: getBuffDescription(b.definition, b.stacks),
          shieldRemaining: b.shieldRemaining,
          effects: b.definition.effects.length > 0 ? b.definition.effects : undefined,
          unremovable: b.definition.unremovable || undefined,
          stacks: b.stacks,
          maxStacks: b.definition.maxStacks,
        })),
        drTimers: drTimers.length > 0 ? drTimers : undefined,
      };
    });
  }

  static buildGasCloudSnapshots(gasCloudSystem: GasCloudSystem<ServerEntity>): GasCloudSnapshot[] {
    return gasCloudSystem.clouds.map(gc => ({
      id: gc.id,
      x: gc.centerX, y: gc.centerY, z: gc.centerZ,
      radius: gc.radius, elapsed: gc.elapsed, duration: gc.duration,
    }));
  }

  static buildChemPoolSnapshots(chemPoolSystem: ChemicalPoolSystem<ServerEntity>): ChemicalPoolSnapshot[] {
    return chemPoolSystem.pools.map(cp => ({
      id: cp.id,
      x: cp.centerX, y: cp.centerY, z: cp.centerZ,
      radius: cp.radius, elapsed: cp.elapsed, duration: cp.duration,
      activationDelay: cp.activationDelay, consumed: cp.consumed,
    }));
  }

  getFullState(
    entities: readonly ServerEntity[],
    buffSystem: ServerBuffSystem,
    combatSystem: ServerCombatSystem,
    gasCloudSystem: GasCloudSystem<ServerEntity>,
    chemPoolSystem: ChemicalPoolSystem<ServerEntity>,
  ): { buffs: EntityBuffSnapshot[]; gasClouds: GasCloudSnapshot[]; chemicalPools: ChemicalPoolSnapshot[]; cooldowns: CooldownSnapshot[] } {
    return {
      buffs: this.buildBuffSnapshots(entities, buffSystem),
      gasClouds: ServerBroadcast.buildGasCloudSnapshots(gasCloudSystem),
      chemicalPools: ServerBroadcast.buildChemPoolSnapshots(chemPoolSystem),
      cooldowns: combatSystem.getAllCooldowns(),
    };
  }
}
