import type { MapConfig } from './MapConfig';
import { CageArenaScript } from './CageArenaScript';

export const THE_CAGE: MapConfig = {
  id: 'cage',
  name: 'The Cage',
  size: { width: 90, depth: 95 },
  spawnPoint: { x: 0, y: 0, z: 26 },
  groundColor: '#1a1a1a',
  skyColor: '#080810',
  fogColor: '#080810',
  fogNear: 40,
  fogFar: 100,
  sunDirection: { x: 0, y: 15, z: 0 },
  sunIntensity: 2.2,
  ambientIntensity: 0.4,
  obstacles: [
    // ── Cage outer walls (collision-only, invisible — bars provide the visual) ─
    { type: 'wall', position: { x: 0, y: 10, z: -30.5 }, scale: { x: 41, y: 20, z: 0.3 }, color: '#1a1a1e', visible: false },
    { type: 'wall', position: { x: 0, y: 10, z: 30.5 }, scale: { x: 41, y: 20, z: 0.3 }, color: '#1a1a1e', visible: false },
    { type: 'wall', position: { x: -20.5, y: 10, z: 0 }, scale: { x: 0.3, y: 20, z: 61.5 }, color: '#1a1a1e', visible: false },
    { type: 'wall', position: { x: 20.5, y: 10, z: 0 }, scale: { x: 0.3, y: 20, z: 61.5 }, color: '#1a1a1e', visible: false },

    // ── Starting pen interior walls (collision-only — bars provide the visual) ─
    // North pen sides
    { type: 'wall', position: { x: -6, y: 2.5, z: -25.5 }, scale: { x: 0.3, y: 5, z: 10 }, color: '#222228', visible: false },
    { type: 'wall', position: { x: 6, y: 2.5, z: -25.5 }, scale: { x: 0.3, y: 5, z: 10 }, color: '#222228', visible: false },
    // South pen sides
    { type: 'wall', position: { x: -6, y: 2.5, z: 25.5 }, scale: { x: 0.3, y: 5, z: 10 }, color: '#222228', visible: false },
    { type: 'wall', position: { x: 6, y: 2.5, z: 25.5 }, scale: { x: 0.3, y: 5, z: 10 }, color: '#222228', visible: false },

    // ── Outer perimeter walls (safety boundary) ────────────────────────────
    { type: 'wall', position: { x: 0, y: 3, z: -47 }, scale: { x: 95, y: 6, z: 0.5 }, color: '#0a0a0a' },
    { type: 'wall', position: { x: 0, y: 3, z: 47 }, scale: { x: 95, y: 6, z: 0.5 }, color: '#0a0a0a' },
    { type: 'wall', position: { x: -45, y: 3, z: 0 }, scale: { x: 0.5, y: 6, z: 95 }, color: '#0a0a0a' },
    { type: 'wall', position: { x: 45, y: 3, z: 0 }, scale: { x: 0.5, y: 6, z: 95 }, color: '#0a0a0a' },
  ],
  spawnPoints: [
    { x: 0, y: 0, z: 26 },  // Team 1 — south pen
    { x: 0, y: 0, z: -26 }, // Team 2 — north pen
  ],
  npcSpawnBounds: { minX: -18, maxX: 18, minZ: -18, maxZ: 18 },
  ambientSound: '/audio/ambient/maps/cage/crowd.wav',
  ambientSoundVolume: 2.5,
  createScript: () => new CageArenaScript(),
};
