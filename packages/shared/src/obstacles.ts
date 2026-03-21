// Obstacle config shared between client map builder and server collision system
export interface ObstacleConfig {
  type: 'box' | 'cylinder' | 'ramp' | 'wall' | 'water';
  position: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  color: string;
  visible?: boolean;
}
