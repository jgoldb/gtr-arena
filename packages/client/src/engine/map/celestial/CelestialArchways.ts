import * as THREE from 'three';
import type { CollisionSystem } from '../../physics/CollisionSystem';
import { createDiamondShaderMaterial } from './CelestialShaders';

/**
 * Creates both diamond archways and their sparkle particles.
 * Returns all ShaderMaterials that need per-frame uTime updates.
 */
export function createDiamondArchways(
  group: THREE.Group,
  collision: CollisionSystem,
): THREE.ShaderMaterial[] {
  const shaderMaterials: THREE.ShaderMaterial[] = [];
  const diamondMat = createDiamondShaderMaterial();
  shaderMaterials.push(diamondMat);

  // Arch 1: Grand Celestial Sweep — wide, sweeping, western side
  const arch1Curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-36, -4.5, 26),
    new THREE.Vector3(-33, -1.5, 22),
    new THREE.Vector3(-27, 1.5, 16),
    new THREE.Vector3(-20, 5, 10),
    new THREE.Vector3(-15, 8, 5),
    new THREE.Vector3(-10, 10, 2),
    new THREE.Vector3(-7, 11, 0),
    new THREE.Vector3(-10, 10, -2),
    new THREE.Vector3(-15, 8, -5),
    new THREE.Vector3(-20, 5, -8),
    new THREE.Vector3(-27, 1.5, -13),
    new THREE.Vector3(-33, -1.5, -18),
    new THREE.Vector3(-36, -4.5, -22),
  ]);
  buildArchway(group, collision, arch1Curve, 4.5, 10, 1.5, diamondMat);

  // Arch 2: Crystal Spire — taller, eastern side
  const arch2Curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(36, -4.0, -24),
    new THREE.Vector3(33, -1.0, -20),
    new THREE.Vector3(27, 2, -15),
    new THREE.Vector3(20, 5.5, -9),
    new THREE.Vector3(14, 9, -5),
    new THREE.Vector3(10, 11.5, -3),
    new THREE.Vector3(8, 12.5, -1),
    new THREE.Vector3(10, 11.5, 1),
    new THREE.Vector3(14, 8.5, 4),
    new THREE.Vector3(20, 5, 8),
    new THREE.Vector3(27, 1.5, 13),
    new THREE.Vector3(33, -1.0, 17),
    new THREE.Vector3(36, -4.0, 21),
  ]);
  buildArchway(group, collision, arch2Curve, 4.0, 8, 1.2, diamondMat);

  // Floating sparkle particles around both arches
  const sparkleMat = createArchSparkles(group, arch1Curve, arch2Curve);
  shaderMaterials.push(sparkleMat);

  return shaderMaterials;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildArchway(
  group: THREE.Group,
  collision: CollisionSystem,
  curve: THREE.CatmullRomCurve3,
  radius: number,
  radialSegments: number,
  _walkableHalfD: number,
  material: THREE.ShaderMaterial,
): void {
  // Faceted tube mesh along the arch curve
  const tubeGeo = new THREE.TubeGeometry(curve, 64, radius, radialSegments, false);
  const tubeMesh = new THREE.Mesh(tubeGeo, material);
  tubeMesh.name = 'diamondArch';
  group.add(tubeMesh);

  // End caps (faceted circles closing the tube openings)
  for (const t of [0, 1] as const) {
    const p = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t);
    const capGeo = new THREE.CircleGeometry(radius, radialSegments);
    const cap = new THREE.Mesh(capGeo, material);
    cap.position.copy(p);
    cap.lookAt(p.clone().add(tangent));
    group.add(cap);
  }

  // Accent lights along the arch
  for (let i = 0; i <= 6; i++) {
    const p = curve.getPointAt(i / 6);
    if (p.y > 2) {
      const light = new THREE.PointLight(0xaaccff, 0.5, 18);
      light.position.set(p.x, p.y + radius + 1.5, p.z);
      group.add(light);
    }
  }

  // Walkable surface colliders along the arch top.
  // Uses 3 parallel strips (center + 2 sides) per segment to approximate
  // the tube's circular cross-section. Thin halfH keeps them as smooth ramps
  // instead of thick walls that block from the side.
  const segCount = 48;
  const points = curve.getPoints(segCount);
  const WALK_HALF_H = 0.5;

  // Cross-section strip layout
  const centerHalfD = radius * 0.35;
  const sideOffset = radius * 0.55;
  const sideHalfD = radius * 0.3;
  const sideDrop = radius - Math.sqrt(radius * radius - sideOffset * sideOffset);

  for (let i = 0; i < segCount; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const midX = (p1.x + p2.x) / 2;
    const midZ = (p1.z + p2.z) / 2;
    const sY1 = p1.y + radius;
    const sY2 = p2.y + radius;
    const midSY = (sY1 + sY2) / 2;

    const dx = p2.x - p1.x;
    const dz = p2.z - p1.z;
    const dy = sY2 - sY1;
    const hDist = Math.sqrt(dx * dx + dz * dz) || 0.001;
    const sDist = Math.sqrt(hDist * hDist + dy * dy);
    const yAngle = Math.atan2(dz, dx);
    const rotZ = Math.atan2(dy, hDist);
    const cosY = Math.cos(yAngle);
    const sinY = Math.sin(yAngle);
    const cosRZ = Math.cos(rotZ);
    const halfW = sDist / 2 + 0.15;

    // Perpendicular direction in XZ plane (across the tube width)
    const perpX = -dz / hDist;
    const perpZ = dx / hDist;

    // Center strip — at full tube-top height
    collision.addCollider({
      type: 'box',
      cx: midX,
      cz: midZ,
      halfW,
      halfD: centerHalfD,
      cosY, sinY,
      centerY: midSY - WALK_HALF_H * cosRZ,
      halfH: WALK_HALF_H,
      rotZ,
    });

    // Side strips — lowered to follow tube curvature
    const sideMidSY = midSY - sideDrop;
    for (const sign of [-1, 1]) {
      collision.addCollider({
        type: 'box',
        cx: midX + perpX * sideOffset * sign,
        cz: midZ + perpZ * sideOffset * sign,
        halfW,
        halfD: sideHalfD,
        cosY, sinY,
        centerY: sideMidSY - WALK_HALF_H * cosRZ,
        halfH: WALK_HALF_H,
        rotZ,
      });
    }
  }

  // Flattened mound bases — squished wider so you can walk up from any angle
  for (const p of points) {
    if (p.y >= 0) {
      addArchBaseMound(group, collision, p, radius, material);
      break;
    }
  }
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].y >= 0) {
      addArchBaseMound(group, collision, points[i], radius, material);
      break;
    }
  }

  // Bridge ramp colliders at each archway base.
  addArchBaseBridge(collision, points, radius, WALK_HALF_H);

  // Register archway base positions as elevation access points for NPC pathfinding
  const startPt = points[0];
  const endPt = points[points.length - 1];
  collision.addElevationAccessPoint({ x: startPt.x, z: startPt.z });
  collision.addElevationAccessPoint({ x: endPt.x, z: endPt.z });

  // Register walkable-surface waypoint chain for NPC path-following navigation.
  const navWaypoints: { x: number; y: number; z: number }[] = points
    .map(p => ({ x: p.x, y: p.y + radius, z: p.z }))
    .filter(wp => wp.y >= 0);

  if (navWaypoints.length >= 2) {
    const first = navWaypoints[0];
    const last = navWaypoints[navWaypoints.length - 1];

    const dxSE = first.x - last.x;
    const dzSE = first.z - last.z;
    const lenSE = Math.sqrt(dxSE * dxSE + dzSE * dzSE) || 1;
    const APPROACH_DIST = 8;
    const dirX = dxSE / lenSE;
    const dirZ = dzSE / lenSE;

    const RAMP_STEPS = 3;
    const moundPeak = radius;

    // Start end: approach -> ramp waypoints -> first tube waypoint
    const startApproach = {
      x: first.x + dirX * APPROACH_DIST,
      y: 0,
      z: first.z + dirZ * APPROACH_DIST,
    };
    navWaypoints.unshift(startApproach);
    // Insert ramp waypoints between approach and first tube wp (now at index 1)
    for (let i = RAMP_STEPS; i >= 1; i--) {
      const t = i / (RAMP_STEPS + 1); // 0.75, 0.5, 0.25 (outer to inner)
      const frac = 1 - t; // fraction along ramp from approach to first tube wp
      navWaypoints.splice(1, 0, {
        x: startApproach.x + (first.x - startApproach.x) * frac,
        y: moundPeak * frac * frac, // quadratic ease
        z: startApproach.z + (first.z - startApproach.z) * frac,
      });
    }

    // End: last tube waypoint -> ramp waypoints -> approach
    const endApproach = {
      x: last.x - dirX * APPROACH_DIST,
      y: 0,
      z: last.z - dirZ * APPROACH_DIST,
    };
    for (let i = 1; i <= RAMP_STEPS; i++) {
      const frac = i / (RAMP_STEPS + 1);
      navWaypoints.push({
        x: last.x + (endApproach.x - last.x) * frac,
        y: moundPeak * (1 - frac) * (1 - frac),
        z: last.z + (endApproach.z - last.z) * frac,
      });
    }
    navWaypoints.push(endApproach);
  }

  collision.addNavigationPath({ waypoints: navWaypoints });
}

