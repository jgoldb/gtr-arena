import * as THREE from 'three';
import { ArenaScript } from './ArenaScript';
import type { Collider, BoxCollider, CircleCollider } from '../physics/CollisionSystem';
import { audioSettings } from '../../ui/AudioSettings';

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

  // Crowd animation (GPU-driven via vertex shader)
  private crowdTimeUniform = { value: 0 };

  // Scoreboard + banners
  private teamKills = [0, 0]; // [red/team0, blue/team1]
  private scoreboardTextures: THREE.CanvasTexture[] = [];
  private southBannerTexture: THREE.CanvasTexture | null = null;
  private northBannerTexture: THREE.CanvasTexture | null = null;
  private bannerTimer = 0;
  private bannerActive = false;

  // One-shot ambient sounds
  private ambientAudioCtx: AudioContext | null = null;
  private cheerBuffer: AudioBuffer | null = null;
  private doorsOpenBuffer: AudioBuffer | null = null;

  // Game over state (-1 = game in progress)
  private gameOverWinningTeam = -1;
  private bannerKillerTeam = -1;
  private readonly BANNER_DURATION = 4;

  private readonly PILLAR_DROP_ANIM = 2;
  private readonly PILLAR_DOWN_TIME = 30;
  private readonly PILLAR_RISE_ANIM = 2;
  private readonly PILLAR_Y_UP = 3;
  private readonly PILLAR_Y_DOWN = -2.7;

  protected override readonly OPEN_ANIM_DURATION = 3.5;

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
    this.preloadAmbientSounds();
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
    this.createUpperArena();
  }

  protected updateArena(dt: number): void {
    // Crowd animation runs always (even during countdown)
    this.crowdTimeUniform.value += dt;

    // Banner animation countdown
    if (this.bannerActive) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) {
        this.bannerActive = false;
        this.drawSouthBanner();
        this.drawNorthBanner();
      }
    }

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
    this.scoreboardTextures = [];
    this.southBannerTexture = null;
    this.northBannerTexture = null;
    if (this.ambientAudioCtx) {
      this.ambientAudioCtx.close();
      this.ambientAudioCtx = null;
    }
    this.cheerBuffer = null;
    this.doorsOpenBuffer = null;
  }

  // ---------------------------------------------------------------------------
  // Killing blow hook — updates scoreboard + triggers banners
  // ---------------------------------------------------------------------------
  onKillingBlow(killerTeam: number, victimTeam: number): void {
    // Update kill counts
    if (killerTeam >= 0 && killerTeam < this.teamKills.length) {
      this.teamKills[killerTeam]++;
    }

    // Redraw scoreboard
    this.drawAllScoreboards();

    // Trigger banners — killer's team gets cheered, victim's team gets shamed
    this.bannerActive = true;
    this.bannerTimer = this.BANNER_DURATION;
    this.bannerKillerTeam = killerTeam;
    this.drawSouthBanner(killerTeam);
    this.drawNorthBanner(killerTeam);

    // Play crowd cheer
    this.playCheerSound();
  }

  onGameOver(winningTeam: number): void {
    this.gameOverWinningTeam = winningTeam;

    // If no killing blow banner is active, show result immediately
    if (!this.bannerActive) {
      this.drawSouthBanner();
      this.drawNorthBanner();
    }
    // Otherwise the result banners will show once the killing blow banner expires
  }

  private async preloadAmbientSounds(): Promise<void> {
    try {
      const ctx = new AudioContext();
      this.ambientAudioCtx = ctx;
      const [cheerResp, doorsResp] = await Promise.all([
        fetch('/audio/ambient/maps/cage/cheer.ogg'),
        fetch('/audio/ambient/maps/cage/doors_open.ogg'),
      ]);
      const [cheerBuf, doorsBuf] = await Promise.all([
        cheerResp.arrayBuffer(),
        doorsResp.arrayBuffer(),
      ]);
      this.cheerBuffer = await ctx.decodeAudioData(cheerBuf);
      this.doorsOpenBuffer = await ctx.decodeAudioData(doorsBuf);
    } catch (e) {
      console.warn('Failed to preload ambient sounds:', e);
    }
  }

  private playAmbientOneShot(buffer: AudioBuffer | null, volumeMultiplier = 1): void {
    if (!this.ambientAudioCtx || !buffer) return;
    if (!audioSettings.enableAmbient || !audioSettings.windowFocused) return;

    const ctx = this.ambientAudioCtx;
    if (ctx.state === 'suspended') ctx.resume();

    const gain = ctx.createGain();
    gain.gain.value = audioSettings.masterVolume * audioSettings.ambientVolume * volumeMultiplier;
    gain.connect(ctx.destination);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = false;
    source.connect(gain);
    source.start();
  }

  private playCheerSound(): void {
    this.playAmbientOneShot(this.cheerBuffer);
  }

  private playDoorsOpenSound(): void {
    this.playAmbientOneShot(this.doorsOpenBuffer, 3);
  }

  protected onOpen(): void {
    this.playDoorsOpenSound();
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
    const { map: floorMap, bumpMap: floorBump } = this.createFloorTexture();
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
    const { map: penFloorMap, bumpMap: penFloorBump } = this.createFloorTexture();
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
    this.group.add(southFloor);

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
    this.group.add(northFloor);
  }

  // ---------------------------------------------------------------------------
  // Cage vertical bars (InstancedMesh)
  // ---------------------------------------------------------------------------
  private createCageBars(): void {
    const barGeo = new THREE.CylinderGeometry(0.06, 0.06, 1, 6);
    const { map: barMap, bumpMap: barBump } = this.createCageBarTexture();
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

  /** Procedural wood-plank + steel-band texture for pillars. */
  private createPillarTextures(): { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
    const W = 512;
    const H = 512;
    const PLANKS = 12;           // number of vertical planks around the barrel
    const BANDS = 3;             // number of steel bands
    const BAND_H = 18;           // band height in pixels
    const GAP = 2;               // dark gap between planks
    const RIVET_R = 4;           // rivet dot radius

    // --- Color map ---
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;

    // Base wood fill
    ctx.fillStyle = '#6b4226';
    ctx.fillRect(0, 0, W, H);

    const plankW = W / PLANKS;

    // Draw each plank with slight color variation and grain
    for (let i = 0; i < PLANKS; i++) {
      const x = i * plankW;

      // Per-plank hue/lightness shift
      const lShift = (Math.sin(i * 3.7) * 12) | 0;
      const r = 107 + lShift;
      const g = 66 + ((lShift * 0.6) | 0);
      const b = 38 + ((lShift * 0.3) | 0);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x + GAP, 0, plankW - GAP * 2, H);

      // Wood grain lines
      ctx.strokeStyle = `rgba(40, 22, 10, 0.25)`;
      ctx.lineWidth = 1;
      const grainCount = 6 + ((Math.sin(i * 5.1) * 3) | 0);
      for (let g = 0; g < grainCount; g++) {
        const gx = x + GAP + 2 + (plankW - GAP * 2 - 4) * (g / grainCount);
        ctx.beginPath();
        // Wavy grain line
        for (let y = 0; y < H; y += 4) {
          const wx = gx + Math.sin(y * 0.02 + i * 2 + g) * 1.5;
          y === 0 ? ctx.moveTo(wx, y) : ctx.lineTo(wx, y);
        }
        ctx.stroke();
      }

      // Knots (occasional)
      if (i % 4 === 1) {
        const knotX = x + plankW / 2;
        const knotY = H * (0.3 + Math.sin(i * 2.3) * 0.2);
        const grad = ctx.createRadialGradient(knotX, knotY, 0, knotX, knotY, 8);
        grad.addColorStop(0, 'rgba(30, 15, 5, 0.7)');
        grad.addColorStop(0.6, 'rgba(60, 30, 15, 0.4)');
        grad.addColorStop(1, 'rgba(60, 30, 15, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(knotX, knotY, 8, 6, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // Dark gap between planks
      ctx.fillStyle = 'rgba(10, 5, 2, 0.9)';
      ctx.fillRect(x, 0, GAP, H);
      ctx.fillRect(x + plankW - GAP, 0, GAP, H);
    }

    // Steel bands
    const bandPositions: number[] = [];
    for (let b = 0; b < BANDS; b++) {
      const by = ((b + 1) / (BANDS + 1)) * H;
      bandPositions.push(by);

      // Band body
      const bandGrad = ctx.createLinearGradient(0, by - BAND_H / 2, 0, by + BAND_H / 2);
      bandGrad.addColorStop(0, '#7a7a82');
      bandGrad.addColorStop(0.3, '#a0a0a8');
      bandGrad.addColorStop(0.5, '#bbbbc4');
      bandGrad.addColorStop(0.7, '#a0a0a8');
      bandGrad.addColorStop(1, '#606068');
      ctx.fillStyle = bandGrad;
      ctx.fillRect(0, by - BAND_H / 2, W, BAND_H);

      // Band edge highlights
      ctx.fillStyle = 'rgba(200, 200, 210, 0.4)';
      ctx.fillRect(0, by - BAND_H / 2, W, 1);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.fillRect(0, by + BAND_H / 2 - 1, W, 1);

      // Rivets on each plank
      for (let i = 0; i < PLANKS; i++) {
        const rx = i * plankW + plankW / 2;
        const rivetGrad = ctx.createRadialGradient(rx - 1, by - 1, 0, rx, by, RIVET_R);
        rivetGrad.addColorStop(0, '#d0d0d8');
        rivetGrad.addColorStop(0.5, '#909098');
        rivetGrad.addColorStop(1, '#505058');
        ctx.fillStyle = rivetGrad;
        ctx.beginPath();
        ctx.arc(rx, by, RIVET_R, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const map = new THREE.CanvasTexture(canvas);
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;

    // --- Bump map (grayscale heightfield) ---
    const bCanvas = document.createElement('canvas');
    bCanvas.width = W;
    bCanvas.height = H;
    const bCtx = bCanvas.getContext('2d')!;

    // Base plank height (lighter = raised)
    bCtx.fillStyle = '#808080';
    bCtx.fillRect(0, 0, W, H);

    // Plank surfaces slightly raised, gaps recessed
    for (let i = 0; i < PLANKS; i++) {
      const x = i * plankW;
      // Plank body — slightly raised
      bCtx.fillStyle = '#999999';
      bCtx.fillRect(x + GAP, 0, plankW - GAP * 2, H);
      // Gaps — recessed
      bCtx.fillStyle = '#333333';
      bCtx.fillRect(x, 0, GAP, H);
      bCtx.fillRect(x + plankW - GAP, 0, GAP, H);

      // Subtle grain bumps
      bCtx.strokeStyle = 'rgba(60, 60, 60, 0.15)';
      bCtx.lineWidth = 1;
      for (let g = 0; g < 4; g++) {
        const gx = x + GAP + 3 + (plankW - GAP * 2 - 6) * (g / 4);
        bCtx.beginPath();
        for (let y = 0; y < H; y += 4) {
          const wx = gx + Math.sin(y * 0.02 + i * 2 + g) * 1.5;
          y === 0 ? bCtx.moveTo(wx, y) : bCtx.lineTo(wx, y);
        }
        bCtx.stroke();
      }
    }

    // Steel bands — raised above planks
    for (const by of bandPositions) {
      bCtx.fillStyle = '#cccccc';
      bCtx.fillRect(0, by - BAND_H / 2, W, BAND_H);
      // Rivets — even more raised
      for (let i = 0; i < PLANKS; i++) {
        const rx = i * plankW + plankW / 2;
        bCtx.fillStyle = '#eeeeee';
        bCtx.beginPath();
        bCtx.arc(rx, by, RIVET_R, 0, Math.PI * 2);
        bCtx.fill();
      }
    }

    const bumpMap = new THREE.CanvasTexture(bCanvas);
    bumpMap.wrapS = THREE.RepeatWrapping;
    bumpMap.wrapT = THREE.RepeatWrapping;

    return { map, bumpMap };
  }

  /** Procedural dirty, aged arena floor texture. */
  private createFloorTexture(): { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
    const W = 1024, H = 1024;
    let seed = 77;
    const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d')!;

    // Base aged concrete — mottled, uneven
    ctx.fillStyle = '#a89880';
    ctx.fillRect(0, 0, W, H);

    // Large-scale patchy color variation (organic, no grid)
    for (let i = 0; i < 50; i++) {
      const cx = rng() * W, cy = rng() * H;
      const r = 80 + rng() * 200;
      const shift = -15 + rng() * 30;
      const grad = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
      grad.addColorStop(0, `rgba(${(168 + shift) | 0},${(152 + shift * 0.8) | 0},${(128 + shift * 0.6) | 0},0.35)`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    }

    // Fine aggregate speckle
    for (let i = 0; i < 24000; i++) {
      const bright = rng() > 0.5;
      ctx.fillStyle = bright
        ? `rgba(195,185,165,${(0.03 + rng() * 0.06).toFixed(2)})`
        : `rgba(75,65,50,${(0.03 + rng() * 0.06).toFixed(2)})`;
      ctx.fillRect(rng() * W, rng() * H, 1 + ((rng() * 3) | 0), 1 + ((rng() * 3) | 0));
    }

    // Dirt accumulation patches
    for (let i = 0; i < 60; i++) {
      const cx = rng() * W, cy = rng() * H;
      const rx = 30 + rng() * 100, ry = 25 + rng() * 80;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
      grad.addColorStop(0, `rgba(45,38,28,${(0.08 + rng() * 0.15).toFixed(2)})`);
      grad.addColorStop(0.6, `rgba(55,45,32,${(0.04 + rng() * 0.08).toFixed(2)})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, rng() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }

    // Grime streaks
    ctx.lineWidth = 3;
    for (let i = 0; i < 45; i++) {
      ctx.strokeStyle = `rgba(55,45,30,${(0.06 + rng() * 0.1).toFixed(2)})`;
      const sx = rng() * W, sy = rng() * H;
      ctx.beginPath(); ctx.moveTo(sx, sy);
      for (let j = 0; j < 5; j++) ctx.lineTo(sx + (rng() - 0.5) * 120, sy + (rng() - 0.5) * 120);
      ctx.stroke();
    }

    // Scuff marks (combat wear)
    ctx.lineWidth = 1;
    for (let i = 0; i < 90; i++) {
      ctx.strokeStyle = `rgba(70,58,40,${(0.08 + rng() * 0.14).toFixed(2)})`;
      const sx = rng() * W, sy = rng() * H;
      ctx.beginPath(); ctx.moveTo(sx, sy);
      for (let j = 0; j < 3; j++) ctx.lineTo(sx + (rng() - 0.5) * 70, sy + (rng() - 0.5) * 70);
      ctx.stroke();
    }

    // Stains (blood, oil, water marks)
    for (let i = 0; i < 55; i++) {
      const cx = rng() * W, cy = rng() * H, r = 15 + rng() * 55;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      const t = rng();
      if (t < 0.3) {
        grad.addColorStop(0, `rgba(40,32,22,${(0.1 + rng() * 0.12).toFixed(2)})`);
      } else if (t < 0.55) {
        grad.addColorStop(0, `rgba(90,25,15,${(0.06 + rng() * 0.1).toFixed(2)})`);
      } else if (t < 0.75) {
        grad.addColorStop(0, `rgba(130,120,100,${(0.04 + rng() * 0.06).toFixed(2)})`);
      } else {
        grad.addColorStop(0, `rgba(65,55,42,${(0.08 + rng() * 0.1).toFixed(2)})`);
      }
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    }

    // Cracks
    ctx.lineWidth = 1;
    for (let i = 0; i < 20; i++) {
      ctx.strokeStyle = `rgba(35,28,18,${(0.2 + rng() * 0.2).toFixed(2)})`;
      let cx = rng() * W, cy = rng() * H;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      for (let j = 0; j < 3 + ((rng() * 5) | 0); j++) {
        cx += (rng() - 0.5) * 90; cy += (rng() - 0.5) * 90;
        ctx.lineTo(cx, cy);
      }
      ctx.stroke();
    }

    const map = new THREE.CanvasTexture(canvas);
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;

    // --- Bump map (uneven worn surface, no grid) ---
    const bc = document.createElement('canvas');
    bc.width = W; bc.height = H;
    const bx = bc.getContext('2d')!;
    bx.fillStyle = '#808080';
    bx.fillRect(0, 0, W, H);

    // Gentle height variation patches
    for (let i = 0; i < 60; i++) {
      const cx = rng() * W, cy = rng() * H, r = 50 + rng() * 120;
      const v = (120 + rng() * 20) | 0;
      bx.fillStyle = `rgb(${v},${v},${v})`;
      bx.beginPath(); bx.arc(cx, cy, r, 0, Math.PI * 2); bx.fill();
    }
    // Surface noise
    for (let i = 0; i < 16000; i++) {
      const v = (115 + rng() * 30) | 0;
      bx.fillStyle = `rgb(${v},${v},${v})`;
      bx.fillRect(rng() * W, rng() * H, 1 + ((rng() * 3) | 0), 1 + ((rng() * 3) | 0));
    }
    // Crack depressions
    bx.strokeStyle = '#555555';
    bx.lineWidth = 2;
    for (let i = 0; i < 18; i++) {
      let cx = rng() * W, cy = rng() * H;
      bx.beginPath(); bx.moveTo(cx, cy);
      for (let j = 0; j < 3 + ((rng() * 4) | 0); j++) {
        cx += (rng() - 0.5) * 80; cy += (rng() - 0.5) * 80;
        bx.lineTo(cx, cy);
      }
      bx.stroke();
    }

    const bumpMap = new THREE.CanvasTexture(bc);
    bumpMap.wrapS = THREE.RepeatWrapping;
    bumpMap.wrapT = THREE.RepeatWrapping;

    return { map, bumpMap };
  }

  /** Brushed/worn metal texture for cage bars. */
  private createCageBarTexture(): { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
    const W = 128, H = 256;
    let seed = 33;
    const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d')!;

    // Base metal
    ctx.fillStyle = '#8a8a94';
    ctx.fillRect(0, 0, W, H);

    // Vertical brushed streaks
    for (let i = 0; i < 60; i++) {
      const x = rng() * W;
      const w = 1 + rng() * 2;
      const bright = rng() > 0.5;
      ctx.fillStyle = bright
        ? `rgba(160,160,170,${(0.05 + rng() * 0.15).toFixed(2)})`
        : `rgba(60,60,68,${(0.05 + rng() * 0.15).toFixed(2)})`;
      ctx.fillRect(x, 0, w, H);
    }

    // Rust spots
    for (let i = 0; i < 8; i++) {
      const cx = rng() * W, cy = rng() * H, r = 3 + rng() * 8;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, `rgba(120,65,30,${(0.15 + rng() * 0.2).toFixed(2)})`);
      grad.addColorStop(0.6, `rgba(100,55,25,${(0.05 + rng() * 0.1).toFixed(2)})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    }

    // Pitting/wear dots
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(50,50,55,${(0.1 + rng() * 0.15).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(rng() * W, rng() * H, 0.5 + rng() * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    const map = new THREE.CanvasTexture(canvas);
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;

    // Bump map
    const bc = document.createElement('canvas');
    bc.width = W; bc.height = H;
    const bx = bc.getContext('2d')!;
    bx.fillStyle = '#808080';
    bx.fillRect(0, 0, W, H);

    // Vertical streaks
    for (let i = 0; i < 40; i++) {
      const v = (120 + rng() * 20) | 0;
      bx.fillStyle = `rgb(${v},${v},${v})`;
      bx.fillRect(rng() * W, 0, 1 + ((rng() * 2) | 0), H);
    }
    // Pitting
    for (let i = 0; i < 30; i++) {
      bx.fillStyle = '#606060';
      bx.beginPath();
      bx.arc(rng() * W, rng() * H, 0.5 + rng() * 1.5, 0, Math.PI * 2);
      bx.fill();
    }

    const bumpMap = new THREE.CanvasTexture(bc);
    bumpMap.wrapS = THREE.RepeatWrapping;
    bumpMap.wrapT = THREE.RepeatWrapping;

    return { map, bumpMap };
  }

  /** Wood-plank + steel-band texture for gates/doors (matches pillar style). */
  private createGateTexture(): { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
    const W = 512, H = 512;
    const PLANKS = 8;
    const BANDS = 3;
    const BAND_H = 22;
    const GAP = 3;
    const RIVET_R = 5;

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d')!;

    // Base wood fill (slightly darker than pillars — aged door)
    ctx.fillStyle = '#5a3820';
    ctx.fillRect(0, 0, W, H);

    const plankW = W / PLANKS;

    // Draw each plank with color variation and grain
    for (let i = 0; i < PLANKS; i++) {
      const x = i * plankW;

      // Per-plank hue/lightness shift
      const lShift = (Math.sin(i * 4.3) * 14) | 0;
      const r = 90 + lShift;
      const g = 56 + ((lShift * 0.6) | 0);
      const b = 32 + ((lShift * 0.3) | 0);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x + GAP, 0, plankW - GAP * 2, H);

      // Wood grain lines
      ctx.strokeStyle = 'rgba(30, 16, 6, 0.25)';
      ctx.lineWidth = 1;
      const grainCount = 5 + ((Math.sin(i * 5.7) * 3) | 0);
      for (let g2 = 0; g2 < grainCount; g2++) {
        const gx = x + GAP + 2 + (plankW - GAP * 2 - 4) * (g2 / grainCount);
        ctx.beginPath();
        for (let y = 0; y < H; y += 4) {
          const wx = gx + Math.sin(y * 0.018 + i * 2.5 + g2) * 2;
          y === 0 ? ctx.moveTo(wx, y) : ctx.lineTo(wx, y);
        }
        ctx.stroke();
      }

      // Knots
      if (i % 3 === 1) {
        const knotX = x + plankW / 2;
        const knotY = H * (0.25 + Math.sin(i * 2.9) * 0.2);
        const grad = ctx.createRadialGradient(knotX, knotY, 0, knotX, knotY, 10);
        grad.addColorStop(0, 'rgba(25, 12, 4, 0.7)');
        grad.addColorStop(0.6, 'rgba(50, 25, 12, 0.4)');
        grad.addColorStop(1, 'rgba(50, 25, 12, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(knotX, knotY, 10, 7, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // Dark gap between planks
      ctx.fillStyle = 'rgba(8, 4, 1, 0.9)';
      ctx.fillRect(x, 0, GAP, H);
      ctx.fillRect(x + plankW - GAP, 0, GAP, H);
    }

    // Steel bands
    const bandPositions: number[] = [];
    for (let b = 0; b < BANDS; b++) {
      const by = ((b + 1) / (BANDS + 1)) * H;
      bandPositions.push(by);

      // Band body gradient
      const bandGrad = ctx.createLinearGradient(0, by - BAND_H / 2, 0, by + BAND_H / 2);
      bandGrad.addColorStop(0, '#6a6a72');
      bandGrad.addColorStop(0.3, '#909098');
      bandGrad.addColorStop(0.5, '#aaaaB4');
      bandGrad.addColorStop(0.7, '#909098');
      bandGrad.addColorStop(1, '#505058');
      ctx.fillStyle = bandGrad;
      ctx.fillRect(0, by - BAND_H / 2, W, BAND_H);

      // Band edge highlights
      ctx.fillStyle = 'rgba(190, 190, 200, 0.4)';
      ctx.fillRect(0, by - BAND_H / 2, W, 1);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.fillRect(0, by + BAND_H / 2 - 1, W, 1);

      // Rivets on each plank
      for (let i = 0; i < PLANKS; i++) {
        const rx = i * plankW + plankW / 2;
        const rivetGrad = ctx.createRadialGradient(rx - 1, by - 1, 0, rx, by, RIVET_R);
        rivetGrad.addColorStop(0, '#d0d0d8');
        rivetGrad.addColorStop(0.5, '#909098');
        rivetGrad.addColorStop(1, '#505058');
        ctx.fillStyle = rivetGrad;
        ctx.beginPath();
        ctx.arc(rx, by, RIVET_R, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const map = new THREE.CanvasTexture(canvas);

    // --- Bump map ---
    const bCanvas = document.createElement('canvas');
    bCanvas.width = W; bCanvas.height = H;
    const bCtx = bCanvas.getContext('2d')!;

    bCtx.fillStyle = '#808080';
    bCtx.fillRect(0, 0, W, H);

    // Plank surfaces raised, gaps recessed
    for (let i = 0; i < PLANKS; i++) {
      const x = i * plankW;
      bCtx.fillStyle = '#999999';
      bCtx.fillRect(x + GAP, 0, plankW - GAP * 2, H);
      bCtx.fillStyle = '#333333';
      bCtx.fillRect(x, 0, GAP, H);
      bCtx.fillRect(x + plankW - GAP, 0, GAP, H);

      // Subtle grain bumps
      bCtx.strokeStyle = 'rgba(60, 60, 60, 0.15)';
      bCtx.lineWidth = 1;
      for (let g = 0; g < 4; g++) {
        const gx = x + GAP + 3 + (plankW - GAP * 2 - 6) * (g / 4);
        bCtx.beginPath();
        for (let y = 0; y < H; y += 4) {
          const wx = gx + Math.sin(y * 0.018 + i * 2.5 + g) * 2;
          y === 0 ? bCtx.moveTo(wx, y) : bCtx.lineTo(wx, y);
        }
        bCtx.stroke();
      }
    }

    // Steel bands raised
    for (const by of bandPositions) {
      bCtx.fillStyle = '#cccccc';
      bCtx.fillRect(0, by - BAND_H / 2, W, BAND_H);
      // Rivets even more raised
      for (let i = 0; i < PLANKS; i++) {
        const rx = i * plankW + plankW / 2;
        bCtx.fillStyle = '#eeeeee';
        bCtx.beginPath();
        bCtx.arc(rx, by, RIVET_R, 0, Math.PI * 2);
        bCtx.fill();
      }
    }

    const bumpMap = new THREE.CanvasTexture(bCanvas);

    return { map, bumpMap };
  }

  /** Machined steel texture for pillar base rings. */
  private createPillarRingTexture(): { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
    const W = 256, H = 64;
    let seed = 99;
    const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d')!;

    // Base polished steel
    ctx.fillStyle = '#909098';
    ctx.fillRect(0, 0, W, H);

    // Concentric machining marks (horizontal = circumferential on the ring)
    for (let y = 0; y < H; y++) {
      const a = 0.04 + rng() * 0.08;
      ctx.fillStyle = rng() > 0.5
        ? `rgba(170,170,175,${a.toFixed(3)})`
        : `rgba(100,100,105,${a.toFixed(3)})`;
      ctx.fillRect(0, y, W, 1);
    }

    // Edge bevels
    const bevelH = 8;
    const topGrad = ctx.createLinearGradient(0, 0, 0, bevelH);
    topGrad.addColorStop(0, 'rgba(200,200,210,0.35)');
    topGrad.addColorStop(1, 'rgba(200,200,210,0)');
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 0, W, bevelH);

    const botGrad = ctx.createLinearGradient(0, H - bevelH, 0, H);
    botGrad.addColorStop(0, 'rgba(30,30,35,0)');
    botGrad.addColorStop(1, 'rgba(30,30,35,0.35)');
    ctx.fillStyle = botGrad;
    ctx.fillRect(0, H - bevelH, W, bevelH);

    // Oil/grease stains
    for (let i = 0; i < 6; i++) {
      const cx = rng() * W, cy = rng() * H, r = 5 + rng() * 12;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, `rgba(50,45,30,${(0.08 + rng() * 0.12).toFixed(2)})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    }

    // Scuff marks
    for (let i = 0; i < 12; i++) {
      ctx.strokeStyle = rng() > 0.5
        ? `rgba(150,150,155,${(0.06 + rng() * 0.1).toFixed(2)})`
        : `rgba(60,60,65,${(0.06 + rng() * 0.1).toFixed(2)})`;
      ctx.lineWidth = 1;
      const sx = rng() * W, sy = rng() * H;
      ctx.beginPath(); ctx.moveTo(sx, sy);
      ctx.lineTo(sx + (rng() - 0.5) * 30, sy + (rng() - 0.5) * 8);
      ctx.stroke();
    }

    const map = new THREE.CanvasTexture(canvas);
    map.wrapS = THREE.RepeatWrapping;

    // Bump map
    const bc = document.createElement('canvas');
    bc.width = W; bc.height = H;
    const bx = bc.getContext('2d')!;
    bx.fillStyle = '#808080';
    bx.fillRect(0, 0, W, H);

    // Machining marks
    for (let y = 0; y < H; y++) {
      const v = (125 + rng() * 10) | 0;
      bx.fillStyle = `rgb(${v},${v},${v})`;
      bx.fillRect(0, y, W, 1);
    }
    // Beveled edges
    bx.fillStyle = '#999999';
    bx.fillRect(0, 0, W, 4);
    bx.fillStyle = '#666666';
    bx.fillRect(0, H - 4, W, 4);

    const bumpMap = new THREE.CanvasTexture(bc);
    bumpMap.wrapS = THREE.RepeatWrapping;

    return { map, bumpMap };
  }

  private createPillars(): void {
    const { map, bumpMap } = this.createPillarTextures();
    const pillarMat = new THREE.MeshStandardMaterial({
      map,
      bumpMap,
      bumpScale: 0.6,
      metalness: 0.1,
      roughness: 0.7,
    });
    const pillarGeo = new THREE.CylinderGeometry(1.8, 1.8, 6, 24);

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
    const { map: gateMap, bumpMap: gateBump } = this.createGateTexture();
    const doorMat = new THREE.MeshStandardMaterial({
      map: gateMap,
      bumpMap: gateBump,
      bumpScale: 0.6,
      metalness: 0.1,
      roughness: 0.7,
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
  // Crowd animation — GPU vertex shader displacement
  // ---------------------------------------------------------------------------

  /**
   * Creates a MeshStandardMaterial with injected vertex shader code that
   * displaces instances based on time for a lively crowd effect.
   * All animation runs on the GPU — zero CPU cost per frame.
   */
  private createCrowdMaterial(
    props: THREE.MeshStandardMaterialParameters,
    part: 'body' | 'head' | 'sign',
  ): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial(props);
    const timeUniform = this.crowdTimeUniform;

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uCrowdTime = timeUniform;

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
    const bodyMat = this.createCrowdMaterial({ roughness: 0.9 }, 'body');
    const bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, maxCount);

    const headGeo = new THREE.SphereGeometry(0.12, 5, 4);
    const headMat = this.createCrowdMaterial({ roughness: 0.8 }, 'head');
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
    const signMat = this.createCrowdMaterial({ roughness: 0.7 }, 'sign');
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

    // Pillar base rings (hollow steel collars the pillars slide through)
    const { map: ringMap, bumpMap: ringBump } = this.createPillarRingTexture();
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
      this.group.add(base);
    }
    for (const pz of [-11, 11]) {
      const base = new THREE.Mesh(baseGeo, baseMat);
      base.position.set(0, 0, pz);
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

  // ---------------------------------------------------------------------------
  // Upper arena — walls, ceiling, trusses, jumbotron, banner
  // ---------------------------------------------------------------------------
  private createUpperArena(): void {
    const CEILING_Y = 24;
    const WALL_TOP = CEILING_Y;

    // ── Shared materials ─────────────────────────────────────────────────────
    const upperWallMat = new THREE.MeshStandardMaterial({
      color: 0x111115,
      roughness: 0.95,
    });
    const concreteTrimMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a20,
      roughness: 0.9,
    });
    const trussMat = new THREE.MeshStandardMaterial({
      color: 0x333338,
      metalness: 0.7,
      roughness: 0.3,
    });
    const ceilingMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0e,
      roughness: 1.0,
      side: THREE.BackSide,
    });

    // ── Upper walls (extend from current wall tops to ceiling) ───────────────
    // Current back walls end at roughly y=10. Extend to WALL_TOP.
    const upperWallHeight = WALL_TOP - 10;
    const upperWallY = 10 + upperWallHeight / 2;

    // East / West upper walls
    const ewGeo = new THREE.BoxGeometry(1, upperWallHeight, 63);
    for (const x of [36.5, -36.5]) {
      const wall = new THREE.Mesh(ewGeo, upperWallMat);
      wall.position.set(x, upperWallY, 0);
      this.group.add(wall);
    }
    // North / South upper walls
    const nsGeo = new THREE.BoxGeometry(74, upperWallHeight, 1);
    for (const z of [-42.5, 42.5]) {
      const wall = new THREE.Mesh(nsGeo, upperWallMat);
      wall.position.set(0, upperWallY, z);
      this.group.add(wall);
    }

    // ── Corner fills (seal the gaps between E/W and N/S walls) ──────────────
    const cornerGeo = new THREE.BoxGeometry(1, WALL_TOP, 1);
    for (const x of [36.5, -36.5]) {
      for (const z of [-42.5, 42.5]) {
        const corner = new THREE.Mesh(cornerGeo, upperWallMat);
        corner.position.set(x, WALL_TOP / 2, z);
        this.group.add(corner);
      }
    }

    // ── Concourse rim — ledge at top of seating ─────────────────────────────
    // East/West: top tier is at y=7.5, add a walkway from x=35.5 to wall
    const rimEWGeo = new THREE.BoxGeometry(2.5, 0.3, 63);
    for (const x of [35.75, -35.75]) {
      const rim = new THREE.Mesh(rimEWGeo, concreteTrimMat);
      rim.position.set(x, 8.5, 0);
      this.group.add(rim);
    }
    // North/South: top tier is at y=5.5
    const rimNSGeo = new THREE.BoxGeometry(56, 0.3, 2.5);
    for (const z of [-41.75, 41.75]) {
      const rim = new THREE.Mesh(rimNSGeo, concreteTrimMat);
      rim.position.set(0, 6.5, z);
      this.group.add(rim);
    }

    // ── Horizontal trim bands on upper walls ─────────────────────────────────
    const bandH = 0.3;
    for (const bandY of [12, 16, 20]) {
      // East / West bands
      const bEW = new THREE.BoxGeometry(0.15, bandH, 63);
      for (const x of [36.0, -36.0]) {
        const band = new THREE.Mesh(bEW, concreteTrimMat);
        band.position.set(x, bandY, 0);
        this.group.add(band);
      }
      // North / South bands
      const bNS = new THREE.BoxGeometry(74, bandH, 0.15);
      for (const z of [-42.0, 42.0]) {
        const band = new THREE.Mesh(bNS, concreteTrimMat);
        band.position.set(0, bandY, z);
        this.group.add(band);
      }
    }

    // ── Ceiling ──────────────────────────────────────────────────────────────
    const ceilGeo = new THREE.BoxGeometry(74, 0.5, 86);
    const ceil = new THREE.Mesh(ceilGeo, ceilingMat);
    ceil.position.set(0, CEILING_Y, 0);
    this.group.add(ceil);

    // ── Ceiling trusses — primary grid ──────────────────────────────────────
    const trussH = 1.2;
    const trussW = 0.25;
    const trussY = CEILING_Y - trussH / 2 - 0.25;
    // Longitudinal trusses (run along Z)
    const trussLongGeo = new THREE.BoxGeometry(trussW, trussH, 86);
    for (const x of [-30, -15, 0, 15, 30]) {
      const truss = new THREE.Mesh(trussLongGeo, trussMat);
      truss.position.set(x, trussY, 0);
      this.group.add(truss);
    }
    // Cross trusses (run along X)
    const trussCrossGeo = new THREE.BoxGeometry(74, trussH, trussW);
    for (const z of [-36, -18, 0, 18, 36]) {
      const truss = new THREE.Mesh(trussCrossGeo, trussMat);
      truss.position.set(0, trussY, z);
      this.group.add(truss);
    }

    // ── Secondary diagonal bracing between trusses ──────────────────────────
    const braceMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a30,
      metalness: 0.6,
      roughness: 0.35,
    });
    const braceGeo = new THREE.BoxGeometry(0.1, 0.5, 0.1);
    // Small X-braces at each truss intersection
    for (const x of [-30, -15, 0, 15, 30]) {
      for (const z of [-36, -18, 0, 18, 36]) {
        // Skip center (jumbotron is there)
        if (Math.abs(x) <= 15 && Math.abs(z) <= 18) continue;
        for (const [rx, rz] of [[1, 1], [1, -1]]) {
          const brace = new THREE.Mesh(braceGeo, braceMat);
          brace.position.set(x + rx * 2, trussY, z + rz * 2);
          brace.rotation.set(0, Math.atan2(rz, rx), Math.PI / 4);
          this.group.add(brace);
        }
      }
    }

    // ── Ceiling catwalks (narrow walkways along trusses) ────────────────────
    const catwalkMat = new THREE.MeshStandardMaterial({
      color: 0x222228,
      metalness: 0.4,
      roughness: 0.6,
    });
    // Two catwalks running along Z at x = ±15
    const catwalkGeo = new THREE.BoxGeometry(1.2, 0.08, 86);
    for (const x of [-15, 15]) {
      const cw = new THREE.Mesh(catwalkGeo, catwalkMat);
      cw.position.set(x, trussY - trussH / 2 - 0.04, 0);
      this.group.add(cw);
    }
    // Catwalk railings
    const railGeo = new THREE.BoxGeometry(0.05, 0.6, 86);
    const railMat = new THREE.MeshStandardMaterial({
      color: 0x444450,
      metalness: 0.5,
      roughness: 0.4,
    });
    for (const x of [-15, 15]) {
      for (const dx of [-0.55, 0.55]) {
        const rail = new THREE.Mesh(railGeo, railMat);
        rail.position.set(x + dx, trussY - trussH / 2 - 0.34, 0);
        this.group.add(rail);
      }
    }

    // ── HVAC ducts (big rectangular tubes running along ceiling) ─────────────
    const ductMat = new THREE.MeshStandardMaterial({
      color: 0x1e1e24,
      metalness: 0.3,
      roughness: 0.7,
    });
    // Two long ducts along X between trusses
    const ductLongGeo = new THREE.BoxGeometry(74, 0.8, 1.5);
    for (const z of [-27, 27]) {
      const duct = new THREE.Mesh(ductLongGeo, ductMat);
      duct.position.set(0, CEILING_Y - 0.65, z);
      this.group.add(duct);
    }
    // Duct rib bands (every ~10 units along each duct)
    const ribGeo = new THREE.BoxGeometry(0.1, 0.9, 1.6);
    for (const z of [-27, 27]) {
      for (let x = -30; x <= 30; x += 10) {
        const rib = new THREE.Mesh(ribGeo, braceMat);
        rib.position.set(x, CEILING_Y - 0.65, z);
        this.group.add(rib);
      }
    }

    // ── Ceiling light fixtures ──────────────────────────────────────────────
    const fixtureMat = new THREE.MeshStandardMaterial({
      color: 0x888888,
      metalness: 0.5,
      roughness: 0.4,
    });
    const lightPanelMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xeeeeff,
      emissiveIntensity: 0.6,
    });
    const fixtureBodyGeo = new THREE.BoxGeometry(2, 0.15, 0.8);
    const lightPanelGeo = new THREE.BoxGeometry(1.8, 0.02, 0.6);
    const fixtureRodGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.5, 4);

    // Grid of light fixtures between major trusses
    const lightXs = [-22.5, -7.5, 7.5, 22.5];
    const lightZs = [-27, -9, 9, 27];
    for (const lx of lightXs) {
      for (const lz of lightZs) {
        // Fixture body
        const body = new THREE.Mesh(fixtureBodyGeo, fixtureMat);
        const fixtureY = trussY - trussH / 2 - 1.5;
        body.position.set(lx, fixtureY, lz);
        this.group.add(body);

        // Light panel (glowing face underneath)
        const panel = new THREE.Mesh(lightPanelGeo, lightPanelMat);
        panel.position.set(lx, fixtureY - 0.08, lz);
        this.group.add(panel);

        // Suspension rods
        for (const dx of [-0.7, 0.7]) {
          const rod = new THREE.Mesh(fixtureRodGeo, fixtureMat);
          rod.position.set(lx + dx, fixtureY + 0.82, lz);
          this.group.add(rod);
        }
      }
    }

    // Actual point lights (only a few to keep performance reasonable)
    const ceilingLightPositions = [
      [-22.5, -9], [-22.5, 9], [22.5, -9], [22.5, 9],
      [-7.5, -27], [-7.5, 27], [7.5, -27], [7.5, 27],
    ];
    for (const [lx, lz] of ceilingLightPositions) {
      const light = new THREE.PointLight(0xddeeff, 0.3, 30, 2);
      light.position.set(lx, trussY - trussH / 2 - 2, lz);
      this.group.add(light);
    }

    // ── Wall details ────────────────────────────────────────────────────────

    // Vertical pilasters/columns on upper walls (structural look)
    const pilasterMat = new THREE.MeshStandardMaterial({
      color: 0x161620,
      roughness: 0.85,
    });
    const pilasterEWGeo = new THREE.BoxGeometry(0.5, upperWallHeight, 0.8);
    const pilasterNSGeo = new THREE.BoxGeometry(0.8, upperWallHeight, 0.5);

    // East/West walls — pilasters every ~10 units
    for (const x of [36.0, -36.0]) {
      const sign = x > 0 ? -1 : 1; // Inward offset
      for (let z = -28; z <= 28; z += 8) {
        const p = new THREE.Mesh(pilasterEWGeo, pilasterMat);
        p.position.set(x + sign * 0.25, upperWallY, z);
        this.group.add(p);
      }
    }
    // North/South walls
    for (const z of [-42.0, 42.0]) {
      const sign = z > 0 ? -1 : 1;
      for (let x = -24; x <= 24; x += 8) {
        const p = new THREE.Mesh(pilasterNSGeo, pilasterMat);
        p.position.set(x, upperWallY, z + sign * 0.25);
        this.group.add(p);
      }
    }

    // Concourse railing (guard rail at the top of the seating)
    const concourseRailMat = new THREE.MeshStandardMaterial({
      color: 0x333340,
      metalness: 0.6,
      roughness: 0.3,
    });
    // East/West rails
    const cRailEWGeo = new THREE.BoxGeometry(0.08, 0.7, 63);
    for (const x of [34.5, -34.5]) {
      const rail = new THREE.Mesh(cRailEWGeo, concourseRailMat);
      rail.position.set(x, 9.2, 0);
      this.group.add(rail);
    }
    // North/South rails
    const cRailNSGeo = new THREE.BoxGeometry(56, 0.7, 0.08);
    for (const z of [-40.5, 40.5]) {
      const rail = new THREE.Mesh(cRailNSGeo, concourseRailMat);
      rail.position.set(0, 7.2, z);
      this.group.add(rail);
    }
    // Railing posts (vertical bars)
    const postGeo = new THREE.BoxGeometry(0.06, 0.7, 0.06);
    for (const x of [34.5, -34.5]) {
      for (let z = -30; z <= 30; z += 4) {
        const post = new THREE.Mesh(postGeo, concourseRailMat);
        post.position.set(x, 9.2, z);
        this.group.add(post);
      }
    }
    for (const z of [-40.5, 40.5]) {
      for (let x = -24; x <= 24; x += 4) {
        const post = new THREE.Mesh(postGeo, concourseRailMat);
        post.position.set(x, 7.2, z);
        this.group.add(post);
      }
    }

    // Exit tunnel openings (dark recesses in the upper walls)
    const exitMat = new THREE.MeshStandardMaterial({
      color: 0x050508,
      roughness: 1.0,
    });
    // Two exits on East wall, two on West wall
    const exitGeo = new THREE.BoxGeometry(0.6, 3, 4);
    for (const x of [36.0, -36.0]) {
      const sign = x > 0 ? -1 : 1;
      for (const z of [-16, 16]) {
        const exit = new THREE.Mesh(exitGeo, exitMat);
        exit.position.set(x + sign * 0.2, 10.5, z);
        this.group.add(exit);
      }
    }

    // Accent strip lighting along the concourse rim (emissive strips)
    const stripMat = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: 0x442266,
      emissiveIntensity: 0.6,
    });
    // East/West strip
    const stripEWGeo = new THREE.BoxGeometry(0.06, 0.06, 63);
    for (const x of [35.0, -35.0]) {
      const strip = new THREE.Mesh(stripEWGeo, stripMat);
      strip.position.set(x, 8.7, 0);
      this.group.add(strip);
    }
    // North/South strip
    const stripNSGeo = new THREE.BoxGeometry(56, 0.06, 0.06);
    for (const z of [-41.0, 41.0]) {
      const strip = new THREE.Mesh(stripNSGeo, stripMat);
      strip.position.set(0, 6.7, z);
      this.group.add(strip);
    }

    // Accent strip along top of wall (just below ceiling)
    const topStripMat = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: 0x331144,
      emissiveIntensity: 0.4,
    });
    const topStripEW = new THREE.BoxGeometry(0.06, 0.06, 63);
    for (const x of [36.0, -36.0]) {
      const strip = new THREE.Mesh(topStripEW, topStripMat);
      strip.position.set(x, CEILING_Y - 0.5, 0);
      this.group.add(strip);
    }
    const topStripNS = new THREE.BoxGeometry(74, 0.06, 0.06);
    for (const z of [-42.0, 42.0]) {
      const strip = new THREE.Mesh(topStripNS, topStripMat);
      strip.position.set(0, CEILING_Y - 0.5, z);
      this.group.add(strip);
    }

    // ── Jumbotron (center, suspended from ceiling) ───────────────────────────
    this.createJumbotron(CEILING_Y);

    // ── "THE CAGE" banner on south upper wall ────────────────────────────────
    this.createWallBanner();
  }

  private createJumbotron(ceilingY: number): void {
    const housingMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a1e,
      metalness: 0.5,
      roughness: 0.4,
    });

    // Housing — box suspended from ceiling
    const housingW = 12;
    const housingH = 3;
    const housingD = 8;
    const housingGeo = new THREE.BoxGeometry(housingW, housingH, housingD);
    const housing = new THREE.Mesh(housingGeo, housingMat);
    const screenY = ceilingY - 5.5;
    housing.position.set(0, screenY, 0);
    this.group.add(housing);

    // Suspension rods from ceiling
    const rodMat = new THREE.MeshStandardMaterial({
      color: 0x444448,
      metalness: 0.7,
      roughness: 0.3,
    });
    const rodLen = ceilingY - screenY - housingH / 2;
    const rodGeo = new THREE.CylinderGeometry(0.1, 0.1, rodLen, 4);
    for (const rx of [-4, 4]) {
      for (const rz of [-2.5, 2.5]) {
        const rod = new THREE.Mesh(rodGeo, rodMat);
        rod.position.set(rx, screenY + housingH / 2 + rodLen / 2, rz);
        this.group.add(rod);
      }
    }

    // Scoreboard screens on all 4 faces (canvas textures for dynamic text)
    // East/West faces (wider)
    const screenEWGeo = new THREE.PlaneGeometry(housingW - 0.5, housingH - 0.5);
    for (const dir of [-1, 1]) {
      const tex = this.createScoreboardTexture(512, 128);
      this.scoreboardTextures.push(tex);
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        emissiveMap: tex,
        emissiveIntensity: 1.2,
        toneMapped: false,
      });
      const screen = new THREE.Mesh(screenEWGeo, mat);
      screen.position.set(0, screenY, dir * (housingD / 2 + 0.02));
      if (dir === -1) screen.rotation.y = Math.PI;
      this.group.add(screen);
    }
    // North/South faces (narrower)
    const screenNSGeo = new THREE.PlaneGeometry(housingD - 0.5, housingH - 0.5);
    for (const dir of [-1, 1]) {
      const tex = this.createScoreboardTexture(512, 128);
      this.scoreboardTextures.push(tex);
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        emissiveMap: tex,
        emissiveIntensity: 1.2,
        toneMapped: false,
      });
      const screen = new THREE.Mesh(screenNSGeo, mat);
      screen.position.set(dir * (housingW / 2 + 0.02), screenY, 0);
      screen.rotation.y = dir * Math.PI / 2;
      this.group.add(screen);
    }

    // Draw initial scoreboard state
    this.drawAllScoreboards();

    // Subtle glow light underneath the jumbotron
    const glow = new THREE.PointLight(0x3355cc, 0.4, 20);
    glow.position.set(0, screenY - housingH / 2 - 0.5, 0);
    this.group.add(glow);

    // Bottom trim (thin bright strip like a ticker bar)
    const tickerMat = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: 0xff4422,
      emissiveIntensity: 0.8,
    });
    const tickerEW = new THREE.BoxGeometry(housingW + 0.2, 0.2, 0.1);
    for (const dir of [-1, 1]) {
      const ticker = new THREE.Mesh(tickerEW, tickerMat);
      ticker.position.set(0, screenY - housingH / 2 - 0.1, dir * (housingD / 2 + 0.05));
      this.group.add(ticker);
    }
    const tickerNS = new THREE.BoxGeometry(0.1, 0.2, housingD + 0.2);
    for (const dir of [-1, 1]) {
      const ticker = new THREE.Mesh(tickerNS, tickerMat);
      ticker.position.set(dir * (housingW / 2 + 0.05), screenY - housingH / 2 - 0.1, 0);
      this.group.add(ticker);
    }
  }

  // ---------------------------------------------------------------------------
  // Scoreboard canvas rendering
  // ---------------------------------------------------------------------------

  private createScoreboardTexture(w: number, h: number): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  }

  private drawAllScoreboards(): void {
    for (const tex of this.scoreboardTextures) {
      this.drawScoreboard(tex);
    }
  }

  private drawScoreboard(tex: THREE.CanvasTexture): void {
    const canvas = tex.image as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;

    // Background
    ctx.fillStyle = '#080812';
    ctx.fillRect(0, 0, w, h);

    // Divider line
    ctx.strokeStyle = '#333344';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w / 2, 8);
    ctx.lineTo(w / 2, h - 8);
    ctx.stroke();

    // "KILLS" header
    ctx.fillStyle = '#666688';
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('KILLS', w / 2, 22);

    // Red team (left) — team 0
    ctx.fillStyle = '#ff3333';
    ctx.font = 'bold 64px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(this.teamKills[0]), w * 0.25, 95);

    // "RED" label
    ctx.fillStyle = '#cc2222';
    ctx.font = 'bold 16px monospace';
    ctx.fillText('RED', w * 0.25, 118);

    // Blue team (right) — team 1
    ctx.fillStyle = '#3388ff';
    ctx.font = 'bold 64px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(this.teamKills[1]), w * 0.75, 95);

    // "BLUE" label
    ctx.fillStyle = '#2266cc';
    ctx.font = 'bold 16px monospace';
    ctx.fillText('BLUE', w * 0.75, 118);

    // VS in center
    ctx.fillStyle = '#444466';
    ctx.font = 'bold 28px monospace';
    ctx.fillText('—', w / 2, 88);

    tex.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // Wall banners (south = red team, north = blue team)
  // ---------------------------------------------------------------------------

  private static readonly CHEER_EMOTES = [
    '🔥', '💀', '⚔️', '👊', '💪', '🏆', '😤',
  ];
  private static readonly CHEER_TEXTS = [
    'DESTROYED!', 'OBLITERATED!', 'CRUSHED!', 'DOMINATED!',
    'ANNIHILATED!', 'WRECKED!', 'ELIMINATED!',
  ];
  private static readonly SHAME_EMOTES = [
    '💩', '🤡', '😂', '🪦', '👎', '📉', '😬',
  ];
  private static readonly SHAME_TEXTS = [
    'EMBARRASSING!', 'PATHETIC!', 'TRAGIC!', 'YIKES!',
    'SHAMEFUL!', 'LOL GG', 'DOWN BAD!',
  ];

  private createWallBanner(): void {
    const bannerW = 20;
    const bannerH = 5;

    // ── South banner (Red team) ──────────────────────────────────────────────
    const southCanvas = document.createElement('canvas');
    southCanvas.width = 512;
    southCanvas.height = 128;
    this.southBannerTexture = new THREE.CanvasTexture(southCanvas);
    this.southBannerTexture.minFilter = THREE.LinearFilter;

    const southMat = new THREE.MeshStandardMaterial({
      map: this.southBannerTexture,
      emissiveMap: this.southBannerTexture,
      emissiveIntensity: 1.5,
      toneMapped: false,
    });
    const southGeo = new THREE.PlaneGeometry(bannerW, bannerH);
    const southMesh = new THREE.Mesh(southGeo, southMat);
    southMesh.position.set(0, 16, 41.5);
    southMesh.rotation.y = Math.PI;
    this.group.add(southMesh);

    // South banner border (red)
    this.createBannerBorder(bannerW, bannerH, 16, 41.45, 0xcc2222);

    // Accent light
    const southLight = new THREE.PointLight(0xcc2222, 0.5, 15);
    southLight.position.set(0, 16, 40);
    this.group.add(southLight);

    // ── North banner (Blue team) ─────────────────────────────────────────────
    const northCanvas = document.createElement('canvas');
    northCanvas.width = 512;
    northCanvas.height = 128;
    this.northBannerTexture = new THREE.CanvasTexture(northCanvas);
    this.northBannerTexture.minFilter = THREE.LinearFilter;

    const northMat = new THREE.MeshStandardMaterial({
      map: this.northBannerTexture,
      emissiveMap: this.northBannerTexture,
      emissiveIntensity: 1.5,
      toneMapped: false,
    });
    const northGeo = new THREE.PlaneGeometry(bannerW, bannerH);
    const northMesh = new THREE.Mesh(northGeo, northMat);
    northMesh.position.set(0, 16, -41.5);
    this.group.add(northMesh);

    // North banner border (blue)
    this.createBannerBorder(bannerW, bannerH, 16, -41.45, 0x2266cc);

    // Accent light
    const northLight = new THREE.PointLight(0x2255aa, 0.5, 15);
    northLight.position.set(0, 16, -40);
    this.group.add(northLight);

    // Draw initial idle state
    this.drawSouthBanner();
    this.drawNorthBanner();
  }

  private createBannerBorder(
    bW: number, bH: number, y: number, z: number, color: number,
  ): void {
    const borderMat = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: color,
      emissiveIntensity: 1.0,
    });
    const w = 0.15;
    const hBar = new THREE.BoxGeometry(bW + w * 2, w, 0.05);
    for (const dy of [-bH / 2, bH / 2]) {
      const bar = new THREE.Mesh(hBar, borderMat);
      bar.position.set(0, y + dy, z);
      this.group.add(bar);
    }
    const vBar = new THREE.BoxGeometry(w, bH, 0.05);
    for (const dx of [-bW / 2, bW / 2]) {
      const bar = new THREE.Mesh(vBar, borderMat);
      bar.position.set(dx, y, z);
      this.group.add(bar);
    }
  }

  private pickRandom<T>(arr: readonly T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /**
   * Draw the south (red team) banner.
   * If killerTeam is provided, it's a killing blow event:
   *   team 0 scored → cheer red, team 1 scored → shame red
   */
  private drawSouthBanner(killerTeam?: number): void {
    if (!this.southBannerTexture) return;
    const canvas = this.southBannerTexture.image as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;

    if (killerTeam === 0) {
      // Red team scored — cheer!
      this.drawBannerReaction(ctx, canvas.width, canvas.height, 'cheer', '#ff2222', '#330000');
    } else if (killerTeam === 1) {
      // Blue team scored — shame red
      this.drawBannerReaction(ctx, canvas.width, canvas.height, 'shame', '#ff2222', '#330000');
    } else if (this.gameOverWinningTeam >= 0) {
      // Game over — show result
      const won = this.gameOverWinningTeam === 0;
      this.drawBannerResult(ctx, canvas.width, canvas.height, won, '#ff2222', '#330000');
    } else {
      // Idle state
      this.drawBannerIdle(ctx, canvas.width, canvas.height, 'RED TEAM', '#cc2222', '#180000');
    }

    this.southBannerTexture.needsUpdate = true;
  }

  /**
   * Draw the north (blue team) banner.
   * If killerTeam is provided:
   *   team 1 scored → cheer blue, team 0 scored → shame blue
   */
  private drawNorthBanner(killerTeam?: number): void {
    if (!this.northBannerTexture) return;
    const canvas = this.northBannerTexture.image as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;

    if (killerTeam === 1) {
      // Blue team scored — cheer!
      this.drawBannerReaction(ctx, canvas.width, canvas.height, 'cheer', '#3388ff', '#000d33');
    } else if (killerTeam === 0) {
      // Red team scored — shame blue
      this.drawBannerReaction(ctx, canvas.width, canvas.height, 'shame', '#3388ff', '#000d33');
    } else if (this.gameOverWinningTeam >= 0) {
      // Game over — show result
      const won = this.gameOverWinningTeam === 1;
      this.drawBannerResult(ctx, canvas.width, canvas.height, won, '#3388ff', '#000d33');
    } else {
      // Idle state
      this.drawBannerIdle(ctx, canvas.width, canvas.height, 'BLUE TEAM', '#2266cc', '#000818');
    }

    this.northBannerTexture.needsUpdate = true;
  }

  private drawBannerIdle(
    ctx: CanvasRenderingContext2D, w: number, h: number,
    label: string, color: string, bg: string,
  ): void {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = color;
    ctx.font = 'bold 48px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, w / 2, h / 2);
  }

  private drawBannerReaction(
    ctx: CanvasRenderingContext2D, w: number, h: number,
    type: 'cheer' | 'shame', color: string, bg: string,
  ): void {
    const isCheer = type === 'cheer';
    const emotes = isCheer ? CageArenaScript.CHEER_EMOTES : CageArenaScript.SHAME_EMOTES;
    const texts = isCheer ? CageArenaScript.CHEER_TEXTS : CageArenaScript.SHAME_TEXTS;
    const emote = this.pickRandom(emotes);
    const text = this.pickRandom(texts);

    // Brighter background for active state
    ctx.fillStyle = isCheer ? '#110800' : '#0a0000';
    ctx.fillRect(0, 0, w, h);

    // Emote
    ctx.font = '52px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emote, w * 0.15, h / 2);
    ctx.fillText(emote, w * 0.85, h / 2);

    // Text
    ctx.fillStyle = isCheer ? '#ffcc00' : color;
    ctx.font = `bold 44px monospace`;
    ctx.fillText(text, w / 2, h / 2);
  }

  private drawBannerResult(
    ctx: CanvasRenderingContext2D, w: number, h: number,
    won: boolean, color: string, bg: string,
  ): void {
    ctx.fillStyle = won ? '#0a0800' : '#0a0000';
    ctx.fillRect(0, 0, w, h);

    const emote = won ? '🏆' : '💀';
    ctx.font = '52px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emote, w * 0.15, h / 2);
    ctx.fillText(emote, w * 0.85, h / 2);

    ctx.fillStyle = won ? '#ffcc00' : color;
    ctx.font = 'bold 48px monospace';
    ctx.fillText(won ? 'VICTORY' : 'DEFEAT', w / 2, h / 2);
  }
}
