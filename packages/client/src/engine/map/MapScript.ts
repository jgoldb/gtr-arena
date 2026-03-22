import * as THREE from 'three';
import type { CollisionSystem } from '../physics/CollisionSystem';

export interface MapScript {
  init(scene: THREE.Scene, mapGroup: THREE.Group, collision: CollisionSystem): void;
  update(dt: number): void;
  dispose(): void;
  /** Reset the arena countdown timer (used to synchronize after all clients are ready). */
  resetTimer?(): void;
  /** Set the elapsed time for the arena countdown (used on rejoin to sync). */
  setElapsed?(elapsed: number): void;
  /** Force open the arena doors immediately (skipping remaining countdown). */
  forceOpenDoors?(): void;
  /** Called when arena doors open. */
  onDoorsOpen?: () => void;
}
