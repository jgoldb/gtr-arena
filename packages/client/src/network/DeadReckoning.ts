/**
 * Dead reckoning system for remote entity position rendering.
 *
 * Instead of interpolating between past server snapshots (which adds 100ms+ of
 * visual latency), this system predicts where each entity IS RIGHT NOW based on
 * their last known position + movement intent.
 *
 * Uses WoW-style movement flag prediction: when moveFlags are available, the
 * predicted direction is reconstructed from moveFlags + rotationY + moveSpeed.
 * This is more accurate than velocity extrapolation because it responds
 * immediately to key press/release changes (no velocity averaging lag).
 *
 * Acceleration-aware arc prediction: when angular velocity (turnSpeed) is
 * available, the predicted path curves along an arc instead of a straight line.
 * This eliminates overshoot on turns — the entity follows the circular path
 * implied by its current rotation rate instead of flying off in a tangent.
 *
 * Falls back to velocity-based extrapolation when moveFlags aren't available
 * (backwards compat with older clients).
 *
 * Y-axis extrapolation uses vy + gravity for smooth jumps instead of staircase
 * snapping to server Y values at 30Hz.
 */

import type { EntityPositionData, S2C_PositionRelay } from '@gtr/shared';
import { MoveFlags } from '@gtr/shared';

export interface DeadReckonedPosition {
  x: number;
  y: number;
  z: number;
  rotationY: number;
  isMoving: boolean;
  vx: number;
  vz: number;
  vy: number;
}

interface EntityDRState {
  // Latest authoritative state from server
  serverX: number;
  serverY: number;
  serverZ: number;
  serverRotationY: number;
  serverVx: number;
  serverVz: number;
  serverIsMoving: boolean;
  receiveTime: number; // performance.now() when this state was received

  // Flag-based prediction fields
  serverMoveFlags: number;
  serverMoveSpeed: number;
  serverVy: number;
  serverTurnSpeed: number;

  // Error correction (blended out over time)
  errorX: number;
  errorZ: number;
  errorY: number;

  // Rotation blending — smoothly tracks toward server rotation
  displayRotationY: number;

  // Stop transition: time remaining for accelerated correction after stop (seconds)
  stopBlendRemaining: number;
}

/**
 * Compute predicted horizontal velocity from movement intent flags and rotation.
 * Reconstructs the direction vector the same way PlayerController does:
 *   forward = (sin(rotY), 0, cos(rotY))
 *   right   = (-cos(rotY), 0, sin(rotY))
 * Then normalizes and scales by moveSpeed.
 */
function flagsToVelocity(flags: number, rotationY: number, moveSpeed: number): { vx: number; vz: number } {
  if (flags === 0 || moveSpeed === 0) return { vx: 0, vz: 0 };

  const sinR = Math.sin(rotationY);
  const cosR = Math.cos(rotationY);

  // Forward: (sinR, cosR), Right: (-cosR, sinR)
  let dx = 0;
  let dz = 0;
  if (flags & MoveFlags.FORWARD)      { dx += sinR;  dz += cosR; }
  if (flags & MoveFlags.BACKWARD)     { dx -= sinR;  dz -= cosR; }
  if (flags & MoveFlags.STRAFE_RIGHT) { dx -= cosR;  dz += sinR; }
  if (flags & MoveFlags.STRAFE_LEFT)  { dx += cosR;  dz -= sinR; }

  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.001) return { vx: 0, vz: 0 };

  const scale = moveSpeed / len;
  return { vx: dx * scale, vz: dz * scale };
}

// Minimum angular velocity (rad/s) to engage arc prediction.
// Below this, straight-line extrapolation is indistinguishable.
const ARC_OMEGA_THRESHOLD = 0.1;

/**
 * Integrate position along a circular arc produced by constant angular velocity.
 *
 * Given initial velocity (vx0, vz0) rotating at ω rad/s around Y, the position
 * integral over time t is:
 *
 *   For |ω| > threshold:
 *     x = x0 + (1/ω) * ( vx0·sin(ωt) + vz0·(cos(ωt) - 1))
 *     z = z0 + (1/ω) * (-vx0·(cos(ωt) - 1) + vz0·sin(ωt))
 *
 *   This rotates the velocity vector continuously and integrates the arc,
 *   producing exact circular motion for uniform angular speed.
 *
 * When |ω| < threshold, falls back to straight-line extrapolation.
 */
