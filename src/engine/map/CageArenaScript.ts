import * as THREE from 'three';
import { ArenaScript } from './ArenaScript';
import type { Collider, BoxCollider, CircleCollider } from '../physics/CollisionSystem';

export class CageArenaScript extends ArenaScript {
  // Doors
  private doorPivots: THREE.Group[] = [];
  private doorColliders: Collider[] = [];

  // Pillars (east/west)
  private pillarMeshes: THREE.Mesh[] = [];
  private pillarColliders: CircleCollider[] = [];
  // Pillars (north/south) — opposite phase
  private nsPillarMeshes: THREE.Mesh[] = [];
  private nsPillarColliders: CircleCollider[] = [];

  private pillarState: 'up' | 'dropping' | 'down' | 'rising' = 'up';
  private pillarStateTimer = 0;
  private currentPillarUpDuration = 30; // first cycle uses initial delay
  private readonly PILLAR_DROP_ANIM = 2;
  private readonly PILLAR_DOWN_TIME = 30;
  private readonly PILLAR_RISE_ANIM = 2;
  private readonly PILLAR_Y_UP = 3;
  private readonly PILLAR_Y_DOWN = -3;

  constructor() {
    super({
      title: 'THE CAGE',
      titleColor: '#cc2222',
      subtitle: 'Gates open in',
      urgentColor: '#ff4444',
      fightColor: '#ff0000',
      flashColor: 0xffffff,
      flashIntensity: 6,
    });
  }

  // ---------------------------------------------------------------------------
  // ArenaScript hooks
  // ---------------------------------------------------------------------------
  protected initArena(): void {
    this.createRingFloor();
    this.createPenFloors();
    this.createCageBars();
    this.createCameraCollisionWalls();
    this.createCageFrame();
    this.createCornerPosts();
    this.createPillars();
    this.createDoors();
    this.createStadiumStructure();
    this.createSpectators();
    this.createStadiumLighting();
    this.createBarricades();
    this.createRingDetails();
  }

  protected updateArena(dt: number): void {
    if (!this.opened) return;

    this.pillarStateTimer += dt;

    switch (this.pillarState) {
      case 'up':
        if (this.pillarStateTimer >= this.currentPillarUpDuration) {
          this.pillarState = 'dropping';
          this.pillarStateTimer = 0;
        }
        break;
      case 'dropping': {
        const t = Math.min(this.pillarStateTimer / this.PILLAR_DROP_ANIM, 1);
        this.setPillarProgress(t);        // E/W: up → down
        this.setNSPillarProgress(1 - t);  // N/S: down → up
        if (t >= 1) {
          this.pillarState = 'down';
          this.pillarStateTimer = 0;
        }
        break;
      }
      case 'down':
        if (this.pillarStateTimer >= this.PILLAR_DOWN_TIME) {
          this.pillarState = 'rising';
          this.pillarStateTimer = 0;
        }
        break;
      case 'rising': {
        const t = Math.min(this.pillarStateTimer / this.PILLAR_RISE_ANIM, 1);
        this.setPillarProgress(1 - t);  // E/W: down → up
        this.setNSPillarProgress(t);    // N/S: up → down
        if (t >= 1) {
          this.pillarState = 'up';
          this.pillarStateTimer = 0;
          this.currentPillarUpDuration = 30;
        }
        break;
      }
    }
  }

  protected disposeArena(): void {
    this.doorPivots = [];
    this.doorColliders = [];
    this.pillarMeshes = [];
    this.pillarColliders = [];
    this.nsPillarMeshes = [];
    this.nsPillarColliders = [];
  }

  protected onOpen(): void {
    for (const collider of this.doorColliders) {
      this.collision.removeCollider(collider);
    }
  }

  protected animateOpen(t: number): void {
    const angle = (3 * Math.PI / 2) * t;

    // NW half: swings outward into ring, flush with west pen wall
    this.doorPivots[0].rotation.y = -angle;
    // NE half: swings outward into ring, flush with east pen wall
    this.doorPivots[1].rotation.y = angle;
    // SW half: swings outward into ring, flush with west pen wall
    this.doorPivots[2].rotation.y = angle;
    // SE half: swings outward into ring, flush with east pen wall
    this.doorPivots[3].rotation.y = -angle;
  }

  protected getFlashPositions(): { x: number; y: number; z: number }[] {
    return [{ x: 0, y: 6, z: 0 }];
  }

  // ---------------------------------------------------------------------------
  // Ring floor
  // ---------------------------------------------------------------------------
  private createRingFloor(): void {
    // Main ring combat surface
    const ringGeo = new THREE.PlaneGeometry(39, 39);
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
    southFloor.position.set(0, 0.015, 25.5);
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
    northFloor.position.set(0, 0.015, -25.5);
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
    this.group.add(mesh);
  }

