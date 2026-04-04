import * as THREE from 'three';
import {
  createFloorTexture,
  createCageBarTexture,
  createPillarRingTexture,
} from './CageTextures';

export function createRingFloor(group: THREE.Group): void {
  // Main ring combat surface
  const ringGeo = new THREE.PlaneGeometry(39, 39);
  const { map: floorMap, bumpMap: floorBump } = createFloorTexture();
  const ringMat = new THREE.MeshStandardMaterial({
    map: floorMap,
    bumpMap: floorBump,
    bumpScale: 0.3,
    roughness: 0.85,
    emissive: 0x332211,
    emissiveIntensity: 0.08,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  ring.receiveShadow = true;
  group.add(ring);

  // Red border lines around the ring edge
  const edgeMat = new THREE.MeshStandardMaterial({
    color: 0x993333,
    roughness: 0.8,
    emissive: 0x440000,
    emissiveIntensity: 0.15,
  });
  const borders: { pos: number[]; size: [number, number] }[] = [
    { pos: [0, 0.03, -19.2], size: [39, 0.6] },
    { pos: [0, 0.03, 19.2], size: [39, 0.6] },
    { pos: [-19.2, 0.03, 0], size: [0.6, 39] },
    { pos: [19.2, 0.03, 0], size: [0.6, 39] },
  ];
  for (const b of borders) {
    const geo = new THREE.PlaneGeometry(b.size[0], b.size[1]);
    const mesh = new THREE.Mesh(geo, edgeMat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(b.pos[0], b.pos[1], b.pos[2]);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

export function createPenFloors(group: THREE.Group): void {
  const { map: penFloorMap, bumpMap: penFloorBump } = createFloorTexture();
  penFloorMap.repeat.set(2, 2);
  penFloorBump.repeat.set(2, 2);

  // South pen (Team 1 - red)
  const southGeo = new THREE.PlaneGeometry(11.5, 9.5);
  const southMat = new THREE.MeshStandardMaterial({
    map: penFloorMap,
    bumpMap: penFloorBump,
    bumpScale: 0.25,
    color: 0x442222,
    roughness: 0.9,
    emissive: 0x330000,
    emissiveIntensity: 0.12,
  });
  const southFloor = new THREE.Mesh(southGeo, southMat);
  southFloor.rotation.x = -Math.PI / 2;
  southFloor.position.set(0, 0.015, 25.5);
  southFloor.receiveShadow = true;
  group.add(southFloor);

  // North pen (Team 2 - blue)
  const northGeo = new THREE.PlaneGeometry(11.5, 9.5);
  const northMat = new THREE.MeshStandardMaterial({
    map: penFloorMap,
    bumpMap: penFloorBump,
    bumpScale: 0.25,
    color: 0x222244,
    roughness: 0.9,
    emissive: 0x000033,
    emissiveIntensity: 0.12,
  });
  const northFloor = new THREE.Mesh(northGeo, northMat);
  northFloor.rotation.x = -Math.PI / 2;
  northFloor.position.set(0, 0.015, -25.5);
  northFloor.receiveShadow = true;
  group.add(northFloor);
}

export function createCageBars(group: THREE.Group): void {
  const barGeo = new THREE.CylinderGeometry(0.06, 0.06, 1, 6);
  const { map: barMap, bumpMap: barBump } = createCageBarTexture();
  const barMat = new THREE.MeshStandardMaterial({
    map: barMap,
    bumpMap: barBump,
    bumpScale: 0.3,
    metalness: 0.7,
    roughness: 0.25,
  });

  const bars: { x: number; y: number; z: number; h: number }[] = [];
  const cageH = 20;
  const cageY = 10;
  const penH = 5;
  const penY = 2.5;
  const spacing = 1.2;

  // East cage wall bars
  for (let z = -30; z <= 30; z += spacing) {
    bars.push({ x: 20.35, y: cageY, z, h: cageH });
  }
  // West cage wall bars
  for (let z = -30; z <= 30; z += spacing) {
    bars.push({ x: -20.35, y: cageY, z, h: cageH });
  }
  // North cage wall bars
  for (let x = -20; x <= 20; x += spacing) {
    bars.push({ x, y: cageY, z: -30.35, h: cageH });
  }
  // South cage wall bars
  for (let x = -20; x <= 20; x += spacing) {
    bars.push({ x, y: cageY, z: 30.35, h: cageH });
  }

  // North pen wall bars
  for (let z = -21; z >= -29.5; z -= spacing) {
    bars.push({ x: -5.85, y: penY, z, h: penH });
    bars.push({ x: 5.85, y: penY, z, h: penH });
  }
  // South pen wall bars
  for (let z = 21; z <= 29.5; z += spacing) {
    bars.push({ x: -5.85, y: penY, z, h: penH });
    bars.push({ x: 5.85, y: penY, z, h: penH });
  }

  const mesh = new THREE.InstancedMesh(barGeo, barMat, bars.length);
  const dummy = new THREE.Object3D();

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    dummy.position.set(bar.x, bar.y, bar.z);
    dummy.scale.set(1, bar.h, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }

  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

export function createCameraCollisionWalls(group: THREE.Group): void {
  const invisMat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
  });

  const walls: { pos: [number, number, number]; size: [number, number, number] }[] = [
    // Cage outer walls
    { pos: [20.5, 10, 0], size: [0.1, 20, 61] },     // East
    { pos: [-20.5, 10, 0], size: [0.1, 20, 61] },    // West
    { pos: [0, 10, -30.5], size: [41, 20, 0.1] },    // North
    { pos: [0, 10, 30.5], size: [41, 20, 0.1] },     // South
    // Pen interior walls
    { pos: [-6, 2.5, -25.5], size: [0.1, 5, 10] },   // North pen west
    { pos: [6, 2.5, -25.5], size: [0.1, 5, 10] },    // North pen east
    { pos: [-6, 2.5, 25.5], size: [0.1, 5, 10] },    // South pen west
    { pos: [6, 2.5, 25.5], size: [0.1, 5, 10] },     // South pen east
  ];

  for (const w of walls) {
    const geo = new THREE.BoxGeometry(w.size[0], w.size[1], w.size[2]);
    const mesh = new THREE.Mesh(geo, invisMat);
    mesh.position.set(w.pos[0], w.pos[1], w.pos[2]);
    group.add(mesh);
  }
}

export function createCageFrame(group: THREE.Group): void {
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x666670,
    metalness: 0.8,
    roughness: 0.2,
  });

  const beams: { pos: number[]; scale: number[] }[] = [
    // Top frame (y=20)
    { pos: [0, 20, -30.5], scale: [41, 0.25, 0.25] },
    { pos: [0, 20, 30.5], scale: [41, 0.25, 0.25] },
    { pos: [-20.5, 20, 0], scale: [0.25, 0.25, 61.5] },
    { pos: [20.5, 20, 0], scale: [0.25, 0.25, 61.5] },
    // Bottom frame (ground level)
    { pos: [0, 0.125, -30.5], scale: [41, 0.25, 0.25] },
    { pos: [0, 0.125, 30.5], scale: [41, 0.25, 0.25] },
    { pos: [-20.5, 0.125, 0], scale: [0.25, 0.25, 61.5] },
    { pos: [20.5, 0.125, 0], scale: [0.25, 0.25, 61.5] },
    // Mid-height horizontal (y=4)
    { pos: [0, 4, -30.5], scale: [41, 0.18, 0.18] },
    { pos: [0, 4, 30.5], scale: [41, 0.18, 0.18] },
    { pos: [-20.5, 4, 0], scale: [0.18, 0.18, 61.5] },
    { pos: [20.5, 4, 0], scale: [0.18, 0.18, 61.5] },
    // Pen wall top beams
    { pos: [-6, 5, -25.5], scale: [0.18, 0.18, 10] },
    { pos: [6, 5, -25.5], scale: [0.18, 0.18, 10] },
    { pos: [-6, 5, 25.5], scale: [0.18, 0.18, 10] },
    { pos: [6, 5, 25.5], scale: [0.18, 0.18, 10] },
  ];

  for (const b of beams) {
    const geo = new THREE.BoxGeometry(b.scale[0], b.scale[1], b.scale[2]);
    const mesh = new THREE.Mesh(geo, frameMat);
    mesh.position.set(b.pos[0], b.pos[1], b.pos[2]);
    mesh.castShadow = true;
    group.add(mesh);
  }

  // Cage ceiling grid (thin bars at y=20)
  const meshBarMat = new THREE.MeshStandardMaterial({
    color: 0x555560,
    metalness: 0.7,
    roughness: 0.3,
  });

  // East-west bars across the top
  for (let z = -28; z <= 28; z += 6) {
    const geo = new THREE.BoxGeometry(41, 0.06, 0.06);
    const mesh = new THREE.Mesh(geo, meshBarMat);
    mesh.position.set(0, 20.05, z);
    group.add(mesh);
  }
  // North-south bars across the top
  for (let x = -20; x <= 20; x += 6) {
    const geo = new THREE.BoxGeometry(0.06, 0.06, 61);
    const mesh = new THREE.Mesh(geo, meshBarMat);
    mesh.position.set(x, 20.05, 0);
    group.add(mesh);
  }
}

export function createCornerPosts(group: THREE.Group): void {
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x555560,
    metalness: 0.6,
    roughness: 0.3,
  });

  // Cage corner posts
  const cagePostGeo = new THREE.CylinderGeometry(0.25, 0.25, 20, 8);
  const cageCorners: number[][] = [
    [-20.5, 10, -30.5],
    [20.5, 10, -30.5],
    [-20.5, 10, 30.5],
    [20.5, 10, 30.5],
  ];
  for (const [x, y, z] of cageCorners) {
    const post = new THREE.Mesh(cagePostGeo, postMat);
    post.position.set(x, y, z);
    post.castShadow = true;
    group.add(post);
  }

  // Gate hinge posts (thicker, at door pivots)
  const gatePostMat = new THREE.MeshStandardMaterial({
    color: 0x666670,
    metalness: 0.7,
    roughness: 0.2,
  });
  const gatePostGeo = new THREE.CylinderGeometry(0.3, 0.3, 5.5, 8);
  const gatePosts: number[][] = [
    [-6, 2.75, -20.5],
    [6, 2.75, -20.5],
    [-6, 2.75, 20.5],
    [6, 2.75, 20.5],
  ];
  for (const [x, y, z] of gatePosts) {
    const post = new THREE.Mesh(gatePostGeo, gatePostMat);
    post.position.set(x, y, z);
    post.castShadow = true;
    group.add(post);
  }
}

