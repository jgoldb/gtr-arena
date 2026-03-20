import * as THREE from 'three';
import type { MapScript } from './MapScript';
import type { CollisionSystem, Collider } from '../physics/CollisionSystem';
import type { BoxCollider } from '../physics/CollisionSystem';

export class CageArenaScript implements MapScript {
  private group!: THREE.Group;
  private collision!: CollisionSystem;

  // Doors
  private doorPivots: THREE.Group[] = [];
  private doorColliders: Collider[] = [];
  private doorsOpen = false;
  private doorAnimProgress = 0;
  private readonly DOOR_OPEN_TIME = 60;
  private readonly DOOR_ANIM_DURATION = 2.5;

  // Timer
  private elapsed = 0;

  // Effects
  private flashLight: THREE.PointLight | null = null;

  // UI
  private overlayEl: HTMLElement | null = null;
  private countdownEl: HTMLElement | null = null;
  private fightEl: HTMLElement | null = null;

  init(scene: THREE.Scene, mapGroup: THREE.Group, collision: CollisionSystem): void {
    this.group = mapGroup;
    this.collision = collision;
    this.elapsed = 0;
    this.doorsOpen = false;
    this.doorAnimProgress = 0;

    this.createRingFloor();
    this.createPenFloors();
    this.createCageBars();
    this.createCageFrame();
    this.createCornerPosts();
    this.createDoors();
    this.createStadiumStructure();
    this.createSpectators();
    this.createStadiumLighting();
    this.createBarricades();
    this.createRingDetails();
    this.createCountdownUI();
  }

  update(dt: number): void {
    this.elapsed += dt;

    // Countdown
    if (!this.doorsOpen) {
      const remaining = Math.max(0, Math.ceil(this.DOOR_OPEN_TIME - this.elapsed));

      if (this.countdownEl) {
        this.countdownEl.textContent = String(remaining);

        if (remaining <= 10) {
          this.countdownEl.style.color = '#ff4444';
          this.countdownEl.style.textShadow =
            '0 0 30px rgba(255,0,0,0.8), 2px 2px 6px rgba(0,0,0,0.8)';
        }
        if (remaining <= 3 && remaining > 0) {
          const pulse = 1 + Math.sin(this.elapsed * 10) * 0.08;
          this.countdownEl.style.transform = `scale(${pulse})`;
        }
      }

      if (this.elapsed >= this.DOOR_OPEN_TIME) {
        this.openDoors();
      }
    }

    // Door swing animation
    if (this.doorsOpen && this.doorAnimProgress < 1) {
      this.doorAnimProgress += dt / this.DOOR_ANIM_DURATION;
      if (this.doorAnimProgress > 1) this.doorAnimProgress = 1;
      this.animateDoors(this.doorAnimProgress);
    }

    // Flash effect
    if (this.flashLight) {
      const flashAge = this.elapsed - this.DOOR_OPEN_TIME;
      if (flashAge < 1.2) {
        this.flashLight.intensity = 6 * (1 - flashAge / 1.2);
      } else {
        this.group.remove(this.flashLight);
        this.flashLight = null;
      }
    }

    // Fade out FIGHT text
    if (this.fightEl) {
      const fightAge = this.elapsed - this.DOOR_OPEN_TIME;
      if (fightAge > 2.5) {
        this.fightEl.style.opacity = String(Math.max(0, 1 - (fightAge - 2.5) / 1));
        if (fightAge > 3.5) {
          this.fightEl.remove();
          this.fightEl = null;
        }
      }
    }
  }

  forceOpenDoors(): void {
    if (this.doorsOpen) return;
    this.elapsed = this.DOOR_OPEN_TIME;
    this.openDoors();
  }

  dispose(): void {
    this.overlayEl?.remove();
    this.fightEl?.remove();
    this.overlayEl = null;
    this.fightEl = null;
    this.countdownEl = null;
    this.doorPivots = [];
    this.doorColliders = [];
    this.flashLight = null;
  }

