import type { EntitySnapshot, EntityBuffSnapshot, GasCloudSnapshot, ChemicalPoolSnapshot } from '@gtr/shared';
import type { EntityPositionData, EntityStateDelta } from '@gtr/shared';

/**
 * Snapshot interpolation buffer for smooth remote entity rendering.
 *
 * Instead of lerping toward the latest server position (exponential chase),
 * this stores timestamped snapshots and linearly interpolates between two
 * known states. The client renders INTERP_DELAY_MS behind real-time so
 * there are always two snapshots to interpolate between.
 *
 * This is the same technique WoW and most MMOs use for remote entity movement.
 */

interface BufferedSnapshot {
  tick: number;
  serverTimestamp: number;
  receiveTime: number; // performance.now() when received
  positions: Map<string, EntityPositionData>;
}

export interface InterpolatedPosition {
  x: number;
  y: number;
  z: number;
  rotationY: number;
  isMoving: boolean;
}

export class SnapshotBuffer {
  private snapshots: BufferedSnapshot[] = [];
  private static readonly MAX_BUFFER_SIZE = 30; // ~1.5s at 20Hz
  private static readonly INTERP_DELAY_MS = 100; // render 2 ticks behind

  // Full entity state maintained incrementally from server deltas
  private entityStates = new Map<string, EntitySnapshot>();
  private entityBuffs = new Map<string, EntityBuffSnapshot>();
  private gasClouds: GasCloudSnapshot[] = [];
  private chemicalPools: ChemicalPoolSnapshot[] = [];

  /**
   * Push a position update from a game_state_update message.
   */
  pushPositions(tick: number, serverTimestamp: number, positions: EntityPositionData[]): void {
    const posMap = new Map<string, EntityPositionData>();
    for (const p of positions) {
      posMap.set(p.id, p);
    }

    this.snapshots.push({
      tick,
      serverTimestamp,
      receiveTime: performance.now(),
      positions: posMap,
    });

    // Trim old snapshots
    while (this.snapshots.length > SnapshotBuffer.MAX_BUFFER_SIZE) {
      this.snapshots.shift();
    }
  }

  /**
   * Apply partial state deltas from the server (only changed fields).
   */
  applyStateDeltas(deltas: EntityStateDelta[]): void {
    for (const delta of deltas) {
      let state = this.entityStates.get(delta.id);
      if (!state) continue; // Entity not yet known — wait for keyframe

      // Apply only the fields that are present in the delta
      if (delta.hp !== undefined) state.hp = delta.hp;
      if (delta.maxHp !== undefined) state.maxHp = delta.maxHp;
      if (delta.mana !== undefined) state.mana = delta.mana;
      if (delta.maxMana !== undefined) state.maxMana = delta.maxMana;
      if (delta.dead !== undefined) state.dead = delta.dead;
      if (delta.inCombat !== undefined) state.inCombat = delta.inCombat;
      if (delta.stunned !== undefined) state.stunned = delta.stunned;
      if (delta.charging !== undefined) state.charging = delta.charging;
      if (delta.isAutoAttacking !== undefined) state.isAutoAttacking = delta.isAutoAttacking;
      if ('castingAbilityId' in delta) state.castingAbilityId = delta.castingAbilityId!;
      if (delta.castingElapsed !== undefined) state.castingElapsed = delta.castingElapsed;
      if (delta.castingTotalTime !== undefined) state.castingTotalTime = delta.castingTotalTime;
      if (delta.castingIsChannel !== undefined) state.castingIsChannel = delta.castingIsChannel;
      if ('targetEntityId' in delta) state.targetEntityId = delta.targetEntityId!;
    }
  }

  /**
   * Apply buff updates (only for entities whose buffs changed).
   */
  applyBuffUpdates(buffs: EntityBuffSnapshot[]): void {
    for (const b of buffs) {
      this.entityBuffs.set(b.entityId, b);
    }
  }

  /**
   * Update world effect snapshots.
   */
  updateWorldEffects(gasClouds?: GasCloudSnapshot[], chemPools?: ChemicalPoolSnapshot[]): void {
    if (gasClouds !== undefined) this.gasClouds = gasClouds;
    if (chemPools !== undefined) this.chemicalPools = chemPools;
  }

