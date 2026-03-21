import * as THREE from 'three';
import type { CollisionSystem } from '../physics/CollisionSystem';

export interface MapScript {
  init(scene: THREE.Scene, mapGroup: THREE.Group, collision: CollisionSystem): void;
  update(dt: number): void;
  dispose(): void;
}
