import type { Targetable } from '../types';
import { DR_RESET_TIMER, DR_MULTIPLIERS } from '@gtr/shared';
import type { BuffDefinition, BuffEffect } from '@gtr/shared';

export type { BuffEffect, BuffDefinition };

export interface ActiveBuff {
  readonly definition: BuffDefinition;
  remaining: number;
  shieldRemaining?: number; // mutable shield HP (only if definition.shieldAmount)
  appliedAt: number;
  stacks?: number; // current stack count (only for stackable buffs)
}

interface DREntry {
  count: number;
  remaining: number;
  lastBuffId: string;
  lastIcon: string;
}

/** Brief window after sleep application where damage won't break it (ms) */
const SLEEP_GRACE_PERIOD_MS = 50;

export class BuffSystem {
  private activeBuffs = new Map<Targetable, ActiveBuff[]>();
  private drState = new Map<Targetable, Map<string, DREntry>>();
  onBuffApplied?: (target: Targetable, definition: BuffDefinition) => void;
  onBuffExpired?: (target: Targetable, definition: BuffDefinition) => void;
  onStacksChanged?: (target: Targetable, buffId: string, oldStacks: number, newStacks: number) => void;

  /** Apply a buff/debuff. Returns false if blocked by DR immunity. */
  apply(target: Targetable, definition: BuffDefinition): boolean {
    if (target.dead) return false;

    let effectiveDuration = definition.duration;

    // Diminishing returns
    if (definition.drCategory) {
      let entityDR = this.drState.get(target);
      if (!entityDR) {
        entityDR = new Map();
        this.drState.set(target, entityDR);
      }
      const dr = entityDR.get(definition.drCategory);
      const count = dr?.count ?? 0;

      if (count >= DR_MULTIPLIERS.length - 1) {
        // Immune — don't apply, let existing timer keep counting down
        return false;
      }

      effectiveDuration = definition.duration * DR_MULTIPLIERS[count];
      entityDR.set(definition.drCategory, {
        count: count + 1,
        remaining: DR_RESET_TIMER,
        lastBuffId: definition.id,
        lastIcon: definition.icon,
      });
    }

    let buffs = this.activeBuffs.get(target);
    if (!buffs) {
      buffs = [];
      this.activeBuffs.set(target, buffs);
    }
    // Refresh duration if already present
    const existing = buffs.find(b => b.definition.id === definition.id);
    if (existing) {
      existing.remaining = effectiveDuration;
      existing.appliedAt = Date.now();
      if (definition.shieldAmount !== undefined) {
        existing.shieldRemaining = definition.shieldAmount;
      }
      // For stackable buffs, re-applying adds stacks (capped at max)
      if (definition.maxStacks !== undefined && existing.stacks !== undefined) {
        existing.stacks = Math.min(existing.stacks + (definition.stacks ?? 1), definition.maxStacks);
      }
    } else {
      buffs.push({
        definition,
        remaining: effectiveDuration,
        shieldRemaining: definition.shieldAmount,
        appliedAt: Date.now(),
        stacks: definition.stacks,
      });
      this.onBuffApplied?.(target, definition);
    }
    return true;
  }

  setRemaining(target: Targetable, buffId: string, remaining: number): void {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return;
    const buff = buffs.find(b => b.definition.id === buffId);
    if (buff) buff.remaining = remaining;
  }

  addStacks(target: Targetable, buffId: string, amount: number): void {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return;
    const buff = buffs.find(b => b.definition.id === buffId);
    if (buff && buff.stacks !== undefined && buff.definition.maxStacks !== undefined) {
      const oldStacks = buff.stacks;
      buff.stacks = Math.min(buff.stacks + amount, buff.definition.maxStacks);
      if (buff.stacks !== oldStacks) {
        this.onStacksChanged?.(target, buffId, oldStacks, buff.stacks);
      }
    }
  }

  removeStacks(target: Targetable, buffId: string, amount: number): void {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return;
    const buff = buffs.find(b => b.definition.id === buffId);
    if (buff && buff.stacks !== undefined) {
      const oldStacks = buff.stacks;
      buff.stacks = Math.max(0, buff.stacks - amount);
      if (buff.stacks !== oldStacks) {
        this.onStacksChanged?.(target, buffId, oldStacks, buff.stacks);
      }
      if (buff.stacks <= 0 && !buff.definition.allowZeroStacks) {
        this.remove(target, buffId);
      }
    }
  }

  getStacks(target: Targetable, buffId: string): number {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return 0;
    const buff = buffs.find(b => b.definition.id === buffId);
    return buff?.stacks ?? 0;
  }

  remove(target: Targetable, buffId: string, silent = false): void {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return;
    const idx = buffs.findIndex(b => b.definition.id === buffId);
    if (idx !== -1) {
      const removed = buffs.splice(idx, 1)[0];
      if (!silent) this.onBuffExpired?.(target, removed.definition);
    }
    if (buffs.length === 0) this.activeBuffs.delete(target);
  }

  getBuffs(target: Targetable): readonly ActiveBuff[] {
    const all = this.activeBuffs.get(target);
    if (!all) return [];
    return all.filter(b => b.definition.type === 'buff');
  }

  getDebuffs(target: Targetable): readonly ActiveBuff[] {
    const all = this.activeBuffs.get(target);
    if (!all) return [];
    return all.filter(b => b.definition.type === 'debuff');
  }

  hasDebuff(target: Targetable, debuffId: string): boolean {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return false;
    return buffs.some(b => b.definition.id === debuffId && b.definition.type === 'debuff');
  }

