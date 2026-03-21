import type { Ability } from '@gtr/shared';
import { yardsToUnits } from '@gtr/shared';
import type { ServerEntity } from './ServerEntity.js';
import type { ServerBuffSystem } from './ServerBuffSystem.js';
import type { ServerRegenSystem } from './ServerRegenSystem.js';
import type { CollisionSystem } from './ServerMapManager.js';

export type CombatError = 'no-target' | 'out-of-range' | 'not-facing' | 'on-cooldown' | 'not-enough-mana' | 'dead' | 'not-in-los' | 'stunned' | 'casting';

export interface CombatResult {
  success: boolean;
  error?: CombatError;
  errorMessage?: string;
}

export type CombatTextType = 'damage' | 'heal' | 'crit' | 'miss' | 'dodge';

export class ServerCombatSystem {
  private cooldowns = new Map<string, Map<string, { remaining: number; total: number }>>(); // entityId -> (abilityId -> cooldown)
  private static readonly COMBAT_DURATION = 5;
  private static readonly MISS_CHANCE = 0.03;
  // Generous range tolerance to compensate for client-server latency.
  // Without this, high-latency players get abilities rejected at range boundaries
  // because the target has moved by the time the server processes the request.
  private static readonly RANGE_TOLERANCE = yardsToUnits(2);
  private combatTimers = new Map<ServerEntity, number>();
  private regenSystem: ServerRegenSystem;
  private buffSystem: ServerBuffSystem;
  private collision: CollisionSystem;

  onCombatText?: (source: ServerEntity, target: ServerEntity, amount: number, type: CombatTextType) => void;
  onDirectDamageDealt?: (target: ServerEntity) => void;

  constructor(regenSystem: ServerRegenSystem, buffSystem: ServerBuffSystem, collision: CollisionSystem) {
    this.regenSystem = regenSystem;
    this.buffSystem = buffSystem;
    this.collision = collision;
  }

  enterCombat(entity: ServerEntity): void {
    if (entity.dead) return;
    entity.inCombat = true;
    this.combatTimers.set(entity, ServerCombatSystem.COMBAT_DURATION);
  }

