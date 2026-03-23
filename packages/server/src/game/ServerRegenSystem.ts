import { REGEN_TICK_INTERVAL, MANA_REGEN_DELAY, RESTING_MANA_MULTIPLIER, getCharacterStats } from '@gtr/shared';
import type { ServerEntity } from './ServerEntity.js';
import type { ServerBuffSystem } from './ServerBuffSystem.js';

export class ServerRegenSystem {

  private tickAccumulator = 0;
  private manaUsedTimers = new Map<ServerEntity, number>();
  private getEntities: () => ServerEntity[];
  private buffSystem: ServerBuffSystem | null = null;

  constructor(getEntities: () => ServerEntity[]) {
    this.getEntities = getEntities;
  }

  setBuffSystem(buffSystem: ServerBuffSystem): void {
    this.buffSystem = buffSystem;
  }

  notifyManaUsed(entity: ServerEntity): void {
    this.manaUsedTimers.set(entity, 0);
  }

  update(dt: number): void {
    for (const [entity, elapsed] of this.manaUsedTimers) {
      this.manaUsedTimers.set(entity, elapsed + dt);
    }

    this.tickAccumulator += dt;
    while (this.tickAccumulator >= REGEN_TICK_INTERVAL) {
      this.tickAccumulator -= REGEN_TICK_INTERVAL;
      this.tick();
    }
  }

  private tick(): void {
    for (const entity of this.getEntities()) {
      if (entity.dead) continue;

      const stats = getCharacterStats(entity.characterId);

      if (!entity.inCombat && entity.hp < entity.maxHp) {
        entity.hp = Math.min(entity.maxHp, entity.hp + stats.hpRegen);
      }

      if (entity.maxMana > 0 && entity.mana < entity.maxMana) {
        const timeSinceUse = this.manaUsedTimers.get(entity);
        if (timeSinceUse === undefined || timeSinceUse >= MANA_REGEN_DELAY) {
          const isResting = this.buffSystem?.hasBuff(entity, 'resting') ?? false;
          const regenAmount = isResting
            ? stats.manaRegen * RESTING_MANA_MULTIPLIER
            : stats.manaRegen;
          entity.mana = Math.min(entity.maxMana, entity.mana + regenAmount);
        }
      }
    }
  }
}
