import * as THREE from 'three';
import type { Ability } from './Ability';
import type { Targetable } from '../types';
import type { RegenSystem } from './RegenSystem';
import type { BuffSystem } from './BuffSystem';
import type { CollisionSystem } from '../physics/CollisionSystem';

export type CombatError = 'no-target' | 'out-of-range' | 'not-facing' | 'on-cooldown' | 'not-enough-mana' | 'dead' | 'not-in-los' | 'stunned' | 'casting' | 'moving';

export interface CombatResult {
  success: boolean;
  error?: CombatError;
  errorMessage?: string;
}

export type CombatTextType = 'damage' | 'heal' | 'crit' | 'miss' | 'dodge';

export class CombatSystem {
  private cooldowns = new Map<string, { remaining: number; total: number }>(); // ability id → cooldown state
  private static readonly COMBAT_DURATION = 5; // seconds before leaving combat
  private static readonly MISS_CHANCE = 0.03; // 3% flat miss chance
  private static readonly GOD_MODE_DAMAGE_MULT = 11; // +1000% damage
  private combatTimers = new Map<Targetable, number>(); // entity → seconds remaining
  private regenSystem: RegenSystem;
  private buffSystem: BuffSystem;
  private collisionSystem: CollisionSystem;
  private godModeEntities = new Set<Targetable>();
  onCombatText?: (target: Targetable, amount: number, type: CombatTextType) => void;
  onDirectDamageDealt?: (target: Targetable) => void;
  onFlinchDamage?: (target: Targetable) => void;
  onHostileAction?: (attacker: Targetable, target: Targetable) => void;
  onEnterCombat?: (entity: Targetable) => void;
  onLeaveCombat?: (entity: Targetable) => void;

  constructor(regenSystem: RegenSystem, buffSystem: BuffSystem, collisionSystem: CollisionSystem) {
    this.regenSystem = regenSystem;
    this.buffSystem = buffSystem;
    this.collisionSystem = collisionSystem;
  }

  setGodMode(entity: Targetable, active: boolean): void {
    if (active) this.godModeEntities.add(entity);
    else this.godModeEntities.delete(entity);
  }

  isGodMode(entity: Targetable): boolean {
    return this.godModeEntities.has(entity);
  }

  enterCombat(entity: Targetable): void {
    if (entity.dead) return;
    const wasInCombat = entity.inCombat;
    entity.inCombat = true;
    this.combatTimers.set(entity, CombatSystem.COMBAT_DURATION);
    if (!wasInCombat) {
      this.onEnterCombat?.(entity);
    }
  }

  isInCombat(entity: Targetable): boolean {
    return this.combatTimers.has(entity);
  }

  /** Check facing: is attacker looking roughly toward the target? (120° cone) */
  private isFacing(
    attackerPos: THREE.Vector3,
    attackerRotY: number,
    targetPos: THREE.Vector3
  ): boolean {
    const toTarget = new THREE.Vector3()
      .subVectors(targetPos, attackerPos)
      .normalize();
    // Player forward is along +Z in local space, rotated by mesh.rotation.y
    const forward = new THREE.Vector3(
      Math.sin(attackerRotY),
      0,
      Math.cos(attackerRotY)
    );
    const dot = forward.dot(new THREE.Vector3(toTarget.x, 0, toTarget.z).normalize());
    // cos(60°) = 0.5 → 120° cone in front
    return dot > 0.5;
  }

  /** Roll hit outcome: miss → dodge → crit → normal */
  private rollOutcome(attacker: Targetable, target: Targetable, canDodge = true): 'miss' | 'dodge' | 'crit' | 'normal' {
    const roll = Math.random();
    if (roll < CombatSystem.MISS_CHANCE) return 'miss';
    // Can only dodge if facing the attacker (and dodge is allowed — abilities disable this)
    if (canDodge) {
      const targetFacingAttacker = this.isFacing(
        target.mesh.position, target.mesh.rotation.y, attacker.mesh.position
      );
      const targetStunned = this.buffSystem.isStunned(target);
      if (targetFacingAttacker && !targetStunned && roll < CombatSystem.MISS_CHANCE + target.dodgeChance) return 'dodge';
    }
    // Resting targets are always crit
    if (this.buffSystem.hasBuff(target, 'resting')) return 'crit';
    if (Math.random() < attacker.critChance) return 'crit';
    return 'normal';
  }

  /** Roll miss check only (for channel start). Returns true if the attack misses. */
  rollMiss(): boolean {
    return Math.random() < CombatSystem.MISS_CHANCE;
  }

