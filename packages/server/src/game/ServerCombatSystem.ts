import type { Ability } from '@gtr/shared';
import { yardsToUnits, JimmyLegdDebuff, type CombatError, type CombatResult, type CombatTextType, COMBAT_DURATION, MISS_CHANCE, GOD_MODE_DAMAGE_MULT, rollAbilityBaseDamage, applyBonusDamage, isFacingCheck } from '@gtr/shared';
import type { ServerEntity } from './ServerEntity.js';
import type { ServerBuffSystem } from './ServerBuffSystem.js';
import type { ServerRegenSystem } from './ServerRegenSystem.js';
import type { CollisionSystem } from './ServerMapManager.js';

export type { CombatError, CombatResult, CombatTextType };

export class ServerCombatSystem {
  private cooldowns = new Map<string, Map<string, { remaining: number; total: number }>>(); // entityId -> (abilityId -> cooldown)
  private gcds = new Map<string, { remaining: number; total: number }>(); // entityId -> GCD state
  // Range tolerance for residual latency (sub-tick timing, interpolation granularity).
  // Reduced from 2 yards now that server-side position rewind handles the bulk of lag compensation.
  private static readonly RANGE_TOLERANCE = yardsToUnits(1);
  private combatTimers = new Map<ServerEntity, number>();
  private regenSystem: ServerRegenSystem;
  private buffSystem: ServerBuffSystem;
  private collision: CollisionSystem;

  onCombatText?: (source: ServerEntity, target: ServerEntity, amount: number, type: CombatTextType, ability?: Ability, isAutoAttack?: boolean) => void;
  onDirectDamageDealt?: (target: ServerEntity) => void;
  onFlinchDamage?: (target: ServerEntity) => void;
  onSleepApplied?: (attacker: ServerEntity, target: ServerEntity) => void;
  onBlindApplied?: (attacker: ServerEntity, target: ServerEntity) => void;
  onEntityKilled?: (killer: ServerEntity, victim: ServerEntity) => void;

  constructor(regenSystem: ServerRegenSystem, buffSystem: ServerBuffSystem, collision: CollisionSystem) {
    this.regenSystem = regenSystem;
    this.buffSystem = buffSystem;
    this.collision = collision;
  }

  enterCombat(entity: ServerEntity): void {
    if (entity.dead) return;
    entity.inCombat = true;
    this.combatTimers.set(entity, COMBAT_DURATION);
  }

  private isFacing(ax: number, az: number, aRotY: number, tx: number, tz: number): boolean {
    return isFacingCheck(Math.sin(aRotY), Math.cos(aRotY), tx - ax, tz - az);
  }

  private rollOutcome(attacker: ServerEntity, target: ServerEntity, canDodge = true): 'miss' | 'dodge' | 'crit' | 'normal' {
    const roll = Math.random();
    if (roll < MISS_CHANCE) return 'miss';
    if (canDodge) {
      const targetFacing = this.isFacing(target.x, target.z, target.rotationY, attacker.x, attacker.z);
      const targetStunned = this.buffSystem.isStunned(target);
      if (targetFacing && !targetStunned && roll < MISS_CHANCE + target.dodgeChance) return 'dodge';
    }
    // Resting targets are always crit
    if (this.buffSystem.hasBuff(target, 'resting')) return 'crit';
    if (Math.random() < attacker.critChance) return 'crit';
    return 'normal';
  }

  rollMiss(): boolean {
    return Math.random() < MISS_CHANCE;
  }

  private getDistance(ax: number, az: number, bx: number, bz: number, ay = 0, by = 0): number {
    const dx = ax - bx;
    const dy = ay - by;
    const dz = az - bz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  update(dt: number): void {
    // Update per-entity GCDs
    for (const [entityId, gcd] of this.gcds) {
      gcd.remaining -= dt;
      if (gcd.remaining <= 0) this.gcds.delete(entityId);
    }

    // Update per-entity cooldowns
    for (const [entityId, cds] of this.cooldowns) {
      for (const [abilityId, cd] of cds) {
        const next = cd.remaining - dt;
        if (next <= 0) {
          cds.delete(abilityId);
        } else {
          cd.remaining = next;
        }
      }
      if (cds.size === 0) this.cooldowns.delete(entityId);
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
      } else {
        this.combatTimers.set(entity, next);
      }
    }
  }

  getCooldownRemaining(entityId: string, abilityId: string): number {
    return this.cooldowns.get(entityId)?.get(abilityId)?.remaining ?? 0;
  }