function arcExtrapolate(
  x0: number, z0: number,
  vx0: number, vz0: number,
  omega: number, t: number,
): { x: number; z: number } {
  if (Math.abs(omega) < ARC_OMEGA_THRESHOLD) {
    // Straight-line fallback
    return { x: x0 + vx0 * t, z: z0 + vz0 * t };
  }

  const wt = omega * t;
  const sinWt = Math.sin(wt);
  const cosWtM1 = Math.cos(wt) - 1; // cos(ωt) - 1
  const invW = 1 / omega;

  return {
    x: x0 + invW * ( vx0 * sinWt + vz0 * cosWtM1),
    z: z0 + invW * (-vx0 * cosWtM1 + vz0 * sinWt),
  };
}

export class DeadReckoning {
  private entities = new Map<string, EntityDRState>();

  // ── One-way latency compensation ─────────────────────────────────────
  // When predicting remote entity positions, we add estimated one-way latency
  // (RTT / 2) to the extrapolation time. This pushes the predicted position
  // forward to where the entity actually IS NOW, rather than where it was when
  // the server sent the packet. On a 60ms RTT connection this eliminates 30ms
  // of visual lag — very noticeable in fast-paced combat.
  private oneWayLatencyMs = 0;

  // How quickly position errors are blended out (seconds).
  // Scales with RTT: higher latency means larger corrections (because we're
  // predicting further ahead), so we need more time to blend them out smoothly.
  private static readonly BASE_CORRECTION_TIME = 0.15;
  private static readonly MIN_CORRECTION_TIME = 0.1;
  private static readonly MAX_CORRECTION_TIME = 0.25;

  // Max time to extrapolate beyond latest server state (seconds).
  // Caps how far ahead we predict to prevent runaway drift on packet loss.
  private static readonly MAX_EXTRAPOLATION = 0.3;

  // If position error exceeds this, snap instantly (teleport, respawn, etc.)
  private static readonly SNAP_THRESHOLD = 5.0; // world units

  // Rotation blending speed — higher = faster tracking toward server rotation
  private static readonly ROTATION_CORRECTION_TIME = 0.1; // 100ms

  // Faster correction time used briefly after an entity stops moving.
  // Settles to the exact stop position quickly (~200ms) without a hard snap.
  private static readonly STOP_CORRECTION_TIME = 0.06; // 60ms — ~95% settled in 180ms
  private static readonly STOP_BLEND_DURATION = 0.25; // how long the fast correction lasts

  // Gravity for Y extrapolation (must match PlayerController/ServerEntity)
  private static readonly GRAVITY = 20;

  /**
   * Update network latency estimate. Call whenever RTT is updated (e.g. from ping/pong).
   * Dead reckoning uses half-RTT to compensate for one-way transport delay.
   */
  setRtt(rttMs: number): void {
    this.oneWayLatencyMs = rttMs / 2;
  }

  /** RTT-adaptive correction time — scales with latency for smoother blending. */
  private get correctionTime(): number {
    // Higher latency = predicting further ahead = larger errors = need more blend time
    const rttFactor = Math.max(0, this.oneWayLatencyMs - 20) / 200; // 0 at 20ms, 1 at 220ms
    return Math.min(
      DeadReckoning.MAX_CORRECTION_TIME,
      Math.max(
        DeadReckoning.MIN_CORRECTION_TIME,
        DeadReckoning.BASE_CORRECTION_TIME + rttFactor * 0.1,
      ),
    );
  }

