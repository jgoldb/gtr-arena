import type { EntitySnapshot, EntityBuffSnapshot, GasCloudSnapshot, ChemicalPoolSnapshot } from '@gtr/shared';
import type { EntityPositionData, EntityStateDelta } from '@gtr/shared';

/**
 * Snapshot interpolation buffer for smooth remote entity rendering.
 *
 * Instead of lerping toward the latest server position (exponential chase),
 * this stores timestamped snapshots and uses cubic Hermite spline interpolation
 * between two known states. The client renders behind real-time so there are
 * always two snapshots to interpolate between.
 *
 * Key improvements over a fixed-delay approach:
 * - Cubic Hermite interpolation: uses server-provided velocity as tangents
 *   at each snapshot, producing C1-continuous curves through knot points.
 *   This eliminates the visible "kinks" at snapshot boundaries that linear
 *   interpolation produces during turns and speed changes.
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
  /** Interpolated horizontal velocity (world units/sec) */
  vx: number;
  vz: number;
}

export class SnapshotBuffer {
  private snapshots: BufferedSnapshot[] = [];
  private static readonly MAX_BUFFER_SIZE = 45; // ~1.5s at 30Hz

  // ── Adaptive delay ──────────────────────────────────────────────────
  // Instead of a fixed 100ms, we measure inter-packet arrival jitter and
  // set the delay to cover ~95th percentile (mean + 2*stddev), clamped
  // to a reasonable range. This keeps the buffer fed on real connections
  // while staying responsive on LAN.
  //
  // Asymmetric adaptation for WiFi: jitter spikes are absorbed fast
  // (high alpha) so the buffer doesn't underrun, while jitter decreases
  // decay slowly (low alpha) to avoid oscillation after a burst.
  private static readonly MIN_DELAY_MS = 50;   // floor (LAN)
  private static readonly MAX_DELAY_MS = 300;  // ceiling (bad connection)
  private static readonly JITTER_ALPHA_UP = 0.3;   // fast react to spikes
  private static readonly JITTER_ALPHA_DOWN = 0.05; // slow decay when stable
  private interpDelayMs = 100; // initial guess, adapts quickly
  private lastReceiveTime = 0;
  private avgInterval = 50;    // EWMA of inter-packet interval
  private avgJitter = 0;       // EWMA of absolute deviation from avgInterval
  private jitterHighWater = 0; // peak jitter tracker, decays slowly

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

      // Asymmetric EWMA: fast alpha when jitter increases, slow when it decreases.
      // This absorbs WiFi spikes in 1-2 packets but takes ~1s to relax back down.
      const aInterval = interval > this.avgInterval
        ? SnapshotBuffer.JITTER_ALPHA_UP : SnapshotBuffer.JITTER_ALPHA_DOWN;
      this.avgInterval = this.avgInterval * (1 - aInterval) + interval * aInterval;

      const aJitter = jitter > this.avgJitter
        ? SnapshotBuffer.JITTER_ALPHA_UP : SnapshotBuffer.JITTER_ALPHA_DOWN;
      this.avgJitter = this.avgJitter * (1 - aJitter) + jitter * aJitter;

      // High-water mark: jumps instantly to peak jitter, decays slowly.
      // Prevents the delay from collapsing between WiFi burst clusters.
      if (jitter > this.jitterHighWater) {
        this.jitterHighWater = jitter;
      } else {
        this.jitterHighWater *= (1 - SnapshotBuffer.JITTER_ALPHA_DOWN);
      }

      // Target delay uses the larger of EWMA jitter and decaying high-water mark
      const effectiveJitter = Math.max(this.avgJitter, this.jitterHighWater * 0.5);
      const target = this.avgInterval + effectiveJitter * 2;
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
        // Carry forward with isMoving = false and zero velocity (entity didn't send an update → stationary)
        posMap.set(id, { ...p, isMoving: false, vx: 0, vz: 0 });
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
        if (pos) return { x: pos.x, y: pos.y, z: pos.z, rotationY: pos.rotationY, isMoving: pos.isMoving, vx: pos.vx, vz: pos.vz };
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

      const latestPos = latest.positions.get(entityId);

      // No position data at all
      if (!latestPos) return null;

      // Only extrapolate if the entity was actually moving
      if (!latestPos.isMoving) {
        return { x: latestPos.x, y: latestPos.y, z: latestPos.z, rotationY: latestPos.rotationY, isMoving: false, vx: 0, vz: 0 };
      }

