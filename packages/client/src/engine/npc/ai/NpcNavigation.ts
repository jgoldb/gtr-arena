import * as THREE from 'three';
import type { CollisionSystem, NavigationPath, MovingPlatform } from '../../physics/CollisionSystem';
import { getCharacterStats, MELEE_RANGE_THRESHOLD, type CharacterId } from '@gtr/shared';

type NavResult = { type: 'waypoint'; target: THREE.Vector3; stopDistance: number } | { type: 'wait' } | null;

/**
 * Handles archway path-following and elevator/platform awareness for NPC AI.
 *
 * Extracted from NpcAiBrain to keep navigation logic separate from
 * decision-making and combat AI.
 */
export class NpcNavigation {
  private collision: () => CollisionSystem;
  private characterId: CharacterId;

  /** Navigation commitment — prevents frame-by-frame waypoint oscillation.
   *  When the NPC picks a navigation target, it commits for a short duration
   *  before re-evaluating, preventing rapid flipping between waypoints. */
  private cachedNavResult: NavResult = null;
  commitTimer = 0;
  private commitTargetPos: THREE.Vector3 | null = null;

  /** Re-usable constants for detectPathSurface */
  private static readonly PATH_SURFACE_MAX_Y_GAP = 1.5;
  private static readonly PATH_SURFACE_MAX_XZ_DIST = 4;

  constructor(collision: () => CollisionSystem, characterId: CharacterId) {
    this.collision = collision;
    this.characterId = characterId;
  }

  /**
   * Returns a (possibly cached) navigation result, preventing frame-by-frame
   * oscillation between waypoints. Recalculates when: the commit timer expires,
   * the NPC reaches its current waypoint, or the target entity moves significantly.
   */
  resolveNavigation(
    npcPos: THREE.Vector3,
    targetPos: THREE.Vector3,
  ): NavResult {
    const targetMoved = this.commitTargetPos &&
      this.commitTargetPos.distanceTo(targetPos) > 5;
    const reachedWaypoint = this.cachedNavResult?.type === 'waypoint' &&
      npcPos.distanceTo(this.cachedNavResult.target) < this.cachedNavResult.stopDistance + 0.5;
    const needsRecalc = this.commitTimer <= 0 || targetMoved || reachedWaypoint;

    if (needsRecalc) {
      this.cachedNavResult = this.getNavigationTarget(npcPos, targetPos);
      // Wait states (elevator) re-evaluate faster since platform Y changes continuously
      this.commitTimer = this.cachedNavResult?.type === 'wait' ? 0.3 : 1.0;
      this.commitTargetPos = targetPos.clone();
    }

    return this.cachedNavResult;
  }