  private isFacing(ax: number, az: number, aRotY: number, tx: number, tz: number): boolean {
    const dx = tx - ax;
    const dz = tz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.001) return true;
    const forward = { x: Math.sin(aRotY), z: Math.cos(aRotY) };
    const dot = forward.x * (dx / len) + forward.z * (dz / len);
    return dot > 0.5; // 120 degree cone
  }

  private rollOutcome(attacker: ServerEntity, target: ServerEntity, canDodge = true): 'miss' | 'dodge' | 'crit' | 'normal' {
    const roll = Math.random();
    if (roll < ServerCombatSystem.MISS_CHANCE) return 'miss';
    if (canDodge) {
      const targetFacing = this.isFacing(target.x, target.z, target.rotationY, attacker.x, attacker.z);
      const targetStunned = this.buffSystem.isStunned(target);
      if (targetFacing && !targetStunned && roll < ServerCombatSystem.MISS_CHANCE + target.dodgeChance) return 'dodge';
    }
    if (Math.random() < attacker.critChance) return 'crit';
    return 'normal';
  }

  rollMiss(): boolean {
    return Math.random() < ServerCombatSystem.MISS_CHANCE;
  }

  private getDistance(ax: number, az: number, bx: number, bz: number): number {
    const dx = ax - bx;
    const dz = az - bz;
    return Math.sqrt(dx * dx + dz * dz);
  }

  update(dt: number): void {
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
  }

  leaveCombat(entity: ServerEntity): void {
    entity.inCombat = false;
    this.combatTimers.delete(entity);
  }

  hasLineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
    return this.collision.hasLineOfSight(ax, az, bx, bz);
  }

  validateAbility(
    ability: Ability,
    attacker: ServerEntity,
    target: ServerEntity | null
  ): CombatResult {
    if (attacker.dead) {
      return { success: false, error: 'dead', errorMessage: 'You are dead' };
    }
    if (target?.dead) {
      return { success: false, error: 'dead', errorMessage: 'Target is dead' };
    }
    if (this.buffSystem.isStunned(attacker)) {
      return { success: false, error: 'stunned', errorMessage: 'You are stunned' };
    }
    if (this.getCooldownRemaining(attacker.id, ability.id) > 0) {
      return { success: false, error: 'on-cooldown', errorMessage: 'Ability is not ready yet' };
    }
    if (ability.requiresHostileTarget) {
      if (!target || !target.isHostileTo(attacker)) {
        return { success: false, error: 'no-target', errorMessage: 'No hostile target' };
      }
    }
    const effectiveManaCost = Math.round(ability.manaCost * this.buffSystem.getManaCostMultiplier(attacker));
    if (attacker.mana < effectiveManaCost) {
      return { success: false, error: 'not-enough-mana', errorMessage: 'Not enough mana' };
    }
    if (ability.requiresHostileTarget && target) {
      const dist = this.getDistance(attacker.x, attacker.z, target.x, target.z);
      if (dist > ability.range! + ServerCombatSystem.RANGE_TOLERANCE) {
        return { success: false, error: 'out-of-range', errorMessage: 'Out of range' };
      }
      if (!this.collision.hasLineOfSight(attacker.x, attacker.z, target.x, target.z)) {
        return { success: false, error: 'not-in-los', errorMessage: 'Not in line of sight' };
      }
      if (!this.isFacing(attacker.x, attacker.z, attacker.rotationY, target.x, target.z)) {
        return { success: false, error: 'not-facing', errorMessage: 'Not facing target' };
      }
    }
    if (ability.requiresTarget && !ability.requiresHostileTarget) {
      if (!target) {
        return { success: false, error: 'no-target', errorMessage: 'No target' };
      }
      if (ability.range) {
        const dist = this.getDistance(attacker.x, attacker.z, target.x, target.z);
        if (dist > ability.range + ServerCombatSystem.RANGE_TOLERANCE) {
          return { success: false, error: 'out-of-range', errorMessage: 'Out of range' };
        }
        if (!this.collision.hasLineOfSight(attacker.x, attacker.z, target.x, target.z)) {
          return { success: false, error: 'not-in-los', errorMessage: 'Not in line of sight' };
        }
      }
    }
    return { success: true };
  }

  useAbility(
    ability: Ability,
    attacker: ServerEntity,
    target: ServerEntity | null
  ): CombatResult {
    const validation = this.validateAbility(ability, attacker, target);
    if (!validation.success) return validation;

    const effectiveCost = Math.round(ability.manaCost * this.buffSystem.getManaCostMultiplier(attacker));
    attacker.mana -= effectiveCost;
    if (effectiveCost > 0) {
      this.regenSystem.notifyManaUsed(attacker);
    }

    if (ability.requiresHostileTarget && target) {
      const outcome = this.rollOutcome(attacker, target, false);

      if (outcome === 'miss') {
        this.onCombatText?.(attacker, target, 0, 'miss');
      } else {
        let baseDamage: number;
        if (ability.damageMin !== undefined && ability.damageMax !== undefined) {
          baseDamage = ability.damageMin + Math.floor(
            Math.random() * (ability.damageMax - ability.damageMin + 1)
          );
        } else {
          baseDamage = ability.damage;
        }

        if (ability.bonusDamagePercent && ability.bonusDamageRequiresDebuff) {
          if (this.buffSystem.hasDebuff(target, ability.bonusDamageRequiresDebuff)) {
            baseDamage = Math.round(baseDamage * (1 + ability.bonusDamagePercent / 100));
          }
        }

        const damageMult = this.buffSystem.getDamageDealtMultiplier(attacker);
        baseDamage = Math.round(baseDamage * damageMult);

        const multiplier = outcome === 'crit' ? 2 : 1;
        const damage = baseDamage * multiplier;
        const actualDamage = this.processDamageAbsorb(target, damage, attacker);
        target.hp = Math.max(0, target.hp - actualDamage);
        if (damage > 0) this.onDirectDamageDealt?.(target);
        if (actualDamage > 0) {
          this.onCombatText?.(attacker, target, actualDamage, outcome === 'crit' ? 'crit' : 'damage');
        }

        if (ability.appliesDebuff) {
          this.buffSystem.apply(target, ability.appliesDebuff);
        }

        if (target.hp <= 0 && !target.dead) {
          target.die();
          this.combatTimers.delete(target);
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

    this.setCooldown(attacker.id, ability.id, ability.cooldown);
    return { success: true };
  }

  applySweepDamage(attacker: ServerEntity, target: ServerEntity, baseDamage: number): void {
    if (attacker.dead || target.dead) return;

    const roll = Math.random();
    if (roll < ServerCombatSystem.MISS_CHANCE) {
      this.onCombatText?.(attacker, target, 0, 'miss');
      this.enterCombat(attacker);
      this.enterCombat(target);
      return;
    }

    const damageMult = this.buffSystem.getDamageDealtMultiplier(attacker);
    const adjustedBase = Math.round(baseDamage * damageMult);
    const isCrit = Math.random() < attacker.critChance;
    const multiplier = isCrit ? 2 : 1;
    const damage = Math.round(adjustedBase * multiplier);
    const actualDamage = this.processDamageAbsorb(target, damage, attacker);
    target.hp = Math.max(0, target.hp - actualDamage);
    if (damage > 0) this.onDirectDamageDealt?.(target);
    if (actualDamage > 0) {
      this.onCombatText?.(attacker, target, actualDamage, isCrit ? 'crit' : 'damage');
    }

    this.enterCombat(attacker);
    this.enterCombat(target);

    if (target.hp <= 0 && !target.dead) {
      target.die();
      this.combatTimers.delete(target);
    }
  }

  applyChannelTickDamage(attacker: ServerEntity, target: ServerEntity, tickDamage: number, damageMultiplier = 1): void {
    if (attacker.dead || target.dead) return;

    const adjustedTick = Math.round(tickDamage * damageMultiplier);
    const isCrit = Math.random() < attacker.critChance;
    const mult = isCrit ? 2 : 1;
    const damage = Math.round(adjustedTick * mult);
    const actualDamage = this.processDamageAbsorb(target, damage, attacker);
    target.hp = Math.max(0, target.hp - actualDamage);
    if (damage > 0) this.onDirectDamageDealt?.(target);
    if (actualDamage > 0) {
      this.onCombatText?.(attacker, target, actualDamage, isCrit ? 'crit' : 'damage');
    }
    if (target.hp <= 0 && !target.dead) {
      target.die();
      this.combatTimers.delete(target);
    }

    this.enterCombat(attacker);
    this.enterCombat(target);
  }

  processDamageAbsorb(target: ServerEntity, damage: number, attacker: ServerEntity | null): number {
    const { remaining, reflectDamage } = this.buffSystem.absorbDamage(target, damage);
    if (reflectDamage > 0 && attacker && !attacker.dead) {
      attacker.hp = Math.max(0, attacker.hp - reflectDamage);
      this.onCombatText?.(target, attacker, reflectDamage, 'damage');
      this.enterCombat(attacker);
      if (attacker.hp <= 0 && !attacker.dead) {
        attacker.die();
        this.combatTimers.delete(attacker);
      }
    }
    return remaining;
  }

  applyHeal(source: ServerEntity, target: ServerEntity, healAmount: number): void {
    if (target.dead) return;
    target.hp = Math.min(target.maxHp, target.hp + healAmount);
    this.onCombatText?.(source, target, healAmount, 'heal');
  }

  applyAutoAttackDamage(attacker: ServerEntity, target: ServerEntity, baseDamage: number): void {
    if (attacker.dead || target.dead) return;

    const outcome = this.rollOutcome(attacker, target);

    if (outcome === 'miss') {
      this.onCombatText?.(attacker, target, 0, 'miss');
    } else if (outcome === 'dodge') {
      this.onCombatText?.(attacker, target, 0, 'dodge');
    } else {
      const critMult = outcome === 'crit' ? 2 : 1;
      const buffMult = this.buffSystem.getAutoAttackDamageTakenMultiplier(target);
      const damageMult = this.buffSystem.getDamageDealtMultiplier(attacker);
      const damage = Math.round(baseDamage * buffMult * damageMult * critMult);
      const actualDamage = this.processDamageAbsorb(target, damage, attacker);
      target.hp = Math.max(0, target.hp - actualDamage);
      if (damage > 0) this.onDirectDamageDealt?.(target);
      if (actualDamage > 0) {
        this.onCombatText?.(attacker, target, actualDamage, outcome === 'crit' ? 'crit' : 'damage');
      }
      if (target.hp <= 0 && !target.dead) {
        target.die();
        this.combatTimers.delete(target);
      }
    }

    this.enterCombat(attacker);
    this.enterCombat(target);
  }
}
