import * as THREE from 'three';
import type { CharacterModel } from '../engine/player/characters';
import type { DeadReckoning } from './DeadReckoning';

// ── Types ────────────────────────────────────────────────────────────

/** Minimal view of a remote entity, as needed by the renderer. */
export interface RenderableEntity {
  readonly id: string;
  mesh: THREE.Group;
  model: CharacterModel;
  isMoving: boolean;
  readonly isAutoAttacking: boolean;
  readonly stunned: boolean;
  readonly dead: boolean;
  readonly charging: boolean;
  readonly disconnected: boolean;
  readonly godMode: boolean;
  readonly castingAbilityId: string | null;
  readonly castingElapsed: number;
  readonly castingTotalTime: number;
  readonly castingIsChannel: boolean;
  prevRotationY: number;
}

/** Collision resolver interface — subset of MapManager.collision. */
export interface CollisionResolver {
  resolve(x: number, z: number, y: number, radius: number): { groundY: number };
}

// ── RemoteEntityRenderer ─────────────────────────────────────────────

/**
 * Updates remote entity positions (dead reckoning + collision), animation
 * state (cast/channel/death), and derived animation parameters (speed,
 * strafe, turn speed) each frame.
 */
export class RemoteEntityRenderer {
  private readonly deadReckoning: DeadReckoning;
  private readonly getCollision: () => CollisionResolver;

  constructor(deadReckoning: DeadReckoning, getCollision: () => CollisionResolver) {
    this.deadReckoning = deadReckoning;
    this.getCollision = getCollision;
  }

  /** Update all remote entities for this frame. */
  updateAll(entities: Iterable<RenderableEntity>, dt: number): void {
    for (const entity of entities) {
      this.updateEntity(entity, dt);
    }
  }

  private updateEntity(entity: RenderableEntity, dt: number): void {
    const dr = this.deadReckoning.getPosition(entity.id, dt);
    let interpVx = 0;
    let interpVz = 0;

    if (dr) {
      entity.isMoving = dr.isMoving;

      if (entity.disconnected) {
        // Disconnected entities: freeze X/Z exactly where they are.
        // Use the server-sent Y from dead reckoning so gravity-simulated
        // falls are visible to remote players. Fall back to collision
        // resolution only when vy is zero (tracking moving surfaces).
        if (dr.vy !== 0) {
          entity.mesh.position.y = dr.y;
        } else {
          const baseY = entity.mesh.position.y;
          const groundY = this.getCollision().resolve(
            entity.mesh.position.x, entity.mesh.position.z, baseY + 1, 0.4,
          ).groundY;
          const diff = groundY - baseY;
          if (Math.abs(diff) < 2) {
            entity.mesh.position.y = groundY;
          }
        }
      } else {
        // When grounded (vy=0), resolve Y against the client's collision system
        // so remote players track animated surfaces like the Celestial Ballroom
        // elevator and Cage pillars.
        let finalY = dr.y;
        if (dr.vy === 0 && !entity.godMode) {
          const baseY = entity.mesh.position.y;
          const groundY = this.getCollision().resolve(dr.x, dr.z, baseY + 1, 0.4).groundY;
          const diff = groundY - baseY;
          if (Math.abs(diff) < 2) {
            finalY = groundY;
          }
        }
        entity.mesh.position.set(dr.x, finalY, dr.z);
        entity.mesh.rotation.y = dr.rotationY;
        interpVx = dr.vx;
        interpVz = dr.vz;
      }
    }

    // Update model animation state
    entity.model.setAutoAttacking(entity.isAutoAttacking);
    entity.model.setStunned(entity.stunned);
    this.updateCastAnimation(entity);
    this.updateDeathAnimation(entity);

    // Derive animation params from interpolated velocity
    const speed = Math.sqrt(interpVx * interpVx + interpVz * interpVz);
    const speedMultiplier = entity.isMoving && speed > 0.1 ? speed / 5.6 : 1;
    const strafeDirection = this.computeStrafeDirection(entity, interpVx, interpVz, speed);
    const turnSpeed = this.computeTurnSpeed(entity, dt);

    entity.model.update(dt, {
      isMoving: entity.isMoving,
      isGrounded: (dr?.vy ?? 0) === 0,
      velocityY: dr?.vy ?? 0,
      turnSpeed,
      speedMultiplier,
      strafeDirection,
    });
  }

  private updateCastAnimation(entity: RenderableEntity): void {
    if (entity.castingAbilityId) {
      const progress = entity.castingTotalTime > 0
        ? Math.min(1, entity.castingElapsed / entity.castingTotalTime)
        : 0;
      if (entity.castingIsChannel) {
        entity.model.setChannelAnimation(entity.castingAbilityId, progress);
        entity.model.setCastAnimation(null, 0);
      } else {
        entity.model.setCastAnimation(entity.castingAbilityId, progress);
        entity.model.setChannelAnimation(null, 0);
      }
    } else {
      entity.model.setCastAnimation(null, 0);
      entity.model.setChannelAnimation(null, 0);
    }
  }

  private updateDeathAnimation(entity: RenderableEntity): void {
    if (entity.dead && !entity.model.isDying) {
      entity.model.startDeath();
    } else if (!entity.dead && entity.model.isDying) {
      entity.model.resetDeath();
    }
  }

  private computeStrafeDirection(entity: RenderableEntity, vx: number, vz: number, speed: number): number {
    if (!entity.isMoving || speed <= 0.1) return 0;
    const facingSin = Math.sin(entity.mesh.rotation.y);
    const facingCos = Math.cos(entity.mesh.rotation.y);
    const forwardDot = facingSin * vx + facingCos * vz;
    const rightDot = -facingCos * vx + facingSin * vz;
    const moveAngle = Math.atan2(rightDot, forwardDot);
    const strafe = Math.sin(moveAngle);
    return Math.abs(strafe) < 0.15 ? 0 : strafe;
  }

  private computeTurnSpeed(entity: RenderableEntity, dt: number): number {
    if (dt <= 0) return 0;
    let rotDiff = entity.mesh.rotation.y - entity.prevRotationY;
    while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
    while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
    entity.prevRotationY = entity.mesh.rotation.y;
    return rotDiff / dt;
  }
}