  /**
   * Determines the next navigation waypoint for the NPC, or signals it should
   * wait (e.g. target on elevator at different level).
   *
   * Returns null when no special navigation is needed (normal behavior applies).
   */
  private getNavigationTarget(
    npcPos: THREE.Vector3,
    targetPos: THREE.Vector3,
  ): NavResult {
    const collision = this.collision();

    // ── Elevator / moving-platform navigation ─────────────────────────
    const platforms = collision.getMovingPlatforms();
    const isMelee = getCharacterStats(this.characterId).autoAttackRange
                    <= MELEE_RANGE_THRESHOLD;

    for (const platform of platforms) {
      const surfaceY = platform.getY();
      const isCircular = platform.isCircular ?? false;

      // XZ containment check (circular for pillars, box for elevators)
      const npcInXZ = isCircular
        ? this.horizDist(npcPos, { x: platform.cx, z: platform.cz }) <= platform.halfW + 0.5
        : (Math.abs(npcPos.x - platform.cx) <= platform.halfW + 0.5 &&
           Math.abs(npcPos.z - platform.cz) <= platform.halfD + 0.5);

      const targetInXZ = isCircular
        ? this.horizDist(targetPos, { x: platform.cx, z: platform.cz }) <= platform.halfW + 0.3
        : (Math.abs(targetPos.x - platform.cx) <= platform.halfW &&
           Math.abs(targetPos.z - platform.cz) <= platform.halfD);

      const npcOnPlatform = npcInXZ && Math.abs(npcPos.y - surfaceY) < 1.5;
      const targetOnPlatform = targetInXZ && Math.abs(targetPos.y - surfaceY) < 0.8;

      // ── Auto-cycling platform anticipation (pillars) ──
      const isCycling = platform.cyclesAutomatically === true
                        && platform.maxY !== undefined
                        && platform.minY !== undefined;

      const isSubmerged = isCycling && surfaceY < (platform.minY! + 1.5);
      const isRaised = isCycling && surfaceY > (platform.maxY! - 1.5);

      // Target is on/near a submerged cycling platform — melee NPCs should
      // move onto the footprint so they ride up together when it rises.
      if (isCycling && targetInXZ && isSubmerged && isMelee) {
        // Use a tight check: NPC must be well inside the actual collider radius
        // (not just the generous npcInXZ tolerance) to guarantee it rides the
        // pillar up. halfW IS the collider radius for circular platforms.
        const npcDistToCenter = this.horizDist(npcPos, { x: platform.cx, z: platform.cz });
        if (npcDistToCenter < platform.halfW - 0.3) {
          // Firmly on the platform — fight normally.
          // When the pillar rises, both entities ride up together.
          return null;
        }
        // Not centered enough — walk to the platform center
        return { type: 'waypoint',
                 target: new THREE.Vector3(platform.cx, npcPos.y, platform.cz),
                 stopDistance: 0.3 };
      }

      // Target is on a raised cycling platform the NPC isn't on —
      // walk to base and wait for it to descend.
      if (isCycling && targetOnPlatform && isRaised && !npcOnPlatform) {
        const distToPlat = this.horizDist(npcPos, { x: platform.cx, z: platform.cz });
        if (distToPlat > platform.halfW + 1) {
          return { type: 'waypoint',
                   target: new THREE.Vector3(platform.cx, npcPos.y, platform.cz),
                   stopDistance: 0.5 };
        }
        return { type: 'wait' };
      }

      // Ranged NPC vs raised cycling platform: re-route if height diff
      // makes attacks impractical.
      if (isCycling && targetOnPlatform && isRaised && !npcOnPlatform && !isMelee) {
        if (Math.abs(surfaceY - npcPos.y) > 4) {
          const distToPlat = this.horizDist(npcPos, { x: platform.cx, z: platform.cz });
          if (distToPlat > platform.halfW + 2) {
            return { type: 'waypoint',
                     target: new THREE.Vector3(platform.cx, npcPos.y, platform.cz),
                     stopDistance: platform.halfW + 1 };
          }
          return { type: 'wait' };
        }
      }

      // ── Standard elevator/platform logic ──
      if (npcOnPlatform) {
        if (surfaceY < 2 && !targetOnPlatform) {
          // Platform at ground level and target is elsewhere — step off
          continue;
        }
        // Elevated — if target is here and reachable, fight normally
        if (targetOnPlatform && Math.abs(npcPos.y - targetPos.y) < 3) return null;
        // Otherwise ride the platform (wait for it to reach target or ground)
        return { type: 'wait' };
      }

      if (targetOnPlatform) {
        // Target is on the platform, NPC is not
        if (Math.abs(surfaceY - npcPos.y) < 3) {
          // Platform is at NPC's level — walk onto it
          return { type: 'waypoint',
                   target: new THREE.Vector3(platform.cx, surfaceY, platform.cz),
                   stopDistance: 1.0 };
        }
        // Platform is at a different level — walk to its XZ position and wait
        const distToPlat = this.horizDist(npcPos, { x: platform.cx, z: platform.cz });
        if (distToPlat > 2) {
          return { type: 'waypoint',
                   target: new THREE.Vector3(platform.cx, npcPos.y, platform.cz),
                   stopDistance: 1.0 };
        }
        return { type: 'wait' };
      }
    }

    // Target above all archway peaks — only reachable by elevator.
    // Find the non-cycling platform (elevator) specifically.
    if (targetPos.y > 18) {
      const elevator = platforms.find(p => !p.cyclesAutomatically);
      if (elevator) {
        const surfaceY = elevator.getY();
        if (Math.abs(surfaceY - npcPos.y) < 3) {
          return { type: 'waypoint',
                   target: new THREE.Vector3(elevator.cx, surfaceY, elevator.cz),
                   stopDistance: 1.0 };
        }
        const distToPlat = this.horizDist(npcPos, { x: elevator.cx, z: elevator.cz });
        if (distToPlat > 2) {
          return { type: 'waypoint',
                   target: new THREE.Vector3(elevator.cx, npcPos.y, elevator.cz),
                   stopDistance: 1.0 };
        }
        return { type: 'wait' };
      }
    }

    // ── Archway path-following ──────────────────────────────────────────
    // Uses Y-aligned surface detection instead of elevation thresholds.
    // An entity is "on a path" when it's near a waypoint AND at the same
    // elevation (within step height). This prevents an NPC underneath an
    // arch tube from matching to waypoints on the surface above.
    const paths = collision.getNavigationPaths();
    if (paths.length === 0) return null;

    let npcOnPath = this.detectPathSurface(paths, npcPos);
    const targetOnPath = this.detectPathSurface(paths, targetPos);

    // If the NPC is barely on a low ramp WP and the target is on the ground,
    // the NPC is effectively at ground level — skip path navigation so it
    // walks directly toward the target instead of being routed up the arch.
    if (npcOnPath && !targetOnPath && npcPos.y < 1.0) {
      const wp = npcOnPath.path.waypoints[npcOnPath.wpIdx];
      if (wp.y < 2.0) npcOnPath = null;
    }

    // ── Both on the same archway — follow waypoints toward target ──
    if (npcOnPath && targetOnPath && npcOnPath.path === targetOnPath.path) {
      if (Math.abs(npcOnPath.wpIdx - targetOnPath.wpIdx) <= 1) return null;
      const dir = targetOnPath.wpIdx > npcOnPath.wpIdx ? 1 : -1;
      const wps = npcOnPath.path.waypoints;
      const nextIdx = this.advanceAlongChain(wps, npcPos, npcOnPath.wpIdx + dir, dir, targetOnPath.wpIdx);
      const wp = wps[nextIdx];
      return { type: 'waypoint', target: new THREE.Vector3(wp.x, wp.y, wp.z), stopDistance: 0.8 };
    }

    // ── NPC on a path, target elsewhere — exit toward target ──
    if (npcOnPath) {
      return this.navigateExitPath(npcOnPath, npcPos, targetPos);
    }

    // ── NPC on ground, target on a path — enter via approach waypoint ──
    if (targetOnPath) {
      return this.navigateEnterPath(targetOnPath, npcPos);
    }

    // ── Both on the ground — check if NPC still needs to clear a ramp ──
    if (npcPos.y > 0.5) {
      return this.findNearbyArchwayExit(paths, npcPos, targetPos);
    }
    return null;
  }

