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
  /** Seconds before arena doors open. Players have Arena Preparation during this period. */
  arenaOpenTime?: number;
  /** Music file to loop on the music audio channel while this map is active. */
  music?: string;
  /** Whether this map is selectable in single-player / playground mode. Defaults to true. */
  playableInSinglePlayer?: boolean;
}

export const MAPS: Record<string, MapInfo> = {
  'cage': {
    id: 'cage',
    name: 'The Cage',
    arenaOpenTime: 30,
    music: 'cage.ogg',
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
    arenaOpenTime: 30,
    music: 'ballroom.ogg',
    playableInSinglePlayer: false,
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
  'ui-setup': {
    id: 'ui-setup',
    name: 'Training Room',
    spawnPoints: [
      { x: 0, y: 0, z: 0 },
    ],
    npcSpawnBounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
    obstacles: [
      // Simple box — 4 walls
      { type: 'wall', position: { x: 0, y: 3, z: -15 }, scale: { x: 30, y: 6, z: 0.5 }, color: '#1a1a2e' },
      { type: 'wall', position: { x: 0, y: 3, z: 15 }, scale: { x: 30, y: 6, z: 0.5 }, color: '#1a1a2e' },
      { type: 'wall', position: { x: -15, y: 3, z: 0 }, scale: { x: 0.5, y: 6, z: 30.5 }, color: '#1a1a2e' },
      { type: 'wall', position: { x: 15, y: 3, z: 0 }, scale: { x: 0.5, y: 6, z: 30.5 }, color: '#1a1a2e' },
    ],
  },
};

export const MAP_LIST = Object.values(MAPS).filter(m => m.id !== 'ui-setup');

export function getMapInfo(id: string): MapInfo | undefined {
  return MAPS[id];
}
