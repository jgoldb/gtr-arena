/**
 * Constructs a NavigationGraph from the collision system's registered
 * NavigationPaths (archway waypoint chains) and MovingPlatforms (elevator).
 *
 * The resulting graph connects:
 *  - Archway waypoints (sequential chain edges)
 *  - Ground-level connector nodes (between arch approaches and elevator)
 *  - Elevator nodes with dynamic edges that enable/disable based on Y position
 */

import { NavigationGraph } from './NavigationGraph';
import type { NavigationPath, MovingPlatform } from '../../physics/CollisionSystem';

/** Distance at which two positions are considered "close enough" to connect. */
const GROUND_CONNECT_MAX_DIST = 60;
/** Elevator edge is traversable when platform surface is within this Y of the node. */
const ELEVATOR_Y_TOLERANCE = 2.0;
/** Extra cost added to elevator edges to account for wait time. */
const ELEVATOR_WAIT_COST = 8;

export function buildNavigationGraph(
  paths: readonly NavigationPath[],
  platforms: readonly MovingPlatform[],
): NavigationGraph {
  const graph = new NavigationGraph();

  // ── 1. Add archway waypoint chains as nodes + sequential edges ─────

  /** Maps path index → array of node IDs for that path's waypoints */
  const pathNodeIds: number[][] = [];

  for (const path of paths) {
    const wps = path.waypoints;
    const ids: number[] = [];

    for (const wp of wps) {
      ids.push(graph.addNode(wp.x, wp.y, wp.z, 'archway'));
    }

    // Sequential edges along the chain (bidirectional)
    for (let i = 0; i < ids.length - 1; i++) {
      const a = graph.getNode(ids[i]);
      const b = graph.getNode(ids[i + 1]);
      const cost = dist3d(a.x, a.y, a.z, b.x, b.y, b.z);
      graph.addBidirectionalEdge(ids[i], ids[i + 1], cost);
    }

    pathNodeIds.push(ids);
  }

  // ── 2. Collect ground-level "approach" nodes (chain endpoints) ─────

  /** Node IDs of all ground-level approach waypoints (first/last of each chain). */
  const groundApproachIds: number[] = [];

  for (const ids of pathNodeIds) {
    if (ids.length === 0) continue;
    const firstNode = graph.getNode(ids[0]);
    const lastNode = graph.getNode(ids[ids.length - 1]);
    if (firstNode.y < 1.5) groundApproachIds.push(ids[0]);
    if (lastNode.y < 1.5) groundApproachIds.push(ids[ids.length - 1]);
  }

  // ─��� 3. Add elevator nodes ─────────────────────────────────────────

  const elevatorNodeIds: number[] = [];

  for (const platform of platforms) {
    if (platform.cyclesAutomatically) continue; // Skip auto-cycling pillars

    // Boarding node at ground level
    const boardingId = graph.addNode(platform.cx, 0, platform.cz, 'platform');
    elevatorNodeIds.push(boardingId);

    // Connect boarding node to ground approaches
    groundApproachIds.push(boardingId);

    // Destination nodes at each elevator stop.
    // The Celestial Ballroom elevator visits: ground (0.2), mid (13.5), sky (40)
    const stops = [0.2, 13.5, 40];

    const stopNodeIds: number[] = [];
    for (const stopY of stops) {
      // Ground stop uses the boarding node itself
      if (stopY < 1.5) {
        stopNodeIds.push(boardingId);
        continue;
      }

      const stopId = graph.addNode(platform.cx, stopY, platform.cz, 'platform');
      stopNodeIds.push(stopId);
      elevatorNodeIds.push(stopId);

      // Dynamic edge: boarding ↔ stop, traversable when elevator is near ground
      // (meaning "you can board and ride to this destination")
      const getY = platform.getY.bind(platform);
      graph.addBidirectionalEdge(boardingId, stopId,
        Math.abs(stopY) + ELEVATOR_WAIT_COST,
        () => getY() < 2.5,
      );

      // Also: stop ↔ boarding when elevator is near THIS stop's Y
      // (meaning "you can board at this level and ride down")
      graph.addBidirectionalEdge(stopId, boardingId,
        stopY + ELEVATOR_WAIT_COST,
        () => Math.abs(getY() - stopY) < ELEVATOR_Y_TOLERANCE,
      );
    }

    // Connect mid-level elevator stop to nearby archway surface nodes.
    // The mid stop (Y=13.5) is between the archway peaks — if an NPC is on
    // the elevator at mid-level, it could step off onto a nearby arch surface.
    const midStopId = stopNodeIds.find((_, i) => stops[i] === 13.5);
    if (midStopId !== undefined) {
      for (const ids of pathNodeIds) {
        for (const nodeId of ids) {
          const node = graph.getNode(nodeId);
          // Connect to archway nodes that are at similar height and within
          // reasonable horizontal distance
          if (Math.abs(node.y - 13.5) < 4 && horizDist(node.x, node.z, platform.cx, platform.cz) < 12) {
            const cost = dist3d(node.x, node.y, node.z, platform.cx, 13.5, platform.cz);
            const getY = platform.getY.bind(platform);
            graph.addBidirectionalEdge(midStopId, nodeId,
              cost + ELEVATOR_WAIT_COST / 2,
              () => Math.abs(getY() - 13.5) < ELEVATOR_Y_TOLERANCE,
            );
          }
        }
      }
    }
  }

  // ── 4. Add ground connector nodes and wire everything together ─────

  // Place a few extra ground nodes to ensure good connectivity between
  // arch approaches and elevator. These are placed at midpoints.
  const extraGroundIds: number[] = [];

  // Center of arena
  extraGroundIds.push(graph.addNode(0, 0, 0, 'ground'));

  // Midpoints between the two arch sides (if we have 2+ arches)
  if (pathNodeIds.length >= 2) {
    // North and south connector nodes
    extraGroundIds.push(graph.addNode(0, 0, 20, 'ground'));
    extraGroundIds.push(graph.addNode(0, 0, -20, 'ground'));
  }

  const allGroundIds = [...groundApproachIds, ...extraGroundIds];

  // Connect all ground-level nodes to each other (fully connected at ground)
  for (let i = 0; i < allGroundIds.length; i++) {
    for (let j = i + 1; j < allGroundIds.length; j++) {
      const a = graph.getNode(allGroundIds[i]);
      const b = graph.getNode(allGroundIds[j]);
      const d = horizDist(a.x, a.z, b.x, b.z);
      if (d < GROUND_CONNECT_MAX_DIST) {
        graph.addBidirectionalEdge(allGroundIds[i], allGroundIds[j], d);
      }
    }
  }

  return graph;
}

function dist3d(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function horizDist(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}