  hasBuff(target: Targetable, buffId: string): boolean {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return false;
    return buffs.some(b => b.definition.id === buffId && b.definition.type === 'buff');
  }

  private isEffectActive(buff: ActiveBuff, effect: BuffEffect): boolean {
    return effect.minStacks === undefined || (buff.stacks !== undefined && buff.stacks >= effect.minStacks);
  }

  getAutoAttackSpeedMultiplier(target: Targetable): number {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return 1;
    let mult = 1;
    for (const buff of buffs) {
      for (const effect of buff.definition.effects) {
        if (effect.type === 'autoAttackSpeedPercent' && this.isEffectActive(buff, effect)) {
          mult += effect.value / 100;
        }
      }
    }
    return mult;
  }

  getMovementSpeedMultiplier(target: Targetable): number {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return 1;
    let mult = 1;
    for (const buff of buffs) {
      for (const effect of buff.definition.effects) {
        if (effect.type === 'movementSpeedPercent' && this.isEffectActive(buff, effect)) {
          mult += effect.value / 100;
        }
      }
    }
    return Math.max(0, mult);
  }

  isStunned(target: Targetable): boolean {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return false;
    return buffs.some(b => b.definition.effects.some(e => e.type === 'stun' && this.isEffectActive(b, e)));
  }

  isSleeping(target: Targetable): boolean {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return false;
    return buffs.some(b => b.definition.effects.some(e => e.type === 'sleep' && this.isEffectActive(b, e)));
  }

  removeSleepEffects(target: Targetable): void {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return;
    const now = Date.now();
    for (let i = buffs.length - 1; i >= 0; i--) {
      if (buffs[i].definition.effects.some(e => e.type === 'sleep')) {
        if (now - buffs[i].appliedAt < SLEEP_GRACE_PERIOD_MS) continue;
        const removed = buffs.splice(i, 1)[0];
        this.onBuffExpired?.(target, removed.definition);
      }
    }
    if (buffs.length === 0) this.activeBuffs.delete(target);
  }

  isBlinded(target: Targetable): boolean {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return false;
    return buffs.some(b => b.definition.effects.some(e => e.type === 'blind' && this.isEffectActive(b, e)));
  }

  isDiscombobulated(target: Targetable): boolean {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return false;
    return buffs.some(b => b.definition.effects.some(e => e.type === 'discombobulate' && this.isEffectActive(b, e)));
  }

  getAutoAttackDamageTakenMultiplier(target: Targetable): number {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return 1;
    let mult = 1;
    for (const buff of buffs) {
      for (const effect of buff.definition.effects) {
        if (effect.type === 'autoAttackDamageTakenPercent' && this.isEffectActive(buff, effect)) {
          mult += effect.value / 100;
        }
      }
    }
    return mult;
  }

  update(dt: number): void {
    for (const [entity, buffs] of this.activeBuffs) {
      for (let i = buffs.length - 1; i >= 0; i--) {
        buffs[i].remaining -= dt;
        if (buffs[i].remaining <= 0 || entity.dead) {
          const removed = buffs.splice(i, 1)[0];
          if (!entity.dead) {
            this.onBuffExpired?.(entity, removed.definition);
          }
        }
      }
      if (buffs.length === 0) this.activeBuffs.delete(entity);
    }

    // Tick DR timers
    for (const [entity, categories] of this.drState) {
      for (const [cat, dr] of categories) {
        dr.remaining -= dt;
        if (dr.remaining <= 0 || entity.dead) {
          categories.delete(cat);
        }
      }
      if (categories.size === 0) this.drState.delete(entity);
    }
  }

  getManaCostMultiplier(source: Targetable): number {
    const buffs = this.activeBuffs.get(source);
    if (!buffs) return 1;
    let mult = 1;
    for (const buff of buffs) {
      for (const effect of buff.definition.effects) {
        if (effect.type === 'manaCostPercent' && this.isEffectActive(buff, effect)) {
          mult += effect.value / 100;
        }
      }
    }
    return Math.max(0, mult);
  }

  getDamageDealtMultiplier(source: Targetable): number {
    const buffs = this.activeBuffs.get(source);
    if (!buffs) return 1;
    let mult = 1;
    for (const buff of buffs) {
      for (const effect of buff.definition.effects) {
        if (effect.type === 'damageDealtPercent' && this.isEffectActive(buff, effect)) {
          mult += effect.value / 100;
        }
      }
    }
    return mult;
  }

  /** Process incoming damage through shields. Returns actual HP damage and reflect amount. */
  absorbDamage(target: Targetable, incomingDamage: number): { remaining: number; reflectDamage: number } {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return { remaining: incomingDamage, reflectDamage: 0 };

    let remaining = incomingDamage;
    let totalReflect = 0;

    for (const buff of buffs) {
      // Reflect is based on total incoming damage (before absorption)
      if (buff.definition.shieldReflectPercent && buff.definition.shieldReflectPercent > 0) {
        totalReflect += Math.round(incomingDamage * buff.definition.shieldReflectPercent / 100);
      }
      // Shield absorption
      if (buff.shieldRemaining !== undefined && buff.shieldRemaining > 0) {
        const absorbed = Math.min(remaining, buff.shieldRemaining);
        buff.shieldRemaining -= absorbed;
        remaining -= absorbed;
      }
    }

    return { remaining, reflectDamage: totalReflect };
  }

  clearEntity(entity: Targetable): void {
    this.activeBuffs.delete(entity);
    this.drState.delete(entity);
  }
}
