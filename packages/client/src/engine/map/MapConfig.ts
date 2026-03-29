import type { MapScript } from './MapScript';
import type { ObstacleConfig } from '@gtr/shared';

export type { ObstacleConfig };

export interface MapConfig {
  id: string;
  name: string;
  size: { width: number; depth: number };
  spawnPoint: { x: number; y: number; z: number };
  groundColor: string;
  skyColor: string;
  fogColor: string;
  fogNear: number;
  fogFar: number;
  sunDirection: { x: number; y: number; z: number };
  sunIntensity: number;
  ambientIntensity: number;
  obstacles: ObstacleConfig[];
  spawnPoints?: { x: number; y: number; z: number }[];
  npcSpawnBounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
  ambientSound?: string;
  ambientSoundVolume?: number;  // per-map multiplier, default 1
  createScript?: () => MapScript;
}