  /**
   * Feed new server position data for an entity.
   * Called when game_state_update positions arrive.
   */
  updateEntity(id: string, pos: EntityPositionData | S2C_PositionRelay): void {
    const now = performance.now();
    const existing = this.entities.get(id);

    const moveFlags = (pos as any).moveFlags ?? 0;
    const moveSpeed = (pos as any).moveSpeed ?? 0;
    const vy = (pos as any).vy ?? 0;
    const turnSpeed = (pos as any).turnSpeed ?? 0;

    if (!existing) {
      // First time seeing this entity — no error to correct
      this.entities.set(id, {
        serverX: pos.x, serverY: pos.y, serverZ: pos.z,
        serverRotationY: pos.rotationY,
        serverVx: pos.vx, serverVz: pos.vz,
        serverIsMoving: pos.isMoving,
        receiveTime: now,
        serverMoveFlags: moveFlags,
        serverMoveSpeed: moveSpeed,
        serverVy: vy,
        serverTurnSpeed: turnSpeed,
        errorX: 0, errorZ: 0, errorY: 0,
        displayRotationY: pos.rotationY,
        stopBlendRemaining: 0,
      });
      return;
    }

    // Compute where we were displaying this entity right now (predicted + residual error).
    // Add one-way latency so we predict from the actual send time, not receive time.
    const elapsed = Math.min(
      (now - existing.receiveTime + this.oneWayLatencyMs) / 1000,
      DeadReckoning.MAX_EXTRAPOLATION,
    );

    let displayX: number, displayZ: number;
    if (existing.serverIsMoving) {
      const predicted = this.predictXZ(existing, elapsed);
      displayX = predicted.x + existing.errorX;
      displayZ = predicted.z + existing.errorZ;
    } else {
      displayX = existing.serverX + existing.errorX;
      displayZ = existing.serverZ + existing.errorZ;
    }

    // New XZ error = where we were displaying minus where server says it actually is
    const newErrorX = displayX - pos.x;
    const newErrorZ = displayZ - pos.z;

    // Snap instantly only when error is huge (teleport, respawn, knockback end).
    // Stop transitions use accelerated blending instead — eliminates micro-teleports
    // while still settling to the exact stop position quickly.
    const errorMag = Math.sqrt(newErrorX * newErrorX + newErrorZ * newErrorZ);
    if (errorMag > DeadReckoning.SNAP_THRESHOLD) {
      existing.errorX = 0;
      existing.errorZ = 0;
      existing.errorY = 0;
      existing.displayRotationY = pos.rotationY;
      existing.stopBlendRemaining = 0;
    } else {
      existing.errorX = newErrorX;
      existing.errorZ = newErrorZ;
      // Trigger accelerated correction on stop transition
      const justStopped = existing.serverIsMoving && !pos.isMoving;
      if (justStopped) {
        existing.stopBlendRemaining = DeadReckoning.STOP_BLEND_DURATION;
      }
    }

    // Y error handling
    const wasAirborne = existing.serverVy !== 0;
    const nowAirborne = vy !== 0;
    if (nowAirborne) {
      // Airborne: compute error from predicted parabola position vs new server Y
      const predictedY = this.predictY(existing, elapsed);
      const displayY = predictedY + existing.errorY;
      existing.errorY = displayY - pos.y;
      if (Math.abs(existing.errorY) > DeadReckoning.SNAP_THRESHOLD) {
        existing.errorY = 0;
      }
    } else if (wasAirborne) {
      // Just landed: snap Y to server ground position
      existing.errorY = 0;
    } else {
      // On ground: normal Y error correction (ramps, slopes, etc.)
      const displayY = existing.serverY + existing.errorY;
      existing.errorY = displayY - pos.y;
      if (Math.abs(existing.errorY) > DeadReckoning.SNAP_THRESHOLD) {
        existing.errorY = 0;
      }
    }

    // Update authoritative server state
    existing.serverX = pos.x;
    existing.serverY = pos.y;
    existing.serverZ = pos.z;
    existing.serverRotationY = pos.rotationY;
    existing.serverVx = pos.vx;
    existing.serverVz = pos.vz;
    existing.serverIsMoving = pos.isMoving;
    existing.serverMoveFlags = moveFlags;
    existing.serverMoveSpeed = moveSpeed;
    existing.serverVy = vy;
    existing.serverTurnSpeed = turnSpeed;
    existing.receiveTime = now;
  }

  /**
   * Predict horizontal position from movement flags or velocity.
   *
   * When angular velocity (turnSpeed) is available and above threshold, uses
   * arc integration — the velocity vector rotates continuously, producing a
   * curved predicted path that matches actual player turning behavior. This
   * eliminates the "overshoot then snap back" artifacts of straight-line
   * extrapolation during turns.
   *
   * Prefers flag-based prediction on the ground (more responsive to key
   * press/release). During jumps, uses velocity-based prediction because
   * the actual air movement follows the snapshotted velocity from jump
   * start, not the current key state.
   */
  private predictXZ(state: EntityDRState, elapsed: number): { x: number; z: number } {
    const omega = state.serverTurnSpeed;

    // Flag-based: reconstruct direction from flags + rotation + speed (ground only)
    if (state.serverVy === 0 && state.serverMoveFlags !== 0 && state.serverMoveSpeed > 0) {
      const vel = flagsToVelocity(state.serverMoveFlags, state.serverRotationY, state.serverMoveSpeed);
      return arcExtrapolate(state.serverX, state.serverZ, vel.vx, vel.vz, omega, elapsed);
    }

    // Velocity-based extrapolation (airborne, or fallback when no flags)
    return arcExtrapolate(state.serverX, state.serverZ, state.serverVx, state.serverVz, omega, elapsed);
  }