export function createStadiumStructure(group: THREE.Group): void {
  const concreteMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a,
    roughness: 0.95,
    metalness: 0.0,
  });

  // East side tiers (4 tiers rising outward)
  const eastTiers = [
    { cx: 23.5, cy: 0.75, sy: 1.5 },
    { cx: 27, cy: 1.75, sy: 3.5 },
    { cx: 30.5, cy: 2.75, sy: 5.5 },
    { cx: 34, cy: 3.75, sy: 7.5 },
  ];
  for (const t of eastTiers) {
    // East
    const geoE = new THREE.BoxGeometry(3, t.sy, 61);
    const meshE = new THREE.Mesh(geoE, concreteMat);
    meshE.position.set(t.cx, t.cy, 0);
    meshE.receiveShadow = true;
    group.add(meshE);
    // West (mirror)
    const geoW = new THREE.BoxGeometry(3, t.sy, 61);
    const meshW = new THREE.Mesh(geoW, concreteMat);
    meshW.position.set(-t.cx, t.cy, 0);
    meshW.receiveShadow = true;
    group.add(meshW);
  }

  // North side tiers (3 tiers)
  const northTiers = [
    { cz: -33, cy: 0.75, sy: 1.5 },
    { cz: -36.5, cy: 1.75, sy: 3.5 },
    { cz: -40, cy: 2.75, sy: 5.5 },
  ];
  for (const t of northTiers) {
    // North
    const geoN = new THREE.BoxGeometry(56, t.sy, 3);
    const meshN = new THREE.Mesh(geoN, concreteMat);
    meshN.position.set(0, t.cy, t.cz);
    meshN.receiveShadow = true;
    group.add(meshN);
    // South (mirror)
    const geoS = new THREE.BoxGeometry(56, t.sy, 3);
    const meshS = new THREE.Mesh(geoS, concreteMat);
    meshS.position.set(0, t.cy, -t.cz);
    meshS.receiveShadow = true;
    group.add(meshS);
  }

  // Stadium back walls
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x151518,
    roughness: 0.95,
  });
  const backWalls: { pos: number[]; scale: number[] }[] = [
    { pos: [36.5, 5, 0], scale: [1, 10, 63] },
    { pos: [-36.5, 5, 0], scale: [1, 10, 63] },
    { pos: [0, 4.5, -42.5], scale: [58, 9, 1] },
    { pos: [0, 4.5, 42.5], scale: [58, 9, 1] },
  ];
  for (const w of backWalls) {
    const geo = new THREE.BoxGeometry(w.scale[0], w.scale[1], w.scale[2]);
    const mesh = new THREE.Mesh(geo, wallMat);
    mesh.position.set(w.pos[0], w.pos[1], w.pos[2]);
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Aisle steps (vertical face of each tier, slightly lighter)
  const stepFaceMat = new THREE.MeshStandardMaterial({
    color: 0x333336,
    roughness: 0.9,
  });
  // East aisle step faces
  const stepFaces = [
    { pos: [21.9, 0.75, 0], scale: [0.15, 1.5, 61] },
    { pos: [25.4, 1.75, 0], scale: [0.15, 2, 61] },
    { pos: [28.9, 2.75, 0], scale: [0.15, 2, 61] },
    { pos: [32.4, 3.75, 0], scale: [0.15, 2, 61] },
  ];
  for (const sf of stepFaces) {
    // East
    const geo1 = new THREE.BoxGeometry(sf.scale[0], sf.scale[1], sf.scale[2]);
    const mesh1 = new THREE.Mesh(geo1, stepFaceMat);
    mesh1.position.set(sf.pos[0], sf.pos[1], sf.pos[2]);
    group.add(mesh1);
    // West (mirror)
    const geo2 = new THREE.BoxGeometry(sf.scale[0], sf.scale[1], sf.scale[2]);
    const mesh2 = new THREE.Mesh(geo2, stepFaceMat);
    mesh2.position.set(-sf.pos[0], sf.pos[1], sf.pos[2]);
    group.add(mesh2);
  }
}

