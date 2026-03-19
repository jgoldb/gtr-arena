import * as THREE from 'three';
import { MapConfig, ALL_MAPS } from './MapConfig';
import { MapBuilder, BuiltMap } from './MapBuilder';
import { CollisionSystem } from '../physics/CollisionSystem';

export class MapManager {
  private scene: THREE.Scene;
  private maps: Map<string, MapConfig> = new Map();
  private currentMap: BuiltMap | null = null;
  private currentConfig: MapConfig | null = null;
  readonly collision = new CollisionSystem();

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    for (const map of ALL_MAPS) {
      this.maps.set(map.id, map);
    }
  }

  loadMap(id: string): void {
    const config = this.maps.get(id);
    if (!config) {
      console.error(`Map "${id}" not found`);
      return;
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

  getAvailableMaps(): MapConfig[] {
    return Array.from(this.maps.values());
  }

  registerMap(config: MapConfig): void {
    this.maps.set(config.id, config);
  }
}
