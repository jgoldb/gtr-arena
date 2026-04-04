import * as THREE from 'three';
import { ArenaScript } from './ArenaScript';
import type { Collider, BoxCollider } from '../physics/CollisionSystem';
import { audioSettings } from '../../ui/AudioSettings';
import {
  createSkybox,
  createAsteroidGround,
  createPlasmaWall,
  createOvalCollision,
  createStartingBubbles,
  createBubbleCollision,
  createArenaLighting,
  createGlassPlatform,
} from './celestial/CelestialGeometry';
import { createDiamondArchways } from './celestial/CelestialArchways';

export class CelestialBallroomScript extends ArenaScript {
  // Oval arena dimensions
  private readonly SEMI_MAJOR = 56; // X axis
  private readonly SEMI_MINOR = 44; // Z axis
  private readonly WALL_HEIGHT = 12;

  // Starting zone bubbles
  private readonly BUBBLE_RADIUS = 7;
  private readonly BUBBLE_SPAWN_Z = 32; // +/-Z for the two starting zones

  // Visual references
  private plasmaWallMaterial: THREE.ShaderMaterial | null = null;
  private bubbleMaterials: THREE.ShaderMaterial[] = [];
  private bubbleMeshes: THREE.Mesh[] = [];
  private bubbleColliders: Collider[] = [];
  private archShaderMaterials: THREE.ShaderMaterial[] = [];
  private glassPlatformGroup: THREE.Group | null = null;
  private glassPlatformCollider: BoxCollider | null = null;
  private lastPlatformY = 0.2;
  private platformJumped = false;

  // One-shot ambient sounds
  private ambientAudioCtx: AudioContext | null = null;
  private doorsOpenBuffer: AudioBuffer | null = null;

  protected override readonly OPEN_ANIM_DURATION = 1.5;

  constructor() {
    super({
      title: 'CELESTIAL BALLROOM',
      titleColor: '#aa66ff',
      subtitle: 'Containment field collapses in',
      urgentColor: '#ff44ff',
      fightColor: '#cc66ff',
      flashColor: 0xcc88ff,
      flashIntensity: 8,
    });
  }

  // ---------------------------------------------------------------------------
  // ArenaScript hooks
  // ---------------------------------------------------------------------------
  protected initArena(scene: THREE.Scene): void {
    this.preloadAmbientSounds();
    createSkybox(scene);
    createAsteroidGround(this.group);
    this.plasmaWallMaterial = createPlasmaWall(
      this.group, this.SEMI_MAJOR, this.SEMI_MINOR, this.WALL_HEIGHT,
    );
    createOvalCollision(this.collision, this.SEMI_MAJOR, this.SEMI_MINOR, this.WALL_HEIGHT);
    const bubbles = createStartingBubbles(this.group, this.BUBBLE_RADIUS, this.BUBBLE_SPAWN_Z);
    this.bubbleMaterials = bubbles.materials;
    this.bubbleMeshes = bubbles.meshes;
    this.bubbleColliders = createBubbleCollision(
      this.collision, this.BUBBLE_RADIUS, this.BUBBLE_SPAWN_Z,
    );
    createArenaLighting(this.group, this.BUBBLE_SPAWN_Z);
    this.archShaderMaterials = createDiamondArchways(this.group, this.collision);
    const platform = createGlassPlatform(this.group, this.collision);
    this.glassPlatformGroup = platform.platformGroup;
    this.glassPlatformCollider = platform.collider;
  }

  protected updateArena(): void {
    // Update plasma shader time uniforms
    if (this.plasmaWallMaterial) {
      this.plasmaWallMaterial.uniforms.uTime.value = this.elapsed;
    }
    for (const mat of this.bubbleMaterials) {
      mat.uniforms.uTime.value = this.elapsed;
    }
    for (const mat of this.archShaderMaterials) {
      mat.uniforms.uTime.value = this.elapsed;
    }
    this.updatePlatform();
  }

  protected disposeArena(): void {
    this.plasmaWallMaterial = null;
    this.bubbleMaterials = [];
    this.bubbleMeshes = [];
    this.bubbleColliders = [];
    this.archShaderMaterials = [];
    this.glassPlatformGroup = null;
    this.glassPlatformCollider = null;
    if (this.ambientAudioCtx) {
      this.ambientAudioCtx.close();
      this.ambientAudioCtx = null;
    }
    this.doorsOpenBuffer = null;
  }

  protected onOpen(): void {
    this.playDoorsOpenSound();
    for (const collider of this.bubbleColliders) {
      this.collision.removeCollider(collider);
    }
  }