export function createStadiumLighting(group: THREE.Group): void {
  const poleMat = new THREE.MeshStandardMaterial({
    color: 0x444444,
    metalness: 0.5,
    roughness: 0.5,
  });
  const poleGeo = new THREE.CylinderGeometry(0.25, 0.35, 14, 6);

  const fixtureMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffdd,
    emissiveIntensity: 0.8,
  });
  const fixtureGeo = new THREE.BoxGeometry(1.5, 0.4, 1.5);

  const corners: number[][] = [
    [30.5, 7, 32.5],
    [-30.5, 7, 32.5],
    [30.5, 7, -32.5],
    [-30.5, 7, -32.5],
  ];

  for (const [x, y, z] of corners) {
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(x, y, z);
    pole.castShadow = true;
    group.add(pole);

    const fixture = new THREE.Mesh(fixtureGeo, fixtureMat);
    fixture.position.set(x, 14.5, z);
    group.add(fixture);

    const light = new THREE.PointLight(0xffeedd, 1.2, 50, 1.5);
    light.position.set(x, 14, z);
    group.add(light);
  }

  // Colored accent lights at the gates
  const redLight = new THREE.PointLight(0xff2200, 0.8, 25);
  redLight.position.set(0, 5.5, -20.5);
  group.add(redLight);

  const blueLight = new THREE.PointLight(0x0044ff, 0.8, 25);
  blueLight.position.set(0, 5.5, 20.5);
  group.add(blueLight);

  // Subtle purple uplights on the cage corners
  const uplightColor = 0x6622aa;
  const uplightPositions: number[][] = [
    [-20.5, 0.5, -30.5],
    [20.5, 0.5, -30.5],
    [-20.5, 0.5, 30.5],
    [20.5, 0.5, 30.5],
  ];
  for (const [x, y, z] of uplightPositions) {
    const uplight = new THREE.PointLight(uplightColor, 0.4, 15);
    uplight.position.set(x, y, z);
    group.add(uplight);
  }
}

