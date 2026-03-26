/**
 * Dead reckoning system for remote entity position rendering.
 *
 * Instead of interpolating between past server snapshots (which adds 100ms+ of
 * visual latency), this system predicts where each entity IS RIGHT NOW based on
 * their last known position + velocity. When new server data arrives showing the
 * prediction was slightly off, the error is smoothly blended out over ~150ms.
 *
 * Trade-off vs snapshot interpolation:
 * - Entities are rendered at their approximate CURRENT position (not 100ms behind)
 * - Slight rubber-banding on sharp turns/stops (barely visible at fast correction rates)
 * - Much more responsive for targeting and ability hit feedback
 */

import type { EntityPositionData } from '@gtr/shared';

export interface DeadReckonedPosition {
  x: number;
  y: number;
  z: number;
  rotationY: number;
  isMoving: boolean;
  vx: number;
  vz: number;
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

  // Error correction (blended out over time)
  errorX: number;
  errorZ: number;
  errorY: number;

  // Rotation blending — smoothly tracks toward server rotation
  displayRotationY: number;
}

export class DeadReckoning {
  private entities = new Map<string, EntityDRState>();

  // How quickly position errors are blended out (seconds).
  // Lower = snappier corrections but more visible rubber-banding.
  // 0.15s is a good balance — fast enough to not drift, slow enough to be smooth.
  private static readonly CORRECTION_TIME = 0.15;

  // Max time to extrapolate beyond latest server state (seconds).
  // Caps how far ahead we predict to prevent runaway drift on packet loss.
  private static readonly MAX_EXTRAPOLATION = 0.25;

  // If position error exceeds this, snap instantly (teleport, respawn, etc.)
  private static readonly SNAP_THRESHOLD = 5.0; // world units

  // Rotation blending speed — higher = faster tracking toward server rotation
  private static readonly ROTATION_CORRECTION_TIME = 0.1; // 100ms

  /**
   * Feed new server position data for an entity.
   * Called when game_state_update positions arrive.
   */
  updateEntity(id: string, pos: EntityPositionData): void {
    const now = performance.now();
    const existing = this.entities.get(id);

    if (!existing) {
      // First time seeing this entity — no error to correct
      this.entities.set(id, {
        serverX: pos.x, serverY: pos.y, serverZ: pos.z,
        serverRotationY: pos.rotationY,
        serverVx: pos.vx, serverVz: pos.vz,
        serverIsMoving: pos.isMoving,
        receiveTime: now,
        errorX: 0, errorZ: 0, errorY: 0,
        displayRotationY: pos.rotationY,
      });
      return;
    }

    // Compute where we were displaying this entity right now (predicted + residual error)
    const elapsed = Math.min(
      (now - existing.receiveTime) / 1000,
      DeadReckoning.MAX_EXTRAPOLATION,
    );

    let displayX: number, displayZ: number;
    if (existing.serverIsMoving) {
      displayX = existing.serverX + existing.serverVx * elapsed + existing.errorX;
      displayZ = existing.serverZ + existing.serverVz * elapsed + existing.errorZ;
    } else {
      displayX = existing.serverX + existing.errorX;
      displayZ = existing.serverZ + existing.errorZ;
    }
    const displayY = existing.serverY + existing.errorY;

    // New error = where we were displaying minus where server says it actually is
    const newErrorX = displayX - pos.x;
    const newErrorZ = displayZ - pos.z;
    const newErrorY = displayY - pos.y;

    // Snap instantly when:
    // - Error is huge (teleport, respawn, knockback end)
    // - Entity just stopped moving — plant feet at exact stop position, no slide
    const errorMag = Math.sqrt(newErrorX * newErrorX + newErrorZ * newErrorZ);
    const justStopped = existing.serverIsMoving && !pos.isMoving;
    if (errorMag > DeadReckoning.SNAP_THRESHOLD || justStopped) {
      existing.errorX = 0;
      existing.errorZ = 0;
      existing.errorY = 0;
      if (errorMag > DeadReckoning.SNAP_THRESHOLD) {
        existing.displayRotationY = pos.rotationY;
      }
    } else {
      existing.errorX = newErrorX;
      existing.errorZ = newErrorZ;
      existing.errorY = newErrorY;
    }

    // Update authoritative server state
    existing.serverX = pos.x;
    existing.serverY = pos.y;
    existing.serverZ = pos.z;
    existing.serverRotationY = pos.rotationY;
    existing.serverVx = pos.vx;
    existing.serverVz = pos.vz;
    existing.serverIsMoving = pos.isMoving;
    existing.receiveTime = now;
  }

  /**
   * Get the dead-reckoned display position for a remote entity.
   * Call every frame with the frame's delta time.
   */
  getPosition(id: string, dt: number): DeadReckonedPosition | null {
    const state = this.entities.get(id);
    if (!state) return null;

    const now = performance.now();
    const elapsed = Math.min(
      (now - state.receiveTime) / 1000,
      DeadReckoning.MAX_EXTRAPOLATION,
    );

    // Dead-reckon from latest server state
    let x: number, z: number;
    if (state.serverIsMoving) {
      x = state.serverX + state.serverVx * elapsed;
      z = state.serverZ + state.serverVz * elapsed;
    } else {
      x = state.serverX;
      z = state.serverZ;
    }
    const y = state.serverY;

    // Decay position error exponentially
    const decay = Math.exp(-dt / DeadReckoning.CORRECTION_TIME);
    state.errorX *= decay;
    state.errorZ *= decay;
    state.errorY *= decay;

    // Zero out tiny residual error to prevent floating point accumulation
    if (Math.abs(state.errorX) < 0.0005) state.errorX = 0;
    if (Math.abs(state.errorZ) < 0.0005) state.errorZ = 0;
    if (Math.abs(state.errorY) < 0.0005) state.errorY = 0;

    // Blend rotation toward server rotation (shortest arc)
    let angleDiff = state.serverRotationY - state.displayRotationY;
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
      existing.receiveTime = performance.now();
      existing.errorX = 0;
      existing.errorZ = 0;
      existing.errorY = 0;
      existing.displayRotationY = rotationY;
    }
  }

  removeEntity(id: string): void {
    this.entities.delete(id);
  }

  clear(): void {
    this.entities.clear();
  }
}
