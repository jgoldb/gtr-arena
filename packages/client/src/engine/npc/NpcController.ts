import * as THREE from 'three';
import { CharacterModel, AnimationInput } from '../player/characters/CharacterModel';
import { createCharacter, CharacterId } from '../player/characters';
import type { Targetable } from '../types';
import { createTargetingHitArea } from '../targeting/targetingHitArea';

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
  castingElapsed = 0;
  castingTotalTime = 0;
  castingIsChannel = false;
  private static readonly DESPAWN_DELAY = 10;
  private static readonly FADE_DURATION = 2;
  private deathTimer = 0;
  private characterModel: CharacterModel;

  stunned = false;

  // NPC auto-attack
  autoAttackTarget: Targetable | null = null;
  onAutoAttackHit?: (attacker: Targetable, target: Targetable, damage: number) => void;
  checkLineOfSight?: (a: THREE.Vector3, b: THREE.Vector3) => boolean;
  resolveGround?: (x: number, z: number, y: number) => number;
  private autoAttackTimer = 0;
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

  get modelName(): string {
    return this.characterModel.displayName;
  }

  get critChance(): number {
    return this.characterModel.critChance;
  }

  get dodgeChance(): number {
    return this.characterModel.dodgeChance;
  }

  setStunned(active: boolean): void {
    this.stunned = active;
    this.characterModel.setStunned(active);
  }

  triggerFlinch(): void {
    this.characterModel.triggerFlinch();
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

    // Combat state transitions
    if (this.inCombat && !this.wasInCombat) {
      // Entered combat — begin auto-attacking
      this.characterModel.setAutoAttacking(true);
      this.autoAttackTimer = 0;
    } else if (!this.inCombat && this.wasInCombat) {
      // Left combat — stop auto-attacking
      this.characterModel.setAutoAttacking(false);
      this.autoAttackTimer = 0;
    }
    this.wasInCombat = this.inCombat;

    // Auto-attack logic (stunned NPCs cannot attack)
    const target = this.autoAttackTarget;
    if (this.inCombat && target && !target.dead && !this.stunned) {
      const dx = target.mesh.position.x - this.mesh.position.x;
      const dz = target.mesh.position.z - this.mesh.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      // Facing check (120° cone, same as player)
      const toTarget = new THREE.Vector3(dx, 0, dz).normalize();
      const rotY = this.mesh.rotation.y;
      const forward = new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY));
      const facing = forward.dot(toTarget) > 0.5;

      // Swing timer
      this.autoAttackTimer += dt;
      if (this.autoAttackTimer >= this.characterModel.autoAttackSpeed) {
        const hasLos = !this.checkLineOfSight || this.checkLineOfSight(this.mesh.position, target.mesh.position);
        if (facing && dist <= this.characterModel.autoAttackRange && hasLos) {
          this.autoAttackTimer = 0;
          this.characterModel.triggerSwing();
          this.onAutoAttackHit?.(this, target, this.characterModel.rollAutoAttackDamage());
        } else {
          // Not facing or out of range — hold timer
          this.autoAttackTimer = this.characterModel.autoAttackSpeed;
        }
      }
    }

    // Track moving ground (e.g. elevator platforms)
    if (this.resolveGround) {
      const pos = this.mesh.position;
      pos.y = this.resolveGround(pos.x, pos.z, pos.y);
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