  /** Detect which archway path surface an entity is physically standing on.
   *  Matches by Y-alignment (within step height) + horizontal proximity, so
   *  an entity underneath a tube won't match to waypoints on the surface above. */
  private detectPathSurface(
    paths: readonly NavigationPath[],
    pos: THREE.Vector3,
  ): { path: NavigationPath; wpIdx: number } | null {
    const MAX_Y = NpcNavigation.PATH_SURFACE_MAX_Y_GAP;
    const MAX_XZ = NpcNavigation.PATH_SURFACE_MAX_XZ_DIST;

    let bestPath: NavigationPath | null = null;
    let bestIdx = -1;
    let bestScore = Infinity;

    for (const path of paths) {
      const wps = path.waypoints;
      for (let i = 0; i < wps.length; i++) {
        const wp = wps[i];
        const yGap = Math.abs(pos.y - wp.y);
        if (yGap > MAX_Y) continue;
        const dx = pos.x - wp.x;
        const dz = pos.z - wp.z;
        const xzDist = Math.sqrt(dx * dx + dz * dz);
        if (xzDist > MAX_XZ) continue;
        const score = xzDist + yGap * 2; // Weight Y alignment heavily
        if (score < bestScore) {
          bestScore = score;
          bestPath = path;
          bestIdx = i;
        }
      }
    }

    return bestPath && bestScore < 5 ? { path: bestPath, wpIdx: bestIdx } : null;
  }

  /** NPC is on a path surface, target is elsewhere — route toward the best exit. */
  private navigateExitPath(
    npcOnPath: { path: NavigationPath; wpIdx: number },
    npcPos: THREE.Vector3,
    targetPos: THREE.Vector3,
  ): { type: 'waypoint'; target: THREE.Vector3; stopDistance: number } | null {
    const wps = npcOnPath.path.waypoints;
    const npcWpIdx = npcOnPath.wpIdx;

    // Pick exit (chain end) that minimises total travel:
    // actual walk distance along chain to exit + horizontal distance from exit to target
    const startWp = wps[0];
    const endWp = wps[wps.length - 1];
    const startCost = this.chainDistance(wps, npcWpIdx, 0) +
      Math.sqrt((startWp.x - targetPos.x) ** 2 + (startWp.z - targetPos.z) ** 2);
    const endCost = this.chainDistance(wps, npcWpIdx, wps.length - 1) +
      Math.sqrt((endWp.x - targetPos.x) ** 2 + (endWp.z - targetPos.z) ** 2);
    const exitIdx = startCost < endCost ? 0 : wps.length - 1;

    // Close to exit approach WP — safe to disengage
    const exitWp = wps[exitIdx];
    const dx = npcPos.x - exitWp.x;
    const dy = npcPos.y - exitWp.y;
    const dz = npcPos.z - exitWp.z;
    if (dx * dx + dy * dy + dz * dz < 4) return null; // Within 2 units

    // Follow chain toward exit, skipping nearby waypoints
    if (Math.abs(npcWpIdx - exitIdx) <= 1) {
      // 0-1 steps from exit but > 2 units away — route directly to exit WP
      return { type: 'waypoint', target: new THREE.Vector3(exitWp.x, exitWp.y, exitWp.z), stopDistance: 0.8 };
    }
    const dir = exitIdx > npcWpIdx ? 1 : -1;
    const nextIdx = this.advanceAlongChain(wps, npcPos, npcWpIdx + dir, dir, exitIdx);
    const wp = wps[nextIdx];
    return { type: 'waypoint', target: new THREE.Vector3(wp.x, wp.y, wp.z), stopDistance: 0.8 };
  }

