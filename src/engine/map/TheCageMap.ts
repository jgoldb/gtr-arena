import type { MapConfig } from './MapConfig';
import { CageArenaScript } from './CageArenaScript';

export const THE_CAGE: MapConfig = {
  id: 'cage',
  name: 'The Cage',
  size: { width: 80, depth: 80 },
  spawnPoint: { x: 0, y: 0, z: 22 },
  groundColor: '#1a1a1a',
  skyColor: '#080810',
  fogColor: '#080810',
  fogNear: 35,
  fogFar: 90,
  sunDirection: { x: 0, y: 15, z: 0 },
  sunIntensity: 1.5,
  ambientIntensity: 0.15,
  obstacles: [
    // ── Cage outer walls (collision-only, invisible — bars provide the visual) ─
    { type: 'wall', position: { x: 0, y: 4, z: -26 }, scale: { x: 36.5, y: 8, z: 0.3 }, color: '#1a1a1e', visible: false },
    { type: 'wall', position: { x: 0, y: 4, z: 26 }, scale: { x: 36.5, y: 8, z: 0.3 }, color: '#1a1a1e', visible: false },
    { type: 'wall', position: { x: -18, y: 4, z: 0 }, scale: { x: 0.3, y: 8, z: 52.5 }, color: '#1a1a1e', visible: false },
    { type: 'wall', position: { x: 18, y: 4, z: 0 }, scale: { x: 0.3, y: 8, z: 52.5 }, color: '#1a1a1e', visible: false },

    // ── Starting pen interior walls (collision-only — bars provide the visual) ─
    // North pen sides
    { type: 'wall', position: { x: -6, y: 2.5, z: -21 }, scale: { x: 0.3, y: 5, z: 10 }, color: '#222228', visible: false },
    { type: 'wall', position: { x: 6, y: 2.5, z: -21 }, scale: { x: 0.3, y: 5, z: 10 }, color: '#222228', visible: false },
    // South pen sides
    { type: 'wall', position: { x: -6, y: 2.5, z: 21 }, scale: { x: 0.3, y: 5, z: 10 }, color: '#222228', visible: false },
    { type: 'wall', position: { x: 6, y: 2.5, z: 21 }, scale: { x: 0.3, y: 5, z: 10 }, color: '#222228', visible: false },

    // ── Ring pillars (LOS blockers) ────────────────────────────────────────
    { type: 'cylinder', position: { x: -8, y: 3, z: 0 }, scale: { x: 1.8, y: 6, z: 1.8 }, color: '#444450' },
    { type: 'cylinder', position: { x: 8, y: 3, z: 0 }, scale: { x: 1.8, y: 6, z: 1.8 }, color: '#444450' },

    // ── Outer perimeter walls (safety boundary) ────────────────────────────
    { type: 'wall', position: { x: 0, y: 3, z: -40 }, scale: { x: 80, y: 6, z: 0.5 }, color: '#0a0a0a' },
    { type: 'wall', position: { x: 0, y: 3, z: 40 }, scale: { x: 80, y: 6, z: 0.5 }, color: '#0a0a0a' },
    { type: 'wall', position: { x: -40, y: 3, z: 0 }, scale: { x: 0.5, y: 6, z: 80 }, color: '#0a0a0a' },
    { type: 'wall', position: { x: 40, y: 3, z: 0 }, scale: { x: 0.5, y: 6, z: 80 }, color: '#0a0a0a' },
  ],
  spawnPoints: [
    { x: 0, y: 0, z: 22 },  // Team 1 — south pen
    { x: 0, y: 0, z: -22 }, // Team 2 — north pen
  ],
  npcSpawnBounds: { minX: -16, maxX: 16, minZ: -14, maxZ: 14 },
  createScript: () => new CageArenaScript(),
};