  /**
   * Load a full keyframe snapshot — resets all state.
   */
  loadKeyframe(entities: EntitySnapshot[], buffs: EntityBuffSnapshot[],
               gasClouds: GasCloudSnapshot[], chemPools: ChemicalPoolSnapshot[]): void {
    this.snapshots.length = 0;
    this.entityStates.clear();
    this.entityBuffs.clear();

    for (const e of entities) {
      this.entityStates.set(e.id, { ...e });
    }
    for (const b of buffs) {
      this.entityBuffs.set(b.entityId, { ...b, buffs: [...b.buffs] });
    }
    this.gasClouds = gasClouds;
    this.chemicalPools = chemPools;
  }

  /**
   * Get the interpolated position for a remote entity at the current render time.
   * Returns null if there are not enough snapshots yet.
   */
  getInterpolatedPosition(entityId: string): InterpolatedPosition | null {
    if (this.snapshots.length < 2) {
      // Not enough data — fall back to latest known position
      if (this.snapshots.length === 1) {
        const pos = this.snapshots[0].positions.get(entityId);
        if (pos) return { x: pos.x, y: pos.y, z: pos.z, rotationY: pos.rotationY, isMoving: pos.isMoving };
      }
      return null;
    }

    const renderTime = performance.now() - SnapshotBuffer.INTERP_DELAY_MS;

    // Find the two snapshots that bracket renderTime
    let before: BufferedSnapshot | null = null;
    let after: BufferedSnapshot | null = null;

    for (let i = 0; i < this.snapshots.length - 1; i++) {
      if (this.snapshots[i].receiveTime <= renderTime && this.snapshots[i + 1].receiveTime > renderTime) {
        before = this.snapshots[i];
        after = this.snapshots[i + 1];
        break;
      }
    }

    // If renderTime is beyond all snapshots, use the last known position
    if (!before || !after) {
      const latest = this.snapshots[this.snapshots.length - 1];
      const pos = latest.positions.get(entityId);
      if (!pos) return null;
      return { x: pos.x, y: pos.y, z: pos.z, rotationY: pos.rotationY, isMoving: pos.isMoving };
    }

    const beforePos = before.positions.get(entityId);
    const afterPos = after.positions.get(entityId);

    if (!beforePos && !afterPos) return null;
    if (!beforePos) return { x: afterPos!.x, y: afterPos!.y, z: afterPos!.z, rotationY: afterPos!.rotationY, isMoving: afterPos!.isMoving };
    if (!afterPos) return { x: beforePos.x, y: beforePos.y, z: beforePos.z, rotationY: beforePos.rotationY, isMoving: beforePos.isMoving };

    // Linear interpolation factor
    const totalTime = after.receiveTime - before.receiveTime;
    const elapsed = renderTime - before.receiveTime;
    const t = totalTime > 0 ? Math.max(0, Math.min(1, elapsed / totalTime)) : 1;

    // Lerp position
    const x = beforePos.x + (afterPos.x - beforePos.x) * t;
    const y = beforePos.y + (afterPos.y - beforePos.y) * t;
    const z = beforePos.z + (afterPos.z - beforePos.z) * t;

    // Angle interpolation (shortest arc)
    let angleDiff = afterPos.rotationY - beforePos.rotationY;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
    const rotationY = beforePos.rotationY + angleDiff * t;

    // isMoving: use the "after" snapshot's value (more recent)
    return { x, y, z, rotationY, isMoving: afterPos.isMoving };
  }

  /**
   * Get the full entity state (HP, mana, combat flags, casting, etc.)
   * This is maintained incrementally from deltas and keyframes.
   */
  getEntityState(entityId: string): EntitySnapshot | undefined {
    return this.entityStates.get(entityId);
  }

  /**
   * Get buff data for an entity.
   */
  getEntityBuffs(entityId: string): EntityBuffSnapshot | undefined {
    return this.entityBuffs.get(entityId);
  }

  getGasClouds(): GasCloudSnapshot[] {
    return this.gasClouds;
  }

  getChemicalPools(): ChemicalPoolSnapshot[] {
    return this.chemicalPools;
  }

  get hasEnoughData(): boolean {
    return this.snapshots.length >= 2;
  }
}
