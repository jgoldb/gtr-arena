import * as THREE from 'three';
import { CharacterModel, AnimationInput } from '../player/characters/CharacterModel';
import { createCharacter, CharacterId } from '../player/characters';
import type { Targetable } from '../types';

const IDLE_INPUT: AnimationInput = {
  isMoving: false,
  isGrounded: true,
  velocityY: 0,
  turnSpeed: 0,
  speedMultiplier: 1,
};

export class NpcController implements Targetable {
  readonly mesh: THREE.Group;
  readonly characterId: CharacterId;
  readonly name = 'NPC';
  readonly hostile = true;
  hp = 100;
  maxHp = 100;
  mana = 100;
  maxMana = 100;
  private characterModel: CharacterModel;

  constructor(characterId: CharacterId, position: THREE.Vector3) {
    this.characterId = characterId;
    this.characterModel = createCharacter(characterId);

    this.mesh = new THREE.Group();
    this.mesh.userData.targetRef = this;
    this.mesh.add(this.characterModel.group);
    this.mesh.position.copy(position);

    // Face toward map center
    this.mesh.rotation.y = Math.atan2(-position.x, -position.z);
  }

  get modelName(): string {
    return this.characterModel.displayName;
  }

  update(dt: number): void {
    this.characterModel.update(dt, IDLE_INPUT);
  }

  getPosition(): THREE.Vector3 {
    return this.mesh.position;
  }

  dispose(): void {
    this.characterModel.dispose();
  }
}