/** Smooth mound base at an archway foot — visual + radial ramp colliders */
function addArchBaseMound(
  group: THREE.Group,
  collision: CollisionSystem,
  basePos: THREE.Vector3,
  tubeRadius: number,
  material: THREE.ShaderMaterial,
): void {
  const spread = tubeRadius * 3;           // XZ radius of the mound
  const moundHeight = tubeRadius;          // peak matches the tube top

  // Visual: low, wide cone — a subtle ramp collar around the tube base
  const visualRadius = tubeRadius * 3;
  const visualHeight = tubeRadius;
  const coneGeo = new THREE.ConeGeometry(visualRadius, visualHeight, 24, 1, true);
  const coneMesh = new THREE.Mesh(coneGeo, material);
  coneMesh.position.set(basePos.x, visualHeight / 2, basePos.z);
  coneMesh.name = 'archBaseMound';
  group.add(coneMesh);

  // Collision: radial ramp colliders (linear slope from ground at edge to peak).
  const numRamps = 24;
  const rampHalfW = spread / 2;
  const rampHalfD = (Math.PI * spread) / numRamps;
  const rotZ = Math.asin(moundHeight / (2 * rampHalfW));
  const sinRot = Math.sin(rotZ);
  const cosRot = Math.cos(rotZ);
  const halfH = 0.5;
  const centerY = rampHalfW * sinRot - halfH * cosRot;

  for (let i = 0; i < numRamps; i++) {
    const theta = (i / numRamps) * Math.PI * 2;
    const inwardAngle = theta + Math.PI;
    const cx = basePos.x + Math.cos(theta) * rampHalfW;
    const cz = basePos.z + Math.sin(theta) * rampHalfW;

    collision.addCollider({
      type: 'box',
      cx,
      cz,
      halfW: rampHalfW,
      halfD: rampHalfD,
      cosY: Math.cos(inwardAngle),
      sinY: Math.sin(inwardAngle),
      centerY,
      halfH,
      rotZ,
    });
  }
}

