import * as THREE from 'three';
import type { NpcController } from '../NpcController';
import type { CollisionSystem } from '../../physics/CollisionSystem';

const BASE_SPEED = 5.6; // Same as player
const COLLISION_RADIUS = 0.4;
const ROTATION_SPEED = 12; // radians/sec for smooth rotation
const ARRIVE_THRESHOLD = 0.15; // close enough to stop

export type MovementIntent =
  | { type: 'idle' }
  | { type: 'moveToward'; target: THREE.Vector3; stopDistance: number }
  | { type: 'kiteFrom'; threat: THREE.Vector3; maxRange: number; preferredRange: number }
  | { type: 'strafeAround'; center: THREE.Vector3; clockwise: boolean; radius: number };

export interface HazardZone {
  center: THREE.Vector3;
  radius: number;
}

export class MovementController {
  private npc: NpcController;
  private collision: CollisionSystem;
  private bounds: { minX: number; maxX: number; minZ: number; maxZ: number };

  intent: MovementIntent = { type: 'idle' };
  faceTarget: THREE.Vector3 | null = null;

  /** Applied externally from BuffSystem each frame */
  speedMultiplier = 1;

  /** From DifficultyProfile */
  speedScale = 1;

  /** How likely this NPC is to avoid hazards (0-1, from difficulty) */
  hazardAvoidance = 0.5;

  /** Updated each think tick with current hazard positions */
  hazards: HazardZone[] = [];

  /** Elevation search state — when NPC is directly below/above target */
  private elevationSearchAngle = Math.random() * Math.PI * 2;

  // --- Stuckness detection & escape ---
  private stuckCheckTimer = 0;
  private lastStuckCheckPos = new THREE.Vector3();
  private stuckDuration = 0;
  private escapeDir: THREE.Vector3 | null = null;
  private escapeDirTimer = 0;
  private static readonly STUCK_CHECK_INTERVAL = 0.35;
  private static readonly STUCK_DIST_THRESHOLD = 0.25;
  private static readonly STUCK_ESCAPE_AFTER = 0.7;
  private static readonly ESCAPE_COMMIT_TIME = 0.4;

  constructor(
    npc: NpcController,
    collision: CollisionSystem,
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
  ) {
    this.npc = npc;
    this.collision = collision;
    this.bounds = bounds;
  }

  updateBounds(bounds: { minX: number; maxX: number; minZ: number; maxZ: number }): void {
    this.bounds = bounds;
  }