  private getDistance(a: THREE.Vector3, b: THREE.Vector3): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  update(dt: number): void {
    for (const [id, cd] of this.cooldowns) {
      const next = cd.remaining - dt;
      if (next <= 0) {
        this.cooldowns.delete(id);
      } else {
        cd.remaining = next;
      }
    }

    for (const [entity, remaining] of this.combatTimers) {
      if (entity.dead) {
        this.combatTimers.delete(entity);
        continue;
      }
      const next = remaining - dt;
      if (next <= 0) {
        this.combatTimers.delete(entity);
        entity.inCombat = false;
        this.onLeaveCombat?.(entity);
      } else {
        this.combatTimers.set(entity, next);
      }
    }
  }

  getCooldownRemaining(abilityId: string): number {
    return this.cooldowns.get(abilityId)?.remaining ?? 0;
  }

  getCooldownTotal(abilityId: string): number {
    return this.cooldowns.get(abilityId)?.total ?? 0;
  }

  clearCooldowns(): void {
    this.cooldowns.clear();
  }

  leaveCombat(entity: Targetable): void {
    const wasInCombat = entity.inCombat;
    entity.inCombat = false;
    this.combatTimers.delete(entity);
    if (wasInCombat) {
      this.onLeaveCombat?.(entity);
    }
  }

  validateAbility(
    ability: Ability,
    attacker: Targetable,
    attackerRotY: number,
    target: Targetable | null
  ): CombatResult {
    if (attacker.dead) {
      return { success: false, error: 'dead', errorMessage: 'You are dead' };
    }
    if (target?.dead && (ability.requiresHostileTarget || ability.requiresTarget)) {
      return { success: false, error: 'dead', errorMessage: 'Target is dead' };
    }
    if (this.buffSystem.isStunned(attacker)) {
      return { success: false, error: 'stunned', errorMessage: 'You are stunned' };
    }
    const isGod = this.godModeEntities.has(attacker);
    if (!isGod && this.cooldowns.has(ability.id)) {
      return { success: false, error: 'on-cooldown', errorMessage: 'Ability is not ready yet' };
    }
    if (ability.requiresHostileTarget) {
      if (!target || !target.isHostileTo(attacker)) {
        return { success: false, error: 'no-target', errorMessage: 'No hostile target' };
      }
    }
    if (!isGod) {
      const effectiveManaCost = Math.round(ability.manaCost * this.buffSystem.getManaCostMultiplier(attacker));
      if (attacker.mana < effectiveManaCost) {
        return { success: false, error: 'not-enough-mana', errorMessage: 'Not enough mana' };
      }
    }
    if (ability.requiresHostileTarget && target) {
      const dist = this.getDistance(attacker.mesh.position, target.mesh.position);
      if (dist > ability.range!) {
        return { success: false, error: 'out-of-range', errorMessage: 'Out of range' };
      }
      if (!this.collisionSystem.hasLineOfSight(
        attacker.mesh.position.x, attacker.mesh.position.z,
        target.mesh.position.x, target.mesh.position.z
      )) {
        return { success: false, error: 'not-in-los', errorMessage: 'Not in line of sight' };
      }
      if (!this.isFacing(attacker.mesh.position, attackerRotY, target.mesh.position)) {
        return { success: false, error: 'not-facing', errorMessage: 'Not facing target' };
      }
    }
    if (ability.requiresTarget && !ability.requiresHostileTarget) {
      if (!target) {
        return { success: false, error: 'no-target', errorMessage: 'No target' };
      }
      if (ability.range) {
        const dist = this.getDistance(attacker.mesh.position, target.mesh.position);
        if (dist > ability.range) {
          return { success: false, error: 'out-of-range', errorMessage: 'Out of range' };
        }
        if (!this.collisionSystem.hasLineOfSight(
          attacker.mesh.position.x, attacker.mesh.position.z,
          target.mesh.position.x, target.mesh.position.z
        )) {
          return { success: false, error: 'not-in-los', errorMessage: 'Not in line of sight' };
        }
      }
    }
    return { success: true };
  }

