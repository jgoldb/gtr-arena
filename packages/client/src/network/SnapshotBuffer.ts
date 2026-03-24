import type { EntitySnapshot, EntityBuffSnapshot, GasCloudSnapshot, ChemicalPoolSnapshot } from '@gtr/shared';
import type { EntityPositionData, EntityStateDelta } from '@gtr/shared';

/**
 * Snapshot interpolation buffer for smooth remote entity rendering.
 *
 * Instead of lerping toward the latest server position (exponential chase),
 * this stores timestamped snapshots and linearly interpolates between two
 * known states. The client renders behind real-time so there are always
 * two snapshots to interpolate between.
 *
 * Key improvements over a fixed-delay approach:
 * - Adaptive delay: adjusts based on measured network jitter so the buffer
 *   rarely runs dry, even at 100-200ms+ RTT.
 * - Position carry-forward: every snapshot contains positions for ALL known
 *   entities, not just those the server included in that tick's delta.
 * - Linear extrapolation: when renderTime overshoots all buffered snapshots
 *   (packet loss / jitter spike), entities continue along their last known
 *   velocity instead of freezing, capped to prevent runaway drift.
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

  // ── Adaptive delay ──────────────────────────────────────────────────
  // Instead of a fixed 100ms, we measure inter-packet arrival jitter and
  // set the delay to cover ~95th percentile (mean + 2*stddev), clamped
  // to a reasonable range. This keeps the buffer fed on real connections
  // while staying responsive on LAN.
  private static readonly MIN_DELAY_MS = 50;   // floor (LAN)
  private static readonly MAX_DELAY_MS = 300;  // ceiling (bad connection)
  private static readonly JITTER_ALPHA = 0.05; // EWMA smoothing factor
  private interpDelayMs = 100; // initial guess, adapts quickly
  private lastReceiveTime = 0;
  private avgInterval = 50;    // EWMA of inter-packet interval
  private avgJitter = 0;       // EWMA of absolute deviation from avgInterval

  // ── Extrapolation ───────────────────────────────────────────────────
  private static readonly MAX_EXTRAPOLATION_MS = 200; // don't extrapolate beyond this

  // Full entity state maintained incrementally from server deltas
  private entityStates = new Map<string, EntitySnapshot>();
  private entityBuffs = new Map<string, EntityBuffSnapshot>();
  private gasClouds: GasCloudSnapshot[] = [];
  private chemicalPools: ChemicalPoolSnapshot[] = [];

  /**
   * Push a position update from a game_state_update message.
   * Carries forward positions from the previous snapshot for entities
   * not included in this update, so every snapshot is "complete".
   */
  pushPositions(tick: number, serverTimestamp: number, positions: EntityPositionData[]): void {
    const now = performance.now();

    // ── Update adaptive delay from arrival jitter ──
    if (this.lastReceiveTime > 0) {
      const interval = now - this.lastReceiveTime;
      const jitter = Math.abs(interval - this.avgInterval);
      const a = SnapshotBuffer.JITTER_ALPHA;
      this.avgInterval = this.avgInterval * (1 - a) + interval * a;
      this.avgJitter = this.avgJitter * (1 - a) + jitter * a;

      // Target delay = average interval + 2x jitter (covers ~95th percentile)
      const target = this.avgInterval + this.avgJitter * 2;
      this.interpDelayMs = Math.max(
        SnapshotBuffer.MIN_DELAY_MS,
        Math.min(SnapshotBuffer.MAX_DELAY_MS, target),
      );
    }
    this.lastReceiveTime = now;

    // ── Build position map with carry-forward ──
    const posMap = new Map<string, EntityPositionData>();

    // Start with all positions from the previous snapshot (carry-forward)
    if (this.snapshots.length > 0) {
      const prev = this.snapshots[this.snapshots.length - 1];
      for (const [id, p] of prev.positions) {
        // Carry forward with isMoving = false (entity didn't send an update → stationary)
        posMap.set(id, { ...p, isMoving: false });
      }
    }

    // Overwrite with fresh data from this tick
    for (const p of positions) {
      posMap.set(p.id, p);
    }

    this.snapshots.push({
      tick,
      serverTimestamp,
      receiveTime: now,
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
    // NOTE: Do NOT clear this.snapshots here — position history is needed for
    // smooth interpolation. Clearing it would cause a visible stutter every
    // keyframe (every 5 seconds) while the buffer refills.
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
   * Remove a disconnected/removed entity from carried-forward positions
   * so it doesn't linger in future snapshots.
   */
  removeEntity(entityId: string): void {
    this.entityStates.delete(entityId);
    this.entityBuffs.delete(entityId);
    // Remove from latest snapshot so it won't carry forward
    if (this.snapshots.length > 0) {
      this.snapshots[this.snapshots.length - 1].positions.delete(entityId);
    }
  }

  /**
   * Get the interpolated position for a remote entity at the current render time.
   * Uses adaptive delay, position carry-forward, and linear extrapolation.
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

    const renderTime = performance.now() - this.interpDelayMs;

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

    // ── Extrapolation: renderTime is beyond all snapshots ──
    if (!before || !after) {
      const len = this.snapshots.length;
      const latest = this.snapshots[len - 1];
      const prev = this.snapshots[len - 2];

      const latestPos = latest.positions.get(entityId);
      const prevPos = prev.positions.get(entityId);

      // No position data at all
      if (!latestPos) return null;

      // Can't compute velocity → return latest position
      if (!prevPos) {
        return { x: latestPos.x, y: latestPos.y, z: latestPos.z, rotationY: latestPos.rotationY, isMoving: latestPos.isMoving };
      }

      // Linear extrapolation based on velocity between last two snapshots
      const dt = latest.receiveTime - prev.receiveTime;
      if (dt <= 0) {
        return { x: latestPos.x, y: latestPos.y, z: latestPos.z, rotationY: latestPos.rotationY, isMoving: latestPos.isMoving };
      }

      const overshoot = renderTime - latest.receiveTime;
      // Cap extrapolation to prevent runaway drift
      const extrapTime = Math.min(overshoot, SnapshotBuffer.MAX_EXTRAPOLATION_MS);

      // Only extrapolate if the entity was actually moving
      if (!latestPos.isMoving) {
        return { x: latestPos.x, y: latestPos.y, z: latestPos.z, rotationY: latestPos.rotationY, isMoving: false };
      }

      const vx = (latestPos.x - prevPos.x) / dt;
      const vy = (latestPos.y - prevPos.y) / dt;
      const vz = (latestPos.z - prevPos.z) / dt;

      return {
        x: latestPos.x + vx * extrapTime,
        y: latestPos.y + vy * extrapTime,
        z: latestPos.z + vz * extrapTime,
        rotationY: latestPos.rotationY, // don't extrapolate rotation
        isMoving: latestPos.isMoving,
      };
    }

    // ── Normal interpolation between two bracketing snapshots ──
    const beforePos = before.positions.get(entityId);
    const afterPos = after.positions.get(entityId);

    // With carry-forward, both should always exist, but handle edge cases
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

  /** Current adaptive interpolation delay (for debug display). */
  get currentDelayMs(): number {
    return this.interpDelayMs;
  }

  /**
   * Get the server timestamp corresponding to the current render time.
   * This is the server time the client is "seeing" right now, accounting
   * for interpolation delay. Used for lag compensation — the client sends
   * this with ability requests so the server can rewind to the right moment.
   */
  getCurrentRenderServerTimestamp(): number | null {
    if (this.snapshots.length < 2) return null;

    const renderTime = performance.now() - this.interpDelayMs;

    // Find the two snapshots bracketing renderTime
    for (let i = 0; i < this.snapshots.length - 1; i++) {
      if (this.snapshots[i].receiveTime <= renderTime && this.snapshots[i + 1].receiveTime > renderTime) {
        const before = this.snapshots[i];
        const after = this.snapshots[i + 1];
        const totalTime = after.receiveTime - before.receiveTime;
        const elapsed = renderTime - before.receiveTime;
        const t = totalTime > 0 ? Math.max(0, Math.min(1, elapsed / totalTime)) : 1;
        return before.serverTimestamp + (after.serverTimestamp - before.serverTimestamp) * t;
      }
    }

    // renderTime is beyond all snapshots (extrapolation) — return latest
    return this.snapshots[this.snapshots.length - 1].serverTimestamp;
  }
}