  update(dt: number): void {
    if (this.npc.dead || this.npc.stunned) {
      this.npc.isMoving = false;
      this.resolveGround();
      return;
    }

    const pos = this.npc.mesh.position;
    let desiredDir: THREE.Vector3 | null = null;

    switch (this.intent.type) {
      case 'idle':
        this.npc.isMoving = false;
        break;

      case 'moveToward': {
        const dx = this.intent.target.x - pos.x;
        const dz = this.intent.target.z - pos.z;
        const dy = this.intent.target.y - pos.y;
        const horizDist = Math.sqrt(dx * dx + dz * dz);

        // Don't consider "arrived" if significantly below/above the target
        const atElevation = Math.abs(dy) < 2;
        const atRange = horizDist <= this.intent.stopDistance + ARRIVE_THRESHOLD;

        if (!atRange) {
          // Normal movement toward target
          desiredDir = new THREE.Vector3(dx / horizDist, 0, dz / horizDist);
        } else if (!atElevation) {
          // Close in XZ but wrong elevation — explore to find an accessible route up/down
          if (horizDist > 0.5) {
            desiredDir = new THREE.Vector3(dx / horizDist, 0, dz / horizDist);
          } else {
            desiredDir = this.getElevationSearchDir(pos, dy > 0);
          }
        } else {
          this.npc.isMoving = false;
        }
        break;
      }

      case 'kiteFrom': {
        const dx = pos.x - this.intent.threat.x;
        const dz = pos.z - this.intent.threat.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < this.intent.preferredRange) {
          // Too close — move away
          if (dist > 0.01) {
            desiredDir = new THREE.Vector3(dx / dist, 0, dz / dist);
          } else {
            // On top of threat, pick random direction
            const angle = Math.random() * Math.PI * 2;
            desiredDir = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
          }
        } else if (dist > this.intent.maxRange) {
          // Too far — move closer
          desiredDir = new THREE.Vector3(-dx / dist, 0, -dz / dist);
        } else {
          this.npc.isMoving = false;
        }
        break;
      }

      case 'strafeAround': {
        const dx = pos.x - this.intent.center.x;
        const dz = pos.z - this.intent.center.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > 0.01) {
          // Perpendicular direction for circling
          const nx = dx / dist;
          const nz = dz / dist;
          const perpX = this.intent.clockwise ? -nz : nz;
          const perpZ = this.intent.clockwise ? nx : -nx;

          // Also adjust radial distance toward desired radius
          const radialError = dist - this.intent.radius;
          const radialX = -nx * radialError * 0.5;
          const radialZ = -nz * radialError * 0.5;

          const mx = perpX + radialX;
          const mz = perpZ + radialZ;
          const mLen = Math.sqrt(mx * mx + mz * mz);
          if (mLen > 0.01) {
            desiredDir = new THREE.Vector3(mx / mLen, 0, mz / mLen);
          }
        }
        break;
      }
    }

    // Stuckness detection: if moving but not making progress, find an escape route
    if (desiredDir) {
      this.stuckCheckTimer += dt;
      if (this.stuckCheckTimer >= MovementController.STUCK_CHECK_INTERVAL) {
        const sdx = pos.x - this.lastStuckCheckPos.x;
        const sdz = pos.z - this.lastStuckCheckPos.z;
        const moved = Math.sqrt(sdx * sdx + sdz * sdz);
        if (moved < MovementController.STUCK_DIST_THRESHOLD) {
          this.stuckDuration += this.stuckCheckTimer;
        } else {
          this.stuckDuration = 0;
          this.escapeDir = null;
        }
        this.lastStuckCheckPos.set(pos.x, pos.y, pos.z);
        this.stuckCheckTimer = 0;
      }

      if (this.stuckDuration >= MovementController.STUCK_ESCAPE_AFTER) {
        this.escapeDirTimer -= dt;
        if (!this.escapeDir || this.escapeDirTimer <= 0) {
          this.escapeDir = this.findEscapeDirection(pos, desiredDir);
          this.escapeDirTimer = MovementController.ESCAPE_COMMIT_TIME;
        }
        desiredDir = this.escapeDir;
      }
    } else {
      this.stuckDuration = 0;
      this.stuckCheckTimer = 0;
      this.escapeDir = null;
    }

    // Hazard avoidance: if idle or moving, steer away from nearby hazards
    if (this.hazardAvoidance > 0 && this.hazards.length > 0) {
      const avoidDir = this.getHazardAvoidanceDir(pos);
      if (avoidDir) {
        if (desiredDir) {
          // Blend avoidance with desired direction
          desiredDir.x += avoidDir.x * this.hazardAvoidance * 2;
          desiredDir.z += avoidDir.z * this.hazardAvoidance * 2;
          desiredDir.normalize();
        } else {
          // No movement intent — but we're in a hazard, so move out
          desiredDir = avoidDir;
          this.npc.isMoving = true;
        }
      }
    }

    if (desiredDir) {
      const effectiveSpeed = BASE_SPEED * this.speedMultiplier * this.speedScale;
      const moveDist = effectiveSpeed * dt;

      // Attempt direct movement
      const intendedX = pos.x + desiredDir.x * moveDist;
      const intendedZ = pos.z + desiredDir.z * moveDist;
      const resolved = this.collision.resolve(intendedX, intendedZ, pos.y, COLLISION_RADIUS);

      // Detect wall collision from the push vector
      const pushX = resolved.x - intendedX;
      const pushZ = resolved.z - intendedZ;
      const pushLenSq = pushX * pushX + pushZ * pushZ;

      if (pushLenSq > 0.0001) {
        // Blocked by obstacle — slide along wall tangent at full speed
        const pushLen = Math.sqrt(pushLenSq);
        const normalX = pushX / pushLen;
        const normalZ = pushZ / pushLen;

        // Remove the wall-normal component from desired direction
        const dot = desiredDir.x * normalX + desiredDir.z * normalZ;
        let slideX = desiredDir.x - dot * normalX;
        let slideZ = desiredDir.z - dot * normalZ;
        let slideLen = Math.sqrt(slideX * slideX + slideZ * slideZ);

        if (slideLen < 0.1) {
          // Nearly head-on into wall — test both perpendicular directions
          // and pick the one that ends up closer to where we want to go
          const p1X = -normalZ, p1Z = normalX;
          const p2X = normalZ, p2Z = -normalX;
          const reach = moveDist * 3;

          const t1 = this.collision.resolve(pos.x + p1X * reach, pos.z + p1Z * reach, pos.y, COLLISION_RADIUS);
          const t2 = this.collision.resolve(pos.x + p2X * reach, pos.z + p2Z * reach, pos.y, COLLISION_RADIUS);

          const goalX = pos.x + desiredDir.x * 20;
          const goalZ = pos.z + desiredDir.z * 20;
          const d1 = (t1.x - goalX) ** 2 + (t1.z - goalZ) ** 2;
          const d2 = (t2.x - goalX) ** 2 + (t2.z - goalZ) ** 2;

          if (d1 <= d2) { slideX = p1X; slideZ = p1Z; }
          else { slideX = p2X; slideZ = p2Z; }
          slideLen = 1;
        }

        // Move along wall tangent at full speed
        const slideResolved = this.collision.resolve(
          pos.x + (slideX / slideLen) * moveDist,
          pos.z + (slideZ / slideLen) * moveDist,
          pos.y, COLLISION_RADIUS
        );
        pos.x = slideResolved.x;
        pos.z = slideResolved.z;
        pos.y = slideResolved.groundY;
      } else {
        // Unblocked — use resolved position directly
        pos.x = resolved.x;
        pos.z = resolved.z;
        pos.y = resolved.groundY;
      }

      // Arena boundary clamping
      const margin = COLLISION_RADIUS;
      pos.x = Math.max(this.bounds.minX + margin, Math.min(this.bounds.maxX - margin, pos.x));
      pos.z = Math.max(this.bounds.minZ + margin, Math.min(this.bounds.maxZ - margin, pos.z));

      this.npc.isMoving = true;
    } else {
      // Always resolve ground even when idle (for moving platforms like rising pillars)
      this.resolveGround();
    }

    // Facing: prefer explicit faceTarget, otherwise face movement direction
    if (this.faceTarget) {
      const fdx = this.faceTarget.x - pos.x;
      const fdz = this.faceTarget.z - pos.z;
      if (fdx * fdx + fdz * fdz > 0.01) {
        const targetRot = Math.atan2(fdx, fdz);
        this.npc.mesh.rotation.y = lerpAngle(this.npc.mesh.rotation.y, targetRot, dt * ROTATION_SPEED);
      }
    } else if (desiredDir) {
      const targetRot = Math.atan2(desiredDir.x, desiredDir.z);
      this.npc.mesh.rotation.y = lerpAngle(this.npc.mesh.rotation.y, targetRot, dt * ROTATION_SPEED);
    }
  }
  /**
   * When directly below/above a target, sample directions to find accessible elevation change.
   * Searches outward for ground that rises/descends toward the target's Y level.
   */
  private getElevationSearchDir(pos: THREE.Vector3, seekUp: boolean): THREE.Vector3 {
    const NUM_SAMPLES = 8;
    const SAMPLE_DISTS = [2, 5];

    let bestDir: THREE.Vector3 | null = null;
    let bestScore = -Infinity;

    for (const sampleDist of SAMPLE_DISTS) {
      for (let i = 0; i < NUM_SAMPLES; i++) {
        const angle = (i / NUM_SAMPLES) * Math.PI * 2;
        const dx = Math.sin(angle);
        const dz = Math.cos(angle);
        const resolved = this.collision.resolve(
          pos.x + dx * sampleDist, pos.z + dz * sampleDist, pos.y, COLLISION_RADIUS
        );

        const heightDelta = resolved.groundY - pos.y;
        const movableDist = Math.sqrt((resolved.x - pos.x) ** 2 + (resolved.z - pos.z) ** 2);
        const score = seekUp ? heightDelta : -heightDelta;

        if (movableDist > sampleDist * 0.3 && score > bestScore) {
          bestScore = score;
          bestDir = new THREE.Vector3(dx, 0, dz);
        }
      }
    }

    // If we found a direction with elevation change, use it
    if (bestDir && bestScore > 0.1) return bestDir;

    // Otherwise explore in a rotating pattern to eventually find the ramp/slope base
    this.elevationSearchAngle += 0.05;
    return new THREE.Vector3(Math.sin(this.elevationSearchAngle), 0, Math.cos(this.elevationSearchAngle));
  }

  /**
   * When stuck, sample directions to find one that makes progress toward the goal.
   * Tries 12 evenly-spaced angles, prioritising directions that are both clear
   * of obstacles AND move closer to the intended destination.
   */
  private findEscapeDirection(pos: THREE.Vector3, desiredDir: THREE.Vector3): THREE.Vector3 {
    const testDist = 3.0;
    const baseAngle = Math.atan2(desiredDir.x, desiredDir.z);
    const goalX = pos.x + desiredDir.x * 30;
    const goalZ = pos.z + desiredDir.z * 30;
    const currentGoalDist = (pos.x - goalX) ** 2 + (pos.z - goalZ) ** 2;

    let bestDir = desiredDir;
    let bestScore = -Infinity;

    // Sample 12 directions — alternating left/right from the desired heading
    for (let i = 1; i <= 12; i++) {
      const sign = i % 2 === 0 ? 1 : -1;
      const step = Math.ceil(i / 2);
      const angle = baseAngle + sign * step * (Math.PI / 6);
      const dx = Math.sin(angle);
      const dz = Math.cos(angle);

      const resolved = this.collision.resolve(
        pos.x + dx * testDist, pos.z + dz * testDist, pos.y, COLLISION_RADIUS
      );

      const actualDx = resolved.x - pos.x;
      const actualDz = resolved.z - pos.z;
      const actualDist = Math.sqrt(actualDx * actualDx + actualDz * actualDz);

      // Must actually be able to move in this direction
      if (actualDist < testDist * 0.3) continue;

      const newGoalDist = (resolved.x - goalX) ** 2 + (resolved.z - goalZ) ** 2;
      const progress = currentGoalDist - newGoalDist; // positive = closer to goal

      const score = progress + actualDist * 0.5;
      if (score > bestScore) {
        bestScore = score;
        bestDir = new THREE.Vector3(dx, 0, dz);
      }
    }

    return bestDir;
  }

  /** Snap Y to the ground at current XZ (for moving platforms, pillars, etc.) */
  private resolveGround(): void {
    const pos = this.npc.mesh.position;
    const resolved = this.collision.resolve(pos.x, pos.z, pos.y, COLLISION_RADIUS);
    pos.y = resolved.groundY;
  }

  /** Returns a direction vector pointing away from the nearest hazard, or null if not in danger */
  private getHazardAvoidanceDir(pos: THREE.Vector3): THREE.Vector3 | null {
    let closestDist = Infinity;
    let avoidX = 0;
    let avoidZ = 0;
    let inDanger = false;

    for (const hazard of this.hazards) {
      const dx = pos.x - hazard.center.x;
      const dz = pos.z - hazard.center.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      // React when within hazard radius + a small margin
      const dangerDist = hazard.radius + 0.5;
      if (dist < dangerDist && dist < closestDist) {
        closestDist = dist;
        inDanger = true;
        if (dist > 0.01) {
          avoidX = dx / dist;
          avoidZ = dz / dist;
        } else {
          // Dead center — pick random direction
          const angle = Math.random() * Math.PI * 2;
          avoidX = Math.sin(angle);
          avoidZ = Math.cos(angle);
        }
      }
    }

    if (!inDanger) return null;
    return new THREE.Vector3(avoidX, 0, avoidZ);
  }
}

function lerpAngle(current: number, target: number, t: number): number {
  let diff = target - current;
  // Normalize to [-PI, PI]
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) < 0.01) return target;
  return current + diff * Math.min(t, 1);
}
