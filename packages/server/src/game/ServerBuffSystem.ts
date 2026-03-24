import { DR_RESET_TIMER, DR_MULTIPLIERS } from '@gtr/shared';
import type { BuffDefinition } from '@gtr/shared';
import type { ServerEntity } from './ServerEntity.js';

export interface ActiveBuff {
  readonly definition: BuffDefinition;
  remaining: number;
  shieldRemaining?: number;
}

interface DREntry {
  count: number;
  remaining: number;
  lastBuffId: string;
  lastIcon: string;
}

export class ServerBuffSystem {
  private activeBuffs = new Map<ServerEntity, ActiveBuff[]>();
  private drState = new Map<ServerEntity, Map<string, DREntry>>();
  onBuffExpired?: (target: ServerEntity, definition: BuffDefinition) => void;

  /** Apply a buff/debuff. Returns false if blocked by DR immunity. */
  apply(target: ServerEntity, definition: BuffDefinition): boolean {
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
    const existing = buffs.find(b => b.definition.id === definition.id);
    if (existing) {
      existing.remaining = effectiveDuration;
      if (definition.shieldAmount !== undefined) {
        existing.shieldRemaining = definition.shieldAmount;
      }
    } else {
      buffs.push({
        definition,
        remaining: effectiveDuration,
        shieldRemaining: definition.shieldAmount,
      });
    }
    return true;
  }

  setRemaining(target: ServerEntity, buffId: string, remaining: number): void {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return;
    const buff = buffs.find(b => b.definition.id === buffId);
    if (buff) buff.remaining = remaining;
  }

  remove(target: ServerEntity, buffId: string): void {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return;
    const idx = buffs.findIndex(b => b.definition.id === buffId);
    if (idx !== -1) buffs.splice(idx, 1);
    if (buffs.length === 0) this.activeBuffs.delete(target);
  }

  getBuffs(target: ServerEntity): readonly ActiveBuff[] {
    const all = this.activeBuffs.get(target);
    if (!all) return [];
    return all.filter(b => b.definition.type === 'buff');
  }

  getDebuffs(target: ServerEntity): readonly ActiveBuff[] {
    const all = this.activeBuffs.get(target);
    if (!all) return [];
    return all.filter(b => b.definition.type === 'debuff');
  }

  getAllBuffs(target: ServerEntity): readonly ActiveBuff[] {
    return this.activeBuffs.get(target) ?? [];
  }

  hasDebuff(target: ServerEntity, debuffId: string): boolean {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return false;
    return buffs.some(b => b.definition.id === debuffId && b.definition.type === 'debuff');
  }

  hasBuff(target: ServerEntity, buffId: string): boolean {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return false;
    return buffs.some(b => b.definition.id === buffId && b.definition.type === 'buff');
  }

  getAutoAttackSpeedMultiplier(target: ServerEntity): number {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return 1;
    let mult = 1;
    for (const buff of buffs) {
      for (const effect of buff.definition.effects) {
        if (effect.type === 'autoAttackSpeedPercent') mult += effect.value / 100;
      }
    }
    return mult;
  }

  getMovementSpeedMultiplier(target: ServerEntity): number {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return 1;
    let mult = 1;
    for (const buff of buffs) {
      for (const effect of buff.definition.effects) {
        if (effect.type === 'movementSpeedPercent') mult += effect.value / 100;
      }
    }
    return Math.max(0, mult);
  }

  isStunned(target: ServerEntity): boolean {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return false;
    return buffs.some(b => b.definition.effects.some(e => e.type === 'stun'));
  }

  isDiscombobulated(target: ServerEntity): boolean {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return false;
    return buffs.some(b => b.definition.effects.some(e => e.type === 'discombobulate'));
  }

  getAutoAttackDamageTakenMultiplier(target: ServerEntity): number {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return 1;
    let mult = 1;
    for (const buff of buffs) {
      for (const effect of buff.definition.effects) {
        if (effect.type === 'autoAttackDamageTakenPercent') mult += effect.value / 100;
      }
    }
    return mult;
  }

  getManaCostMultiplier(source: ServerEntity): number {
    const buffs = this.activeBuffs.get(source);
    if (!buffs) return 1;
    let mult = 1;
    for (const buff of buffs) {
      for (const effect of buff.definition.effects) {
        if (effect.type === 'manaCostPercent') mult += effect.value / 100;
      }
    }
    return Math.max(0, mult);
  }

  getDamageDealtMultiplier(source: ServerEntity): number {
    const buffs = this.activeBuffs.get(source);
    if (!buffs) return 1;
    let mult = 1;
    for (const buff of buffs) {
      for (const effect of buff.definition.effects) {
        if (effect.type === 'damageDealtPercent') mult += effect.value / 100;
      }
    }
    return mult;
  }

  absorbDamage(target: ServerEntity, incomingDamage: number): { remaining: number; reflectDamage: number } {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return { remaining: incomingDamage, reflectDamage: 0 };

    let remaining = incomingDamage;
    let totalReflect = 0;

    for (const buff of buffs) {
      if (buff.definition.shieldReflectPercent && buff.definition.shieldReflectPercent > 0) {
        totalReflect += Math.round(incomingDamage * buff.definition.shieldReflectPercent / 100);
      }
      if (buff.shieldRemaining !== undefined && buff.shieldRemaining > 0) {
        const absorbed = Math.min(remaining, buff.shieldRemaining);
        buff.shieldRemaining -= absorbed;
        remaining -= absorbed;
      }
    }

    return { remaining, reflectDamage: totalReflect };
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

  getDRTimers(target: ServerEntity): { category: string; buffId: string; icon: string; count: number; remaining: number; total: number }[] {
    const entityDR = this.drState.get(target);
    if (!entityDR || entityDR.size === 0) return [];
    const timers: { category: string; buffId: string; icon: string; count: number; remaining: number; total: number }[] = [];
    for (const [cat, dr] of entityDR) {
      timers.push({
        category: cat,
        buffId: dr.lastBuffId,
        icon: dr.lastIcon,
        count: dr.count,
        remaining: dr.remaining,
        total: DR_RESET_TIMER,
      });
    }
    return timers;
  }

  clearEntity(entity: ServerEntity): void {
    this.activeBuffs.delete(entity);
    this.drState.delete(entity);
  }
}
