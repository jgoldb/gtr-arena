import { ObstacleConfig } from '../map/MapConfig';

export interface BoxCollider {
  type: 'box';
  cx: number;
  cz: number;
  halfW: number;
  halfD: number;
  cosY: number;
  sinY: number;
  centerY: number;
  halfH: number;
  rotZ: number;
}

export interface CircleCollider {
  type: 'circle';
  cx: number;
  cz: number;
  radius: number;
  centerY: number;
  halfH: number;
}

export interface WaterZone {
  cx: number;
  cz: number;
  halfW: number;
  halfD: number;
  surfaceY: number;
  floorY: number;
}

export type Collider = BoxCollider | CircleCollider;

export interface ResolveResult {
  x: number;
  z: number;
  groundY: number;
  inWater: boolean;
}

const PLAYER_HEIGHT = 1.8;
const STEP_HEIGHT = 0.5;
const WATER_WADE_DEPTH = 0.3;

export class CollisionSystem {
  private colliders: Collider[] = [];
  private waterZones: WaterZone[] = [];

  buildFromObstacles(obstacles: ObstacleConfig[]): void {
    this.colliders = [];
    this.waterZones = [];

    for (const obs of obstacles) {
      if (obs.type === 'water') {
        const surfaceY = obs.position.y + obs.scale.y / 2;
        this.waterZones.push({
          cx: obs.position.x,
          cz: obs.position.z,
          halfW: obs.scale.x / 2,
          halfD: obs.scale.z / 2,
          surfaceY,
          floorY: surfaceY - WATER_WADE_DEPTH,
        });
        continue;
      }

      if (obs.type === 'cylinder') {
        const hasZRotation = obs.rotation && Math.abs(obs.rotation.z) > 0.1;
        if (hasZRotation) {
          // Horizontal cylinder -> box collider
          const yAngle = obs.rotation?.y ?? 0;
          this.colliders.push({
            type: 'box',
            cx: obs.position.x,
            cz: obs.position.z,
            halfW: obs.scale.y / 2,
            halfD: obs.scale.x,
            cosY: Math.cos(yAngle),
            sinY: Math.sin(yAngle),
            centerY: obs.position.y,
            halfH: obs.scale.x,
            rotZ: 0,
          });
        } else {
          this.colliders.push({
            type: 'circle',
            cx: obs.position.x,
            cz: obs.position.z,
            radius: obs.scale.x,
            centerY: obs.position.y,
            halfH: obs.scale.y / 2,
          });
        }
      } else {
        // box, wall, ramp
        const yAngle = obs.rotation?.y ?? 0;
        this.colliders.push({
          type: 'box',
          cx: obs.position.x,
          cz: obs.position.z,
          halfW: obs.scale.x / 2,
          halfD: obs.scale.z / 2,
          cosY: Math.cos(yAngle),
          sinY: Math.sin(yAngle),
          centerY: obs.position.y,
          halfH: obs.scale.y / 2,
          rotZ: obs.rotation?.z ?? 0,
        });
      }
    }
  }

  resolve(px: number, pz: number, py: number, radius: number): ResolveResult {
    // Phase 1: XZ collision push-out (skip obstacles the player is above)
    for (let iter = 0; iter < 4; iter++) {
      let pushed = false;

      for (const col of this.colliders) {
        const topY = this.getTopY(col, px, pz);
        const heightDiff = topY - py;

        // Player can step onto or is above this surface
        if (heightDiff <= STEP_HEIGHT) continue;

        // Check vertical overlap: player body vs obstacle
        const bottomY = this.getBottomY(col, px, pz);
        if (py + PLAYER_HEIGHT <= bottomY) continue;

        const result = col.type === 'circle'
          ? this.pushCircleVsCircle(px, pz, radius, col)
          : this.pushCircleVsBox(px, pz, radius, col);

        if (result) {
          px = result.x;
          pz = result.z;
          pushed = true;
        }
      }

      if (!pushed) break;
    }

    // Phase 2: Determine base ground, checking water first
    let groundY = 0;
    let inWater = false;

    for (const wz of this.waterZones) {
      if (
        px >= wz.cx - wz.halfW && px <= wz.cx + wz.halfW &&
        pz >= wz.cz - wz.halfD && pz <= wz.cz + wz.halfD &&
        py <= wz.surfaceY
      ) {
        inWater = true;
        groundY = wz.floorY;
      }
    }

    // Phase 3: Solid surface ground height (can override water floor)
    for (const col of this.colliders) {
      const topY = this.getTopY(col, px, pz);
      if (topY - py > STEP_HEIGHT) continue;

      const overlaps = col.type === 'circle'
        ? this.isOverlappingCircle(px, pz, radius, col)
        : this.isOverlappingBox(px, pz, radius, col);

      if (overlaps && topY > groundY) {
        groundY = topY;
      }
    }

    return { x: px, z: pz, groundY, inWater };
  }