  getCooldownTotal(entityId: string, abilityId: string): number {
    return this.cooldowns.get(entityId)?.get(abilityId)?.total ?? 0;
  }

  setCooldown(entityId: string, abilityId: string, duration: number): void {
    if (duration <= 0) return;
    let cds = this.cooldowns.get(entityId);
    if (!cds) {
      cds = new Map();
      this.cooldowns.set(entityId, cds);
    }
    cds.set(abilityId, { remaining: duration, total: duration });
  }

  clearCooldown(entityId: string, abilityId: string): void {
    this.cooldowns.get(entityId)?.delete(abilityId);
  }

  clearAllCooldowns(entityId: string): void {
    this.cooldowns.delete(entityId);
    this.gcds.delete(entityId);
  }

  /** Returns all active cooldowns across all entities (for rejoin sync). */
  getAllCooldowns(): { entityId: string; abilityId: string; remaining: number; total: number }[] {
    const result: { entityId: string; abilityId: string; remaining: number; total: number }[] = [];
    for (const [entityId, cds] of this.cooldowns) {
      for (const [abilityId, cd] of cds) {
        result.push({ entityId, abilityId, remaining: cd.remaining, total: cd.total });
      }
    }
    // Include GCDs as well (using special '__gcd__' key)
    for (const [entityId, gcd] of this.gcds) {
      result.push({ entityId, abilityId: '__gcd__', remaining: gcd.remaining, total: gcd.total });
    }
    return result;
  }

  triggerGcd(entityId: string, duration: number): void {
    this.gcds.set(entityId, { remaining: duration, total: duration });
  }

  getGcdRemaining(entityId: string): number {
    return this.gcds.get(entityId)?.remaining ?? 0;
  }

  getGcdTotal(entityId: string): number {
    return this.gcds.get(entityId)?.total ?? 0;
  }

  leaveCombat(entity: ServerEntity): void {
    entity.inCombat = false;
    this.combatTimers.delete(entity);
  }

  hasLineOfSight(ax: number, az: number, bx: number, bz: number, ay?: number, by?: number): boolean {
    return this.collision.hasLineOfSight(ax, az, bx, bz, ay, by);
  }

  validateAbility(
    ability: Ability,
    attacker: ServerEntity,
    target: ServerEntity | null,
    targetPosOverride?: { x: number; z: number; rotationY: number }
  ): CombatResult {
    if (attacker.dead) {
      return { success: false, error: 'dead', errorMessage: 'You are dead' };
    }
    if (target?.dead && (ability.requiresHostileTarget || ability.requiresTarget)) {
      return { success: false, error: 'dead', errorMessage: 'Target is dead' };
    }
    if (target && this.buffSystem.isUntargetable(target) && (ability.requiresHostileTarget || ability.requiresTarget)) {
      return { success: false, error: 'no-target', errorMessage: 'Target is untargetable' };
    }
    if (!ability.usableWhileCCd && this.buffSystem.isStunned(attacker)) {
      return { success: false, error: 'stunned', errorMessage: 'You are stunned' };
    }
    if (ability.id !== 'crack-rock' && this.buffSystem.hasBuff(attacker, 'dumpster-diving')) {
      return { success: false, error: 'locked', errorMessage: 'Cannot use while Dumpster Diving' };
    }
    if (!attacker.godMode && this.getCooldownRemaining(attacker.id, ability.id) > 0) {
      return { success: false, error: 'on-cooldown', errorMessage: 'Ability is not ready yet' };
    }
    if (ability.requiresHostileTarget) {
      if (!target || !target.isHostileTo(attacker)) {
        return { success: false, error: 'no-target', errorMessage: 'No hostile target' };
      }
    }
    if (ability.requiresFriendlyTarget && target && target !== attacker && target.isHostileTo(attacker)) {
      return { success: false, error: 'no-target', errorMessage: 'Must target a friendly player' };
    }
    if (ability.blockedByTargetDebuff && target && this.buffSystem.hasDebuff(target, ability.blockedByTargetDebuff)) {
      return { success: false, error: 'no-target', errorMessage: 'Target has Recently Bandaged' };
    }
    if (!attacker.godMode) {
      const effectiveManaCost = Math.round(ability.manaCost * this.buffSystem.getManaCostMultiplier(attacker));
      if (attacker.mana < effectiveManaCost) {
        return { success: false, error: 'not-enough-mana', errorMessage: 'Not enough mana' };
      }
    }
    if (ability.requiresHostileTarget && target) {
      // Use rewound target position for range/facing/LoS if available (lag compensation)
      const tx = targetPosOverride?.x ?? target.x;
      const tz = targetPosOverride?.z ?? target.z;
      if (!this.collision.hasLineOfSight(attacker.x, attacker.z, tx, tz, attacker.y, target!.y)) {
        return { success: false, error: 'not-in-los', errorMessage: 'Not in line of sight' };
      }
      const dist = this.getDistance(attacker.x, attacker.z, tx, tz, attacker.y, target!.y);
      if (dist > ability.range! + ServerCombatSystem.RANGE_TOLERANCE) {
        return { success: false, error: 'out-of-range', errorMessage: 'Out of range' };
      }
      if (ability.minRange && dist < ability.minRange) {
        return { success: false, error: 'out-of-range', errorMessage: 'Too close' };
      }
      if (ability.requiresFacing !== false && !this.isFacing(attacker.x, attacker.z, attacker.rotationY, tx, tz)) {
        return { success: false, error: 'not-facing', errorMessage: 'Not facing target' };
      }
    }
    if (ability.requiresTarget && !ability.requiresHostileTarget) {
      if (!target) {
        return { success: false, error: 'no-target', errorMessage: 'No target' };
      }
      if (ability.range && attacker !== target) {
        const tx = targetPosOverride?.x ?? target.x;
        const tz = targetPosOverride?.z ?? target.z;
        if (!this.collision.hasLineOfSight(attacker.x, attacker.z, tx, tz, attacker.y, target!.y)) {
          return { success: false, error: 'not-in-los', errorMessage: 'Not in line of sight' };
        }
        const dist = this.getDistance(attacker.x, attacker.z, tx, tz, attacker.y, target!.y);
        if (dist > ability.range + ServerCombatSystem.RANGE_TOLERANCE) {
          return { success: false, error: 'out-of-range', errorMessage: 'Out of range' };
        }
      }
    }
    return { success: true };
  }

