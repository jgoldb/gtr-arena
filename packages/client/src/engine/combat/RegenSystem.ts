import { REGEN_TICK_INTERVAL, HP_REGEN_AMOUNT, MANA_REGEN_AMOUNT, MANA_REGEN_DELAY, RESTING_MANA_MULTIPLIER } from '@gtr/shared';
import type { Targetable } from '../types';
import type { BuffSystem } from './BuffSystem';

export class RegenSystem {

  private tickAccumulator = 0;
  private manaUsedTimers = new Map<Targetable, number>(); // entity → seconds since last mana use
  private getEntities: () => Targetable[];
  private buffSystem: BuffSystem | null = null;

  constructor(getEntities: () => Targetable[]) {
    this.getEntities = getEntities;
  }

  setBuffSystem(buffSystem: BuffSystem): void {
    this.buffSystem = buffSystem;
  }

  notifyManaUsed(entity: Targetable): void {
    this.manaUsedTimers.set(entity, 0);
  }

  update(dt: number): void {
    // Advance mana usage timers
    for (const [entity, elapsed] of this.manaUsedTimers) {
      this.manaUsedTimers.set(entity, elapsed + dt);
    }

    // Advance tick
    this.tickAccumulator += dt;
    while (this.tickAccumulator >= REGEN_TICK_INTERVAL) {
      this.tickAccumulator -= REGEN_TICK_INTERVAL;
      this.tick();
    }
  }

  private tick(): void {
    for (const entity of this.getEntities()) {
      if (entity.dead) continue;

      // Health regen: only out of combat
      if (!entity.inCombat && entity.hp < entity.maxHp) {
        entity.hp = Math.min(entity.maxHp, entity.hp + HP_REGEN_AMOUNT);
      }

      // Mana regen: only if entity has mana, and 5s since last mana use
      if (entity.maxMana > 0 && entity.mana < entity.maxMana) {
        const timeSinceUse = this.manaUsedTimers.get(entity);
        if (timeSinceUse === undefined || timeSinceUse >= MANA_REGEN_DELAY) {
          const isResting = this.buffSystem?.hasBuff(entity, 'resting') ?? false;
          const regenAmount = isResting
            ? MANA_REGEN_AMOUNT * RESTING_MANA_MULTIPLIER
            : MANA_REGEN_AMOUNT;
          entity.mana = Math.min(entity.maxMana, entity.mana + regenAmount);
        }
      }
    }
  }
}
