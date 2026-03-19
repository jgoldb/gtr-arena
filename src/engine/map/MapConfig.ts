export interface ObstacleConfig {
  type: 'box' | 'cylinder' | 'ramp' | 'wall' | 'water';
  position: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  color: string;
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
}

export const BLADESTORM_ARENA: MapConfig = {
  id: 'bladestorm',
  name: 'Bladestorm Arena',
  size: { width: 44, depth: 44 },
  spawnPoint: { x: 0, y: 0, z: 15 },
  groundColor: '#8B7355',
  skyColor: '#D4A574',
  fogColor: '#C9956B',
  fogNear: 30,
  fogFar: 80,
  sunDirection: { x: 5, y: 10, z: 3 },
  sunIntensity: 2.0,
  ambientIntensity: 0.4,
  obstacles: [
    // Central elevated bridge
    { type: 'ramp', position: { x: -5, y: 0.75, z: 0 }, rotation: { x: 0, y: 0, z: -0.25 }, scale: { x: 6, y: 0.4, z: 4 }, color: '#6B5B45' },
    { type: 'box', position: { x: 0, y: 1.5, z: 0 }, scale: { x: 5, y: 0.4, z: 4 }, color: '#6B5B45' },
    { type: 'ramp', position: { x: 5, y: 0.75, z: 0 }, rotation: { x: 0, y: 0, z: 0.25 }, scale: { x: 6, y: 0.4, z: 4 }, color: '#6B5B45' },

    // Large pillars
    { type: 'cylinder', position: { x: -10, y: 2, z: -10 }, scale: { x: 1.5, y: 4, z: 1.5 }, color: '#8C7B6B' },
    { type: 'cylinder', position: { x: 10, y: 2, z: 10 }, scale: { x: 1.5, y: 4, z: 1.5 }, color: '#8C7B6B' },
    { type: 'cylinder', position: { x: -10, y: 2, z: 10 }, scale: { x: 1.5, y: 4, z: 1.5 }, color: '#8C7B6B' },
    { type: 'cylinder', position: { x: 10, y: 2, z: -10 }, scale: { x: 1.5, y: 4, z: 1.5 }, color: '#8C7B6B' },

    // Perimeter low walls
    { type: 'wall', position: { x: 0, y: 1.5, z: -20 }, scale: { x: 40, y: 3, z: 0.6 }, color: '#7A6B5A' },
    { type: 'wall', position: { x: 0, y: 1.5, z: 20 }, scale: { x: 40, y: 3, z: 0.6 }, color: '#7A6B5A' },
    { type: 'wall', position: { x: -20, y: 1.5, z: 0 }, scale: { x: 0.6, y: 3, z: 40 }, color: '#7A6B5A' },
    { type: 'wall', position: { x: 20, y: 1.5, z: 0 }, scale: { x: 0.6, y: 3, z: 40 }, color: '#7A6B5A' },

    // Scattered cover rocks
    { type: 'box', position: { x: -14, y: 0.5, z: 0 }, rotation: { x: 0, y: 0.4, z: 0 }, scale: { x: 2.5, y: 1, z: 1.5 }, color: '#9C8B7B' },
    { type: 'box', position: { x: 14, y: 0.5, z: 0 }, rotation: { x: 0, y: -0.6, z: 0 }, scale: { x: 2.5, y: 1, z: 1.5 }, color: '#9C8B7B' },
  ],
};

