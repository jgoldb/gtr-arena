import { CollisionSystem, type BoxCollider } from './ServerMapManager.js';
import type { ServerEntity } from './ServerEntity.js';

/**
 * Celestial Ballroom elevator — manages the moving platform collider,
 * computes its Y position each tick, and snaps entities riding it.
 */
export class ServerElevator {
  private readonly collider: BoxCollider;

  private static readonly CX = 1;
  private static readonly CZ = -1;
  private static readonly HALF_W = 4;
  private static readonly HALF_D = 4;
  private static readonly HALF_H = 0.2;
  private static readonly FLOORS = [0.2, 13.5, 40];
  private static readonly STOPS  = [0, 1, 2, 1];
  private static readonly IDLE   = 8;
  private static readonly TRAVEL = 3;
  private static readonly PHASE  = 8 + 3; // IDLE + TRAVEL
  private static readonly CYCLE  = 4 * (8 + 3); // STOPS.length * PHASE

  constructor(collision: CollisionSystem) {
    this.collider = {
      type: 'box',
      cx: ServerElevator.CX,
      cz: ServerElevator.CZ,
      halfW: ServerElevator.HALF_W,
      halfD: ServerElevator.HALF_D,
      cosY: 1,
      sinY: 0,
      centerY: 0.2,
      halfH: ServerElevator.HALF_H,
      rotZ: 0,
    };
    collision.addCollider(this.collider);
  }

  /** Update the elevator collider position (called each tick). */
  update(gameElapsed: number, frozenEntities: ReadonlySet<string>, getEntity: (id: string) => ServerEntity | undefined): void {
    this.collider.centerY = this.computeY(gameElapsed);

    // Keep frozen (disconnected) entities riding the elevator surface so they
    // don't float in mid-air after the platform moves away.
    // Use expanded footprint (+ collisionRadius) to match the client collision
    // system's overlap detection — players can stand up to 0.4 units beyond
    // the box edge and still be "on" the platform.
    const surfaceY = this.collider.centerY + ServerElevator.HALF_H;
    for (const entityId of frozenEntities) {
      const entity = getEntity(entityId);
      if (!entity || entity.dead) continue;
      const dx = entity.x - ServerElevator.CX;
      const dz = entity.z - ServerElevator.CZ;
      if (Math.abs(dx) <= ServerElevator.HALF_W + entity.collisionRadius &&
          Math.abs(dz) <= ServerElevator.HALF_D + entity.collisionRadius) {
        entity.y = surfaceY;
      }
    }
  }

  /** Current elevator surface Y. */
  getSurfaceY(): number {
    return this.collider.centerY + ServerElevator.HALF_H;
  }

  /**
   * If the entity is within the elevator's XZ footprint (+ collision radius),
   * snap its Y to the current elevator surface so it doesn't spawn in mid-air
   * on rejoin.
   */
  snapEntity(entity: ServerEntity): void {
    const dx = entity.x - ServerElevator.CX;
    const dz = entity.z - ServerElevator.CZ;
    if (Math.abs(dx) <= ServerElevator.HALF_W + entity.collisionRadius &&
        Math.abs(dz) <= ServerElevator.HALF_D + entity.collisionRadius) {
      entity.y = this.collider.centerY + ServerElevator.HALF_H;
      entity.fallPeakY = 0;
    }
  }

  private computeY(gameElapsed: number): number {
    const { FLOORS, STOPS, IDLE, TRAVEL, PHASE, CYCLE } = ServerElevator;

    const t = gameElapsed % CYCLE;
    const stopIdx = Math.floor(t / PHASE);
    const phaseT  = t - stopIdx * PHASE;

    const fromY = FLOORS[STOPS[stopIdx]];
    const toY   = FLOORS[STOPS[(stopIdx + 1) % STOPS.length]];

    if (phaseT < IDLE) {
      // Idling — replicate hover bob for accurate collision
      // Skip the bob at ground level so the platform sits still
      const isGroundFloor = STOPS[stopIdx] === 0;
      if (isGroundFloor) return fromY;
      const fadeIn  = Math.min(1, phaseT / 1.0);
      const fadeOut = Math.min(1, (IDLE - phaseT) / 1.0);
      return fromY + Math.sin(gameElapsed * 1.5) * 0.4 * fadeIn * fadeOut;
    }
    // Traveling — ease-in-out cubic
    const p = (phaseT - IDLE) / TRAVEL;
    const eased = p < 0.5
      ? 4 * p * p * p
      : 1 - Math.pow(-2 * p + 2, 3) / 2;
    return fromY + (toY - fromY) * eased;
  }
}