  /**
   * Predict Y position using vertical velocity and gravity.
   * When vy is available, extrapolates a parabolic arc (jump physics).
   * Otherwise returns the server Y unchanged.
   */
  private predictY(state: EntityDRState, elapsed: number): number {
    if (state.serverVy === 0) return state.serverY;
    // y = y0 + vy*t - 0.5*g*t^2 (kinematic equation matching PlayerController physics)
    const predictedY = state.serverY + state.serverVy * elapsed
      - 0.5 * DeadReckoning.GRAVITY * elapsed * elapsed;
    // Floor at 0 — ground level. The client will apply terrain height separately
    // if needed, but we can't predict below the world floor.
    return Math.max(predictedY, 0);
  }

  /**
   * Get the dead-reckoned display position for a remote entity.
   * Call every frame with the frame's delta time.
   */
  getPosition(id: string, dt: number): DeadReckonedPosition | null {
    const state = this.entities.get(id);
    if (!state) return null;

    const now = performance.now();
    // Add one-way latency to extrapolation so entities are rendered at their
    // estimated current position, not where they were when the packet was sent.
    const elapsed = Math.min(
      (now - state.receiveTime + this.oneWayLatencyMs) / 1000,
      DeadReckoning.MAX_EXTRAPOLATION,
    );

    // Dead-reckon from latest server state
    let x: number, z: number;
    if (state.serverIsMoving) {
      const predicted = this.predictXZ(state, elapsed);
      x = predicted.x;
      z = predicted.z;
    } else {
      x = state.serverX;
      z = state.serverZ;
    }
    const y = this.predictY(state, elapsed);

    // Decay position error exponentially.
    // Use faster correction during stop transitions to settle quickly without snapping.
    // Base correction time scales with RTT for smoother blending on laggy connections.
    const correctionTime = state.stopBlendRemaining > 0
      ? DeadReckoning.STOP_CORRECTION_TIME
      : this.correctionTime;
    if (state.stopBlendRemaining > 0) {
      state.stopBlendRemaining = Math.max(0, state.stopBlendRemaining - dt);
    }
    const decay = Math.exp(-dt / correctionTime);
    state.errorX *= decay;
    state.errorZ *= decay;
    state.errorY *= decay;

    // Zero out tiny residual error to prevent floating point accumulation
    if (Math.abs(state.errorX) < 0.0005) state.errorX = 0;
    if (Math.abs(state.errorZ) < 0.0005) state.errorZ = 0;
    if (Math.abs(state.errorY) < 0.0005) state.errorY = 0;

    // Blend rotation toward predicted server rotation.
    // When turning, extrapolate rotation forward using angular velocity so the
    // display rotation tracks ahead instead of always lagging behind.
    const predictedServerRotation = state.serverRotationY + state.serverTurnSpeed * elapsed;
    let angleDiff = predictedServerRotation - state.displayRotationY;
    if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
    const rotBlend = 1 - Math.exp(-dt / DeadReckoning.ROTATION_CORRECTION_TIME);
    state.displayRotationY += angleDiff * rotBlend;

    return {
      x: x + state.errorX,
      y: y + state.errorY,
      z: z + state.errorZ,
      rotationY: state.displayRotationY,
      isMoving: state.serverIsMoving,
      vx: state.serverVx,
      vz: state.serverVz,
      vy: state.serverVy,
    };
  }

  /**
   * Snap an entity to an exact position (e.g. after server correction, respawn).
   * Clears all error — no blending.
   */
  snapEntity(id: string, x: number, y: number, z: number, rotationY: number): void {
    const existing = this.entities.get(id);
    if (existing) {
      existing.serverX = x;
      existing.serverY = y;
      existing.serverZ = z;
      existing.serverRotationY = rotationY;
      existing.serverVx = 0;
      existing.serverVz = 0;
      existing.serverIsMoving = false;
      existing.serverMoveFlags = 0;
      existing.serverMoveSpeed = 0;
      existing.serverVy = 0;
      existing.serverTurnSpeed = 0;
      existing.receiveTime = performance.now();
      existing.errorX = 0;
      existing.errorZ = 0;
      existing.errorY = 0;
      existing.displayRotationY = rotationY;
      existing.stopBlendRemaining = 0;
    }
  }

  removeEntity(id: string): void {
    this.entities.delete(id);
  }

  clear(): void {
    this.entities.clear();
  }
}
