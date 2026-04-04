import type { NetworkManager } from './NetworkManager';

// ── Host interface ────────────────────────────────────────────────────

/** Read-only view of the local player, as needed by position sync. */
export interface PositionSyncHost {
  getPosition(): { x: number; y: number; z: number };
  readonly mesh: { readonly rotation: { readonly y: number } };
  readonly isMoving: boolean;
  readonly moveFlags: number;
  readonly currentMoveSpeed: number;
  readonly velocityY: number;
  readonly turnSpeed: number;
  readonly grounded: boolean;
}

// ── PositionSync ─────────────────────────────────────────────────────

/**
 * Sends local player position to the server at 30Hz with immediate
 * sends on movement state changes (start/stop/direction).
 */
export class PositionSync {
  private readonly network: NetworkManager;
  private readonly getPlayer: () => PositionSyncHost;

  // 30Hz periodic send
  private static readonly SEND_RATE = 1000 / 30;
  private sendAccumulator = 0;

  // Delta compression — skip sends when nothing changed
  private static readonly POSITION_EPSILON = 0.001;
  private static readonly ROTATION_EPSILON = 0.001;
  private lastSentPosition = { x: NaN, y: NaN, z: NaN, rotationY: NaN, isMoving: false };

  // Velocity computation from position deltas
  private prevSendPosition = { x: 0, y: 0, z: 0 };
  private prevSendTime = 0;

  // Immediate send on movement state change — reduces perceived
  // latency for remote players by up to 33ms per state change.
  private static readonly IMMEDIATE_SEND_MIN_INTERVAL = 30; // ms
  private static readonly DIRECTION_CHANGE_THRESHOLD = 0.2;  // radians (~11°)
  private lastImmediateSendTime = 0;
  private prevMoving = false;
  private prevMoveFlags = 0;
  private prevMoveAngle = 0;

  constructor(network: NetworkManager, getPlayer: () => PositionSyncHost) {
    this.network = network;
    this.getPlayer = getPlayer;
  }

  /**
   * Called every frame. Detects movement state changes and sends
   * position updates at 30Hz or immediately on start/stop/direction change.
   */
  update(dt: number): void {
    const player = this.getPlayer();
    const isMovingNow = player.isMoving ?? false;
    const currentMoveFlags = player.moveFlags;
    const now = performance.now();
    let immediateNeeded = false;

    // Compute current movement direction
    let currentMoveAngle = this.prevMoveAngle;
    if (isMovingNow) {
      const pos = player.getPosition();
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
      if (Math.abs(angleDelta) > PositionSync.DIRECTION_CHANGE_THRESHOLD) {
        immediateNeeded = true;
      }
    }

    if (immediateNeeded && (now - this.lastImmediateSendTime) >= PositionSync.IMMEDIATE_SEND_MIN_INTERVAL) {
      this.prevMoveAngle = currentMoveAngle;
      this.send();
      this.lastImmediateSendTime = now;
      this.sendAccumulator = 0; // reset so the periodic tick stays evenly spaced
    }
    this.prevMoving = isMovingNow;
    this.prevMoveFlags = currentMoveFlags;

    // Periodic 30Hz position updates — drift correction between state changes
    this.sendAccumulator += dt * 1000;
    if (this.sendAccumulator >= PositionSync.SEND_RATE) {
      this.sendAccumulator -= PositionSync.SEND_RATE;
      this.prevMoveAngle = currentMoveAngle;
      this.send();
    }
  }

  private send(): void {
    const player = this.getPlayer();
    const pos = player.getPosition();
    const rotationY = player.mesh.rotation.y;
    const isMoving = player.isMoving ?? false;
    const prev = this.lastSentPosition;

    // Skip sending if nothing changed
    if (
      Math.abs(prev.x - pos.x) < PositionSync.POSITION_EPSILON
      && Math.abs(prev.y - pos.y) < PositionSync.POSITION_EPSILON
      && Math.abs(prev.z - pos.z) < PositionSync.POSITION_EPSILON
      && Math.abs(prev.rotationY - rotationY) < PositionSync.ROTATION_EPSILON
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
      moveFlags: player.moveFlags,
      moveSpeed: player.currentMoveSpeed,
      vy: player.velocityY,
      turnSpeed: player.turnSpeed,
      grounded: player.grounded,
    });
  }
}
