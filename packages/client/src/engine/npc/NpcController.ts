import * as THREE from 'three';
import { CharacterModel, AnimationInput } from '../player/characters/CharacterModel';
import { createCharacter, CharacterId } from '../player/characters';
import type { Targetable } from '../types';
import { createTargetingHitArea } from '../targeting/targetingHitArea';
import type { NpcAiBrain } from './ai/NpcAiBrain';

const IDLE_INPUT: AnimationInput = {
  isMoving: false,
  isGrounded: true,
  velocityY: 0,
  turnSpeed: 0,
  speedMultiplier: 1,
  strafeDirection: 0,
};

export class NpcController implements Targetable {
  readonly mesh: THREE.Group;
  readonly characterId: CharacterId;
  readonly name: string;
  readonly team: number;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  inCombat = false;
  dead = false;
  castingAbilityName: string | null = null;
  castingAbilityId: string | null = null;
  castingTarget: Targetable | null = null;
  castingElapsed = 0;
  castingTotalTime = 0;
  castingIsChannel = false;
  private static readonly DESPAWN_DELAY = 10;
  private static readonly FADE_DURATION = 2;
  private deathTimer = 0;
  private characterModel: CharacterModel;

  stunned = false;
  blinded = false;
  isMoving = false;

  /** AI brain — null means zombie/passive mode (existing behavior) */
  aiBrain: NpcAiBrain | null = null;

  // NPC auto-attack target (set by AI brain / Engine, swung by shared AutoAttackSystem)
  autoAttackTarget: Targetable | null = null;
  resolveGround?: (x: number, z: number, y: number) => number;
  private wasInCombat = false;

  constructor(characterId: CharacterId, position: THREE.Vector3, team = 1, name = 'NPC') {
    this.name = name;
    this.team = team;
    this.characterId = characterId;
    this.characterModel = createCharacter(characterId);
    this.maxHp = this.characterModel.baseMaxHp;
    this.maxMana = this.characterModel.baseMaxMana;
    this.hp = this.maxHp;
    this.mana = this.maxMana;

    this.mesh = new THREE.Group();
    this.mesh.userData.targetRef = this;
    this.mesh.add(this.characterModel.group);
    this.mesh.add(createTargetingHitArea());
    this.mesh.position.copy(position);

    // Face toward map center
    this.mesh.rotation.y = Math.atan2(-position.x, -position.z);
  }

  isHostileTo(other: Targetable): boolean {
    return this.team !== other.team;
  }

  get model(): CharacterModel {
    return this.characterModel;
  }

  get modelName(): string {
    return this.characterModel.displayName;
  }

  get critChance(): number {
    return this.characterModel.critChance;
  }

  get dodgeChance(): number {
    return this.characterModel.dodgeChance;
  }

  get autoAttackRange(): number {
    return this.characterModel.autoAttackRange;
  }

  setResting(active: boolean): void {
    this.characterModel.setResting(active);
  }

  setStunned(active: boolean): void {
    this.stunned = active;
    this.characterModel.setStunned(active);
  }

  triggerFlinch(): void {
    this.characterModel.triggerFlinch();
  }

  triggerDodge(): void {
    this.characterModel.triggerDodge();
  }

  die(): void {
    if (this.dead) return;
    this.dead = true;
    this.hp = 0;
    this.inCombat = false;
    this.characterModel.setAutoAttacking(false);
    this.characterModel.startDeath();
  }

  get shouldDespawn(): boolean {
    return this.dead && this.deathTimer >= NpcController.DESPAWN_DELAY;
  }

  update(dt: number): void {
    if (this.dead) {
      this.deathTimer += dt;
      // Fade out during the last FADE_DURATION seconds before despawn
      const fadeStart = NpcController.DESPAWN_DELAY - NpcController.FADE_DURATION;
      if (this.deathTimer >= fadeStart) {
        const t = (this.deathTimer - fadeStart) / NpcController.FADE_DURATION;
        this.characterModel.setOpacity(Math.max(0, 1 - t));
      }
      this.characterModel.update(dt, IDLE_INPUT);
      return;
    }

    // AI brain update (if present — otherwise zombie mode)
    if (this.aiBrain) {
      this.aiBrain.update(dt);
    }

    // Combat state transitions (auto-attack swinging is driven by Engine's shared AutoAttackSystem)
    if (this.inCombat && !this.wasInCombat) {
      this.characterModel.setAutoAttacking(true);
    } else if (!this.inCombat && this.wasInCombat) {
      this.characterModel.setAutoAttacking(false);
    }
    this.wasInCombat = this.inCombat;

    // Track moving ground (e.g. elevator platforms) — only for zombie NPCs
    // AI NPCs get ground resolution from MovementController
    if (!this.aiBrain && this.resolveGround) {
      const pos = this.mesh.position;
      pos.y = this.resolveGround(pos.x, pos.z, pos.y);
    }

    // Drive cast/channel animations on the NPC model
    if (this.castingAbilityId && this.castingTotalTime > 0) {
      const progress = Math.min(1, this.castingElapsed / this.castingTotalTime);
      if (this.castingIsChannel) {
        this.characterModel.setChannelAnimation(this.castingAbilityId, progress);
        this.characterModel.setCastAnimation(null, 0);
      } else {
        this.characterModel.setCastAnimation(this.castingAbilityId, progress);
        this.characterModel.setChannelAnimation(null, 0);
      }
    } else {
      this.characterModel.setCastAnimation(null, 0);
      this.characterModel.setChannelAnimation(null, 0);
    }

    // Animation input — reflect actual movement and gravity state
    const isGrounded = this.aiBrain ? this.aiBrain.movement.grounded : true;
    const velY = this.aiBrain ? this.aiBrain.movement.velocityY : 0;
    const animInput: AnimationInput = {
      isMoving: this.isMoving,
      isGrounded,
      velocityY: velY,
      turnSpeed: 0,
      speedMultiplier: 1,
      strafeDirection: 0,
    };
    this.characterModel.update(dt, animInput);
  }

  getPosition(): THREE.Vector3 {
    return this.mesh.position;
  }

  dispose(): void {
    this.characterModel.dispose();
  }
}
