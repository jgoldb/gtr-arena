/**
 * HeadlessCombat — port of client CombatSystem using plain math.
 * No Three.js dependency. Operates on HeadlessEntity positions directly.
 */

import {
  type Ability,
  type CombatResult,
  type CombatTextType,
  COMBAT_DURATION,
  MISS_CHANCE,
  rollAbilityBaseDamage,
  applyBonusDamage,
  isFacingCheck,
  JimmyLegdDebuff,
  type BuffSystem,
} from '@gtr/shared';
import type { HeadlessEntity } from './HeadlessEntity.js';

export class HeadlessCombat {
  private combatTimers = new Map<HeadlessEntity, number>();
  private buffSystem: BuffSystem<HeadlessEntity>;

  // Callbacks (optional, for reward tracking)
  onDeath?: (victim: HeadlessEntity, killer: HeadlessEntity | null) => void;
  onDamageDealt?: (attacker: HeadlessEntity, target: HeadlessEntity, amount: number) => void;
  onHealDone?: (healer: HeadlessEntity, target: HeadlessEntity, amount: number) => void;
  /** Fires on any direct damage (abilities, auto-attacks, channels, AoE) — used for cast pushback. */
  onDirectDamageDealt?: (target: HeadlessEntity) => void;
  /** LoS check between two entities (provided by arena collision system). */
  hasLineOfSight?: (a: HeadlessEntity, b: HeadlessEntity) => boolean;

  constructor(buffSystem: BuffSystem<HeadlessEntity>) {
    this.buffSystem = buffSystem;
  }

  // ── Facing / Distance ──────────────────────────────────────────────

  private isFacing(attacker: HeadlessEntity, target: HeadlessEntity): boolean {
    return isFacingCheck(
      Math.sin(attacker.rotY), Math.cos(attacker.rotY),
      target.x - attacker.x, target.z - attacker.z,
    );
  }

