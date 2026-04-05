import * as THREE from 'three';
import type { CollisionSystem, MovingPlatform } from '../../physics/CollisionSystem';
import { getCharacterStats, MELEE_RANGE_THRESHOLD, type CharacterId } from '@gtr/shared';
import type { NavNode, NavigationGraph } from './NavigationGraph';

type NavResult = { type: 'waypoint'; target: THREE.Vector3; stopDistance: number } | { type: 'wait' } | null;

/**
 * Graph-based NPC navigation.
 *
 * Uses the NavigationGraph (built at map init from archway chains + elevator +
 * ground connectors) to find optimal routes via A*. Falls back to the legacy
 * heuristic-based navigation when no graph is available.
 */
export class NpcNavigation {
  private collision: () => CollisionSystem;
  private characterId: CharacterId;

  /** Cached A* path — sequence of graph nodes to follow. */
  private cachedPath: NavNode[] | null = null;
  private pathIndex = 0;

  /** Navigation commitment — prevents frame-by-frame recalculation. */
  commitTimer = 0;
  private commitTargetPos: THREE.Vector3 | null = null;

  /** Threshold: if both NPC and target are below this Y and within LoS, skip graph. */
  private static readonly GROUND_Y_THRESHOLD = 1.0;
  /** Distance to a waypoint node before advancing to the next one. */
  private static readonly WP_ARRIVE_DIST = 2.0;
  /** Y-weighted distance for nearest-node lookups to prevent matching under arches. */
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
    const collision = this.collision();
    const graph = collision.getNavigationGraph();

    // If no graph, fall back to legacy navigation
    if (!graph) return this.legacyResolveNavigation(npcPos, targetPos);

    const targetMoved = this.commitTargetPos &&
      this.commitTargetPos.distanceTo(targetPos) > 5;
    const reachedWaypoint = this.cachedPath && this.pathIndex < this.cachedPath.length &&
      this.nodeDistXZ(npcPos, this.cachedPath[this.pathIndex]) < NpcNavigation.WP_ARRIVE_DIST;
    const needsRecalc = this.commitTimer <= 0 || targetMoved || !this.cachedPath;

    // Advance through reached waypoints without requiring full recalc
    if (this.cachedPath && reachedWaypoint) {
      this.pathIndex++;
      // If we've reached the end, trigger recalc
      if (this.pathIndex >= this.cachedPath.length) {
        this.cachedPath = null;
      }
    }

    if (needsRecalc) {
      const result = this.computeGraphPath(npcPos, targetPos, graph, collision);
      this.commitTimer = result?.type === 'wait' ? 0.3 : 1.0;
      this.commitTargetPos = targetPos.clone();
      if (!result) return null;
      if (result.type === 'wait') return result;
    }

    // Return current waypoint from cached path
    if (this.cachedPath && this.pathIndex < this.cachedPath.length) {
      const node = this.cachedPath[this.pathIndex];

      // Platform wait: if next node is a platform node and we're close in XZ
      // but not at the right Y, wait for the elevator
      if (node.type === 'platform' && node.y > 1.5) {
        const xzDist = this.nodeDistXZ(npcPos, node);
        if (xzDist < 3 && Math.abs(npcPos.y - node.y) > 2) {
          return { type: 'wait' };
        }
      }

      return {
        type: 'waypoint',
        target: new THREE.Vector3(node.x, node.y, node.z),
        stopDistance: 0.8,
      };
    }