  useAbility(
    ability: Ability,
    attacker: Targetable,
    attackerRotY: number,
    target: Targetable | null
  ): CombatResult {
    const validation = this.validateAbility(ability, attacker, attackerRotY, target);
    if (!validation.success) return validation;

    // Success — apply effects
    if (!this.godModeEntities.has(attacker)) {
      const effectiveCost = Math.round(ability.manaCost * this.buffSystem.getManaCostMultiplier(attacker));
      attacker.mana -= effectiveCost;
      if (effectiveCost > 0) {
        this.regenSystem.notifyManaUsed(attacker);
      }
    }
    if (ability.requiresHostileTarget && target) {
      // Abilities cannot be dodged (only auto-attacks can)
      const outcome = this.rollOutcome(attacker, target, false);

      if (outcome === 'miss') {
        this.onCombatText?.(target, 0, 'miss');
      } else {
        // Calculate base damage (variable or flat)
        let baseDamage: number;
        if (ability.damageMin !== undefined && ability.damageMax !== undefined) {
          baseDamage = ability.damageMin + Math.floor(
            Math.random() * (ability.damageMax - ability.damageMin + 1)
          );
        } else {
          baseDamage = ability.damage;
        }

        // Apply conditional bonus damage
        if (ability.bonusDamagePercent && ability.bonusDamageRequiresDebuff) {
          if (this.buffSystem.hasDebuff(target, ability.bonusDamageRequiresDebuff)) {
            baseDamage = Math.round(baseDamage * (1 + ability.bonusDamagePercent / 100));
          }
        }

        // Apply attacker's damage dealt modifier (e.g. Retard Strength)
        let damageMult = this.buffSystem.getDamageDealtMultiplier(attacker);
        if (this.godModeEntities.has(attacker)) damageMult *= CombatSystem.GOD_MODE_DAMAGE_MULT;
        baseDamage = Math.round(baseDamage * damageMult);

        const multiplier = outcome === 'crit' ? 2 : 1;
        const damage = baseDamage * multiplier;
        const actualDamage = this.godModeEntities.has(target) ? 0 : this.processDamageAbsorb(target, damage, attacker);
        target.hp = Math.max(0, target.hp - actualDamage);
        if (damage > 0) {
          this.onDirectDamageDealt?.(target);
          this.onFlinchDamage?.(target);
        }
        if (actualDamage > 0) {
          this.onCombatText?.(target, actualDamage, outcome === 'crit' ? 'crit' : 'damage');
        }

        // Apply debuff only on hit
        if (ability.appliesDebuff) {
          this.buffSystem.apply(target, ability.appliesDebuff);
        }

        // Check for kill
        if (target.hp <= 0 && !target.dead) {
          target.die();
          this.combatTimers.delete(target);
        }
      }

      // Combat entry rules (regardless of outcome)
      if (target.isHostileTo(attacker)) {
        this.onHostileAction?.(attacker, target);
        this.enterCombat(attacker);
        this.enterCombat(target);
      } else if (target.inCombat) {
        this.enterCombat(attacker);
      }
    }
    // Apply self buff
    if (ability.appliesSelfBuff) {
      this.buffSystem.apply(attacker, ability.appliesSelfBuff);
    }

    if (!this.godModeEntities.has(attacker)) {
      this.setCooldown(ability.id, ability.cooldown);
    }

    return { success: true };
  }

  hasLineOfSight(a: THREE.Vector3, b: THREE.Vector3): boolean {
    return this.collisionSystem.hasLineOfSight(a.x, a.z, b.x, b.z);
  }

  /** Apply sweep charge damage: can miss or crit, but CANNOT be dodged. */
  applySweepDamage(attacker: Targetable, target: Targetable, baseDamage: number): void {
    if (attacker.dead || target.dead) return;

    const roll = Math.random();
    this.onHostileAction?.(attacker, target);

    if (roll < CombatSystem.MISS_CHANCE) {
      this.onCombatText?.(target, 0, 'miss');
      this.enterCombat(attacker);
      this.enterCombat(target);
      return;
    }

    // Apply attacker's damage dealt modifier
    let damageMult = this.buffSystem.getDamageDealtMultiplier(attacker);
    if (this.godModeEntities.has(attacker)) damageMult *= CombatSystem.GOD_MODE_DAMAGE_MULT;
    const adjustedBase = Math.round(baseDamage * damageMult);

    const isCrit = Math.random() < attacker.critChance;
    const multiplier = isCrit ? 2 : 1;
    const damage = Math.round(adjustedBase * multiplier);
    const actualDamage = this.godModeEntities.has(target) ? 0 : this.processDamageAbsorb(target, damage, attacker);
    target.hp = Math.max(0, target.hp - actualDamage);
    if (damage > 0) {
      this.onDirectDamageDealt?.(target);
      this.onFlinchDamage?.(target);
    }
    if (actualDamage > 0) {
      this.onCombatText?.(target, actualDamage, isCrit ? 'crit' : 'damage');
    }

    this.enterCombat(attacker);
    this.enterCombat(target);

    if (target.hp <= 0 && !target.dead) {
      target.die();
      this.combatTimers.delete(target);
    }
  }

