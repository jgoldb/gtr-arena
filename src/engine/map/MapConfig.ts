import type { MapScript } from './MapScript';

export interface ObstacleConfig {
  type: 'box' | 'cylinder' | 'ramp' | 'wall' | 'water';
  position: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  color: string;
  visible?: boolean;
}

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
  createScript?: () => MapScript;
}
