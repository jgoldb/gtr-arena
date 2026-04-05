import * as THREE from 'three';
import { ArenaScript } from './ArenaScript';
import type { Collider, BoxCollider, CircleCollider } from '../physics/CollisionSystem';
import { audioSettings } from '../../ui/AudioSettings';
import {
  createPillarTextures,
  createGateTexture,
} from './cage/CageTextures';
import { createSpectators } from './cage/CageCrowd';
import {
  createRingFloor,
  createPenFloors,
  createCageBars,
  createCameraCollisionWalls,
  createCageFrame,
  createCornerPosts,
  createStadiumStructure,
  createStadiumLighting,
  createBarricades,
  createRingDetails,
} from './cage/CageGeometry';

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
  /** 0 = E/W fully raised, 1 = E/W fully submerged */
  private ewPillarProgress = 0;
  /** 0 = N/S fully raised, 1 = N/S fully submerged (starts at 1 = down) */
  private nsPillarProgress = 1;

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
    createRingFloor(this.group);
    createPenFloors(this.group);
    createCageBars(this.group);
    createCameraCollisionWalls(this.group);
    createCageFrame(this.group);
    createCornerPosts(this.group);
    this.createPillars();
    this.createDoors();
    createStadiumStructure(this.group);
    createSpectators(this.group, this.crowdTimeUniform);
    createStadiumLighting(this.group);
    createBarricades(this.group);
    createRingDetails(this.group);
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
  // Ring pillars (animated drop/rise)
  // ---------------------------------------------------------------------------


  private createPillars(): void {
    const { map, bumpMap } = createPillarTextures();
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

      // Register as moving platform so NPC AI walks onto the pillar with the player
      this.collision.addMovingPlatform({
        cx: px,
        cz: 0,
        halfW: 1.8,
        halfD: 1.8,
        getY: () => collider.centerY + collider.halfH,
        maxY: this.PILLAR_Y_UP + 3,   // surface Y when fully raised
        minY: this.PILLAR_Y_DOWN + 3,  // surface Y when fully submerged
        cyclesAutomatically: true,
        isCircular: true,
      });
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

      this.collision.addMovingPlatform({
        cx: 0,
        cz: pz,
        halfW: 1.8,
        halfD: 1.8,
        getY: () => collider.centerY + collider.halfH,
        maxY: this.PILLAR_Y_UP + 3,
        minY: this.PILLAR_Y_DOWN + 3,
        cyclesAutomatically: true,
        isCircular: true,
      });
    }
  }

  private setPillarProgress(t: number): void {
    this.ewPillarProgress = t;
    const y = this.PILLAR_Y_UP + (this.PILLAR_Y_DOWN - this.PILLAR_Y_UP) * t;
    for (let i = 0; i < this.pillarMeshes.length; i++) {
      this.pillarMeshes[i].position.y = y;
      this.pillarColliders[i].centerY = y;
    }
  }

  /** Same as setPillarProgress but for the north/south pair. */
  private setNSPillarProgress(t: number): void {
    this.nsPillarProgress = t;
    const y = this.PILLAR_Y_UP + (this.PILLAR_Y_DOWN - this.PILLAR_Y_UP) * t;
    for (let i = 0; i < this.nsPillarMeshes.length; i++) {
      this.nsPillarMeshes[i].position.y = y;
      this.nsPillarColliders[i].centerY = y;
    }
  }

  getPillarState(): { ewPillarUp: number; nsPillarUp: number; pillarPhasePct: number } {
    let phaseDuration: number;
    switch (this.pillarState) {
      case 'up': phaseDuration = this.currentPillarUpDuration; break;
      case 'dropping': phaseDuration = this.PILLAR_DROP_ANIM; break;
      case 'down': phaseDuration = this.PILLAR_DOWN_TIME; break;
      case 'rising': phaseDuration = this.PILLAR_RISE_ANIM; break;
    }
    return {
      ewPillarUp: 1 - this.ewPillarProgress,
      nsPillarUp: 1 - this.nsPillarProgress,
      pillarPhasePct: phaseDuration > 0 ? this.pillarStateTimer / phaseDuration : 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Doors (animated gates)
  // ---------------------------------------------------------------------------
  private createDoors(): void {
    const { map: gateMap, bumpMap: gateBump } = createGateTexture();
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
