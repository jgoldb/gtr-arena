import * as THREE from 'three';

/**
 * GPU-driven crowd material — injects a vertex shader snippet that snaps
 * each InstancedMesh instance between two poses at a unique per-instance
 * frequency derived from its world position.
 * All animation runs on the GPU — zero CPU cost per frame.
 */
function createCrowdMaterial(
  crowdTimeUniform: { value: number },
  props: THREE.MeshStandardMaterialParameters,
  part: 'body' | 'head' | 'sign',
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial(props);

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCrowdTime = crowdTimeUniform;

    // Inject uniform declaration at the top of the vertex shader
    shader.vertexShader = 'uniform float uCrowdTime;\n' + shader.vertexShader;

    // Inject displacement code after the <begin_vertex> chunk
    // (which sets `vec3 transformed = vec3(position);`)
    //
    // We derive a per-instance phase from the instance matrix's world
    // position (column 3) so each spectator moves independently.
    const displacementCode = /* glsl */ `
      {
        // Extract instance world position from the instance matrix
        vec3 iPos = vec3(
          instanceMatrix[3][0],
          instanceMatrix[3][1],
          instanceMatrix[3][2]
        );

        // Per-instance hashes for unique timing
        float h1 = fract(sin(iPos.x * 127.1 + iPos.z * 311.7) * 43758.5);
        float h2 = fract(sin(iPos.x * 269.5 + iPos.z * 183.3) * 28461.3);

        // Each spectator toggles at their own rate (0.4–1.2 Hz)
        float freq = 0.4 + h1 * 0.8;
        // Binary state: 0 or 1, hard snap like a sprite swap
        float state = step(0.5, fract(uCrowdTime * freq + h2));

        ${part === 'sign' ? `
        // Signs: snap between tilted left / tilted right
        float side = state * 2.0 - 1.0; // -1 or +1
        transformed.x += side * 0.1;
        transformed.y += state * 0.06;
        ` : `
        // Body/head: snap between resting and "hands up" pose
        transformed.y += state * ${part === 'head' ? '0.18' : '0.12'};
        `}
      }
    `;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' + displacementCode,
    );
  };

  return mat;
}

function createCrowdSigns(
  group: THREE.Group,
  crowdTimeUniform: { value: number },
  random: () => number,
  spectatorCount: number,
): void {
  const signColors = [
    '#ff0000', '#00ff00', '#ffff00', '#ff00ff', '#00ffff', '#ff8800', '#ffffff',
  ];
  const signGeo = new THREE.BoxGeometry(0.5, 0.35, 0.04);
  const signMat = createCrowdMaterial(crowdTimeUniform, { roughness: 0.7 }, 'sign');
  const signCount = Math.floor(spectatorCount * 0.04);
  const signMesh = new THREE.InstancedMesh(signGeo, signMat, signCount);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  // Reset seed for deterministic sign placement tied to spectator grid
  let seed2 = 12345;
  const random2 = () => {
    seed2 = (seed2 * 1103515245 + 12345) & 0x7fffffff;
    return seed2 / 0x7fffffff;
  };

  // Scatter signs at random spectator-like positions in the tiers
  const tierConfigs = [
    // East side
    { mainAxis: 'z' as const, mStart: -29, mEnd: 29, crossPos: [22.5, 28, 31.5, 35], topYs: [1.5, 3.5, 5.5, 7.5] },
    // West side
    { mainAxis: 'z' as const, mStart: -29, mEnd: 29, crossPos: [-22.5, -28, -31.5, -35], topYs: [1.5, 3.5, 5.5, 7.5] },
    // North side
    { mainAxis: 'x' as const, mStart: -26, mEnd: 26, crossPos: [-32, -37.5], topYs: [1.5, 3.5] },
    // South side
    { mainAxis: 'x' as const, mStart: -26, mEnd: 26, crossPos: [32, 37.5], topYs: [1.5, 3.5] },
  ];

  let si = 0;
  for (const tc of tierConfigs) {
    for (let ti = 0; ti < tc.crossPos.length; ti++) {
      const cp = tc.crossPos[ti];
      const topY = tc.topYs[ti] ?? tc.topYs[tc.topYs.length - 1];
      for (let m = tc.mStart; m <= tc.mEnd; m += 3 + random2() * 4) {
        if (si >= signCount) break;
        const x = tc.mainAxis === 'x' ? m : cp;
        const z = tc.mainAxis === 'z' ? m : cp;
        dummy.position.set(x, topY + 1.1 + random2() * 0.3, z);
        dummy.rotation.set(
          (random2() - 0.5) * 0.3,
          random2() * Math.PI * 2,
          (random2() - 0.5) * 0.2,
        );
        dummy.scale.set(0.8 + random2() * 0.4, 0.8 + random2() * 0.4, 1);
        dummy.updateMatrix();
        signMesh.setMatrixAt(si, dummy.matrix);
        color.set(signColors[Math.floor(random2() * signColors.length)]);
        signMesh.setColorAt(si, color);
        si++;
      }
    }
  }

  signMesh.count = si;
  signMesh.instanceMatrix.needsUpdate = true;
  if (signMesh.instanceColor) signMesh.instanceColor.needsUpdate = true;
  group.add(signMesh);
}

