import type { CharacterId, CharacterStats } from '@gtr/shared';
import type { Ability, BuffDefinition } from '@gtr/shared';
import type { EntitySnapshot } from '@gtr/shared';
import { getCharacterStats } from '@gtr/shared';

export class ServerEntity {
  readonly id: string;
  readonly userId: string;
  readonly characterId: CharacterId;
  readonly name: string;
  readonly team: number;

  // Position
  x = 0;
  y = 0;
  z = 0;
  rotationY = 0;

  // Stats
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  inCombat = false;
  dead = false;
  stunned = false;
  charging = false;
  isMoving = false;
  isAutoAttacking = false;
  godMode = false;
  disconnected = false;

  // Character stats
  readonly autoAttackDamageMin: number;
  readonly autoAttackDamageMax: number;
  readonly autoAttackSpeed: number;
  readonly autoAttackRange: number;
  readonly critChance: number;
  readonly dodgeChance: number;
  readonly abilities: readonly Ability[];

  // Movement
  speed = 5.6;
  movementSpeedModifier = 1;
  readonly collisionRadius = 0.4;
  readonly jumpForce = 7;
  readonly gravity = 20;
  readonly backpedalMultiplier = 0.5;
  readonly airDriftFraction = 0.25;
  velocityY = 0;
  grounded = true;

  // State
  discombobulated = false;
  private discombobSeed = 0;

  constructor(id: string, userId: string, characterId: CharacterId, name: string, team: number) {
    this.id = id;
    this.userId = userId;
    this.characterId = characterId;
    this.name = name;
    this.team = team;

    const stats = getCharacterStats(characterId);
    this.hp = stats.baseMaxHp;
    this.maxHp = stats.baseMaxHp;
    this.mana = stats.baseMaxMana;
    this.maxMana = stats.baseMaxMana;
    this.autoAttackDamageMin = stats.autoAttackDamageMin;
    this.autoAttackDamageMax = stats.autoAttackDamageMax;
    this.autoAttackSpeed = stats.autoAttackSpeed;
    this.autoAttackRange = stats.autoAttackRange;
    this.critChance = stats.critChance;
    this.dodgeChance = stats.dodgeChance;
    this.abilities = stats.abilities;
  }

  isHostileTo(other: ServerEntity): boolean {
    return this.team !== other.team;
  }

  rollAutoAttackDamage(): number {
    return this.autoAttackDamageMin + Math.floor(
      Math.random() * (this.autoAttackDamageMax - this.autoAttackDamageMin + 1)
    );
  }

  die(): void {
    if (this.dead) return;
    this.dead = true;
    this.hp = 0;
    this.inCombat = false;
    this.isAutoAttacking = false;
    this.charging = false;
  }

  respawn(spawnPoint: { x: number; y: number; z: number }): void {
    this.dead = false;
    this.hp = this.maxHp;
    this.mana = this.maxMana;
    this.inCombat = false;
    this.x = spawnPoint.x;
    this.y = spawnPoint.y;
    this.z = spawnPoint.z;
    this.velocityY = 0;
    this.grounded = true;
    this.stunned = false;
    this.charging = false;
    this.discombobulated = false;
  }

  setDiscombobulated(active: boolean): void {
    if (active && !this.discombobulated) {
      this.discombobSeed = Math.random() * 1000;
    }
    this.discombobulated = active;
  }

  getDiscombobSeed(): number {
    return this.discombobSeed;
  }

  toSnapshot(): EntitySnapshot {
    return {
      id: this.id,
      characterId: this.characterId,
      team: this.team,
      name: this.name,
      x: this.x,
      y: this.y,
      z: this.z,
      rotationY: this.rotationY,
      hp: this.hp,
      maxHp: this.maxHp,
      mana: this.mana,
      maxMana: this.maxMana,
      dead: this.dead,
      inCombat: this.inCombat,
      stunned: this.stunned,
      charging: this.charging,
      isMoving: this.isMoving,
      isAutoAttacking: this.isAutoAttacking,
      castingAbilityId: null,
      castingElapsed: 0,
      castingTotalTime: 0,
      castingIsChannel: false,
      targetEntityId: null,
      disconnected: this.disconnected || undefined,
    };
  }
}