    return null;
  }

  /**
   * Compute a new path using the navigation graph.
   * Returns a NavResult for immediate use and populates cachedPath for follow-up frames.
   */
  private computeGraphPath(
    npcPos: THREE.Vector3,
    targetPos: THREE.Vector3,
    graph: NavigationGraph,
    collision: CollisionSystem,
  ): NavResult {
    this.cachedPath = null;
    this.pathIndex = 0;

    // ── Quick exit: both on ground with line-of-sight ──
    const bothOnGround = npcPos.y < NpcNavigation.GROUND_Y_THRESHOLD &&
                         targetPos.y < NpcNavigation.GROUND_Y_THRESHOLD;
    if (bothOnGround) {
      const hasLoS = collision.hasLineOfSight(
        npcPos.x, npcPos.z, targetPos.x, targetPos.z,
        npcPos.y, targetPos.y,
      );
      if (hasLoS) return null; // Direct movement, no routing needed
    }

    // ── Check moving platforms first (elevator/pillar special cases) ──
    const platformResult = this.checkPlatforms(npcPos, targetPos, collision);
    if (platformResult) return platformResult;

    // ── A* pathfinding on graph ──
    const path = graph.findPath(
      npcPos.x, npcPos.y, npcPos.z,
      targetPos.x, targetPos.y, targetPos.z,
    );

    if (!path || path.length === 0) {
      // No graph path — check if NPC is slightly elevated (on a ramp) and
      // needs help getting off. Use legacy archway exit logic.
      if (npcPos.y > 0.5) {
        return this.findNearbyArchwayExit(npcPos, targetPos, collision);
      }
      return null;
    }

    // Trim leading nodes the NPC has already passed (within arrive distance)
    let startIdx = 0;
    while (startIdx < path.length - 1 && this.nodeDistWeighted(npcPos, path[startIdx]) < NpcNavigation.WP_ARRIVE_DIST) {
      startIdx++;
    }

    // If the path is all ground-level nodes and NPC has LoS to target, skip it.
    // This prevents unnecessary waypoint routing when direct movement works.
    const allGround = path.every(n => n.y < 1.5);
    if (allGround && bothOnGround) return null;

    this.cachedPath = path.slice(startIdx);
    this.pathIndex = 0;

    if (this.cachedPath.length === 0) return null;

    const firstNode = this.cachedPath[0];

    // Platform wait state
    if (firstNode.type === 'platform' && firstNode.y > 1.5) {
      const xzDist = this.nodeDistXZ(npcPos, firstNode);
      if (xzDist < 3 && Math.abs(npcPos.y - firstNode.y) > 2) {
        return { type: 'wait' };
      }
    }

    return {
      type: 'waypoint',
      target: new THREE.Vector3(firstNode.x, firstNode.y, firstNode.z),
      stopDistance: 0.8,
    };
  }

  /**
   * Handle moving platform interactions directly — these need real-time Y checks
   * that the static graph edges can't fully capture.
   */
  private checkPlatforms(
    npcPos: THREE.Vector3,
    targetPos: THREE.Vector3,
    collision: CollisionSystem,
  ): NavResult {
    const platforms = collision.getMovingPlatforms();
    const isMelee = getCharacterStats(this.characterId).autoAttackRange
                    <= MELEE_RANGE_THRESHOLD;

    for (const platform of platforms) {
      const surfaceY = platform.getY();
      const isCircular = platform.isCircular ?? false;

      const npcInXZ = isCircular
        ? this.horizDist(npcPos.x, npcPos.z, platform.cx, platform.cz) <= platform.halfW + 0.5
        : (Math.abs(npcPos.x - platform.cx) <= platform.halfW + 0.5 &&
           Math.abs(npcPos.z - platform.cz) <= platform.halfD + 0.5);

      const targetInXZ = isCircular
        ? this.horizDist(targetPos.x, targetPos.z, platform.cx, platform.cz) <= platform.halfW + 0.3
        : (Math.abs(targetPos.x - platform.cx) <= platform.halfW &&
           Math.abs(targetPos.z - platform.cz) <= platform.halfD);

      const npcOnPlatform = npcInXZ && Math.abs(npcPos.y - surfaceY) < 1.5;
      const targetOnPlatform = targetInXZ && Math.abs(targetPos.y - surfaceY) < 0.8;

      // ── Auto-cycling platform (pillars) ──
      const isCycling = platform.cyclesAutomatically === true
                        && platform.maxY !== undefined
                        && platform.minY !== undefined;

      if (isCycling) {
        const isSubmerged = surfaceY < (platform.minY! + 1.5);
        const isRaised = surfaceY > (platform.maxY! - 1.5);

        if (targetInXZ && isSubmerged && isMelee) {
          const npcDistToCenter = this.horizDist(npcPos.x, npcPos.z, platform.cx, platform.cz);
          if (npcDistToCenter < platform.halfW - 0.3) return null;
          return { type: 'waypoint',
                   target: new THREE.Vector3(platform.cx, npcPos.y, platform.cz),
                   stopDistance: 0.3 };
        }

        if (targetOnPlatform && isRaised && !npcOnPlatform) {
          const distToPlat = this.horizDist(npcPos.x, npcPos.z, platform.cx, platform.cz);
          if (distToPlat > platform.halfW + 1) {
            return { type: 'waypoint',
                     target: new THREE.Vector3(platform.cx, npcPos.y, platform.cz),
                     stopDistance: 0.5 };
          }
          return { type: 'wait' };
        }

        if (targetOnPlatform && isRaised && !npcOnPlatform && !isMelee) {
          if (Math.abs(surfaceY - npcPos.y) > 4) {
            const distToPlat = this.horizDist(npcPos.x, npcPos.z, platform.cx, platform.cz);
            if (distToPlat > platform.halfW + 2) {
              return { type: 'waypoint',
                       target: new THREE.Vector3(platform.cx, npcPos.y, platform.cz),
                       stopDistance: platform.halfW + 1 };
            }
            return { type: 'wait' };
          }
        }
        continue; // Don't fall through to standard platform logic for cycling platforms
      }

      // ── Standard elevator/platform logic ──
      if (npcOnPlatform) {
        if (surfaceY < 2 && !targetOnPlatform) continue; // Step off at ground
        if (targetOnPlatform && Math.abs(npcPos.y - targetPos.y) < 3) return null;
        return { type: 'wait' }; // Ride it
      }

      if (targetOnPlatform) {
        if (Math.abs(surfaceY - npcPos.y) < 3) {
          return { type: 'waypoint',
                   target: new THREE.Vector3(platform.cx, surfaceY, platform.cz),
                   stopDistance: 1.0 };
        }
        const distToPlat = this.horizDist(npcPos.x, npcPos.z, platform.cx, platform.cz);
        if (distToPlat > 2) {
          return { type: 'waypoint',
                   target: new THREE.Vector3(platform.cx, npcPos.y, platform.cz),
                   stopDistance: 1.0 };
        }
        return { type: 'wait' };
      }
    }

    // Target above archway peaks — route to elevator
    if (targetPos.y > 18) {
      const elevator = platforms.find(p => !p.cyclesAutomatically);
      if (elevator) {
        const surfaceY = elevator.getY();
        if (Math.abs(surfaceY - npcPos.y) < 3) {
          return { type: 'waypoint',
                   target: new THREE.Vector3(elevator.cx, surfaceY, elevator.cz),
                   stopDistance: 1.0 };
        }
        const distToPlat = this.horizDist(npcPos.x, npcPos.z, elevator.cx, elevator.cz);
        if (distToPlat > 2) {
          return { type: 'waypoint',
                   target: new THREE.Vector3(elevator.cx, npcPos.y, elevator.cz),
                   stopDistance: 1.0 };
        }
        return { type: 'wait' };
      }
    }

    return null; // No platform interaction
  }

  /**
   * When the NPC is slightly elevated (on a ramp) but not matched to a graph
   * path node, find the nearest archway exit to guide it off the ramp.
   */
  private findNearbyArchwayExit(
    npcPos: THREE.Vector3,
    targetPos: THREE.Vector3,
    collision: CollisionSystem,
  ): NavResult {
    const paths = collision.getNavigationPaths();
    for (const path of paths) {
      const wps = path.waypoints;
      for (let i = 0; i < wps.length; i++) {
        const wp = wps[i];
        if (wp.y < 0.5) continue;
        const dx = npcPos.x - wp.x;
        const dy = npcPos.y - wp.y;
        const dz = npcPos.z - wp.z;
        if (dx * dx + dy * dy + dz * dz < 9) {
          // Near an elevated waypoint — route to the chain end closest to target
          const s = wps[0];
          const e = wps[wps.length - 1];
          const sDist = this.horizDist(npcPos.x, npcPos.z, s.x, s.z);
          const eDist = this.horizDist(npcPos.x, npcPos.z, e.x, e.z);
          const sToTarget = this.horizDist(s.x, s.z, targetPos.x, targetPos.z);
          const eToTarget = this.horizDist(e.x, e.z, targetPos.x, targetPos.z);
          const exitWp = (sDist + sToTarget) < (eDist + eToTarget) ? s : e;
          return { type: 'waypoint', target: new THREE.Vector3(exitWp.x, 0, exitWp.z), stopDistance: 1.0 };
        }
      }
    }
    return null;
  }

  // ── Legacy navigation (fallback when no graph is available) ──────────

  /** Legacy path surface detection — used as fallback */
  private legacyDetectPathSurface(
    paths: readonly import('../../physics/CollisionSystem').NavigationPath[],
    pos: THREE.Vector3,
  ): { path: import('../../physics/CollisionSystem').NavigationPath; wpIdx: number } | null {
    const MAX_Y = NpcNavigation.PATH_SURFACE_MAX_Y_GAP;
    const MAX_XZ = NpcNavigation.PATH_SURFACE_MAX_XZ_DIST;

    let bestPath: import('../../physics/CollisionSystem').NavigationPath | null = null;
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
        const score = xzDist + yGap * 2;
        if (score < bestScore) {
          bestScore = score;
          bestPath = path;
          bestIdx = i;
        }
      }
    }

    return bestPath && bestScore < 5 ? { path: bestPath, wpIdx: bestIdx } : null;
  }

  /** Full legacy navigation — used when no NavigationGraph is available. */
  private legacyResolveNavigation(
    npcPos: THREE.Vector3,
    targetPos: THREE.Vector3,
  ): NavResult {
    const collision = this.collision();
    const platforms = collision.getMovingPlatforms();
    const isMelee = getCharacterStats(this.characterId).autoAttackRange
                    <= MELEE_RANGE_THRESHOLD;

    // Platform handling (same as checkPlatforms)
    for (const platform of platforms) {
      const surfaceY = platform.getY();
      const isCircular = platform.isCircular ?? false;

      const npcInXZ = isCircular
        ? this.horizDist(npcPos.x, npcPos.z, platform.cx, platform.cz) <= platform.halfW + 0.5
        : (Math.abs(npcPos.x - platform.cx) <= platform.halfW + 0.5 &&
           Math.abs(npcPos.z - platform.cz) <= platform.halfD + 0.5);
      const targetInXZ = isCircular
        ? this.horizDist(targetPos.x, targetPos.z, platform.cx, platform.cz) <= platform.halfW + 0.3
        : (Math.abs(targetPos.x - platform.cx) <= platform.halfW &&
           Math.abs(targetPos.z - platform.cz) <= platform.halfD);
      const npcOnPlatform = npcInXZ && Math.abs(npcPos.y - surfaceY) < 1.5;
      const targetOnPlatform = targetInXZ && Math.abs(targetPos.y - surfaceY) < 0.8;

      const isCycling = platform.cyclesAutomatically === true
                        && platform.maxY !== undefined && platform.minY !== undefined;
      const isSubmerged = isCycling && surfaceY < (platform.minY! + 1.5);
      const isRaised = isCycling && surfaceY > (platform.maxY! - 1.5);

      if (isCycling && targetInXZ && isSubmerged && isMelee) {
        const d = this.horizDist(npcPos.x, npcPos.z, platform.cx, platform.cz);
        if (d < platform.halfW - 0.3) return null;
        return { type: 'waypoint', target: new THREE.Vector3(platform.cx, npcPos.y, platform.cz), stopDistance: 0.3 };
      }
      if (isCycling && targetOnPlatform && isRaised && !npcOnPlatform) {
        const d = this.horizDist(npcPos.x, npcPos.z, platform.cx, platform.cz);
        if (d > platform.halfW + 1) return { type: 'waypoint', target: new THREE.Vector3(platform.cx, npcPos.y, platform.cz), stopDistance: 0.5 };
        return { type: 'wait' };
      }
      if (npcOnPlatform) {
        if (surfaceY < 2 && !targetOnPlatform) continue;
        if (targetOnPlatform && Math.abs(npcPos.y - targetPos.y) < 3) return null;
        return { type: 'wait' };
      }
      if (targetOnPlatform) {
        if (Math.abs(surfaceY - npcPos.y) < 3) return { type: 'waypoint', target: new THREE.Vector3(platform.cx, surfaceY, platform.cz), stopDistance: 1.0 };
        const d = this.horizDist(npcPos.x, npcPos.z, platform.cx, platform.cz);
        if (d > 2) return { type: 'waypoint', target: new THREE.Vector3(platform.cx, npcPos.y, platform.cz), stopDistance: 1.0 };
        return { type: 'wait' };
      }
    }

    if (targetPos.y > 18) {
      const elevator = platforms.find(p => !p.cyclesAutomatically);
      if (elevator) {
        const surfaceY = elevator.getY();
        if (Math.abs(surfaceY - npcPos.y) < 3) return { type: 'waypoint', target: new THREE.Vector3(elevator.cx, surfaceY, elevator.cz), stopDistance: 1.0 };
        const d = this.horizDist(npcPos.x, npcPos.z, elevator.cx, elevator.cz);
        if (d > 2) return { type: 'waypoint', target: new THREE.Vector3(elevator.cx, npcPos.y, elevator.cz), stopDistance: 1.0 };
        return { type: 'wait' };
      }
    }

    // Legacy archway path-following
    const paths = collision.getNavigationPaths();
    if (paths.length === 0) return null;

    let npcOnPath = this.legacyDetectPathSurface(paths, npcPos);
    const targetOnPath = this.legacyDetectPathSurface(paths, targetPos);

    if (npcOnPath && !targetOnPath && npcPos.y < 1.0) {
      const wp = npcOnPath.path.waypoints[npcOnPath.wpIdx];
      if (wp.y < 2.0) npcOnPath = null;
    }

    if (npcOnPath && targetOnPath && npcOnPath.path === targetOnPath.path) {
      if (Math.abs(npcOnPath.wpIdx - targetOnPath.wpIdx) <= 1) return null;
      const dir = targetOnPath.wpIdx > npcOnPath.wpIdx ? 1 : -1;
      const wps = npcOnPath.path.waypoints;
      const nextIdx = this.legacyAdvanceAlongChain(wps, npcPos, npcOnPath.wpIdx + dir, dir, targetOnPath.wpIdx);
      const wp = wps[nextIdx];
      return { type: 'waypoint', target: new THREE.Vector3(wp.x, wp.y, wp.z), stopDistance: 0.8 };
    }
    if (npcOnPath) return this.legacyNavigateExitPath(npcOnPath, npcPos, targetPos);
    if (targetOnPath) return this.legacyNavigateEnterPath(targetOnPath, npcPos);

    if (npcPos.y > 0.5) return this.findNearbyArchwayExit(npcPos, targetPos, collision);
    return null;
  }

  private legacyAdvanceAlongChain(
    wps: readonly { readonly x: number; readonly y: number; readonly z: number }[],
    npcPos: THREE.Vector3, startIdx: number, dir: number, destIdx: number,
  ): number {
    let idx = startIdx;
    while (idx !== destIdx) {
      const wp = wps[idx];
      const dx = npcPos.x - wp.x, dy = npcPos.y - wp.y, dz = npcPos.z - wp.z;
      if (dx * dx + dy * dy + dz * dz >= 4) break;
      const next = idx + dir;
      if (next < 0 || next >= wps.length) break;
      idx = next;
    }
    return idx;
  }

  private legacyNavigateExitPath(
    npcOnPath: { path: import('../../physics/CollisionSystem').NavigationPath; wpIdx: number },
    npcPos: THREE.Vector3, targetPos: THREE.Vector3,
  ): NavResult {
    const wps = npcOnPath.path.waypoints;
    const npcWpIdx = npcOnPath.wpIdx;
    const startWp = wps[0], endWp = wps[wps.length - 1];
    const startCost = this.legacyChainDistance(wps, npcWpIdx, 0) +
      this.horizDist(startWp.x, startWp.z, targetPos.x, targetPos.z);
    const endCost = this.legacyChainDistance(wps, npcWpIdx, wps.length - 1) +
      this.horizDist(endWp.x, endWp.z, targetPos.x, targetPos.z);
    const exitIdx = startCost < endCost ? 0 : wps.length - 1;
    const exitWp = wps[exitIdx];
    const dx = npcPos.x - exitWp.x, dy = npcPos.y - exitWp.y, dz = npcPos.z - exitWp.z;
    if (dx * dx + dy * dy + dz * dz < 4) return null;
    if (Math.abs(npcWpIdx - exitIdx) <= 1) {
      return { type: 'waypoint', target: new THREE.Vector3(exitWp.x, exitWp.y, exitWp.z), stopDistance: 0.8 };
    }
    const dir = exitIdx > npcWpIdx ? 1 : -1;
    const nextIdx = this.legacyAdvanceAlongChain(wps, npcPos, npcWpIdx + dir, dir, exitIdx);
    const wp = wps[nextIdx];
    return { type: 'waypoint', target: new THREE.Vector3(wp.x, wp.y, wp.z), stopDistance: 0.8 };
  }

  private legacyNavigateEnterPath(
    targetOnPath: { path: import('../../physics/CollisionSystem').NavigationPath; wpIdx: number },
    npcPos: THREE.Vector3,
  ): NavResult {
    const wps = targetOnPath.path.waypoints;
    const targetWpIdx = targetOnPath.wpIdx;
    const startWp = wps[0], endWp = wps[wps.length - 1];
    const startCost = this.horizDist(npcPos.x, npcPos.z, startWp.x, startWp.z) +
      this.legacyChainDistance(wps, 0, targetWpIdx);
    const endCost = this.horizDist(npcPos.x, npcPos.z, endWp.x, endWp.z) +
      this.legacyChainDistance(wps, wps.length - 1, targetWpIdx);
    const approachWp = startCost < endCost ? startWp : endWp;
    return { type: 'waypoint', target: new THREE.Vector3(approachWp.x, 0, approachWp.z), stopDistance: 2.0 };
  }

  private legacyChainDistance(
    wps: readonly { readonly x: number; readonly y: number; readonly z: number }[],
    fromIdx: number, toIdx: number,
  ): number {
    let dist = 0;
    const step = toIdx > fromIdx ? 1 : -1;
    for (let i = fromIdx; i !== toIdx; i += step) {
      const a = wps[i], b = wps[i + step];
      dist += Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
    }
    return dist;
  }

  // ── Utility ──────────────────────────────────────────────────────────

  private horizDist(ax: number, az: number, bx: number, bz: number): number {
    const dx = ax - bx;
    const dz = az - bz;
    return Math.sqrt(dx * dx + dz * dz);
  }

  private nodeDistXZ(pos: THREE.Vector3, node: NavNode): number {
    const dx = pos.x - node.x;
    const dz = pos.z - node.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  private nodeDistWeighted(pos: THREE.Vector3, node: NavNode): number {
    const dx = pos.x - node.x;
    const dy = (pos.y - node.y) * 2;
    const dz = pos.z - node.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}
