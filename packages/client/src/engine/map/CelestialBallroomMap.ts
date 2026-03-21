import type { MapConfig } from './MapConfig';
import { CelestialBallroomScript } from './CelestialBallroomScript';

export const CELESTIAL_BALLROOM: MapConfig = {
  id: 'celestial-ballroom',
  name: 'Celestial Ballroom',
  size: { width: 150, depth: 130 },
  spawnPoint: { x: 0, y: 0, z: 32 },
  groundColor: '#1a1a1e',
  skyColor: '#000008',
  fogColor: '#000008',
  fogNear: 60,
  fogFar: 150,
  sunDirection: { x: 5, y: 20, z: 3 },
  sunIntensity: 1.6,
  ambientIntensity: 0.4,
  obstacles: [
    // ── Outer safety boundary (invisible) ─────────────────────────────────
    { type: 'wall', position: { x: 0, y: 5, z: -65 }, scale: { x: 160, y: 10, z: 0.5 }, color: '#000000', visible: false },
    { type: 'wall', position: { x: 0, y: 5, z: 65 }, scale: { x: 160, y: 10, z: 0.5 }, color: '#000000', visible: false },
    { type: 'wall', position: { x: -80, y: 5, z: 0 }, scale: { x: 0.5, y: 10, z: 130 }, color: '#000000', visible: false },
    { type: 'wall', position: { x: 80, y: 5, z: 0 }, scale: { x: 0.5, y: 10, z: 130 }, color: '#000000', visible: false },
  ],
  spawnPoints: [
    { x: 0, y: 0, z: 32 },   // Team 1 — south bubble
    { x: 0, y: 0, z: -32 },  // Team 2 — north bubble
  ],
  npcSpawnBounds: { minX: -40, maxX: 40, minZ: -30, maxZ: 30 },
  createScript: () => new CelestialBallroomScript(),
};