  private async preloadAmbientSounds(): Promise<void> {
    try {
      const ctx = new AudioContext();
      this.ambientAudioCtx = ctx;
      const resp = await fetch('/audio/ambient/maps/celestial-ballroom/doors_open.ogg');
      const buf = await resp.arrayBuffer();
      this.doorsOpenBuffer = await ctx.decodeAudioData(buf);
    } catch (e) {
      console.warn('Failed to preload ambient sounds:', e);
    }
  }

  private playDoorsOpenSound(): void {
    if (!this.ambientAudioCtx || !this.doorsOpenBuffer) return;
    if (!audioSettings.enableAmbient || !audioSettings.windowFocused) return;

    const ctx = this.ambientAudioCtx;
    if (ctx.state === 'suspended') ctx.resume();

    const gain = ctx.createGain();
    gain.gain.value = audioSettings.masterVolume * audioSettings.ambientVolume * 3;
    gain.connect(ctx.destination);

    const source = ctx.createBufferSource();
    source.buffer = this.doorsOpenBuffer;
    source.loop = false;
    source.connect(gain);
    source.start();
  }

  protected animateOpen(t: number): void {
    for (let i = 0; i < this.bubbleMeshes.length; i++) {
      const mesh = this.bubbleMeshes[i];
      const mat = this.bubbleMaterials[i];

      // Expand and fade
      const scale = 1 + t * 2.5;
      mesh.scale.set(scale, scale, scale);
      mat.uniforms.uOpacity.value = 1 - t;

      if (t >= 1) {
        this.group.remove(mesh);
      }
    }

    if (t >= 1) {
      this.bubbleMeshes = [];
      this.bubbleMaterials = [];
    }
  }

  protected getFlashPositions(): { x: number; y: number; z: number }[] {
    return [
      { x: 0, y: 6, z: this.BUBBLE_SPAWN_Z },
      { x: 0, y: 6, z: -this.BUBBLE_SPAWN_Z },
    ];
  }

  // ---------------------------------------------------------------------------
  // Glass platform elevator
  // ---------------------------------------------------------------------------

  /**
   * Elevator cycle: ground -> mid -> sky -> mid -> ground, idling at each stop
   * with a gentle hover bob, then smoothly traveling to the next floor.
   */
  private updatePlatform(): void {
    if (!this.glassPlatformGroup || !this.glassPlatformCollider) return;

    const FLOORS = [0.2, 13.5, 40];   // ground, mid (between arches), sky
    const STOPS  = [0, 1, 2, 1];      // ping-pong sequence through floors
    const IDLE   = 8;                  // seconds idling at each stop
    const TRAVEL = 3;                  // seconds traveling between stops
    const PHASE  = IDLE + TRAVEL;
    const CYCLE  = STOPS.length * PHASE;

    const t = this.elapsed % CYCLE;
    const stopIdx = Math.floor(t / PHASE);
    const phaseT  = t - stopIdx * PHASE;

    const fromY = FLOORS[STOPS[stopIdx]];
    const toY   = FLOORS[STOPS[(stopIdx + 1) % STOPS.length]];

    let y: number;
    if (phaseT < IDLE) {
      // Idling — gentle hover bob that fades in/out for smooth transitions
      // Skip the bob at ground level so the platform sits still
      const isGroundFloor = STOPS[stopIdx] === 0;
      const fadeIn  = Math.min(1, phaseT / 1.0);
      const fadeOut = Math.min(1, (IDLE - phaseT) / 1.0);
      y = fromY + (isGroundFloor ? 0 : Math.sin(this.elapsed * 1.5) * 0.4 * fadeIn * fadeOut);
    } else {
      // Traveling — ease-in-out cubic
      const p = (phaseT - IDLE) / TRAVEL;
      const eased = p < 0.5
        ? 4 * p * p * p
        : 1 - Math.pow(-2 * p + 2, 3) / 2;
      y = fromY + (toY - fromY) * eased;
    }

    // Detect if the platform jumped significantly (tab was backgrounded)
    this.platformJumped = Math.abs(y - this.lastPlatformY) > 2;
    this.lastPlatformY = y;

    this.glassPlatformGroup.position.y = y;
    this.glassPlatformCollider.centerY = y;
  }

  getMovingPlatformSnapY(px: number, pz: number): number | undefined {
    if (!this.platformJumped || !this.glassPlatformCollider) return undefined;
    const dx = px - 1;   // ELEVATOR_CX
    const dz = pz - (-1); // ELEVATOR_CZ
    if (Math.abs(dx) <= 4 && Math.abs(dz) <= 4) { // halfW, halfD
      return this.glassPlatformCollider.centerY + 0.2; // + halfH
    }
    return undefined;
  }
}
