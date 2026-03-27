import * as THREE from 'three';
import { MapConfig } from './MapConfig';
import { MapBuilder, BuiltMap } from './MapBuilder';
import { CollisionSystem } from '../physics/CollisionSystem';
import { THE_CAGE } from './TheCageMap';
import { CELESTIAL_BALLROOM } from './CelestialBallroomMap';
import { UI_SETUP } from './UISetupMap';
import type { MapScript } from './MapScript';

export class MapManager {
  private scene: THREE.Scene;
  private maps: Map<string, MapConfig> = new Map();
  private currentMap: BuiltMap | null = null;
  private currentConfig: MapConfig | null = null;
  private currentScript: MapScript | null = null;
  readonly collision = new CollisionSystem();

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

  dispose(): void {
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
