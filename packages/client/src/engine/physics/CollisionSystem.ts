import type { ObstacleConfig } from '@gtr/shared';

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

export interface ElevationAccessPoint {
  readonly x: number;
  readonly z: number;
}

export class CollisionSystem {
  private colliders: Collider[] = [];
  private waterZones: WaterZone[] = [];
  private elevationAccessPoints: ElevationAccessPoint[] = [];

  buildFromObstacles(obstacles: ObstacleConfig[]): void {
    this.colliders = [];
    this.waterZones = [];
    this.elevationAccessPoints = [];

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

  private static readonly SIGHT_HEIGHT = 1.5;

  /**
   * Returns true if the line segment (ax,az)→(bx,bz) is clear of all
   * colliders tall enough to block sight.
   * When ay/by are provided, performs 3D-aware checking: the sight line
   * travels from (ax, ay+SIGHT_HEIGHT, az) to (bx, by+SIGHT_HEIGHT, bz)
   * and only colliders whose vertical extent intersects the sight line Y
   * at the XZ intersection point can block.
   */
  hasLineOfSight(ax: number, az: number, bx: number, bz: number, ay?: number, by?: number): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const yAware = ay !== undefined && by !== undefined;
    const eyeA = yAware ? ay! + CollisionSystem.SIGHT_HEIGHT : 0;
    const eyeB = yAware ? by! + CollisionSystem.SIGHT_HEIGHT : 0;

    for (const col of this.colliders) {
      // Compute the full Y range of the collider
      let colMinY: number, colMaxY: number;
      if (col.type === 'circle' || col.rotZ === 0) {
        colMinY = col.centerY - col.halfH;
        colMaxY = col.centerY + col.halfH;
      } else {
        const slopeRange = col.halfW * Math.abs(Math.sin(col.rotZ));
        const flatH = col.halfH * Math.cos(col.rotZ);
        colMinY = col.centerY - slopeRange - flatH;
        colMaxY = col.centerY + slopeRange + flatH;
      }

      if (yAware) {
        // Collider entirely above both entities' eyes — overhead, skip
        if (colMinY >= Math.max(eyeA, eyeB)) continue;
        // Collider entirely below both entities' feet — underfoot, skip
        if (colMaxY <= Math.min(ay!, by!) + STEP_HEIGHT) continue;
      } else {
        if (colMaxY <= 0.5) continue;
      }

      // XZ intersection: get t-range [tMin, tMax] within [0,1]
      const tRange = col.type === 'circle'
        ? this.segmentHitRangeCircle(ax, az, dx, dz, col)
        : this.segmentHitRangeBox(ax, az, dx, dz, col);

      if (!tRange) continue;

      // If Y-aware, check sight line Y at intersection against collider Y
      if (yAware) {
        const yAtT0 = eyeA + tRange[0] * (eyeB - eyeA);
        const yAtT1 = eyeA + tRange[1] * (eyeB - eyeA);
        const sightMinY = Math.min(yAtT0, yAtT1);
        const sightMaxY = Math.max(yAtT0, yAtT1);

        // For ramped colliders, compute tighter Y bounds at the actual
        // intersection XZ points instead of using the global worst-case range.
        // This prevents sloped surfaces (archways) from blocking LoS between
        // entities standing on the same surface.
        let effectiveMinY = colMinY;
        let effectiveMaxY = colMaxY;
        if (col.type === 'box' && col.rotZ !== 0) {
          const px0 = ax + tRange[0] * dx;
          const pz0 = az + tRange[0] * dz;
          const px1 = ax + tRange[1] * dx;
          const pz1 = az + tRange[1] * dz;
          effectiveMaxY = Math.max(this.getTopY(col, px0, pz0), this.getTopY(col, px1, pz1));
          effectiveMinY = Math.min(this.getBottomY(col, px0, pz0), this.getBottomY(col, px1, pz1));
        }

        // No vertical overlap: sight line passes above or below collider
        if (sightMinY >= effectiveMaxY || sightMaxY <= effectiveMinY) continue;
      }

      return false;
    }
    return true;
  }

  /** Returns the [tMin, tMax] parameter range where the segment hits the circle, or null. */
  private segmentHitRangeCircle(
    ox: number, oz: number, dx: number, dz: number, col: CircleCollider
  ): [number, number] | null {
    const fx = ox - col.cx;
    const fz = oz - col.cz;
    const a = dx * dx + dz * dz;
    const b = 2 * (fx * dx + fz * dz);
    const c = fx * fx + fz * fz - col.radius * col.radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sqrtDisc = Math.sqrt(disc);
    const t1 = (-b - sqrtDisc) / (2 * a);
    const t2 = (-b + sqrtDisc) / (2 * a);
    if (t2 < 0 || t1 > 1) return null;
    return [Math.max(0, t1), Math.min(1, t2)];
  }

  /** Returns the [tMin, tMax] parameter range where the segment hits the oriented box, or null. */
  private segmentHitRangeBox(
    ox: number, oz: number, dx: number, dz: number, col: BoxCollider
  ): [number, number] | null {
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
      if (lox < -col.halfW || lox > col.halfW) return null;
    } else {
      let t1 = (-col.halfW - lox) / ldx;
      let t2 = (col.halfW - lox) / ldx;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    }

    // Z slab
    if (Math.abs(ldz) < 1e-8) {
      if (loz < -col.halfD || loz > col.halfD) return null;
    } else {
      let t1 = (-col.halfD - loz) / ldz;
      let t2 = (col.halfD - loz) / ldz;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    }

    return [tMin, tMax];
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

  addElevationAccessPoint(point: ElevationAccessPoint): void {
    this.elevationAccessPoints.push(point);
  }

  getElevationAccessPoints(): readonly ElevationAccessPoint[] {
    return this.elevationAccessPoints;
  }
}