  // ---------------------------------------------------------------------------
  // Invisible camera-collision walls (fill gaps between cage bars)
  // ---------------------------------------------------------------------------
  private createCameraCollisionWalls(): void {
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
      this.group.add(mesh);
    }
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
      this.group.add(mesh);
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
      this.group.add(mesh);
    }
    // North-south bars across the top
    for (let x = -20; x <= 20; x += 6) {
      const geo = new THREE.BoxGeometry(0.06, 0.06, 61);
      const mesh = new THREE.Mesh(geo, meshBarMat);
      mesh.position.set(x, 20.05, 0);
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
      [-6, 2.75, -20.5],
      [6, 2.75, -20.5],
      [-6, 2.75, 20.5],
      [6, 2.75, 20.5],
    ];
    for (const [x, y, z] of gatePosts) {
      const post = new THREE.Mesh(gatePostGeo, gatePostMat);
      post.position.set(x, y, z);
      post.castShadow = true;
      this.group.add(post);
    }
  }

  // ---------------------------------------------------------------------------
  // Ring pillars (animated drop/rise)
  // ---------------------------------------------------------------------------
  private createPillars(): void {
    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0x444450,
      metalness: 0.6,
      roughness: 0.3,
    });
    const pillarGeo = new THREE.CylinderGeometry(1.8, 1.8, 6, 16);

    // East/West pillars — start UP
    for (const px of [-11, 11]) {
      const mesh = new THREE.Mesh(pillarGeo, pillarMat);
      mesh.position.set(px, this.PILLAR_Y_UP, 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.pillarMeshes.push(mesh);

      const collider: CircleCollider = {
        type: 'circle',
        cx: px,
        cz: 0,
        radius: 1.8,
        centerY: this.PILLAR_Y_UP,
        halfH: 3,
      };
      this.collision.addCollider(collider);
      this.pillarColliders.push(collider);
    }

    // North/South pillars — start DOWN (opposite phase)
    for (const pz of [-11, 11]) {
      const mesh = new THREE.Mesh(pillarGeo, pillarMat);
      mesh.position.set(0, this.PILLAR_Y_DOWN, pz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.nsPillarMeshes.push(mesh);

      const collider: CircleCollider = {
        type: 'circle',
        cx: 0,
        cz: pz,
        radius: 1.8,
        centerY: this.PILLAR_Y_DOWN,
        halfH: 3,
      };
      this.collision.addCollider(collider);
      this.nsPillarColliders.push(collider);
    }
  }

  private setPillarProgress(t: number): void {
    const y = this.PILLAR_Y_UP + (this.PILLAR_Y_DOWN - this.PILLAR_Y_UP) * t;
    for (let i = 0; i < this.pillarMeshes.length; i++) {
      this.pillarMeshes[i].position.y = y;
      this.pillarColliders[i].centerY = y;
    }
  }

  /** Same as setPillarProgress but for the north/south pair. */
  private setNSPillarProgress(t: number): void {
    const y = this.PILLAR_Y_UP + (this.PILLAR_Y_DOWN - this.PILLAR_Y_UP) * t;
    for (let i = 0; i < this.nsPillarMeshes.length; i++) {
      this.nsPillarMeshes[i].position.y = y;
      this.nsPillarColliders[i].centerY = y;
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
      { px: -6, pz: -20.5, mx: 3 }, // NW half
      { px: 6, pz: -20.5, mx: -3 }, // NE half
      { px: -6, pz: 20.5, mx: 3 }, // SW half
      { px: 6, pz: 20.5, mx: -3 }, // SE half
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
      cz: -20.5,
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
      cz: 20.5,
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
      this.group.add(meshE);
      // West (mirror)
      const geoW = new THREE.BoxGeometry(3, t.sy, 61);
      const meshW = new THREE.Mesh(geoW, concreteMat);
      meshW.position.set(-t.cx, t.cy, 0);
      meshW.receiveShadow = true;
      this.group.add(meshW);
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
      this.group.add(meshN);
      // South (mirror)
      const geoS = new THREE.BoxGeometry(56, t.sy, 3);
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
      this.group.add(mesh);
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
      [30.5, 7, 32.5],
      [-30.5, 7, 32.5],
      [30.5, 7, -32.5],
      [-30.5, 7, -32.5],
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
    redLight.position.set(0, 5.5, -20.5);
    this.group.add(redLight);

    const blueLight = new THREE.PointLight(0x0044ff, 0.8, 25);
    blueLight.position.set(0, 5.5, 20.5);
    this.group.add(blueLight);

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
      [21, 0.325, -5],
      [21, 0.325, 5],
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
    for (const px of [-11, 11]) {
      const base = new THREE.Mesh(baseGeo, baseMat);
      base.position.set(px, 0.06, 0);
      base.receiveShadow = true;
      this.group.add(base);
    }
    for (const pz of [-11, 11]) {
      const base = new THREE.Mesh(baseGeo, baseMat);
      base.position.set(0, 0.06, pz);
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
    const chainGeo = new THREE.CylinderGeometry(0.04, 0.04, 20, 6);
    const chain = new THREE.Mesh(chainGeo, chainMat);
    chain.position.set(0, 0.08, 0);
    chain.rotation.z = Math.PI / 2;
    this.group.add(chain);
  }
}
