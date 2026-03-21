import type { Targetable } from '../types';

export interface BuffEffect {
  readonly type: 'autoAttackDamageTakenPercent' | 'autoAttackSpeedPercent' | 'movementSpeedPercent' | 'stun' | 'discombobulate';
  readonly value: number; // e.g. 50 = +50%, -20 = -20%
}

export interface BuffDefinition {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly duration: number; // seconds
  readonly type: 'buff' | 'debuff';
  readonly description: string;
  readonly effects: readonly BuffEffect[];
}

export interface ActiveBuff {
  readonly definition: BuffDefinition;
  remaining: number;
}

export class BuffSystem {
  private activeBuffs = new Map<Targetable, ActiveBuff[]>();

  apply(target: Targetable, definition: BuffDefinition): void {
    if (target.dead) return;
    let buffs = this.activeBuffs.get(target);
    if (!buffs) {
      buffs = [];
      this.activeBuffs.set(target, buffs);
    }
    // Refresh duration if already present
    const existing = buffs.find(b => b.definition.id === definition.id);
    if (existing) {
      existing.remaining = definition.duration;
    } else {
      buffs.push({ definition, remaining: definition.duration });
    }
  }

  setRemaining(target: Targetable, buffId: string, remaining: number): void {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return;
    const buff = buffs.find(b => b.definition.id === buffId);
    if (buff) buff.remaining = remaining;
  }

  remove(target: Targetable, buffId: string): void {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return;
    const idx = buffs.findIndex(b => b.definition.id === buffId);
    if (idx !== -1) buffs.splice(idx, 1);
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

  getAutoAttackSpeedMultiplier(target: Targetable): number {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return 1;
    let mult = 1;
    for (const buff of buffs) {
      for (const effect of buff.definition.effects) {
        if (effect.type === 'autoAttackSpeedPercent') {
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
        if (effect.type === 'movementSpeedPercent') {
          mult += effect.value / 100;
        }
      }
    }
    return mult;
  }

  isStunned(target: Targetable): boolean {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return false;
    return buffs.some(b => b.definition.effects.some(e => e.type === 'stun'));
  }

  isDiscombobulated(target: Targetable): boolean {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return false;
    return buffs.some(b => b.definition.effects.some(e => e.type === 'discombobulate'));
  }

  getAutoAttackDamageTakenMultiplier(target: Targetable): number {
    const buffs = this.activeBuffs.get(target);
    if (!buffs) return 1;
    let mult = 1;
    for (const buff of buffs) {
      for (const effect of buff.definition.effects) {
        if (effect.type === 'autoAttackDamageTakenPercent') {
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
          buffs.splice(i, 1);
        }
      }
      if (buffs.length === 0) this.activeBuffs.delete(entity);
    }
  }

  clearEntity(entity: Targetable): void {
    this.activeBuffs.delete(entity);
  }
}
