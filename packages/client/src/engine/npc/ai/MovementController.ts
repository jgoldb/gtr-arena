import * as THREE from 'three';
import type { NpcController } from '../NpcController';
import type { CollisionSystem } from '../../physics/CollisionSystem';
import type { Targetable } from '../../types';

const BASE_SPEED = 5.6; // Same as player
const COLLISION_RADIUS = 0.4;
const ROTATION_SPEED = 12; // radians/sec for smooth rotation
const ARRIVE_THRESHOLD = 0.15; // close enough to stop
const GRAVITY = 20; // Same as player
const GROUND_FOLLOW_THRESHOLD = 1; // Same as player — snap to ground if within this distance
/** NPCs use a higher step height than the player (0.5) so they can walk from
 *  mound ramps onto overlapping tube walkable colliders at archway bases. */
const NPC_STEP_HEIGHT = 1.5;

/** Max vertical distance to consider a hazard threatening */
const HAZARD_Y_THRESHOLD = 2.0;

export type MovementIntent =
  | { type: 'idle' }
  | { type: 'moveToward'; target: THREE.Vector3; stopDistance: number }
  | { type: 'kiteFrom'; threat: THREE.Vector3; maxRange: number; preferredRange: number }
  | { type: 'strafeAround'; center: THREE.Vector3; clockwise: boolean; radius: number }
  | { type: 'wander' };

export interface HazardZone {
  center: THREE.Vector3;
  radius: number;
  owner: Targetable;
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

  /** Discombobulate: WASD-style direction scramble (derangement of [0,1,2,3]).
   *  Indices: 0=forward, 1=left, 2=backward, 3=right.
   *  When active, the NPC's intended movement components are remapped through this. */
  discombobActive = false;
  /** 0 = fully scrambled, 1 = fully adapted (blends scrambled→correct) */
  discombobAdaptation = 0;
  private discombobMap: number[] = [0, 1, 2, 3];

  /** Wander state for blind — random direction that changes periodically */
  private wanderDir = new THREE.Vector3(Math.sin(Math.random() * Math.PI * 2), 0, Math.cos(Math.random() * Math.PI * 2));
  private wanderTimer = 0;
  private static readonly WANDER_CHANGE_INTERVAL = 1.2; // seconds between direction changes
  private static readonly WANDER_SPEED_SCALE = 0.5; // walk, don't sprint

  /** Gravity / falling state */
  velocityY = 0;
  grounded = true;
  private fallPeakY = 0;
  onFallDamage?: (fallDistance: number) => void;

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
      this.applyGravity(dt);
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
          // Steer away from walls/boundaries to avoid getting cornered
          desiredDir = this.adjustKiteDirForWalls(pos, desiredDir, this.intent.threat);
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

      case 'wander': {
        // Blinded wander — walk in a random direction, changing periodically
        this.wanderTimer += dt;
        if (this.wanderTimer >= MovementController.WANDER_CHANGE_INTERVAL) {
          this.wanderTimer = 0;
          const angle = Math.random() * Math.PI * 2;
          this.wanderDir.set(Math.sin(angle), 0, Math.cos(angle));
        }
        desiredDir = this.wanderDir.clone();
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

    // Apply discombobulate WASD-style direction scramble
    if (desiredDir && this.discombobActive) {
      this.applyDiscombobScramble(desiredDir);
    }

    let groundY: number;

    if (desiredDir) {
      const wanderSlow = this.intent.type === 'wander' ? MovementController.WANDER_SPEED_SCALE : 1;
      const effectiveSpeed = BASE_SPEED * this.speedMultiplier * this.speedScale * wanderSlow;
      const moveDist = effectiveSpeed * dt;

      // Attempt direct movement
      const intendedX = pos.x + desiredDir.x * moveDist;
      const intendedZ = pos.z + desiredDir.z * moveDist;
      const resolved = this.collision.resolve(intendedX, intendedZ, pos.y, COLLISION_RADIUS, NPC_STEP_HEIGHT);

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

          const t1 = this.collision.resolve(pos.x + p1X * reach, pos.z + p1Z * reach, pos.y, COLLISION_RADIUS, NPC_STEP_HEIGHT);
          const t2 = this.collision.resolve(pos.x + p2X * reach, pos.z + p2Z * reach, pos.y, COLLISION_RADIUS, NPC_STEP_HEIGHT);

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
          pos.y, COLLISION_RADIUS, NPC_STEP_HEIGHT
        );
        pos.x = slideResolved.x;
        pos.z = slideResolved.z;
        groundY = slideResolved.groundY;
      } else {
        // Unblocked — use resolved position directly
        pos.x = resolved.x;
        pos.z = resolved.z;
        groundY = resolved.groundY;
      }