  private isBehind(attacker: HeadlessEntity, target: HeadlessEntity): boolean {
    const dx = attacker.x - target.x;
    const dz = attacker.z - target.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.001) return false;
    const forwardX = Math.sin(target.rotY);
    const forwardZ = Math.cos(target.rotY);
    const dot = forwardX * (dx / len) + forwardZ * (dz / len);
    return dot < 0;
  }

  private distance(a: HeadlessEntity, b: HeadlessEntity): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  // ── Rolls ─���────────────────────────���───────────────────────────────

  private rollOutcome(attacker: HeadlessEntity, target: HeadlessEntity, canDodge: boolean):
    'miss' | 'dodge' | 'crit' | 'normal' {
    const roll = Math.random();
    if (roll < MISS_CHANCE) return 'miss';
    if (canDodge) {
      const targetFacing = this.isFacing(target, attacker);
      const targetStunned = this.buffSystem.isStunned(target);
      if (targetFacing && !targetStunned && roll < MISS_CHANCE + target.dodgeChance) return 'dodge';
    }
    if (this.buffSystem.hasBuff(target, 'resting')) return 'crit';
    if (Math.random() < attacker.critChance) return 'crit';
    return 'normal';
  }

  // ── Damage Processing ─���────────────────────────────────────────────

  processDamageAbsorb(target: HeadlessEntity, damage: number, attacker: HeadlessEntity | null): number {
    const damageTakenMult = this.buffSystem.getDamageTakenMultiplier(target);
    damage = Math.round(damage * damageTakenMult);
    const { remaining, reflectDamage } = this.buffSystem.absorbDamage(target, damage);
    if (reflectDamage > 0 && attacker && !attacker.dead) {
      attacker.hp = Math.max(0, attacker.hp - reflectDamage);
      if (attacker.hp <= 0 && !attacker.dead) {
        attacker.die();
        this.combatTimers.delete(attacker);
        this.onDeath?.(attacker, target);
      }
    }
    return remaining;
  }

  // ── Combat State ───────────────────────────────────────────────────

  enterCombat(entity: HeadlessEntity): void {
    if (entity.dead) return;
    entity.inCombat = true;
    this.combatTimers.set(entity, COMBAT_DURATION);
  }

  update(dt: number): void {
    for (const [entity, remaining] of this.combatTimers) {
      if (entity.dead) {
        this.combatTimers.delete(entity);
        continue;
      }
      const next = remaining - dt;
      if (next <= 0) {
        this.combatTimers.delete(entity);
        entity.inCombat = false;
      } else {
        this.combatTimers.set(entity, next);
      }
    }
  }

  // ── Ability Validation ─────────────────────────────────────────────

  validateAbility(
    ability: Ability,
    attacker: HeadlessEntity,
    target: HeadlessEntity | null,
  ): CombatResult {
    if (attacker.dead) return { success: false, error: 'dead' };
    if (target?.dead && (ability.requiresHostileTarget || ability.requiresTarget)) {
      return { success: false, error: 'dead' };
    }
    if (target && this.buffSystem.isUntargetable(target) && (ability.requiresHostileTarget || ability.requiresTarget)) {
      return { success: false, error: 'no-target' };
    }
    if (!ability.usableWhileCCd && this.buffSystem.isStunned(attacker)) {
      return { success: false, error: 'stunned' };
    }
    if (ability.id !== 'crack-rock' && this.buffSystem.hasBuff(attacker, 'dumpster-diving')) {
      return { success: false, error: 'locked' };
    }
    // Cooldown check via entity tracker
    if (!attacker.cooldowns.isReady(ability.id)) {
      return { success: false, error: 'on-cooldown' };
    }
    // Mana check
    const effectiveCost = Math.round(ability.manaCost * this.buffSystem.getManaCostMultiplier(attacker));
    if (attacker.mana < effectiveCost) {
      return { success: false, error: 'not-enough-mana' };
    }
    if (ability.requiresHostileTarget) {
      if (!target || !target.isHostileTo(attacker)) {
        return { success: false, error: 'no-target' };
      }
      const dist = this.distance(attacker, target);
      if (ability.range && dist > ability.range) {
        return { success: false, error: 'out-of-range' };
      }
      if (ability.minRange && dist < ability.minRange) {
        return { success: false, error: 'out-of-range' };
      }
      if (ability.requiresFacing !== false && !this.isFacing(attacker, target)) {
        return { success: false, error: 'not-facing' };
      }
      if (this.hasLineOfSight && !this.hasLineOfSight(attacker, target)) {
        return { success: false, error: 'not-in-los' };
      }
    }
    if (ability.requiresTarget && !ability.requiresHostileTarget) {
      if (!target) return { success: false, error: 'no-target' };
      if (ability.range && attacker !== target) {
        if (this.distance(attacker, target) > ability.range) {
          return { success: false, error: 'out-of-range' };
        }
      }
    }
    if (ability.blockedByTargetDebuff && target && this.buffSystem.hasDebuff(target, ability.blockedByTargetDebuff)) {
      return { success: false, error: 'no-target' };
    }
    return { success: true };
  }

  // ── Use Ability ────────────��───────────────────────────────────────

  useAbility(
    ability: Ability,
    attacker: HeadlessEntity,
    target: HeadlessEntity | null,
  ): CombatResult {
    const validation = this.validateAbility(ability, attacker, target);
    if (!validation.success) return validation;

    // Deduct mana
    const effectiveCost = Math.round(ability.manaCost * this.buffSystem.getManaCostMultiplier(attacker));
    attacker.mana -= effectiveCost;

    // Hostile damage
    if (ability.requiresHostileTarget && target) {
      const outcome = this.rollOutcome(attacker, target, !!ability.isMelee);

      if (outcome !== 'miss' && outcome !== 'dodge') {
        let baseDamage = rollAbilityBaseDamage(ability);
        baseDamage = applyBonusDamage(baseDamage, ability,
          !!ability.bonusDamageRequiresDebuff && this.buffSystem.hasDebuff(target, ability.bonusDamageRequiresDebuff));

        // Shank: 50% bonus from behind
        if (ability.id === 'shank' && this.isBehind(attacker, target)) {
          baseDamage = Math.round(baseDamage * 1.5);
        }

        const damageMult = this.buffSystem.getDamageDealtMultiplier(attacker);
        baseDamage = Math.round(baseDamage * damageMult);

        const multiplier = outcome === 'crit' ? 2 : 1;
        const damage = baseDamage * multiplier;
        const actualDamage = this.processDamageAbsorb(target, damage, attacker);
        target.hp = Math.max(0, target.hp - actualDamage);

        if (actualDamage > 0) {
          this.onDamageDealt?.(attacker, target, actualDamage);
          this.onDirectDamageDealt?.(target);
        }

        // Wake sleeping targets
        if (this.buffSystem.isSleeping(target)) {
          this.buffSystem.removeSleepEffects(target);
        }

        // Apply debuff on hit
        if (ability.appliesDebuff) {
          this.buffSystem.apply(target, ability.appliesDebuff);
        }

        // Jimmy Legs double-apply
        if (ability.id === 'jimmy-legs' && this.buffSystem.hasDebuff(target, 'jimmy-legs')) {
          this.buffSystem.apply(target, JimmyLegdDebuff);
        }

        // Death check
        if (target.hp <= 0 && !target.dead) {
          target.die();
          this.combatTimers.delete(target);
          this.onDeath?.(target, attacker);
        }
      }

      this.enterCombat(attacker);
      this.enterCombat(target);
    }

    // Self buff
    if (ability.appliesSelfBuff) {
      this.buffSystem.apply(attacker, ability.appliesSelfBuff);
    }

    // Cooldown + GCD
    attacker.cooldowns.setCooldown(ability.id, ability.cooldown);
    attacker.cooldowns.triggerGcd();

    return { success: true };
  }

  // ── Auto-attack damage ─────────────────────────────��───────────────

  applyAutoAttackDamage(attacker: HeadlessEntity, target: HeadlessEntity, baseDamage: number, canDodge = true): boolean {
    if (attacker.dead || target.dead) return false;
    if (this.buffSystem.isUntargetable(target)) return false;

    const outcome = this.rollOutcome(attacker, target, canDodge);
    if (outcome === 'miss' || outcome === 'dodge') {
      this.enterCombat(attacker);
      this.enterCombat(target);
      return false;
    }

    const critMult = outcome === 'crit' ? 2 : 1;
    const buffMult = this.buffSystem.getAutoAttackDamageTakenMultiplier(target);
    const damageMult = this.buffSystem.getDamageDealtMultiplier(attacker);
    const damage = Math.round(baseDamage * buffMult * damageMult * critMult);
    const actualDamage = this.processDamageAbsorb(target, damage, attacker);
    target.hp = Math.max(0, target.hp - actualDamage);

    if (actualDamage > 0) {
      this.onDamageDealt?.(attacker, target, actualDamage);
      this.onDirectDamageDealt?.(target);
    }

    // Wake sleeping targets
    if (this.buffSystem.isSleeping(target)) {
      this.buffSystem.removeSleepEffects(target);
    }

    if (target.hp <= 0 && !target.dead) {
      target.die();
      this.combatTimers.delete(target);
      this.onDeath?.(target, attacker);
    }

    this.enterCombat(attacker);
    this.enterCombat(target);
    return outcome === 'crit';
  }

  // ── Channel tick damage ───────────���────────────────────────────────

  applyChannelTickDamage(attacker: HeadlessEntity, target: HeadlessEntity, tickDamage: number, damageMultiplier = 1): void {
    if (attacker.dead || target.dead) return;

    const adjustedTick = Math.round(tickDamage * damageMultiplier);
    const isCrit = Math.random() < attacker.critChance;
    const damage = Math.round(adjustedTick * (isCrit ? 2 : 1));
    const actualDamage = this.processDamageAbsorb(target, damage, attacker);
    target.hp = Math.max(0, target.hp - actualDamage);

    if (actualDamage > 0) {
      this.onDamageDealt?.(attacker, target, actualDamage);
      this.onDirectDamageDealt?.(target);
    }

    if (target.hp <= 0 && !target.dead) {
      target.die();
      this.combatTimers.delete(target);
      this.onDeath?.(target, attacker);
    }

    this.enterCombat(attacker);
    this.enterCombat(target);
  }

  // ── Sweep damage ───────────────────────────────────────────────────

  applySweepDamage(attacker: HeadlessEntity, target: HeadlessEntity, baseDamage: number): void {
    if (attacker.dead || target.dead) return;

    const outcome = this.rollOutcome(attacker, target, true);
    if (outcome === 'miss' || outcome === 'dodge') {
      this.enterCombat(attacker);
      this.enterCombat(target);
      return;
    }

    const damageMult = this.buffSystem.getDamageDealtMultiplier(attacker);
    const adjusted = Math.round(baseDamage * damageMult);
    const damage = Math.round(adjusted * (outcome === 'crit' ? 2 : 1));
    const actualDamage = this.processDamageAbsorb(target, damage, attacker);
    target.hp = Math.max(0, target.hp - actualDamage);

    if (actualDamage > 0) {
      this.onDamageDealt?.(attacker, target, actualDamage);
      this.onDirectDamageDealt?.(target);
    }

    this.enterCombat(attacker);
    this.enterCombat(target);

    if (target.hp <= 0 && !target.dead) {
      target.die();
      this.combatTimers.delete(target);
      this.onDeath?.(target, attacker);
    }
  }

  // ── AoE damage ─────────────────────────────────────────────────────

  applyAoeDamage(attacker: HeadlessEntity, target: HeadlessEntity, ability: Ability): void {
    if (attacker.dead || target.dead) return;

    const outcome = this.rollOutcome(attacker, target, !!ability.isMelee);
    if (outcome === 'miss' || outcome === 'dodge') {
      this.enterCombat(attacker);
      this.enterCombat(target);
      return;
    }

    let baseDamage = rollAbilityBaseDamage(ability);
    const damageMult = this.buffSystem.getDamageDealtMultiplier(attacker);
    baseDamage = Math.round(baseDamage * damageMult);
    const damage = baseDamage * (outcome === 'crit' ? 2 : 1);
    const actualDamage = this.processDamageAbsorb(target, damage, attacker);
    target.hp = Math.max(0, target.hp - actualDamage);

    if (actualDamage > 0) {
      this.onDamageDealt?.(attacker, target, actualDamage);
      this.onDirectDamageDealt?.(target);
    }

    if (ability.appliesDebuff) {
      this.buffSystem.apply(target, ability.appliesDebuff);
    }

    this.enterCombat(attacker);
    this.enterCombat(target);

    if (target.hp <= 0 && !target.dead) {
      target.die();
      this.combatTimers.delete(target);
      this.onDeath?.(target, attacker);
    }
  }

  // ── Heal ────────��──────────────────────────────────────────────────

  applyHeal(target: HeadlessEntity, healAmount: number, source?: HeadlessEntity): void {
    if (target.dead) return;
    const actual = Math.min(healAmount, target.maxHp - target.hp);
    target.hp = Math.min(target.maxHp, target.hp + healAmount);
    if (actual > 0 && source) {
      this.onHealDone?.(source, target, actual);
    }
  }

  clearEntity(entity: HeadlessEntity): void {
    this.combatTimers.delete(entity);
  }
}
