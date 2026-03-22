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
  readonly team: number;
  isHostileTo(other: Targetable): boolean;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  inCombat: boolean;
  dead: boolean;
  readonly critChance: number;
  readonly dodgeChance: number;
  readonly mesh: THREE.Group;
  die(): void;
  // Casting state (for nameplate cast bars)
  castingAbilityName: string | null;
  castingElapsed: number;
  castingTotalTime: number;
  castingIsChannel: boolean;
  disconnected?: boolean;
}