      // Arena boundary clamping
      const margin = COLLISION_RADIUS;
      pos.x = Math.max(this.bounds.minX + margin, Math.min(this.bounds.maxX - margin, pos.x));
      pos.z = Math.max(this.bounds.minZ + margin, Math.min(this.bounds.maxZ - margin, pos.z));

      this.npc.isMoving = true;
    } else {
      // Idle — still need ground height for gravity
      groundY = this.collision.resolve(pos.x, pos.z, pos.y, COLLISION_RADIUS, NPC_STEP_HEIGHT).groundY;
    }

    // Apply gravity (same physics as PlayerController)
    this.velocityY -= GRAVITY * dt;
    pos.y += this.velocityY * dt;

    // Track highest point while airborne
    if (!this.grounded && pos.y > this.fallPeakY) {
      this.fallPeakY = pos.y;
    }

    // Landing detection
    if (pos.y <= groundY) {
      const wasAirborne = !this.grounded;
      pos.y = groundY;
      this.velocityY = 0;
      this.grounded = true;
      if (wasAirborne) {
        const fallDistance = this.fallPeakY - groundY;
        if (fallDistance > 0) this.onFallDamage?.(fallDistance);
      }
    } else if (this.grounded && pos.y - groundY < GROUND_FOLLOW_THRESHOLD) {
      // Follow descending ground smoothly
      pos.y = groundY;
      this.velocityY = 0;
    } else if (this.grounded && pos.y - groundY >= GROUND_FOLLOW_THRESHOLD) {
      // Walked off a ledge — start falling
      this.grounded = false;
      this.fallPeakY = pos.y;
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
    const NUM_SAMPLES = 12;
    const SAMPLE_DISTS = [2, 4, 8];

    // If we have a move target, bias the search toward it
    const target = this.intent.type === 'moveToward' ? this.intent.target : null;

    let bestDir: THREE.Vector3 | null = null;
    let bestScore = -Infinity;

    for (const sampleDist of SAMPLE_DISTS) {
      for (let i = 0; i < NUM_SAMPLES; i++) {
        const angle = (i / NUM_SAMPLES) * Math.PI * 2;
        const dx = Math.sin(angle);
        const dz = Math.cos(angle);
        const resolved = this.collision.resolve(
          pos.x + dx * sampleDist, pos.z + dz * sampleDist, pos.y, COLLISION_RADIUS, NPC_STEP_HEIGHT
        );

        const heightDelta = resolved.groundY - pos.y;
        const movableDist = Math.sqrt((resolved.x - pos.x) ** 2 + (resolved.z - pos.z) ** 2);
        let score = seekUp ? heightDelta : -heightDelta;

        // Mild bias toward directions that also move toward the target's XZ
        if (target && score > 0) {
          const toTargetX = target.x - pos.x;
          const toTargetZ = target.z - pos.z;
          const toTargetLen = Math.sqrt(toTargetX * toTargetX + toTargetZ * toTargetZ);
          if (toTargetLen > 0.1) {
            const dot = (dx * toTargetX + dz * toTargetZ) / toTargetLen;
            score += dot * 0.5;
          }
        }

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
        pos.x + dx * testDist, pos.z + dz * testDist, pos.y, COLLISION_RADIUS, NPC_STEP_HEIGHT
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

  /** Apply gravity at current XZ (used when dead/stunned to keep falling) */
  private applyGravity(dt: number): void {
    const pos = this.npc.mesh.position;
    const groundY = this.collision.resolve(pos.x, pos.z, pos.y, COLLISION_RADIUS, NPC_STEP_HEIGHT).groundY;
    this.velocityY -= GRAVITY * dt;
    pos.y += this.velocityY * dt;
    if (!this.grounded && pos.y > this.fallPeakY) {
      this.fallPeakY = pos.y;
    }
    if (pos.y <= groundY) {
      const wasAirborne = !this.grounded;
      pos.y = groundY;
      this.velocityY = 0;
      this.grounded = true;
      if (wasAirborne) {
        const fallDistance = this.fallPeakY - groundY;
        if (fallDistance > 0) this.onFallDamage?.(fallDistance);
      }
    } else if (this.grounded && pos.y - groundY < GROUND_FOLLOW_THRESHOLD) {
      pos.y = groundY;
      this.velocityY = 0;
    } else if (this.grounded && pos.y - groundY >= GROUND_FOLLOW_THRESHOLD) {
      this.grounded = false;
      this.fallPeakY = pos.y;
    }
  }

  /** Returns a direction vector pointing away from the nearest hostile hazard, or null if not in danger */
  private getHazardAvoidanceDir(pos: THREE.Vector3): THREE.Vector3 | null {
    let closestDist = Infinity;
    let avoidX = 0;
    let avoidZ = 0;
    let inDanger = false;

    for (const hazard of this.hazards) {
      // Only avoid hazards from hostile entities
      if (!this.npc.isHostileTo(hazard.owner)) continue;

      // Ignore hazards on a different vertical level
      const dy = Math.abs(pos.y - hazard.center.y);
      if (dy > HAZARD_Y_THRESHOLD) continue;

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

  /**
   * When kiting, adjust the desired direction to avoid running into walls,
   * boundaries, or corners. If the direct-away path is blocked or leads near
   * a boundary, sample alternative directions and pick the one with the best
   * combination of clearance, distance from the threat, and distance from walls.
   */
  private adjustKiteDirForWalls(
    pos: THREE.Vector3,
    dir: THREE.Vector3,
    threat: THREE.Vector3
  ): THREE.Vector3 {
    const PROBE_DIST = 2.5;
    const BOUNDARY_MARGIN = 2.0;

    // Quick check: is the current direction clear?
    const probeX = pos.x + dir.x * PROBE_DIST;
    const probeZ = pos.z + dir.z * PROBE_DIST;

    const nearBoundary =
      probeX < this.bounds.minX + BOUNDARY_MARGIN ||
      probeX > this.bounds.maxX - BOUNDARY_MARGIN ||
      probeZ < this.bounds.minZ + BOUNDARY_MARGIN ||
      probeZ > this.bounds.maxZ - BOUNDARY_MARGIN;

    const resolved = this.collision.resolve(probeX, probeZ, pos.y, COLLISION_RADIUS, NPC_STEP_HEIGHT);
    const clearance = Math.sqrt((resolved.x - pos.x) ** 2 + (resolved.z - pos.z) ** 2);
    const blocked = clearance < PROBE_DIST * 0.7;

    if (!nearBoundary && !blocked) return dir; // Path is clear, no adjustment needed

    // Path is obstructed — sample alternative directions and pick the best
    const baseAngle = Math.atan2(dir.x, dir.z);
    let bestDir = dir.clone();
    let bestScore = -Infinity;

    // Score the original direction as baseline
    const origBoundaryDist = Math.min(
      probeX - this.bounds.minX, this.bounds.maxX - probeX,
      probeZ - this.bounds.minZ, this.bounds.maxZ - probeZ
    );
    const origThreatDist = Math.sqrt(
      (pos.x + dir.x - threat.x) ** 2 + (pos.z + dir.z - threat.z) ** 2
    );
    bestScore = clearance * 2 + origThreatDist + Math.max(0, origBoundaryDist) * 0.5;

    // Sample 10 directions, alternating left/right from the original heading
    for (let i = 0; i < 10; i++) {
      const sign = i % 2 === 0 ? 1 : -1;
      const step = Math.ceil((i + 1) / 2);
      const angle = baseAngle + sign * step * (Math.PI / 5); // ~36° steps, up to ±180°

      const cx = Math.sin(angle);
      const cz = Math.cos(angle);

      // Probe clearance
      const cpx = pos.x + cx * PROBE_DIST;
      const cpz = pos.z + cz * PROBE_DIST;
      const cResolved = this.collision.resolve(cpx, cpz, pos.y, COLLISION_RADIUS, NPC_STEP_HEIGHT);
      const cClearance = Math.sqrt((cResolved.x - pos.x) ** 2 + (cResolved.z - pos.z) ** 2);

      // Boundary distance at probe point
      const cBoundaryDist = Math.min(
        cpx - this.bounds.minX, this.bounds.maxX - cpx,
        cpz - this.bounds.minZ, this.bounds.maxZ - cpz
      );

      // How much this direction moves us away from the threat
      const cThreatDist = Math.sqrt(
        (pos.x + cx - threat.x) ** 2 + (pos.z + cz - threat.z) ** 2
      );

      const score = cClearance * 2 + cThreatDist + Math.max(0, cBoundaryDist) * 0.5;

      if (score > bestScore) {
        bestScore = score;
        bestDir = new THREE.Vector3(cx, 0, cz);
      }
    }

    return bestDir;
  }

  /**
   * Generate a WASD-style derangement: a permutation of [0,1,2,3] where no
   * element maps to itself.  Mirrors PlayerController.generateKeyScramble().
   * 0=forward, 1=left, 2=backward, 3=right.
   */
  generateDiscombobScramble(): void {
    const indices = [0, 1, 2, 3];
    let shuffled: number[];
    do {
      shuffled = [...indices];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
    } while (shuffled.some((v, i) => v === i));
    this.discombobMap = shuffled;
    this.discombobActive = true;
    this.discombobAdaptation = 0;
  }

  /**
   * Decompose desiredDir into forward/left/back/right components relative to
   * the NPC's facing, remap them through the scramble, then reconstruct.
   * Blends between scrambled and original based on discombobAdaptation (0→1).
   */
  private applyDiscombobScramble(desiredDir: THREE.Vector3): void {
    const rotY = this.npc.mesh.rotation.y;
    const fwdX = Math.sin(rotY);
    const fwdZ = Math.cos(rotY);
    // right = 90° clockwise from forward
    const rightX = Math.cos(rotY);
    const rightZ = -Math.sin(rotY);

    // Project onto local axes
    const fwdDot = desiredDir.x * fwdX + desiredDir.z * fwdZ;
    const rightDot = desiredDir.x * rightX + desiredDir.z * rightZ;

    // Separate into 4 positive-only cardinal components
    // [0]=forward, [1]=left, [2]=backward, [3]=right
    const components = [
      Math.max(0, fwdDot),    // forward
      Math.max(0, -rightDot), // left
      Math.max(0, -fwdDot),   // backward
      Math.max(0, rightDot),  // right
    ];

    // Direction unit vectors for each cardinal
    // [0]=forward, [1]=left, [2]=backward, [3]=right
    const dirX = [fwdX, -rightX, -fwdX, rightX];
    const dirZ = [fwdZ, -rightZ, -fwdZ, rightZ];

    // Reconstruct with scrambled mapping
    let scrambledX = 0;
    let scrambledZ = 0;
    for (let i = 0; i < 4; i++) {
      const mapped = this.discombobMap[i];
      scrambledX += dirX[mapped] * components[i];
      scrambledZ += dirZ[mapped] * components[i];
    }

    // Normalize scrambled direction
    const sLen = Math.sqrt(scrambledX * scrambledX + scrambledZ * scrambledZ);
    if (sLen > 0.001) {
      scrambledX /= sLen;
      scrambledZ /= sLen;
    }

    // Blend: adaptation 0 = full scramble, 1 = original direction
    const t = this.discombobAdaptation;
    desiredDir.x = desiredDir.x * t + scrambledX * (1 - t);
    desiredDir.z = desiredDir.z * t + scrambledZ * (1 - t);

    const len = Math.sqrt(desiredDir.x * desiredDir.x + desiredDir.z * desiredDir.z);
    if (len > 0.001) {
      desiredDir.x /= len;
      desiredDir.z /= len;
    }
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