  /** NPC is on the ground, target is on a path — route to the best approach WP. */
  private navigateEnterPath(
    targetOnPath: { path: NavigationPath; wpIdx: number },
    npcPos: THREE.Vector3,
  ): { type: 'waypoint'; target: THREE.Vector3; stopDistance: number } {
    const wps = targetOnPath.path.waypoints;
    const targetWpIdx = targetOnPath.wpIdx;

    // Pick approach WP (chain end) that minimises total travel:
    // horizontal distance NPC → approach + actual walk distance along chain to target
    const startWp = wps[0];
    const endWp = wps[wps.length - 1];
    const startCost = this.horizDist(npcPos, startWp) + this.chainDistance(wps, 0, targetWpIdx);
    const endCost = this.horizDist(npcPos, endWp) + this.chainDistance(wps, wps.length - 1, targetWpIdx);
    const approachWp = startCost < endCost ? startWp : endWp;

    return { type: 'waypoint', target: new THREE.Vector3(approachWp.x, 0, approachWp.z), stopDistance: 2.0 };
  }

  horizDist(a: THREE.Vector3, b: { x: number; z: number }): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /** Advance along a waypoint chain from startIdx toward destIdx, skipping
   *  waypoints that are too close to the NPC (< 2 units). At archway peaks
   *  the curve flattens and consecutive waypoints cluster tightly — without
   *  this the NPC "arrives" instantly and stalls. */
  private advanceAlongChain(
    wps: readonly { readonly x: number; readonly y: number; readonly z: number }[],
    npcPos: THREE.Vector3,
    startIdx: number,
    dir: number,
    destIdx: number,
  ): number {
    let idx = startIdx;
    while (idx !== destIdx) {
      const wp = wps[idx];
      const dx = npcPos.x - wp.x;
      const dy = npcPos.y - wp.y;
      const dz = npcPos.z - wp.z;
      if (dx * dx + dy * dy + dz * dz >= 4) break; // >= 2 units away
      const next = idx + dir;
      if (next < 0 || next >= wps.length) break;
      idx = next;
    }
    return idx;
  }

  /** Compute the actual walk distance along the waypoint chain between two indices. */
  private chainDistance(
    wps: readonly { readonly x: number; readonly y: number; readonly z: number }[],
    fromIdx: number,
    toIdx: number,
  ): number {
    let dist = 0;
    const step = toIdx > fromIdx ? 1 : -1;
    for (let i = fromIdx; i !== toIdx; i += step) {
      const a = wps[i];
      const b = wps[i + step];
      dist += Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
    }
    return dist;
  }

  /** When the NPC is slightly elevated (below the archway threshold but still
   *  on a ramp), find the nearest archway exit approach waypoint to guide it
   *  off the ramp before allowing direct movement toward the target. */
  private findNearbyArchwayExit(
    paths: readonly NavigationPath[],
    npcPos: THREE.Vector3,
    targetPos: THREE.Vector3,
  ): { type: 'waypoint'; target: THREE.Vector3; stopDistance: number } | null {
    for (const path of paths) {
      const wps = path.waypoints;
      for (let i = 0; i < wps.length; i++) {
        const wp = wps[i];
        if (wp.y < 0.5) continue; // Skip ground-level approach WPs
        const dx = npcPos.x - wp.x;
        const dy = npcPos.y - wp.y;
        const dz = npcPos.z - wp.z;
        if (dx * dx + dy * dy + dz * dz < 9) { // Within 3 units of an elevated WP
          // Route to the chain end that minimises total travel to the target
          const s = wps[0];
          const e = wps[wps.length - 1];
          const sDist = this.horizDist(npcPos, s);
          const eDist = this.horizDist(npcPos, e);
          const sToTarget = Math.sqrt((s.x - targetPos.x) ** 2 + (s.z - targetPos.z) ** 2);
          const eToTarget = Math.sqrt((e.x - targetPos.x) ** 2 + (e.z - targetPos.z) ** 2);
          const exitWp = (sDist + sToTarget) < (eDist + eToTarget) ? s : e;
          return { type: 'waypoint', target: new THREE.Vector3(exitWp.x, 0, exitWp.z), stopDistance: 1.0 };
        }
      }
    }
    return null;
  }
}