  setCooldown(abilityId: string, duration: number): void {
    if (duration > 0) {
      this.cooldowns.set(abilityId, { remaining: duration, total: duration });
    }
  }

  clearCooldown(abilityId: string): void {
    this.cooldowns.delete(abilityId);
  }

  /** Channel ticks cannot miss or be dodged; each tick rolls crit independently.
   *  damageMultiplier is a snapshotted multiplier from buffs at channel start. */
  applyChannelTickDamage(attacker: Targetable, target: Targetable, tickDamage: number, damageMultiplier = 1): void {
    if (attacker.dead || target.dead) return;

    this.onHostileAction?.(attacker, target);
    const godMult = this.godModeEntities.has(attacker) ? CombatSystem.GOD_MODE_DAMAGE_MULT : 1;
    const adjustedTick = Math.round(tickDamage * damageMultiplier * godMult);
    const isCrit = Math.random() < attacker.critChance;
    const mult = isCrit ? 2 : 1;
    const damage = Math.round(adjustedTick * mult);
    const actualDamage = this.godModeEntities.has(target) ? 0 : this.processDamageAbsorb(target, damage, attacker);
    target.hp = Math.max(0, target.hp - actualDamage);
    if (damage > 0) {
      this.onDirectDamageDealt?.(target);
    }
    if (actualDamage > 0) {
      this.onCombatText?.(target, actualDamage, isCrit ? 'crit' : 'damage');
    }
    if (target.hp <= 0 && !target.dead) {
      target.die();
      this.combatTimers.delete(target);
    }

    this.enterCombat(attacker);
    this.enterCombat(target);
  }

  /** Process damage through shields. Returns actual HP damage. Handles reflection. */
  processDamageAbsorb(target: Targetable, damage: number, attacker: Targetable | null): number {
    const { remaining, reflectDamage } = this.buffSystem.absorbDamage(target, damage);
    if (reflectDamage > 0 && attacker && !attacker.dead && !this.godModeEntities.has(attacker)) {
      attacker.hp = Math.max(0, attacker.hp - reflectDamage);
      this.onCombatText?.(attacker, reflectDamage, 'damage');
      this.enterCombat(attacker);
      if (attacker.hp <= 0 && !attacker.dead) {
        attacker.die();
        this.combatTimers.delete(attacker);
      }
    }
    return remaining;
  }

  applyHeal(target: Targetable, healAmount: number): void {
    if (target.dead) return;
    target.hp = Math.min(target.maxHp, target.hp + healAmount);
    this.onCombatText?.(target, healAmount, 'heal');
  }

  applyAutoAttackDamage(attacker: Targetable, target: Targetable, baseDamage: number): void {
    if (attacker.dead || target.dead) return;

    this.onHostileAction?.(attacker, target);
    const outcome = this.rollOutcome(attacker, target);

    if (outcome === 'miss') {
      this.onCombatText?.(target, 0, 'miss');
    } else if (outcome === 'dodge') {
      this.onCombatText?.(target, 0, 'dodge');
    } else {
      const critMult = outcome === 'crit' ? 2 : 1;
      const buffMult = this.buffSystem.getAutoAttackDamageTakenMultiplier(target);
      let damageMult = this.buffSystem.getDamageDealtMultiplier(attacker);
      if (this.godModeEntities.has(attacker)) damageMult *= CombatSystem.GOD_MODE_DAMAGE_MULT;
      const damage = Math.round(baseDamage * buffMult * damageMult * critMult);
      const actualDamage = this.godModeEntities.has(target) ? 0 : this.processDamageAbsorb(target, damage, attacker);
      target.hp = Math.max(0, target.hp - actualDamage);
      if (damage > 0) {
        this.onDirectDamageDealt?.(target);
        this.onFlinchDamage?.(target);
      }
      if (actualDamage > 0) {
        this.onCombatText?.(target, actualDamage, outcome === 'crit' ? 'crit' : 'damage');
      }
      if (target.hp <= 0 && !target.dead) {
        target.die();
        this.combatTimers.delete(target);
      }
    }

    // Auto-attacks are always hostile actions — both parties enter combat
    this.enterCombat(attacker);
    this.enterCombat(target);
  }
}
