import type { Targetable } from '../types';
import type { BuffSystem } from './BuffSystem';

export class RegenSystem {
  private static readonly TICK_INTERVAL = 2.5; // seconds
  private static readonly REGEN_AMOUNT = 2;
  private static readonly MANA_REGEN_DELAY = 5; // seconds after last mana use
  private static readonly RESTING_MANA_MULTIPLIER = 4; // 300% increase = 4x total

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
    while (this.tickAccumulator >= RegenSystem.TICK_INTERVAL) {
      this.tickAccumulator -= RegenSystem.TICK_INTERVAL;
      this.tick();
    }
  }

  private tick(): void {
    for (const entity of this.getEntities()) {
      if (entity.dead) continue;

      // Health regen: only out of combat
      if (!entity.inCombat && entity.hp < entity.maxHp) {
        entity.hp = Math.min(entity.maxHp, entity.hp + RegenSystem.REGEN_AMOUNT);
      }

      // Mana regen: only if entity has mana, and 5s since last mana use
      if (entity.maxMana > 0 && entity.mana < entity.maxMana) {
        const timeSinceUse = this.manaUsedTimers.get(entity);
        if (timeSinceUse === undefined || timeSinceUse >= RegenSystem.MANA_REGEN_DELAY) {
          const isResting = this.buffSystem?.hasBuff(entity, 'resting') ?? false;
          const regenAmount = isResting
            ? RegenSystem.REGEN_AMOUNT * RegenSystem.RESTING_MANA_MULTIPLIER
            : RegenSystem.REGEN_AMOUNT;
          entity.mana = Math.min(entity.maxMana, entity.mana + regenAmount);
        }
      }
    }
  }
}
