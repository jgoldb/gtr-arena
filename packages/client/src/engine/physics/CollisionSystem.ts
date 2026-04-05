import {
  CollisionSystem as SharedCollisionSystem,
} from '@gtr/shared';
import type { NavigationGraph } from '../npc/ai/NavigationGraph';

// Re-export shared types so existing client imports keep working
export type {
  BoxCollider,
  CircleCollider,
  Collider,
  WaterZone,
  ResolveResult,
} from '@gtr/shared';

// ── Client-only types ───────────────────────────────────────────────────────

export interface ElevationAccessPoint {
  readonly x: number;
  readonly z: number;
}

/** Ordered chain of walkable-surface waypoints along an elevated structure (archway). */
export interface NavigationPath {
  readonly waypoints: readonly { readonly x: number; readonly y: number; readonly z: number }[];
}

/** A platform that moves vertically (elevator/pillar). AI queries its live Y position. */
export interface MovingPlatform {
  readonly cx: number;
  readonly cz: number;
  readonly halfW: number;
  readonly halfD: number;
  /** Returns the current surface Y of the platform. */
  getY(): number;
  /** Maximum surface Y this platform can reach (e.g. pillar fully raised). */
  readonly maxY?: number;
  /** Minimum surface Y (e.g. pillar fully submerged). */
  readonly minY?: number;
  /** True for platforms that cycle automatically (pillars). Tells the AI
   *  "stand here and wait — the platform will come to you." */
  readonly cyclesAutomatically?: boolean;
  /** True for circular platforms (use distance-from-center for XZ checks). */
  readonly isCircular?: boolean;
}

// ── Client CollisionSystem — extends shared with navigation/AI features ─────

export class CollisionSystem extends SharedCollisionSystem {
  private elevationAccessPoints: ElevationAccessPoint[] = [];
  private navigationPaths: NavigationPath[] = [];
  private movingPlatforms: MovingPlatform[] = [];
  private navGraph: NavigationGraph | null = null;

  override buildFromObstacles(obstacles: import('@gtr/shared').ObstacleConfig[]): void {
    super.buildFromObstacles(obstacles);
    this.elevationAccessPoints = [];
    this.navigationPaths = [];
    this.movingPlatforms = [];
    this.navGraph = null;
  }

  addElevationAccessPoint(point: ElevationAccessPoint): void {
    this.elevationAccessPoints.push(point);
  }

  getElevationAccessPoints(): readonly ElevationAccessPoint[] {
    return this.elevationAccessPoints;
  }

  addNavigationPath(path: NavigationPath): void {
    this.navigationPaths.push(path);
  }

  getNavigationPaths(): readonly NavigationPath[] {
    return this.navigationPaths;
  }

  addMovingPlatform(platform: MovingPlatform): void {
    this.movingPlatforms.push(platform);
  }

  getMovingPlatforms(): readonly MovingPlatform[] {
    return this.movingPlatforms;
  }

  setNavigationGraph(graph: NavigationGraph): void {
    this.navGraph = graph;
  }

  getNavigationGraph(): NavigationGraph | null {
    return this.navGraph;
  }
}
