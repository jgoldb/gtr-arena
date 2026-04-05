/**
 * Waypoint graph with A* pathfinding for NPC navigation.
 *
 * The graph connects archway waypoint chains, elevator nodes, and ground-level
 * connector nodes into a single searchable structure.  Dynamic edges (elevator)
 * are evaluated at query time via an `isTraversable` predicate.
 */

export interface NavNode {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly type: 'ground' | 'archway' | 'platform';
}

interface NavEdge {
  readonly to: number;
  readonly cost: number;
  /** When present, edge is only usable if this returns true (checked during A*). */
  readonly isTraversable?: () => boolean;
}

export class NavigationGraph {
  private nodes: NavNode[] = [];
  private adjacency: NavEdge[][] = []; // adjacency[nodeId] = outgoing edges

  // ── Graph construction ───────────────────────────────────────────────

  addNode(x: number, y: number, z: number, type: NavNode['type']): number {
    const id = this.nodes.length;
    this.nodes.push({ id, x, y, z, type });
    this.adjacency.push([]);
    return id;
  }

  addEdge(from: number, to: number, cost: number, isTraversable?: () => boolean): void {
    this.adjacency[from].push({ to, cost, isTraversable });
  }

  addBidirectionalEdge(a: number, b: number, cost: number, isTraversable?: () => boolean): void {
    this.addEdge(a, b, cost, isTraversable);
    this.addEdge(b, a, cost, isTraversable);
  }

  getNode(id: number): NavNode {
    return this.nodes[id];
  }

  get nodeCount(): number {
    return this.nodes.length;
  }

  // ── Nearest-node lookup ──────────────────────────────────────────────

  /** Find the graph node closest to `pos`, using Y-weighted 3D distance.
   *  The Y weight penalises vertical mismatches so an entity under an arch
   *  doesn't snap to nodes on the surface above. */
  findNearestNode(
    px: number, py: number, pz: number,
    filter?: (n: NavNode) => boolean,
  ): NavNode | null {
    let best: NavNode | null = null;
    let bestDist = Infinity;
    const Y_WEIGHT = 3; // penalise Y mismatch heavily

    for (const node of this.nodes) {
      if (filter && !filter(node)) continue;
      const dx = px - node.x;
      const dy = (py - node.y) * Y_WEIGHT;
      const dz = pz - node.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        best = node;
      }
    }
    return best;
  }

  /** Find nearest node that is on the ground (Y < threshold). */
  findNearestGroundNode(px: number, pz: number): NavNode | null {
    return this.findNearestNode(px, 0, pz, n => n.y < 1.5);
  }

  // ── Pathfinding ──────────────────────────────────────────────────────

  /** Find the shortest path between two positions via the graph.
   *  Returns the node sequence (excluding the virtual start/end), or null
   *  if no path exists. */
  findPath(
    fromX: number, fromY: number, fromZ: number,
    toX: number, toY: number, toZ: number,
  ): NavNode[] | null {
    const startNode = this.findNearestNode(fromX, fromY, fromZ);
    const goalNode = this.findNearestNode(toX, toY, toZ);
    if (!startNode || !goalNode) return null;
    if (startNode.id === goalNode.id) return null; // already there

    const idPath = this.astar(startNode.id, goalNode.id);
    if (!idPath) return null;

    return idPath.map(id => this.nodes[id]);
  }

  /** A* search on the node graph. Returns ordered node IDs or null. */
  private astar(startId: number, goalId: number): number[] | null {
    const goal = this.nodes[goalId];
    const nodeCount = this.nodes.length;

    // g[n] = cost from start to n
    const g = new Float64Array(nodeCount).fill(Infinity);
    // f[n] = g[n] + heuristic(n, goal)
    const f = new Float64Array(nodeCount).fill(Infinity);
    const cameFrom = new Int32Array(nodeCount).fill(-1);
    const closed = new Uint8Array(nodeCount);

    g[startId] = 0;
    f[startId] = this.heuristic(startId, goal);

    // Simple binary-heap-less open set (fine for <200 nodes)
    const open = new Set<number>();
    open.add(startId);

    while (open.size > 0) {
      // Pick node with lowest f
      let current = -1;
      let currentF = Infinity;
      for (const id of open) {
        if (f[id] < currentF) {
          currentF = f[id];
          current = id;
        }
      }

      if (current === goalId) return this.reconstructPath(cameFrom, current);

      open.delete(current);
      closed[current] = 1;

      for (const edge of this.adjacency[current]) {
        if (closed[edge.to]) continue;
        if (edge.isTraversable && !edge.isTraversable()) continue;

        const tentativeG = g[current] + edge.cost;
        if (tentativeG < g[edge.to]) {
          cameFrom[edge.to] = current;
          g[edge.to] = tentativeG;
          f[edge.to] = tentativeG + this.heuristic(edge.to, goal);
          open.add(edge.to);
        }
      }
    }

    return null; // no path found
  }

  private heuristic(nodeId: number, goal: NavNode): number {
    const n = this.nodes[nodeId];
    const dx = n.x - goal.x;
    const dy = n.y - goal.y;
    const dz = n.z - goal.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private reconstructPath(cameFrom: Int32Array, current: number): number[] {
    const path: number[] = [current];
    while (cameFrom[current] !== -1) {
      current = cameFrom[current];
      path.push(current);
    }
    path.reverse();
    return path;
  }
}