      const overshoot = renderTime - latest.receiveTime;
      // Cap extrapolation to prevent runaway drift
      const extrapTime = Math.min(overshoot, SnapshotBuffer.MAX_EXTRAPOLATION_MS) / 1000; // convert to seconds (velocity is units/sec)

      return {
        x: latestPos.x + latestPos.vx * extrapTime,
        y: latestPos.y,
        z: latestPos.z + latestPos.vz * extrapTime,
        rotationY: latestPos.rotationY, // don't extrapolate rotation
        isMoving: latestPos.isMoving,
        vx: latestPos.vx,
        vz: latestPos.vz,
      };
    }

    // ── Cubic Hermite interpolation between two bracketing snapshots ──
    // Uses position + velocity at each knot to produce C1-continuous curves,
    // eliminating velocity discontinuities at snapshot boundaries during turns.
    const beforePos = before.positions.get(entityId);
    const afterPos = after.positions.get(entityId);

    // With carry-forward, both should always exist, but handle edge cases
    if (!beforePos && !afterPos) return null;
    if (!beforePos) return { x: afterPos!.x, y: afterPos!.y, z: afterPos!.z, rotationY: afterPos!.rotationY, isMoving: afterPos!.isMoving, vx: afterPos!.vx, vz: afterPos!.vz };
    if (!afterPos) return { x: beforePos.x, y: beforePos.y, z: beforePos.z, rotationY: beforePos.rotationY, isMoving: beforePos.isMoving, vx: beforePos.vx, vz: beforePos.vz };

    // Interpolation parameter t ∈ [0, 1]
    const totalTime = after.receiveTime - before.receiveTime;
    const elapsed = renderTime - before.receiveTime;
    const t = totalTime > 0 ? Math.max(0, Math.min(1, elapsed / totalTime)) : 1;

    // Interval duration in seconds (velocity is in units/sec)
    const dtSec = totalTime / 1000;

    // Hermite tangents: velocity * interval = position change implied by tangent
    // m0 = velocity_at_start * dt, m1 = velocity_at_end * dt
    const m0x = beforePos.vx * dtSec;
    const m0z = beforePos.vz * dtSec;
    const m1x = afterPos.vx * dtSec;
    const m1z = afterPos.vz * dtSec;

    // Hermite basis functions
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;   // position at start
    const h10 = t3 - 2 * t2 + t;         // tangent at start
    const h01 = -2 * t3 + 3 * t2;        // position at end
    const h11 = t3 - t2;                  // tangent at end

    const x = h00 * beforePos.x + h10 * m0x + h01 * afterPos.x + h11 * m1x;
    const z = h00 * beforePos.z + h10 * m0z + h01 * afterPos.z + h11 * m1z;

    // Y (vertical) stays linear — gravity/ground-clamping doesn't benefit from curves
    const y = beforePos.y + (afterPos.y - beforePos.y) * t;

    // Velocity from Hermite derivative: d/dt of the basis functions, divided by dtSec
    // to convert from position-per-t back to units/sec
    const dh00 = 6 * t2 - 6 * t;
    const dh10 = 3 * t2 - 4 * t + 1;
    const dh01 = -6 * t2 + 6 * t;
    const dh11 = 3 * t2 - 2 * t;

    const vx = dtSec > 0
      ? (dh00 * beforePos.x + dh10 * m0x + dh01 * afterPos.x + dh11 * m1x) / dtSec
      : afterPos.vx;
    const vz = dtSec > 0
      ? (dh00 * beforePos.z + dh10 * m0z + dh01 * afterPos.z + dh11 * m1z) / dtSec
      : afterPos.vz;

    // Angle interpolation (shortest arc) — stays linear, small deltas don't need curves
    let angleDiff = afterPos.rotationY - beforePos.rotationY;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
    const rotationY = beforePos.rotationY + angleDiff * t;

    // isMoving: use the "after" snapshot's value (more recent)
    return { x, y, z, rotationY, isMoving: afterPos.isMoving, vx, vz };
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
   *
   * When a clock offset is provided (from ClockSync), we compute this directly:
   *   renderServerTime = estimatedServerNow - interpDelay
   * This is more accurate than interpolation-based estimation, especially during
   * packet loss or jitter spikes where snapshot arrival times don't reflect true
   * server timing.
   *
   * @param clockOffset - If provided, Date.now() + clockOffset ≈ server's Date.now().
   */
  getCurrentRenderServerTimestamp(clockOffset?: number): number | null {
    // Clock-sync path: derive directly from synced clocks
    if (clockOffset !== undefined) {
      return Date.now() + clockOffset - this.interpDelayMs;
    }

    // Fallback: interpolate between received server timestamps
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