/** Create the full crowd system: instanced body + head meshes, plus signs. */
export function createSpectators(
  group: THREE.Group,
  crowdTimeUniform: { value: number },
): void {
  // Seeded random for deterministic crowd
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const shirtColors = [
    '#e53935', '#d32f2f', '#c62828',
    '#1e88e5', '#1565c0', '#0d47a1',
    '#43a047', '#2e7d32',
    '#fdd835', '#f9a825',
    '#ff8f00', '#ef6c00',
    '#8e24aa', '#6a1b9a',
    '#ffffff', '#e0e0e0',
    '#212121', '#424242',
  ];
  const skinTones = [
    '#FFDAB9', '#F5CBA7', '#D4A574', '#C68642', '#8D5524', '#6B4226',
  ];

  const maxCount = 2400;
  const bodyGeo = new THREE.BoxGeometry(0.35, 0.65, 0.28);
  const bodyMat = createCrowdMaterial(crowdTimeUniform, { roughness: 0.9 }, 'body');
  const bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, maxCount);

  const headGeo = new THREE.SphereGeometry(0.12, 5, 4);
  const headMat = createCrowdMaterial(crowdTimeUniform, { roughness: 0.8 }, 'head');
  const headMesh = new THREE.InstancedMesh(headGeo, headMat, maxCount);

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  let idx = 0;
  const spacing = 0.65;

  // Helper: add a row of spectators along an axis
  const addSection = (
    mainAxis: 'x' | 'z',
    mainStart: number,
    mainEnd: number,
    crossPositions: number[],
    topY: number,
    faceAngle: number,
  ) => {
    for (const crossPos of crossPositions) {
      for (let m = mainStart; m <= mainEnd; m += spacing) {
        if (idx >= maxCount) return;
        const x = mainAxis === 'x' ? m : crossPos;
        const z = mainAxis === 'z' ? m : crossPos;
        const y = topY + 0.33;

        // Body
        dummy.position.set(x, y, z);
        dummy.rotation.set(0, faceAngle + (random() - 0.5) * 0.4, 0);
        dummy.scale.set(
          0.9 + random() * 0.2,
          0.75 + random() * 0.5,
          0.9 + random() * 0.2,
        );
        dummy.updateMatrix();
        bodyMesh.setMatrixAt(idx, dummy.matrix);
        color.set(shirtColors[Math.floor(random() * shirtColors.length)]);
        bodyMesh.setColorAt(idx, color);

        // Head
        dummy.position.set(x, y + 0.42 + random() * 0.08, z);
        dummy.rotation.set(0, faceAngle + (random() - 0.5) * 0.6, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        headMesh.setMatrixAt(idx, dummy.matrix);
        color.set(skinTones[Math.floor(random() * skinTones.length)]);
        headMesh.setColorAt(idx, color);

        idx++;
      }
    }
  };

  // East side tiers (face west toward ring) — 4 tiers, 2 rows each
  addSection('z', -29, 29, [22.5, 24.5], 1.5, -Math.PI / 2);
  addSection('z', -29, 29, [26, 28], 3.5, -Math.PI / 2);
  addSection('z', -29, 29, [29.5, 31.5], 5.5, -Math.PI / 2);
  addSection('z', -29, 29, [33, 35], 7.5, -Math.PI / 2);

  // West side tiers (face east toward ring)
  addSection('z', -29, 29, [-22.5, -24.5], 1.5, Math.PI / 2);
  addSection('z', -29, 29, [-26, -28], 3.5, Math.PI / 2);
  addSection('z', -29, 29, [-29.5, -31.5], 5.5, Math.PI / 2);
  addSection('z', -29, 29, [-33, -35], 7.5, Math.PI / 2);

  // North side tiers (face south toward ring) — 3 tiers
  addSection('x', -26, 26, [-32, -34], 1.5, 0);
  addSection('x', -26, 26, [-35.5, -37.5], 3.5, 0);
  addSection('x', -26, 26, [-39, -41], 5.5, 0);

  // South side tiers (face north toward ring)
  addSection('x', -26, 26, [32, 34], 1.5, Math.PI);
  addSection('x', -26, 26, [35.5, 37.5], 3.5, Math.PI);
  addSection('x', -26, 26, [39, 41], 5.5, Math.PI);

  bodyMesh.count = idx;
  headMesh.count = idx;
  bodyMesh.instanceMatrix.needsUpdate = true;
  headMesh.instanceMatrix.needsUpdate = true;
  if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
  if (headMesh.instanceColor) headMesh.instanceColor.needsUpdate = true;

  bodyMesh.castShadow = true;
  headMesh.castShadow = true;
  group.add(bodyMesh);
  group.add(headMesh);

  // Signs held up by ~5% of spectators
  createCrowdSigns(group, crowdTimeUniform, random, idx);
}