  private getTopY(col: Collider, px: number, pz: number): number {
    if (col.type === 'circle') {
      return col.centerY + col.halfH;
    }
    if (col.rotZ === 0) {
      return col.centerY + col.halfH;
    }
    // Ramp: top varies based on local X position
    const dx = px - col.cx;
    const dz = pz - col.cz;
    const localX = dx * col.cosY + dz * col.sinY;
    return col.centerY + localX * Math.sin(col.rotZ) + col.halfH * Math.cos(col.rotZ);
  }

  private getBottomY(col: Collider, px: number, pz: number): number {
    if (col.type === 'circle') {
      return col.centerY - col.halfH;
    }
    if (col.rotZ === 0) {
      return col.centerY - col.halfH;
    }
    const dx = px - col.cx;
    const dz = pz - col.cz;
    const localX = dx * col.cosY + dz * col.sinY;
    return col.centerY + localX * Math.sin(col.rotZ) - col.halfH * Math.cos(col.rotZ);
  }

  private isOverlappingCircle(px: number, pz: number, radius: number, col: CircleCollider): boolean {
    const dx = px - col.cx;
    const dz = pz - col.cz;
    const minDist = radius + col.radius;
    return (dx * dx + dz * dz) < minDist * minDist;
  }

  private isOverlappingBox(px: number, pz: number, radius: number, col: BoxCollider): boolean {
    const dx = px - col.cx;
    const dz = pz - col.cz;
    const localX = dx * col.cosY + dz * col.sinY;
    const localZ = -dx * col.sinY + dz * col.cosY;

    const closestX = Math.max(-col.halfW, Math.min(col.halfW, localX));
    const closestZ = Math.max(-col.halfD, Math.min(col.halfD, localZ));
    const cdx = localX - closestX;
    const cdz = localZ - closestZ;
    return (cdx * cdx + cdz * cdz) < radius * radius;
  }

  private pushCircleVsCircle(
    px: number, pz: number, radius: number, col: CircleCollider
  ): { x: number; z: number } | null {
    const dx = px - col.cx;
    const dz = pz - col.cz;
    const distSq = dx * dx + dz * dz;
    const minDist = radius + col.radius;

    if (distSq >= minDist * minDist) return null;

    const dist = Math.sqrt(distSq);
    if (dist < 0.0001) {
      return { x: px + minDist, z: pz };
    }

    const overlap = minDist - dist;
    return { x: px + (dx / dist) * overlap, z: pz + (dz / dist) * overlap };
  }