/**
 * Bridge ramp colliders at each end of an archway where the tube emerges
 * from the ground. These fill the height gap between the mound peak and the
 * first tube walkable strips.
 */
function addArchBaseBridge(
  collision: CollisionSystem,
  points: THREE.Vector3[],
  radius: number,
  walkHalfH: number,
): void {
  const BRIDGE_SEGS = 6;

  for (const fromStart of [true, false]) {
    for (let s = 0; s < BRIDGE_SEGS; s++) {
      const i = fromStart ? s : points.length - 1 - s;
      const j = fromStart ? s + 1 : points.length - 2 - s;
      if (j < 0 || j >= points.length) continue;

      const p1 = points[i];
      const p2 = points[j];

      // Tube surface Y at these points
      const sY1 = p1.y + radius;
      const sY2 = p2.y + radius;

      // Only add bridges where the tube surface is below ~8 units
      if (sY1 > 8 && sY2 > 8) continue;

      const midX = (p1.x + p2.x) / 2;
      const midZ = (p1.z + p2.z) / 2;
      const midSY = (sY1 + sY2) / 2;

      const dx = p2.x - p1.x;
      const dz = p2.z - p1.z;
      const dy = sY2 - sY1;
      const hDist = Math.sqrt(dx * dx + dz * dz) || 0.001;
      const sDist = Math.sqrt(hDist * hDist + dy * dy);
      const yAngle = Math.atan2(dz, dx);
      const rotZ = Math.atan2(dy, hDist);
      const cosY = Math.cos(yAngle);
      const sinY = Math.sin(yAngle);
      const cosRZ = Math.cos(rotZ);
      const halfW = sDist / 2 + 0.3;

      const bridgeHalfD = radius * 0.9;

      collision.addCollider({
        type: 'box',
        cx: midX,
        cz: midZ,
        halfW,
        halfD: bridgeHalfD,
        cosY, sinY,
        centerY: midSY - walkHalfH * cosRZ,
        halfH: walkHalfH,
        rotZ,
      });
    }
  }
}

/** Sparkle particles floating near the diamond archways. Returns the ShaderMaterial. */
function createArchSparkles(
  group: THREE.Group,
  curve1: THREE.CatmullRomCurve3,
  curve2: THREE.CatmullRomCurve3,
): THREE.ShaderMaterial {
  const count = 300;
  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count);

  let seed = 31337;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let i = 0; i < count; i++) {
    const curve = i < count / 2 ? curve1 : curve2;
    const p = curve.getPointAt(rng());
    positions[i * 3]     = p.x + (rng() - 0.5) * 8;
    positions[i * 3 + 1] = Math.max(0.5, p.y + (rng() - 0.5) * 5 + 2);
    positions[i * 3 + 2] = p.z + (rng() - 0.5) * 8;
    phases[i] = rng() * Math.PI * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      uniform float uTime;
      attribute float aPhase;
      varying float vAlpha;
      void main() {
        vAlpha = pow(sin(aPhase + uTime * 2.5) * 0.5 + 0.5, 4.0);
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPos;
        gl_PointSize = mix(1.0, 4.5, vAlpha) * (180.0 / -mvPos.z);
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        gl_FragColor = vec4(0.85, 0.92, 1.0, (1.0 - d * d) * vAlpha * 0.9);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const pts = new THREE.Points(geo, mat);
  pts.name = 'archSparkles';
  group.add(pts);

  return mat;
}