  useAbility(
    ability: Ability,
    attacker: ServerEntity,
    target: ServerEntity | null,
    targetPosOverride?: { x: number; z: number; rotationY: number }
  ): CombatResult {
    const validation = this.validateAbility(ability, attacker, target, targetPosOverride);
    if (!validation.success) return validation;

    if (!attacker.godMode) {
      const effectiveCost = Math.round(ability.manaCost * this.buffSystem.getManaCostMultiplier(attacker));
      attacker.mana -= effectiveCost;
      if (effectiveCost > 0) {
        this.regenSystem.notifyManaUsed(attacker);
      }
    }

    if (ability.requiresHostileTarget && target) {
      const outcome = this.rollOutcome(attacker, target, !!ability.isMelee);

      if (outcome === 'miss' || outcome === 'dodge') {
        this.onCombatText?.(attacker, target, 0, outcome, ability);
      } else {
        let baseDamage = rollAbilityBaseDamage(ability);
        baseDamage = applyBonusDamage(baseDamage, ability,
          !!ability.bonusDamageRequiresDebuff && this.buffSystem.hasDebuff(target, ability.bonusDamageRequiresDebuff));

        let damageMult = this.buffSystem.getDamageDealtMultiplier(attacker);
        if (attacker.godMode) damageMult *= GOD_MODE_DAMAGE_MULT;
        baseDamage = Math.round(baseDamage * damageMult);

        const multiplier = outcome === 'crit' ? 2 : 1;
        const damage = baseDamage * multiplier;
        const actualDamage = target.godMode ? 0 : this.processDamageAbsorb(target, damage, attacker);
        target.hp = Math.max(0, target.hp - actualDamage);
        if (damage > 0) {
          this.onDirectDamageDealt?.(target);
          this.onFlinchDamage?.(target);
        }
        if (actualDamage > 0) {
          this.onCombatText?.(attacker, target, actualDamage, outcome === 'crit' ? 'crit' : 'damage', ability);
        } else if (damage === 0) {
          // 0-damage hostile ability (e.g. debuff-only) — still notify for auto-targeting
          this.onCombatText?.(attacker, target, 0, 'damage', ability);
        }

        // Jimmy Legs: if target already has it, also immobilize
        if (ability.id === 'jimmy-legs' && this.buffSystem.hasDebuff(target, 'jimmy-legs')) {
          if (!this.buffSystem.apply(target, JimmyLegdDebuff)) {
            this.onCombatText?.(attacker, target, 0, 'immune', ability);
          }
        }

        if (ability.appliesDebuff) {
          if (!this.buffSystem.apply(target, ability.appliesDebuff)) {
            this.onCombatText?.(attacker, target, 0, 'immune', ability);
          } else {
            if (ability.appliesDebuff.effects.some(e => e.type === 'sleep')) {
              this.onSleepApplied?.(attacker, target);
            }
            if (ability.appliesDebuff.effects.some(e => e.type === 'blind')) {
              this.onBlindApplied?.(attacker, target);
            }
          }
        }

        if (target.hp <= 0 && !target.dead) {
          target.die();
          this.combatTimers.delete(target);
          this.onEntityKilled?.(attacker, target);
        }
      }

      if (target.isHostileTo(attacker)) {
        this.enterCombat(attacker);
        this.enterCombat(target);
      } else if (target.inCombat) {
        this.enterCombat(attacker);
      }
    }

    if (ability.appliesSelfBuff) {
      this.buffSystem.apply(attacker, ability.appliesSelfBuff);
    }

    if (!attacker.godMode) {
      this.setCooldown(attacker.id, ability.id, ability.cooldown);
    }
    return { success: true };
  }

