import type { ObstacleConfig } from './obstacles.js';

export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
}

export interface MapInfo {
  id: string;
  name: string;
  spawnPoints: SpawnPoint[];
  npcSpawnBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  obstacles: ObstacleConfig[];
}

export const MAPS: Record<string, MapInfo> = {
  'cage': {
    id: 'cage',
    name: 'The Cage',
    spawnPoints: [
      { x: 0, y: 0, z: 26 },   // Team 0 — south pen
      { x: 0, y: 0, z: -26 },  // Team 1 — north pen
    ],
    npcSpawnBounds: { minX: -18, maxX: 18, minZ: -18, maxZ: 18 },
    obstacles: [
      // Cage outer walls
      { type: 'wall', position: { x: 0, y: 10, z: -30.5 }, scale: { x: 41, y: 20, z: 0.3 }, color: '#1a1a1e', visible: false },
      { type: 'wall', position: { x: 0, y: 10, z: 30.5 }, scale: { x: 41, y: 20, z: 0.3 }, color: '#1a1a1e', visible: false },
      { type: 'wall', position: { x: -20.5, y: 10, z: 0 }, scale: { x: 0.3, y: 20, z: 61.5 }, color: '#1a1a1e', visible: false },
      { type: 'wall', position: { x: 20.5, y: 10, z: 0 }, scale: { x: 0.3, y: 20, z: 61.5 }, color: '#1a1a1e', visible: false },
      // Starting pen interior walls
      { type: 'wall', position: { x: -6, y: 2.5, z: -25.5 }, scale: { x: 0.3, y: 5, z: 10 }, color: '#222228', visible: false },
      { type: 'wall', position: { x: 6, y: 2.5, z: -25.5 }, scale: { x: 0.3, y: 5, z: 10 }, color: '#222228', visible: false },
      { type: 'wall', position: { x: -6, y: 2.5, z: 25.5 }, scale: { x: 0.3, y: 5, z: 10 }, color: '#222228', visible: false },
      { type: 'wall', position: { x: 6, y: 2.5, z: 25.5 }, scale: { x: 0.3, y: 5, z: 10 }, color: '#222228', visible: false },
      // Outer perimeter walls
      { type: 'wall', position: { x: 0, y: 3, z: -47 }, scale: { x: 95, y: 6, z: 0.5 }, color: '#0a0a0a' },
      { type: 'wall', position: { x: 0, y: 3, z: 47 }, scale: { x: 95, y: 6, z: 0.5 }, color: '#0a0a0a' },
      { type: 'wall', position: { x: -45, y: 3, z: 0 }, scale: { x: 0.5, y: 6, z: 95 }, color: '#0a0a0a' },
      { type: 'wall', position: { x: 45, y: 3, z: 0 }, scale: { x: 0.5, y: 6, z: 95 }, color: '#0a0a0a' },
    ],
  },
  'celestial-ballroom': {
    id: 'celestial-ballroom',
    name: 'Celestial Ballroom',
    spawnPoints: [
      { x: 0, y: 0, z: 32 },   // Team 0 — south bubble
      { x: 0, y: 0, z: -32 },  // Team 1 — north bubble
    ],
    npcSpawnBounds: { minX: -40, maxX: 40, minZ: -30, maxZ: 30 },
    obstacles: [
      // Outer safety boundary
      { type: 'wall', position: { x: 0, y: 5, z: -65 }, scale: { x: 160, y: 10, z: 0.5 }, color: '#000000', visible: false },
      { type: 'wall', position: { x: 0, y: 5, z: 65 }, scale: { x: 160, y: 10, z: 0.5 }, color: '#000000', visible: false },
      { type: 'wall', position: { x: -80, y: 5, z: 0 }, scale: { x: 0.5, y: 10, z: 130 }, color: '#000000', visible: false },
      { type: 'wall', position: { x: 80, y: 5, z: 0 }, scale: { x: 0.5, y: 10, z: 130 }, color: '#000000', visible: false },
    ],
  },
};

export const MAP_LIST = Object.values(MAPS);

export function getMapInfo(id: string): MapInfo | undefined {
  return MAPS[id];
}