  // ---------------------------------------------------------------------------
  // Ring floor
  // ---------------------------------------------------------------------------
  private createRingFloor(): void {
    // Main ring combat surface
    const ringGeo = new THREE.PlaneGeometry(34, 30);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0xd8d0c0,
      roughness: 0.85,
      emissive: 0x332211,
      emissiveIntensity: 0.08,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    ring.receiveShadow = true;
    this.group.add(ring);

    // Red border lines around the ring edge
    const edgeMat = new THREE.MeshStandardMaterial({
      color: 0x993333,
      roughness: 0.8,
      emissive: 0x440000,
      emissiveIntensity: 0.15,
    });
    const borders: { pos: number[]; size: [number, number] }[] = [
      { pos: [0, 0.03, -14.7], size: [34, 0.6] },
      { pos: [0, 0.03, 14.7], size: [34, 0.6] },
      { pos: [-16.7, 0.03, 0], size: [0.6, 30] },
      { pos: [16.7, 0.03, 0], size: [0.6, 30] },
    ];
    for (const b of borders) {
      const geo = new THREE.PlaneGeometry(b.size[0], b.size[1]);
      const mesh = new THREE.Mesh(geo, edgeMat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(b.pos[0], b.pos[1], b.pos[2]);
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  // ---------------------------------------------------------------------------
  // Starting pen floors
  // ---------------------------------------------------------------------------
  private createPenFloors(): void {
    // South pen (Team 1 - red)
    const southGeo = new THREE.PlaneGeometry(11.5, 9.5);
    const southMat = new THREE.MeshStandardMaterial({
      color: 0x331111,
      roughness: 0.9,
      emissive: 0x330000,
      emissiveIntensity: 0.12,
    });
    const southFloor = new THREE.Mesh(southGeo, southMat);
    southFloor.rotation.x = -Math.PI / 2;
    southFloor.position.set(0, 0.015, 21);
    southFloor.receiveShadow = true;
    this.group.add(southFloor);

    // North pen (Team 2 - blue)
    const northGeo = new THREE.PlaneGeometry(11.5, 9.5);
    const northMat = new THREE.MeshStandardMaterial({
      color: 0x111133,
      roughness: 0.9,
      emissive: 0x000033,
      emissiveIntensity: 0.12,
    });
    const northFloor = new THREE.Mesh(northGeo, northMat);
    northFloor.rotation.x = -Math.PI / 2;
    northFloor.position.set(0, 0.015, -21);
    northFloor.receiveShadow = true;
    this.group.add(northFloor);
  }

  // ---------------------------------------------------------------------------
  // Cage vertical bars (InstancedMesh)
  // ---------------------------------------------------------------------------
  private createCageBars(): void {
    const barGeo = new THREE.CylinderGeometry(0.06, 0.06, 1, 6);
    const barMat = new THREE.MeshStandardMaterial({
      color: 0x888890,
      metalness: 0.7,
      roughness: 0.25,
    });

    const bars: { x: number; y: number; z: number; h: number }[] = [];
    const cageH = 8;
    const cageY = 4;
    const penH = 5;
    const penY = 2.5;
    const spacing = 1.2;

    // East cage wall bars
    for (let z = -25.5; z <= 25.5; z += spacing) {
      bars.push({ x: 17.85, y: cageY, z, h: cageH });
    }
    // West cage wall bars
    for (let z = -25.5; z <= 25.5; z += spacing) {
      bars.push({ x: -17.85, y: cageY, z, h: cageH });
    }
    // North cage wall bars
    for (let x = -17.5; x <= 17.5; x += spacing) {
      bars.push({ x, y: cageY, z: -25.85, h: cageH });
    }
    // South cage wall bars
    for (let x = -17.5; x <= 17.5; x += spacing) {
      bars.push({ x, y: cageY, z: 25.85, h: cageH });
    }

    // North pen wall bars
    for (let z = -16.5; z >= -25; z -= spacing) {
      bars.push({ x: -5.85, y: penY, z, h: penH });
      bars.push({ x: 5.85, y: penY, z, h: penH });
    }
    // South pen wall bars
    for (let z = 16.5; z <= 25; z += spacing) {
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
    this.group.add(mesh);
  }

  // ---------------------------------------------------------------------------
  // Cage horizontal frame beams and ceiling mesh
  // ---------------------------------------------------------------------------
  private createCageFrame(): void {
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x666670,
      metalness: 0.8,
      roughness: 0.2,
    });

    const beams: { pos: number[]; scale: number[] }[] = [
      // Top frame (y=8)
      { pos: [0, 8, -26], scale: [36.5, 0.25, 0.25] },
      { pos: [0, 8, 26], scale: [36.5, 0.25, 0.25] },
      { pos: [-18, 8, 0], scale: [0.25, 0.25, 52.5] },
      { pos: [18, 8, 0], scale: [0.25, 0.25, 52.5] },
      // Bottom frame (ground level)
      { pos: [0, 0.125, -26], scale: [36.5, 0.25, 0.25] },
      { pos: [0, 0.125, 26], scale: [36.5, 0.25, 0.25] },
      { pos: [-18, 0.125, 0], scale: [0.25, 0.25, 52.5] },
      { pos: [18, 0.125, 0], scale: [0.25, 0.25, 52.5] },
      // Mid-height horizontal (y=4)
      { pos: [0, 4, -26], scale: [36.5, 0.18, 0.18] },
      { pos: [0, 4, 26], scale: [36.5, 0.18, 0.18] },
      { pos: [-18, 4, 0], scale: [0.18, 0.18, 52.5] },
      { pos: [18, 4, 0], scale: [0.18, 0.18, 52.5] },
      // Pen wall top beams
      { pos: [-6, 5, -21], scale: [0.18, 0.18, 10] },
      { pos: [6, 5, -21], scale: [0.18, 0.18, 10] },
      { pos: [-6, 5, 21], scale: [0.18, 0.18, 10] },
      { pos: [6, 5, 21], scale: [0.18, 0.18, 10] },
    ];

    for (const b of beams) {
      const geo = new THREE.BoxGeometry(b.scale[0], b.scale[1], b.scale[2]);
      const mesh = new THREE.Mesh(geo, frameMat);
      mesh.position.set(b.pos[0], b.pos[1], b.pos[2]);
      mesh.castShadow = true;
      this.group.add(mesh);
    }

    // Cage ceiling grid (thin bars at y=8)
    const meshBarMat = new THREE.MeshStandardMaterial({
      color: 0x555560,
      metalness: 0.7,
      roughness: 0.3,
    });

    // East-west bars across the top
    for (let z = -24; z <= 24; z += 6) {
      const geo = new THREE.BoxGeometry(36, 0.06, 0.06);
      const mesh = new THREE.Mesh(geo, meshBarMat);
      mesh.position.set(0, 8.05, z);
      this.group.add(mesh);
    }
    // North-south bars across the top
    for (let x = -17; x <= 17; x += 6) {
      const geo = new THREE.BoxGeometry(0.06, 0.06, 52);
      const mesh = new THREE.Mesh(geo, meshBarMat);
      mesh.position.set(x, 8.05, 0);
      this.group.add(mesh);
    }
  }

  // ---------------------------------------------------------------------------
  // Corner posts
  // ---------------------------------------------------------------------------
  private createCornerPosts(): void {
    const postMat = new THREE.MeshStandardMaterial({
      color: 0x555560,
      metalness: 0.6,
      roughness: 0.3,
    });

    // Cage corner posts
    const cagePostGeo = new THREE.CylinderGeometry(0.25, 0.25, 8, 8);
    const cageCorners: number[][] = [
      [-18, 4, -26],
      [18, 4, -26],
      [-18, 4, 26],
      [18, 4, 26],
    ];
    for (const [x, y, z] of cageCorners) {
      const post = new THREE.Mesh(cagePostGeo, postMat);
      post.position.set(x, y, z);
      post.castShadow = true;
      this.group.add(post);
    }

    // Gate hinge posts (thicker, at door pivots)
    const gatePostMat = new THREE.MeshStandardMaterial({
      color: 0x666670,
      metalness: 0.7,
      roughness: 0.2,
    });
    const gatePostGeo = new THREE.CylinderGeometry(0.3, 0.3, 5.5, 8);
    const gatePosts: number[][] = [
      [-6, 2.75, -16],
      [6, 2.75, -16],
      [-6, 2.75, 16],
      [6, 2.75, 16],
    ];
    for (const [x, y, z] of gatePosts) {
      const post = new THREE.Mesh(gatePostGeo, gatePostMat);
      post.position.set(x, y, z);
      post.castShadow = true;
      this.group.add(post);
    }
  }

  // ---------------------------------------------------------------------------
  // Doors (animated gates)
  // ---------------------------------------------------------------------------
  private createDoors(): void {
    const doorMat = new THREE.MeshStandardMaterial({
      color: 0x555555,
      metalness: 0.85,
      roughness: 0.15,
    });
    const halfDoorGeo = new THREE.BoxGeometry(6, 5, 0.2);

    // Cage bar decoration on door panels
    const barGeo = new THREE.CylinderGeometry(0.04, 0.04, 4.6, 4);
    const barMat = new THREE.MeshStandardMaterial({
      color: 0x888888,
      metalness: 0.7,
      roughness: 0.3,
    });

    // Horizontal bar for the door
    const hBarGeo = new THREE.BoxGeometry(5.6, 0.06, 0.06);
    const hBarMat = barMat;

    const doorDefs = [
      { px: -6, pz: -16, mx: 3 }, // NW half
      { px: 6, pz: -16, mx: -3 }, // NE half
      { px: -6, pz: 16, mx: 3 }, // SW half
      { px: 6, pz: 16, mx: -3 }, // SE half
    ];

    for (const def of doorDefs) {
      const pivot = new THREE.Group();
      pivot.position.set(def.px, 0, def.pz);

      const door = new THREE.Mesh(halfDoorGeo, doorMat.clone());
      door.position.set(def.mx, 2.5, 0);
      door.castShadow = true;
      door.receiveShadow = true;

      // Vertical bars on the door
      for (let bx = -2.4; bx <= 2.4; bx += 0.8) {
        const bar = new THREE.Mesh(barGeo, barMat);
        bar.position.set(bx, 0, 0.11);
        door.add(bar);
      }

      // Horizontal bars on the door
      for (let by = -1.5; by <= 1.5; by += 1.5) {
        const hBar = new THREE.Mesh(hBarGeo, hBarMat);
        hBar.position.set(0, by, 0.11);
        door.add(hBar);
      }

      pivot.add(door);
      this.group.add(pivot);
      this.doorPivots.push(pivot);
    }

    // Add collision for closed doors
    const northDoor: BoxCollider = {
      type: 'box',
      cx: 0,
      cz: -16,
      halfW: 6,
      halfD: 0.1,
      cosY: 1,
      sinY: 0,
      centerY: 2.5,
      halfH: 2.5,
      rotZ: 0,
    };
    const southDoor: BoxCollider = {
      type: 'box',
      cx: 0,
      cz: 16,
      halfW: 6,
      halfD: 0.1,
      cosY: 1,
      sinY: 0,
      centerY: 2.5,
      halfH: 2.5,
      rotZ: 0,
    };

    this.collision.addCollider(northDoor);
    this.collision.addCollider(southDoor);
    this.doorColliders.push(northDoor, southDoor);
  }

  // ---------------------------------------------------------------------------
  // Stadium seating structure
  // ---------------------------------------------------------------------------
  private createStadiumStructure(): void {
    const concreteMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a2a,
      roughness: 0.95,
      metalness: 0.0,
    });

    // East side tiers (4 tiers rising outward)
    const eastTiers = [
      { cx: 21, cy: 0.75, sy: 1.5 },
      { cx: 24.5, cy: 1.75, sy: 3.5 },
      { cx: 28, cy: 2.75, sy: 5.5 },
      { cx: 31.5, cy: 3.75, sy: 7.5 },
    ];
    for (const t of eastTiers) {
      // East
      const geoE = new THREE.BoxGeometry(3, t.sy, 50);
      const meshE = new THREE.Mesh(geoE, concreteMat);
      meshE.position.set(t.cx, t.cy, 0);
      meshE.receiveShadow = true;
      this.group.add(meshE);
      // West (mirror)
      const geoW = new THREE.BoxGeometry(3, t.sy, 50);
      const meshW = new THREE.Mesh(geoW, concreteMat);
      meshW.position.set(-t.cx, t.cy, 0);
      meshW.receiveShadow = true;
      this.group.add(meshW);
    }

    // North side tiers (3 tiers)
    const northTiers = [
      { cz: -28.5, cy: 0.75, sy: 1.5 },
      { cz: -32, cy: 1.75, sy: 3.5 },
      { cz: -35.5, cy: 2.75, sy: 5.5 },
    ];
    for (const t of northTiers) {
      // North
      const geoN = new THREE.BoxGeometry(50, t.sy, 3);
      const meshN = new THREE.Mesh(geoN, concreteMat);
      meshN.position.set(0, t.cy, t.cz);
      meshN.receiveShadow = true;
      this.group.add(meshN);
      // South (mirror)
      const geoS = new THREE.BoxGeometry(50, t.sy, 3);
      const meshS = new THREE.Mesh(geoS, concreteMat);
      meshS.position.set(0, t.cy, -t.cz);
      meshS.receiveShadow = true;
      this.group.add(meshS);
    }

    // Stadium back walls
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x151518,
      roughness: 0.95,
    });
    const backWalls: { pos: number[]; scale: number[] }[] = [
      { pos: [34, 5, 0], scale: [1, 10, 52] },
      { pos: [-34, 5, 0], scale: [1, 10, 52] },
      { pos: [0, 4.5, -38], scale: [52, 9, 1] },
      { pos: [0, 4.5, 38], scale: [52, 9, 1] },
    ];
    for (const w of backWalls) {
      const geo = new THREE.BoxGeometry(w.scale[0], w.scale[1], w.scale[2]);
      const mesh = new THREE.Mesh(geo, wallMat);
      mesh.position.set(w.pos[0], w.pos[1], w.pos[2]);
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    // Aisle steps (vertical face of each tier, slightly lighter)
    const stepFaceMat = new THREE.MeshStandardMaterial({
      color: 0x333336,
      roughness: 0.9,
    });
    // East aisle step faces
    const stepFaces = [
      { pos: [19.4, 0.75, 0], scale: [0.15, 1.5, 50] },
      { pos: [22.9, 1.75, 0], scale: [0.15, 2, 50] },
      { pos: [26.4, 2.75, 0], scale: [0.15, 2, 50] },
      { pos: [29.9, 3.75, 0], scale: [0.15, 2, 50] },
    ];
    for (const sf of stepFaces) {
      // East
      const geo1 = new THREE.BoxGeometry(sf.scale[0], sf.scale[1], sf.scale[2]);
      const mesh1 = new THREE.Mesh(geo1, stepFaceMat);
      mesh1.position.set(sf.pos[0], sf.pos[1], sf.pos[2]);
      this.group.add(mesh1);
      // West (mirror)
      const geo2 = new THREE.BoxGeometry(sf.scale[0], sf.scale[1], sf.scale[2]);
      const mesh2 = new THREE.Mesh(geo2, stepFaceMat);
      mesh2.position.set(-sf.pos[0], sf.pos[1], sf.pos[2]);
      this.group.add(mesh2);
    }
  }

  // ---------------------------------------------------------------------------
  // Spectators (InstancedMesh bodies + heads)
  // ---------------------------------------------------------------------------
  private createSpectators(): void {
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
    const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
    const bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, maxCount);

    const headGeo = new THREE.SphereGeometry(0.12, 5, 4);
    const headMat = new THREE.MeshStandardMaterial({ roughness: 0.8 });
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
    addSection('z', -24, 24, [20, 22], 1.5, -Math.PI / 2);
    addSection('z', -24, 24, [23.5, 25.5], 3.5, -Math.PI / 2);
    addSection('z', -24, 24, [27, 29], 5.5, -Math.PI / 2);
    addSection('z', -24, 24, [30.5, 32.5], 7.5, -Math.PI / 2);

    // West side tiers (face east toward ring)
    addSection('z', -24, 24, [-20, -22], 1.5, Math.PI / 2);
    addSection('z', -24, 24, [-23.5, -25.5], 3.5, Math.PI / 2);
    addSection('z', -24, 24, [-27, -29], 5.5, Math.PI / 2);
    addSection('z', -24, 24, [-30.5, -32.5], 7.5, Math.PI / 2);

    // North side tiers (face south toward ring) — 3 tiers
    addSection('x', -24, 24, [-27.5, -29.5], 1.5, 0);
    addSection('x', -24, 24, [-31, -33], 3.5, 0);
    addSection('x', -24, 24, [-34.5, -36.5], 5.5, 0);

    // South side tiers (face north toward ring)
    addSection('x', -24, 24, [27.5, 29.5], 1.5, Math.PI);
    addSection('x', -24, 24, [31, 33], 3.5, Math.PI);
    addSection('x', -24, 24, [34.5, 36.5], 5.5, Math.PI);

    bodyMesh.count = idx;
    headMesh.count = idx;
    bodyMesh.instanceMatrix.needsUpdate = true;
    headMesh.instanceMatrix.needsUpdate = true;
    if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
    if (headMesh.instanceColor) headMesh.instanceColor.needsUpdate = true;

    bodyMesh.castShadow = true;
    headMesh.castShadow = true;
    this.group.add(bodyMesh);
    this.group.add(headMesh);

    // Signs held up by ~5% of spectators
    this.createCrowdSigns(random, idx);
  }

  private createCrowdSigns(random: () => number, spectatorCount: number): void {
    const signColors = [
      '#ff0000', '#00ff00', '#ffff00', '#ff00ff', '#00ffff', '#ff8800', '#ffffff',
    ];
    const signGeo = new THREE.BoxGeometry(0.5, 0.35, 0.04);
    const signMat = new THREE.MeshStandardMaterial({ roughness: 0.7 });
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
      { mainAxis: 'z' as const, mStart: -24, mEnd: 24, crossPos: [20, 25.5, 29, 32.5], topYs: [1.5, 3.5, 5.5, 7.5] },
      // West side
      { mainAxis: 'z' as const, mStart: -24, mEnd: 24, crossPos: [-20, -25.5, -29, -32.5], topYs: [1.5, 3.5, 5.5, 7.5] },
      // North side
      { mainAxis: 'x' as const, mStart: -24, mEnd: 24, crossPos: [-27.5, -33], topYs: [1.5, 3.5] },
      // South side
      { mainAxis: 'x' as const, mStart: -24, mEnd: 24, crossPos: [27.5, 33], topYs: [1.5, 3.5] },
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
    this.group.add(signMesh);
  }

  // ---------------------------------------------------------------------------
  // Stadium lighting
  // ---------------------------------------------------------------------------
  private createStadiumLighting(): void {
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
      [28, 7, 28],
      [-28, 7, 28],
      [28, 7, -28],
      [-28, 7, -28],
    ];

    for (const [x, y, z] of corners) {
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(x, y, z);
      pole.castShadow = true;
      this.group.add(pole);

      const fixture = new THREE.Mesh(fixtureGeo, fixtureMat);
      fixture.position.set(x, 14.5, z);
      this.group.add(fixture);

      const light = new THREE.PointLight(0xffeedd, 1.2, 50, 1.5);
      light.position.set(x, 14, z);
      this.group.add(light);
    }

    // Colored accent lights at the gates
    const redLight = new THREE.PointLight(0xff2200, 0.8, 25);
    redLight.position.set(0, 5.5, -16);
    this.group.add(redLight);

    const blueLight = new THREE.PointLight(0x0044ff, 0.8, 25);
    blueLight.position.set(0, 5.5, 16);
    this.group.add(blueLight);

    // Subtle purple uplights on the cage corners
    const uplightColor = 0x6622aa;
    const uplightPositions: number[][] = [
      [-18, 0.5, -26],
      [18, 0.5, -26],
      [-18, 0.5, 26],
      [18, 0.5, 26],
    ];
    for (const [x, y, z] of uplightPositions) {
      const uplight = new THREE.PointLight(uplightColor, 0.4, 15);
      uplight.position.set(x, y, z);
      this.group.add(uplight);
    }
  }

  // ---------------------------------------------------------------------------
  // Barricades (between cage and seating)
  // ---------------------------------------------------------------------------
  private createBarricades(): void {
    const barricadeMat = new THREE.MeshStandardMaterial({
      color: 0x222225,
      roughness: 0.8,
    });

    const barricades: { pos: number[]; scale: number[] }[] = [
      { pos: [19.2, 0.45, 0], scale: [0.2, 0.9, 50] },
      { pos: [-19.2, 0.45, 0], scale: [0.2, 0.9, 50] },
      { pos: [0, 0.45, -27.2], scale: [50, 0.9, 0.2] },
      { pos: [0, 0.45, 27.2], scale: [50, 0.9, 0.2] },
    ];

    for (const b of barricades) {
      const geo = new THREE.BoxGeometry(b.scale[0], b.scale[1], b.scale[2]);
      const mesh = new THREE.Mesh(geo, barricadeMat);
      mesh.position.set(b.pos[0], b.pos[1], b.pos[2]);
      mesh.receiveShadow = true;
      this.group.add(mesh);
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
      this.group.add(mesh);
    }
  }

  // ---------------------------------------------------------------------------
  // Ring details (announcer tables, center mark, pillar bases)
  // ---------------------------------------------------------------------------
  private createRingDetails(): void {
    // Announcer tables (east side, between cage and barricade)
    const tableMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a2a,
      roughness: 0.7,
    });
    const tableGeo = new THREE.BoxGeometry(2.5, 0.65, 0.9);
    const tableLegGeo = new THREE.BoxGeometry(0.12, 0.35, 0.12);
    const tables: number[][] = [
      [18.5, 0.325, -5],
      [18.5, 0.325, 5],
    ];
    for (const [x, y, z] of tables) {
      const table = new THREE.Mesh(tableGeo, tableMat);
      table.position.set(x, y, z);
      table.receiveShadow = true;
      this.group.add(table);
      // Table legs
      for (const lx of [-1, 1]) {
        for (const lz of [-0.3, 0.3]) {
          const leg = new THREE.Mesh(tableLegGeo, tableMat);
          leg.position.set(x + lx, 0.175, z + lz);
          this.group.add(leg);
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
      this.group.add(mon);
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
    this.group.add(ringMark);

    // Inner ring mark (smaller)
    const innerMarkGeo = new THREE.RingGeometry(0.8, 1, 24);
    const innerMark = new THREE.Mesh(innerMarkGeo, ringMarkMat);
    innerMark.rotation.x = -Math.PI / 2;
    innerMark.position.y = 0.025;
    this.group.add(innerMark);

    // Pillar base decorations
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x555560,
      metalness: 0.7,
      roughness: 0.2,
    });
    const baseGeo = new THREE.CylinderGeometry(2.2, 2.2, 0.12, 16);
    for (const px of [-8, 8]) {
      const base = new THREE.Mesh(baseGeo, baseMat);
      base.position.set(px, 0.06, 0);
      base.receiveShadow = true;
      this.group.add(base);
    }

    // Chain decoration between pillar bases (draped chains across the ring)
    const chainMat = new THREE.MeshStandardMaterial({
      color: 0x777780,
      metalness: 0.8,
      roughness: 0.2,
    });
    // Simplified as a thin drooping cylinder arc (just a small bar for visual)
    const chainGeo = new THREE.CylinderGeometry(0.04, 0.04, 14, 6);
    const chain = new THREE.Mesh(chainGeo, chainMat);
    chain.position.set(0, 0.08, 0);
    chain.rotation.z = Math.PI / 2;
    this.group.add(chain);
  }

  // ---------------------------------------------------------------------------
  // Countdown UI overlay
  // ---------------------------------------------------------------------------
  private createCountdownUI(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0;
      pointer-events: none;
      z-index: 50;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding-top: 55px;
    `;

    const title = document.createElement('div');
    title.style.cssText = `
      font-family: 'Impact', 'Arial Black', sans-serif;
      font-size: 52px;
      color: #cc2222;
      text-shadow: 0 0 20px rgba(200,0,0,0.5), 2px 2px 4px rgba(0,0,0,0.8);
      letter-spacing: 10px;
      text-transform: uppercase;
    `;
    title.textContent = 'THE CAGE';
    overlay.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.style.cssText = `
      font-size: 18px;
      color: #888;
      margin-top: 4px;
      font-family: Arial, sans-serif;
      text-shadow: 1px 1px 3px rgba(0,0,0,0.8);
      letter-spacing: 4px;
      text-transform: uppercase;
    `;
    subtitle.textContent = 'Gates open in';
    overlay.appendChild(subtitle);

    const countdown = document.createElement('div');
    countdown.style.cssText = `
      font-family: 'Impact', 'Arial Black', sans-serif;
      font-size: 64px;
      color: #ffffff;
      text-shadow: 0 0 20px rgba(255,255,255,0.3), 2px 2px 6px rgba(0,0,0,0.8);
      margin-top: 0;
      transition: color 0.3s, text-shadow 0.3s;
    `;
    countdown.textContent = '60';
    overlay.appendChild(countdown);

    document.body.appendChild(overlay);
    this.overlayEl = overlay;
    this.countdownEl = countdown;
  }

  // ---------------------------------------------------------------------------
  // Door open sequence
  // ---------------------------------------------------------------------------
  private openDoors(): void {
    this.doorsOpen = true;
    this.doorAnimProgress = 0;

    // Remove door colliders
    for (const collider of this.doorColliders) {
      this.collision.removeCollider(collider);
    }

    // Flash effect
    const flash = new THREE.PointLight(0xffffff, 6, 40);
    flash.position.set(0, 6, 0);
    this.group.add(flash);
    this.flashLight = flash;

    // Remove countdown overlay
    if (this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
      this.countdownEl = null;
    }

    this.showFightText();
  }

  private animateDoors(progress: number): void {
    // Ease-out cubic
    const t = 1 - Math.pow(1 - progress, 3);
    const angle = (Math.PI / 2) * t;

    // NW half: swings CCW (toward +z into ring)
    this.doorPivots[0].rotation.y = angle;
    // NE half: swings CW
    this.doorPivots[1].rotation.y = -angle;
    // SW half: swings CW (toward -z into ring)
    this.doorPivots[2].rotation.y = -angle;
    // SE half: swings CCW
    this.doorPivots[3].rotation.y = angle;
  }

  private showFightText(): void {
    const fight = document.createElement('div');
    fight.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none;
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Impact', 'Arial Black', sans-serif;
      font-size: 120px;
      color: #ff0000;
      text-shadow:
        0 0 40px rgba(255,0,0,0.8),
        0 0 80px rgba(255,0,0,0.4),
        4px 4px 8px rgba(0,0,0,0.9);
      letter-spacing: 15px;
      transition: opacity 1s ease-out;
    `;
    fight.textContent = 'FIGHT!';
    document.body.appendChild(fight);
    this.fightEl = fight;
  }
}