  applySweepDamage(attacker: ServerEntity, target: ServerEntity, baseDamage: number): void {
    if (attacker.dead || target.dead) return;

    const outcome = this.rollOutcome(attacker, target, true);
    if (outcome === 'miss' || outcome === 'dodge') {
      this.onCombatText?.(attacker, target, 0, outcome);
      this.enterCombat(attacker);
      this.enterCombat(target);
      return;
    }

    let damageMult = this.buffSystem.getDamageDealtMultiplier(attacker);
    if (attacker.godMode) damageMult *= GOD_MODE_DAMAGE_MULT;
    const adjustedBase = Math.round(baseDamage * damageMult);
    const multiplier = outcome === 'crit' ? 2 : 1;
    const damage = Math.round(adjustedBase * multiplier);
    const actualDamage = target.godMode ? 0 : this.processDamageAbsorb(target, damage, attacker);
    target.hp = Math.max(0, target.hp - actualDamage);
    if (damage > 0) {
      this.onDirectDamageDealt?.(target);
      this.onFlinchDamage?.(target);
    }
    if (actualDamage > 0) {
      this.onCombatText?.(attacker, target, actualDamage, outcome === 'crit' ? 'crit' : 'damage');
    }

    this.enterCombat(attacker);
    this.enterCombat(target);

    if (target.hp <= 0 && !target.dead) {
      target.die();
      this.combatTimers.delete(target);
      this.onEntityKilled?.(attacker, target);
    }
  }

  /** Apply AoE ability damage to a single target (called per-target in the AoE). */
  applyAoeDamage(attacker: ServerEntity, target: ServerEntity, ability: Ability): void {
    if (attacker.dead || target.dead) return;

    const outcome = this.rollOutcome(attacker, target, !!ability.isMelee);
    if (outcome === 'miss' || outcome === 'dodge') {
      this.onCombatText?.(attacker, target, 0, outcome, ability);
      this.enterCombat(attacker);
      this.enterCombat(target);
      return;
    }

    let baseDamage = rollAbilityBaseDamage(ability);

    let damageMult = this.buffSystem.getDamageDealtMultiplier(attacker);
    if (attacker.godMode) damageMult *= GOD_MODE_DAMAGE_MULT;
    baseDamage = Math.round(baseDamage * damageMult);

    const isCrit = outcome === 'crit';
    const damage = baseDamage * (isCrit ? 2 : 1);
    const actualDamage = target.godMode ? 0 : this.processDamageAbsorb(target, damage, attacker);
    target.hp = Math.max(0, target.hp - actualDamage);
    if (damage > 0) {
      this.onDirectDamageDealt?.(target);
      this.onFlinchDamage?.(target);
    }
    if (actualDamage > 0) {
      this.onCombatText?.(attacker, target, actualDamage, isCrit ? 'crit' : 'damage', ability);
    }

    // Apply debuff on hit
    if (ability.appliesDebuff) {
      if (!this.buffSystem.apply(target, ability.appliesDebuff)) {
        this.onCombatText?.(attacker, target, 0, 'immune', ability);
      } else {
        if (ability.appliesDebuff.effects.some(e => e.type === 'sleep')) {
          this.onSleepApplied?.(attacker, target);
        }
        if (ability.appliesDebuff.effects.some(e => e.type === 'blind')) {
          this.onBlindApplied?.(attacker, target);
        }
      }
    }

    this.enterCombat(attacker);
    this.enterCombat(target);

    if (target.hp <= 0 && !target.dead) {
      target.die();
      this.combatTimers.delete(target);
      this.onEntityKilled?.(attacker, target);
    }
  }

