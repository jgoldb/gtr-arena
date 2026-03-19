import * as THREE from 'three';

export interface GameContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  clock: THREE.Clock;
  canvas: HTMLCanvasElement;
}

export interface GameSystem {
  update(deltaTime: number): void;
  dispose?(): void;
}

export interface Targetable {
  readonly name: string;
  readonly modelName: string;
  readonly hostile: boolean;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  readonly mesh: THREE.Group;
}