export const VERDANT_ARENA: MapConfig = {
  id: 'verdant',
  name: 'Verdant Grounds',
  size: { width: 38, depth: 38 },
  spawnPoint: { x: 0, y: 0, z: 14 },
  groundColor: '#4A7A3D',
  skyColor: '#87CEEB',
  fogColor: '#A8D8A8',
  fogNear: 35,
  fogFar: 90,
  sunDirection: { x: 3, y: 12, z: 5 },
  sunIntensity: 2.2,
  ambientIntensity: 0.5,
  obstacles: [
    // Central platform
    { type: 'cylinder', position: { x: 0, y: 0.4, z: 0 }, scale: { x: 4, y: 0.8, z: 4 }, color: '#5A8A4D' },

    // Four symmetrical pillars
    { type: 'cylinder', position: { x: -8, y: 1.5, z: -8 }, scale: { x: 1.2, y: 3, z: 1.2 }, color: '#A0A0A0' },
    { type: 'cylinder', position: { x: 8, y: 1.5, z: -8 }, scale: { x: 1.2, y: 3, z: 1.2 }, color: '#A0A0A0' },
    { type: 'cylinder', position: { x: -8, y: 1.5, z: 8 }, scale: { x: 1.2, y: 3, z: 1.2 }, color: '#A0A0A0' },
    { type: 'cylinder', position: { x: 8, y: 1.5, z: 8 }, scale: { x: 1.2, y: 3, z: 1.2 }, color: '#A0A0A0' },

    // Hedgerow walls for line-of-sight breaks
    { type: 'wall', position: { x: -5, y: 0.75, z: 0 }, scale: { x: 0.8, y: 1.5, z: 6 }, color: '#3D6B2E' },
    { type: 'wall', position: { x: 5, y: 0.75, z: 0 }, scale: { x: 0.8, y: 1.5, z: 6 }, color: '#3D6B2E' },
    { type: 'wall', position: { x: 0, y: 0.75, z: -5 }, scale: { x: 6, y: 1.5, z: 0.8 }, color: '#3D6B2E' },
    { type: 'wall', position: { x: 0, y: 0.75, z: 5 }, scale: { x: 6, y: 1.5, z: 0.8 }, color: '#3D6B2E' },

    // Perimeter walls
    { type: 'wall', position: { x: 0, y: 1.5, z: -17 }, scale: { x: 34, y: 3, z: 0.6 }, color: '#808080' },
    { type: 'wall', position: { x: 0, y: 1.5, z: 17 }, scale: { x: 34, y: 3, z: 0.6 }, color: '#808080' },
    { type: 'wall', position: { x: -17, y: 1.5, z: 0 }, scale: { x: 0.6, y: 3, z: 34 }, color: '#808080' },
    { type: 'wall', position: { x: 17, y: 1.5, z: 0 }, scale: { x: 0.6, y: 3, z: 34 }, color: '#808080' },
  ],
};

export const SHADOW_SEWERS: MapConfig = {
  id: 'sewers',
  name: 'Shadow Sewers',
  size: { width: 32, depth: 32 },
  spawnPoint: { x: 0, y: 0, z: 12 },
  groundColor: '#3A3A4A',
  skyColor: '#2A2A3E',
  fogColor: '#2E2E42',
  fogNear: 15,
  fogFar: 50,
  sunDirection: { x: 2, y: 6, z: 1 },
  sunIntensity: 1.2,
  ambientIntensity: 0.35,
  obstacles: [
    // Central water pool
    { type: 'water', position: { x: 0, y: -0.5, z: 0 }, scale: { x: 8, y: 1.0, z: 8 }, color: '#2A5A8A' },

    // Pipe obstacles (horizontal cylinders)
    { type: 'cylinder', position: { x: -8, y: 0.8, z: -5 }, rotation: { x: 0, y: 0, z: Math.PI / 2 }, scale: { x: 0.8, y: 4, z: 0.8 }, color: '#5A5A6A' },
    { type: 'cylinder', position: { x: 8, y: 0.8, z: 5 }, rotation: { x: 0, y: 0, z: Math.PI / 2 }, scale: { x: 0.8, y: 4, z: 0.8 }, color: '#5A5A6A' },

    // Support columns
    { type: 'box', position: { x: -6, y: 2, z: -6 }, scale: { x: 1.5, y: 4, z: 1.5 }, color: '#4A4A5A' },
    { type: 'box', position: { x: 6, y: 2, z: -6 }, scale: { x: 1.5, y: 4, z: 1.5 }, color: '#4A4A5A' },
    { type: 'box', position: { x: -6, y: 2, z: 6 }, scale: { x: 1.5, y: 4, z: 1.5 }, color: '#4A4A5A' },
    { type: 'box', position: { x: 6, y: 2, z: 6 }, scale: { x: 1.5, y: 4, z: 1.5 }, color: '#4A4A5A' },

    // Ramp leading up to elevated side area
    { type: 'ramp', position: { x: -10, y: 0.5, z: 0 }, rotation: { x: 0, y: 0, z: -0.2 }, scale: { x: 5, y: 0.3, z: 3 }, color: '#4A4A5A' },
    { type: 'box', position: { x: -13, y: 1, z: 0 }, scale: { x: 3, y: 0.3, z: 5 }, color: '#4A4A5A' },

    // Perimeter walls
    { type: 'wall', position: { x: 0, y: 2, z: -14 }, scale: { x: 28, y: 4, z: 0.8 }, color: '#3A3A4A' },
    { type: 'wall', position: { x: 0, y: 2, z: 14 }, scale: { x: 28, y: 4, z: 0.8 }, color: '#3A3A4A' },
    { type: 'wall', position: { x: -14, y: 2, z: 0 }, scale: { x: 0.8, y: 4, z: 28 }, color: '#3A3A4A' },
    { type: 'wall', position: { x: 14, y: 2, z: 0 }, scale: { x: 0.8, y: 4, z: 28 }, color: '#3A3A4A' },
  ],
};

export const ALL_MAPS: MapConfig[] = [BLADESTORM_ARENA, VERDANT_ARENA, SHADOW_SEWERS];
