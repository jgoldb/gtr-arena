import * as THREE from 'three';
import { MapConfig } from './MapConfig';
import { MapBuilder, BuiltMap } from './MapBuilder';
import { CollisionSystem } from '../physics/CollisionSystem';
import { THE_CAGE } from './TheCageMap';
import { CELESTIAL_BALLROOM } from './CelestialBallroomMap';
import { UI_SETUP } from './UISetupMap';
import type { MapScript } from './MapScript';
import { audioSettings } from '../../ui/AudioSettings';

export class MapManager {
  private scene: THREE.Scene;
  private maps: Map<string, MapConfig> = new Map();
  private currentMap: BuiltMap | null = null;
  private currentConfig: MapConfig | null = null;
  private currentScript: MapScript | null = null;
  readonly collision = new CollisionSystem();

  // Ambient sound
  private ambientCtx: AudioContext | null = null;
  private ambientGain: GainNode | null = null;
  private ambientSource: AudioBufferSourceNode | null = null;
  private ambientSoundVolume = 1;
  private ambientSettingsListener: (() => void) | null = null;
  private ambientVisibilityListener: (() => void) | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    for (const map of [THE_CAGE, CELESTIAL_BALLROOM, UI_SETUP]) {
      this.maps.set(map.id, map);
    }
  }

  loadMap(id: string): void {
    const config = this.maps.get(id);
    if (!config) {
      console.error(`Map "${id}" not found`);
      return;
    }

    // Stop previous ambient sound
    this.stopAmbientSound();

    // Dispose active map script before removing the scene group
    if (this.currentScript) {
      this.currentScript.dispose();
      this.currentScript = null;
    }

    // Remove existing map group
    if (this.currentMap) {
      this.scene.remove(this.currentMap.group);
      this.currentMap.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      });
    }

    // Clear fog and background (builder will set new ones)
    this.scene.fog = null;
    this.scene.background = null;

    this.currentMap = MapBuilder.build(config, this.scene);
    this.currentConfig = config;
    this.collision.buildFromObstacles(config.obstacles);

    // Initialize map script if the config defines one
    if (config.createScript) {
      this.currentScript = config.createScript();
      this.currentScript.init(this.scene, this.currentMap.group, this.collision);
    }

    // Start ambient sound if the map defines one
    if (config.ambientSound) {
      this.ambientSoundVolume = config.ambientSoundVolume ?? 1;
      this.startAmbientSound(config.ambientSound);
    }
  }

  update(dt: number): void {
    this.currentScript?.update(dt);
  }

  /** Reset the arena countdown timer (synchronize after all clients report ready). */
  resetTimer(): void {
    this.currentScript?.resetTimer?.();
  }

  /** Set the elapsed time for the arena countdown (used on rejoin to sync). */
  setElapsed(elapsed: number): void {
    this.currentScript?.setElapsed?.(elapsed);
  }

  /** Force open the arena doors immediately. */
  forceOpenDoors(): void {
    this.currentScript?.forceOpenDoors?.();
  }

  /** Update the gate vote display. */
  updateGateVotes(voteCount: number, totalPlayers: number): void {
    (this.currentScript as any)?.updateGateVotes?.(voteCount, totalPlayers);
  }

  /** Notify the map script of a killing blow. */
  onKillingBlow(killerTeam: number, victimTeam: number): void {
    this.currentScript?.onKillingBlow?.(killerTeam, victimTeam);
  }

  /**
   * If a moving platform jumped this frame (e.g. tab restore), returns the
   * surface Y for the entity at (px, pz).  Undefined = no snap needed.
   */
  getMovingPlatformSnapY(px: number, pz: number): number | undefined {
    return this.currentScript?.getMovingPlatformSnapY?.(px, pz);
  }

  getScript(): MapScript | null {
    return this.currentScript;
  }

  getCurrentConfig(): MapConfig | null {
    return this.currentConfig;
  }

  getBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    if (!this.currentMap) {
      return { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
    }
    return this.currentMap.bounds;
  }

  getSpawnPoint(): { x: number; y: number; z: number } {
    if (!this.currentConfig) {
      return { x: 0, y: 0, z: 0 };
    }
    return { ...this.currentConfig.spawnPoint };
  }

  getNpcSpawnBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    return this.currentConfig?.npcSpawnBounds ?? this.getBounds();
  }

  private get ambientVolume(): number {
    if (!audioSettings.enableAmbient || !audioSettings.windowFocused) return 0;
    return audioSettings.masterVolume * audioSettings.ambientVolume * this.ambientSoundVolume;
  }

  private applyAmbientVolume(): void {
    if (!this.ambientCtx || !this.ambientGain) return;
    const ctx = this.ambientCtx;
    const gain = this.ambientGain;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(this.ambientVolume, ctx.currentTime + 0.15);
  }

  private async startAmbientSound(url: string): Promise<void> {
    try {
      const ctx = new AudioContext();
      this.ambientCtx = ctx;
      const gain = ctx.createGain();
      this.ambientGain = gain;
      gain.gain.value = 0;
      gain.connect(ctx.destination);

      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(buf);

      // Context may have been stopped while fetching
      if (!this.ambientCtx || this.ambientCtx !== ctx) {
        ctx.close();
        return;
      }

      const source = ctx.createBufferSource();
      this.ambientSource = source;
      source.buffer = audioBuf;
      source.loop = true;
      source.connect(gain);
      source.start();

      // Fade in
      if (ctx.state !== 'suspended' && !document.hidden) {
        gain.gain.linearRampToValueAtTime(this.ambientVolume, ctx.currentTime + 2);
      }

      // Resume on user gesture if suspended
      if (ctx.state === 'suspended') {
        const resume = () => {
          ctx.resume().then(() => {
            document.removeEventListener('pointerdown', resume);
            document.removeEventListener('keydown', resume);
            if (this.ambientCtx === ctx && this.ambientGain && !document.hidden) {
              this.ambientGain.gain.linearRampToValueAtTime(this.ambientVolume, ctx.currentTime + 2);
            }
          });
        };
        document.addEventListener('pointerdown', resume);
        document.addEventListener('keydown', resume);
      }

      // React to settings changes (volume and enable/disable)
      this.ambientSettingsListener = () => this.applyAmbientVolume();
      audioSettings.onChange(this.ambientSettingsListener);

      // React to visibility changes
      this.ambientVisibilityListener = () => {
        if (!this.ambientCtx || !this.ambientGain) return;
        const g = this.ambientGain;
        g.gain.cancelScheduledValues(this.ambientCtx.currentTime);
        g.gain.setValueAtTime(g.gain.value, this.ambientCtx.currentTime);
        if (document.hidden) {
          g.gain.linearRampToValueAtTime(0, this.ambientCtx.currentTime + 0.3);
        } else {
          g.gain.linearRampToValueAtTime(this.ambientVolume, this.ambientCtx.currentTime + 0.5);
        }
      };
      document.addEventListener('visibilitychange', this.ambientVisibilityListener);
    } catch {
      // Audio not available — silent fail
    }
  }

  private stopAmbientSound(): void {
    if (this.ambientSettingsListener) {
      audioSettings.removeListener(this.ambientSettingsListener);
      this.ambientSettingsListener = null;
    }
    if (this.ambientVisibilityListener) {
      document.removeEventListener('visibilitychange', this.ambientVisibilityListener);
      this.ambientVisibilityListener = null;
    }
    if (this.ambientSource) {
      try { this.ambientSource.stop(); } catch { /* already stopped */ }
      this.ambientSource = null;
    }
    if (this.ambientCtx) {
      this.ambientCtx.close();
      this.ambientCtx = null;
    }
    this.ambientGain = null;
  }

  dispose(): void {
    this.stopAmbientSound();
    if (this.currentScript) {
      this.currentScript.dispose();
      this.currentScript = null;
    }
  }

  getAvailableMaps(): MapConfig[] {
    return Array.from(this.maps.values());
  }

  registerMap(config: MapConfig): void {
    this.maps.set(config.id, config);
  }
}