  private pushCircleVsBox(
    px: number, pz: number, radius: number, col: BoxCollider
  ): { x: number; z: number } | null {
    const relX = px - col.cx;
    const relZ = pz - col.cz;
    const localX = relX * col.cosY + relZ * col.sinY;
    const localZ = -relX * col.sinY + relZ * col.cosY;

    const closestX = Math.max(-col.halfW, Math.min(col.halfW, localX));
    const closestZ = Math.max(-col.halfD, Math.min(col.halfD, localZ));

    const dx = localX - closestX;
    const dz = localZ - closestZ;
    const distSq = dx * dx + dz * dz;

    if (distSq >= radius * radius) return null;

    let lx: number, lz: number;

    if (distSq < 0.0001) {
      // Player center is inside the box — push out along shortest axis
      const pushRight = col.halfW - localX;
      const pushLeft = col.halfW + localX;
      const pushFar = col.halfD - localZ;
      const pushNear = col.halfD + localZ;
      const minPush = Math.min(pushRight, pushLeft, pushFar, pushNear);

      lx = 0;
      lz = 0;
      if (minPush === pushRight) lx = col.halfW + radius - localX;
      else if (minPush === pushLeft) lx = -(col.halfW + radius + localX);
      else if (minPush === pushFar) lz = col.halfD + radius - localZ;
      else lz = -(col.halfD + radius + localZ);
    } else {
      const dist = Math.sqrt(distSq);
      const overlap = radius - dist;
      lx = (dx / dist) * overlap;
      lz = (dz / dist) * overlap;
    }

    // Transform back to world space
    const wx = lx * col.cosY - lz * col.sinY;
    const wz = lx * col.sinY + lz * col.cosY;
    return { x: px + wx, z: pz + wz };
  }

  /**
   * Returns true if the 2D line segment (ax,az)→(bx,bz) is clear of all
   * colliders tall enough to block sight (top > minBlockHeight).
   */
  hasLineOfSight(ax: number, az: number, bx: number, bz: number, minBlockHeight = 0.5): boolean {
    const dx = bx - ax;
    const dz = bz - az;

    for (const col of this.colliders) {
      // Only block if the collider pokes above the ground
      const topY = col.centerY + col.halfH;
      if (topY <= minBlockHeight) continue;

      const blocked = col.type === 'circle'
        ? this.segmentIntersectsCircle(ax, az, dx, dz, col)
        : this.segmentIntersectsBox(ax, az, dx, dz, col);

      if (blocked) return false;
    }
    return true;
  }

  /** Does the segment origin+(t*dir) for t∈[0,1] hit the circle? */
  private segmentIntersectsCircle(
    ox: number, oz: number, dx: number, dz: number, col: CircleCollider
  ): boolean {
    const fx = ox - col.cx;
    const fz = oz - col.cz;
    const a = dx * dx + dz * dz;
    const b = 2 * (fx * dx + fz * dz);
    const c = fx * fx + fz * fz - col.radius * col.radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return false;
    const sqrtDisc = Math.sqrt(disc);
    const t1 = (-b - sqrtDisc) / (2 * a);
    const t2 = (-b + sqrtDisc) / (2 * a);
    return t2 >= 0 && t1 <= 1;
  }

  /** Does the segment hit the oriented box (2D slab test in local space)? */
  private segmentIntersectsBox(
    ox: number, oz: number, dx: number, dz: number, col: BoxCollider
  ): boolean {
    // Transform into box-local space
    const relOx = ox - col.cx;
    const relOz = oz - col.cz;
    const lox = relOx * col.cosY + relOz * col.sinY;
    const loz = -relOx * col.sinY + relOz * col.cosY;
    const ldx = dx * col.cosY + dz * col.sinY;
    const ldz = -dx * col.sinY + dz * col.cosY;

    let tMin = 0;
    let tMax = 1;

    // X slab
    if (Math.abs(ldx) < 1e-8) {
      if (lox < -col.halfW || lox > col.halfW) return false;
    } else {
      let t1 = (-col.halfW - lox) / ldx;
      let t2 = (col.halfW - lox) / ldx;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return false;
    }

    // Z slab
    if (Math.abs(ldz) < 1e-8) {
      if (loz < -col.halfD || loz > col.halfD) return false;
    } else {
      let t1 = (-col.halfD - loz) / ldz;
      let t2 = (col.halfD - loz) / ldz;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return false;
    }

    return true;
  }

  addCollider(collider: Collider): void {
    this.colliders.push(collider);
  }

  removeCollider(collider: Collider): void {
    const idx = this.colliders.indexOf(collider);
    if (idx !== -1) this.colliders.splice(idx, 1);
  }

  getColliders(): readonly Collider[] {
    return this.colliders;
  }

  getWaterZones(): readonly WaterZone[] {
    return this.waterZones;
  }
}