export function createBarricades(group: THREE.Group): void {
  const barricadeMat = new THREE.MeshStandardMaterial({
    color: 0x222225,
    roughness: 0.8,
  });

  const barricades: { pos: number[]; scale: number[] }[] = [
    { pos: [21.7, 0.45, 0], scale: [0.2, 0.9, 61] },
    { pos: [-21.7, 0.45, 0], scale: [0.2, 0.9, 61] },
    { pos: [0, 0.45, -31.7], scale: [56, 0.9, 0.2] },
    { pos: [0, 0.45, 31.7], scale: [56, 0.9, 0.2] },
  ];

  for (const b of barricades) {
    const geo = new THREE.BoxGeometry(b.scale[0], b.scale[1], b.scale[2]);
    const mesh = new THREE.Mesh(geo, barricadeMat);
    mesh.position.set(b.pos[0], b.pos[1], b.pos[2]);
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Barricade padding on top (soft bumper look)
  const padMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.95 });
  for (const b of barricades) {
    const geo = new THREE.BoxGeometry(
      b.scale[0] + 0.1,
      0.12,
      b.scale[2] + 0.1,
    );
    const mesh = new THREE.Mesh(geo, padMat);
    mesh.position.set(b.pos[0], 0.96, b.pos[2]);
    group.add(mesh);
  }
}

