import { getCharacterStats, GLOBAL_COOLDOWN, type CharacterId, type Positionable, type Ability } from '@gtr/shared';

// ── Cooldown Tracker ─────────────────────────────────────────────────────

export class CooldownTracker {
  private cooldowns = new Map<string, { remaining: number; total: number }>();
  private gcdRemaining = 0;

  isReady(abilityId: string): boolean {
    return (this.cooldowns.get(abilityId)?.remaining ?? 0) <= 0 && this.gcdRemaining <= 0;
  }

  isOnGcd(): boolean {
    return this.gcdRemaining > 0;
  }

  getCooldownRemaining(abilityId: string): number {
    return this.cooldowns.get(abilityId)?.remaining ?? 0;
  }

  /** Returns normalized cooldown values for all abilities (0 = ready, 1 = full cd). */
  getCooldownVector(abilities: readonly (Ability | null)[]): number[] {
    return abilities.map(a => {
      if (!a) return 0;
      const cd = this.cooldowns.get(a.id);
      if (!cd || cd.remaining <= 0) return 0;
      return cd.remaining / cd.total;
    });
  }

  setCooldown(abilityId: string, duration: number): void {
    if (duration > 0) {
      this.cooldowns.set(abilityId, { remaining: duration, total: duration });
    }
  }

  clearCooldown(abilityId: string): void {
    this.cooldowns.delete(abilityId);
  }

  triggerGcd(): void {
    this.gcdRemaining = GLOBAL_COOLDOWN;
  }

  getGcdRemaining(): number {
    return this.gcdRemaining;
  }

  update(dt: number): void {
    if (this.gcdRemaining > 0) {
      this.gcdRemaining = Math.max(0, this.gcdRemaining - dt);
    }
    for (const [id, cd] of this.cooldowns) {
      cd.remaining -= dt;
      if (cd.remaining <= 0) this.cooldowns.delete(id);
    }
  }

  reset(): void {
    this.cooldowns.clear();
    this.gcdRemaining = 0;
  }
}

// ── Headless Entity ──────────────────────────────────────────────────────

export class HeadlessEntity implements Positionable {
  // Identity
  readonly characterId: CharacterId;
  readonly team: number;
  readonly name: string;

  // Position & orientation (replaces THREE.Group mesh)
  x = 0;
  y = 0;
  z = 0;
  rotY = 0;

  // Stats
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  readonly critChance: number;
  readonly dodgeChance: number;
  readonly autoAttackRange: number;
  readonly abilities: readonly (Ability | null)[];

  // State
  inCombat = false;
  dead = false;
  isMoving = false;
  stunned = false;
  blinded = false;

  // Casting
  castingAbilityName: string | null = null;
  castingAbilityId: string | null = null;
  castingElapsed = 0;
  castingTotalTime = 0;
  castingIsChannel = false;

  // Auto-attack
  autoAttackTarget: HeadlessEntity | null = null;

  // Systems
  readonly cooldowns = new CooldownTracker();

  constructor(characterId: CharacterId, team: number, name: string) {
    this.characterId = characterId;
    this.team = team;
    this.name = name;

    const stats = getCharacterStats(characterId);
    this.hp = stats.baseMaxHp;
    this.maxHp = stats.baseMaxHp;
    this.mana = stats.baseMaxMana;
    this.maxMana = stats.baseMaxMana;
    this.critChance = stats.critChance;
    this.dodgeChance = stats.dodgeChance;
    this.autoAttackRange = stats.autoAttackRange;
    this.abilities = stats.abilities;
  }

  isHostileTo(other: Positionable): boolean {
    return this.team !== other.team;
  }

  die(): void {
    this.dead = true;
    this.inCombat = false;
    this.autoAttackTarget = null;
  }

  /** Reset to full HP/mana, alive, clear state. */
  respawn(x: number, z: number, y = 0): void {
    const stats = getCharacterStats(this.characterId);
    this.hp = stats.baseMaxHp;
    this.maxHp = stats.baseMaxHp;
    this.mana = stats.baseMaxMana;
    this.maxMana = stats.baseMaxMana;
    this.dead = false;
    this.inCombat = false;
    this.isMoving = false;
    this.stunned = false;
    this.blinded = false;
    this.castingAbilityName = null;
    this.castingAbilityId = null;
    this.castingElapsed = 0;
    this.castingTotalTime = 0;
    this.castingIsChannel = false;
    this.autoAttackTarget = null;
    this.cooldowns.reset();
    this.x = x;
    this.y = y;
    this.z = z;
    this.rotY = 0;
  }

  distanceTo(other: HeadlessEntity): number {
    const dx = this.x - other.x;
    const dz = this.z - other.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /** Face toward another entity. */
  faceToward(other: HeadlessEntity): void {
    const dx = other.x - this.x;
    const dz = other.z - this.z;
    this.rotY = Math.atan2(dx, dz);
  }
}