  applyChannelTickDamage(attacker: ServerEntity, target: ServerEntity, tickDamage: number, damageMultiplier = 1): void {
    if (attacker.dead || target.dead) return;

    const godMult = attacker.godMode ? GOD_MODE_DAMAGE_MULT : 1;
    const adjustedTick = Math.round(tickDamage * damageMultiplier * godMult);
    const isCrit = Math.random() < attacker.critChance;
    const mult = isCrit ? 2 : 1;
    const damage = Math.round(adjustedTick * mult);
    const actualDamage = target.godMode ? 0 : this.processDamageAbsorb(target, damage, attacker);
    target.hp = Math.max(0, target.hp - actualDamage);
    if (damage > 0) this.onDirectDamageDealt?.(target);
    if (actualDamage > 0) {
      this.onCombatText?.(attacker, target, actualDamage, isCrit ? 'crit' : 'damage');
    }
    if (target.hp <= 0 && !target.dead) {
      target.die();
      this.combatTimers.delete(target);
      this.onEntityKilled?.(attacker, target);
    }

    this.enterCombat(attacker);
    this.enterCombat(target);
  }

  processDamageAbsorb(target: ServerEntity, damage: number, attacker: ServerEntity | null): number {
    const damageTakenMult = this.buffSystem.getDamageTakenMultiplier(target);
    damage = Math.round(damage * damageTakenMult);
    const { remaining, reflectDamage } = this.buffSystem.absorbDamage(target, damage);
    if (reflectDamage > 0 && attacker && !attacker.dead && !attacker.godMode) {
      attacker.hp = Math.max(0, attacker.hp - reflectDamage);
      this.onCombatText?.(target, attacker, reflectDamage, 'damage');
      this.enterCombat(attacker);
      if (attacker.hp <= 0 && !attacker.dead) {
        attacker.die();
        this.combatTimers.delete(attacker);
        this.onEntityKilled?.(target, attacker);
      }
    }
    return remaining;
  }

  applyHeal(source: ServerEntity, target: ServerEntity, healAmount: number): void {
    if (target.dead) return;
    target.hp = Math.min(target.maxHp, target.hp + healAmount);
    this.onCombatText?.(source, target, healAmount, 'heal');
  }

  /** Returns true if the auto-attack was a critical hit. */
  applyAutoAttackDamage(attacker: ServerEntity, target: ServerEntity, baseDamage: number, canDodge = true): boolean {
    if (attacker.dead || target.dead) return false;
    if (this.buffSystem.isUntargetable(target) || this.buffSystem.isUntargetable(attacker)) return false;

    const outcome = this.rollOutcome(attacker, target, canDodge);

    if (outcome === 'miss') {
      this.onCombatText?.(attacker, target, 0, 'miss', undefined, true);
    } else if (outcome === 'dodge') {
      this.onCombatText?.(attacker, target, 0, 'dodge', undefined, true);
    } else {
      const critMult = outcome === 'crit' ? 2 : 1;
      const buffMult = this.buffSystem.getAutoAttackDamageTakenMultiplier(target);
      let damageMult = this.buffSystem.getDamageDealtMultiplier(attacker);
      if (attacker.godMode) damageMult *= GOD_MODE_DAMAGE_MULT;
      const damage = Math.round(baseDamage * buffMult * damageMult * critMult);
      const actualDamage = target.godMode ? 0 : this.processDamageAbsorb(target, damage, attacker);
      target.hp = Math.max(0, target.hp - actualDamage);
      if (damage > 0) {
        this.onDirectDamageDealt?.(target);
        this.onFlinchDamage?.(target);
      }
      if (actualDamage > 0) {
        this.onCombatText?.(attacker, target, actualDamage, outcome === 'crit' ? 'crit' : 'damage', undefined, true);
      }
      if (target.hp <= 0 && !target.dead) {
        target.die();
        this.combatTimers.delete(target);
        this.onEntityKilled?.(attacker, target);
      }
    }

    this.enterCombat(attacker);
    this.enterCombat(target);
    return outcome === 'crit';
  }
}