export function createRingDetails(group: THREE.Group): void {
  // Announcer tables (east side, between cage and barricade)
  const tableMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a,
    roughness: 0.7,
  });
  const tableGeo = new THREE.BoxGeometry(2.5, 0.65, 0.9);
  const tableLegGeo = new THREE.BoxGeometry(0.12, 0.35, 0.12);
  const tables: number[][] = [
    [21, 0.325, -5],
    [21, 0.325, 5],
  ];
  for (const [x, y, z] of tables) {
    const table = new THREE.Mesh(tableGeo, tableMat);
    table.position.set(x, y, z);
    table.receiveShadow = true;
    group.add(table);
    // Table legs
    for (const lx of [-1, 1]) {
      for (const lz of [-0.3, 0.3]) {
        const leg = new THREE.Mesh(tableLegGeo, tableMat);
        leg.position.set(x + lx, 0.175, z + lz);
        group.add(leg);
      }
    }
  }

  // Monitor on each table
  const monitorMat = new THREE.MeshStandardMaterial({
    color: 0x111111,
    emissive: 0x222266,
    emissiveIntensity: 0.3,
  });
  const monitorGeo = new THREE.BoxGeometry(0.6, 0.45, 0.05);
  for (const [x, , z] of tables) {
    const mon = new THREE.Mesh(monitorGeo, monitorMat);
    mon.position.set(x, 0.88, z);
    mon.rotation.y = -Math.PI / 2;
    group.add(mon);
  }

  // Center ring marking
  const ringMarkGeo = new THREE.RingGeometry(2.5, 2.8, 32);
  const ringMarkMat = new THREE.MeshStandardMaterial({
    color: 0xcc3333,
    roughness: 0.8,
    emissive: 0x440000,
    emissiveIntensity: 0.1,
  });
  const ringMark = new THREE.Mesh(ringMarkGeo, ringMarkMat);
  ringMark.rotation.x = -Math.PI / 2;
  ringMark.position.y = 0.025;
  group.add(ringMark);

  // Inner ring mark (smaller)
  const innerMarkGeo = new THREE.RingGeometry(0.8, 1, 24);
  const innerMark = new THREE.Mesh(innerMarkGeo, ringMarkMat);
  innerMark.rotation.x = -Math.PI / 2;
  innerMark.position.y = 0.025;
  group.add(innerMark);

  // Pillar base rings (hollow steel collars the pillars slide through)
  const { map: ringMap, bumpMap: ringBump } = createPillarRingTexture();
  const baseMat = new THREE.MeshStandardMaterial({
    map: ringMap,
    bumpMap: ringBump,
    bumpScale: 0.3,
    metalness: 0.8,
    roughness: 0.15,
  });
  const innerR = 1.85; // slightly larger than pillar radius (1.8) for clearance
  const outerR = 2.3;
  const ringH = 0.3;
  // Rectangular cross-section revolved around Y axis → hollow ring
  const profile = [
    new THREE.Vector2(innerR, 0),
    new THREE.Vector2(outerR, 0),
    new THREE.Vector2(outerR, ringH),
    new THREE.Vector2(innerR, ringH),
  ];
  const baseGeo = new THREE.LatheGeometry(profile, 32);
  for (const px of [-11, 11]) {
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.set(px, 0, 0);
    base.receiveShadow = true;
    group.add(base);
  }
  for (const pz of [-11, 11]) {
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.set(0, 0, pz);
    base.receiveShadow = true;
    group.add(base);
  }

  // Chain decoration between pillar bases (draped chains across the ring)
  const chainMat = new THREE.MeshStandardMaterial({
    color: 0x777780,
    metalness: 0.8,
    roughness: 0.2,
  });
  // Simplified as a thin drooping cylinder arc (just a small bar for visual)
  const chainGeo = new THREE.CylinderGeometry(0.04, 0.04, 20, 6);
  const chain = new THREE.Mesh(chainGeo, chainMat);
  chain.position.set(0, 0.08, 0);
  chain.rotation.z = Math.PI / 2;
  group.add(chain);
}
