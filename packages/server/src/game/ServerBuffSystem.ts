import type { BuffDefinition } from '@gtr/shared';
import type { ServerEntity } from './ServerEntity.js';

export interface ActiveBuff {
  readonly definition: BuffDefinition;
  remaining: number;
  shieldRemaining?: number;
}

export class ServerBuffSystem {
  private activeBuffs = new Map<ServerEntity, ActiveBuff[]>();
  onBuffExpired?: (target: ServerEntity, definition: BuffDefinition) => void;

  apply(target: ServerEntity, definition: BuffDefinition): void {
    if (target.dead) return;
    let buffs = this.activeBuffs.get(target);
    if (!buffs) {
      buffs = [];
      this.activeBuffs.set(target, buffs);
    }
    const existing = buffs.find(b => b.definition.id === definition.id);
    if (existing) {
      existing.remaining = definition.duration;
      if (definition.shieldAmount !== undefined) {
        existing.shieldRemaining = definition.shieldAmount;
      }
    } else {
      buffs.push({
        definition,
        remaining: definition.duration,
        shieldRemaining: definition.shieldAmount,
      });
    }
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
    return mult;
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
  }

  clearEntity(entity: ServerEntity): void {
    this.activeBuffs.delete(entity);
  }
}
