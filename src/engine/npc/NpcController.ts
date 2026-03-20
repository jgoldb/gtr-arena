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
  inCombat = false;
  dead = false;
  private static readonly DESPAWN_DELAY = 10;
  private deathTimer = 0;
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

  die(): void {
    if (this.dead) return;
    this.dead = true;
    this.hp = 0;
    this.inCombat = false;
    this.characterModel.startDeath();
  }

  get shouldDespawn(): boolean {
    return this.dead && this.deathTimer >= NpcController.DESPAWN_DELAY;
  }

  update(dt: number): void {
    if (this.dead) {
      this.deathTimer += dt;
    }
    this.characterModel.update(dt, IDLE_INPUT);
  }

  getPosition(): THREE.Vector3 {
    return this.mesh.position;
  }

  dispose(): void {
    this.characterModel.dispose();
  }
}
