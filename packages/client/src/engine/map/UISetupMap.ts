import type { MapConfig } from './MapConfig';

export const UI_SETUP: MapConfig = {
  id: 'ui-setup',
  name: 'Training Room',
  size: { width: 30, depth: 30 },
  spawnPoint: { x: 0, y: 0, z: 0 },
  groundColor: '#1a1a2e',
  skyColor: '#0a0a14',
  fogColor: '#0a0a14',
  fogNear: 20,
  fogFar: 50,
  sunDirection: { x: 3, y: 15, z: 3 },
  sunIntensity: 1.2,
  ambientIntensity: 0.5,
  obstacles: [
    // Simple box — 4 walls
    { type: 'wall', position: { x: 0, y: 3, z: -15 }, scale: { x: 30, y: 6, z: 0.5 }, color: '#1a1a2e' },
    { type: 'wall', position: { x: 0, y: 3, z: 15 }, scale: { x: 30, y: 6, z: 0.5 }, color: '#1a1a2e' },
    { type: 'wall', position: { x: -15, y: 3, z: 0 }, scale: { x: 0.5, y: 6, z: 30.5 }, color: '#1a1a2e' },
    { type: 'wall', position: { x: 15, y: 3, z: 0 }, scale: { x: 0.5, y: 6, z: 30.5 }, color: '#1a1a2e' },
  ],
  npcSpawnBounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
  // No createScript — no arena doors or countdown
};
