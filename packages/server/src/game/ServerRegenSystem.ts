import type { ServerEntity } from './ServerEntity.js';
import type { ServerBuffSystem } from './ServerBuffSystem.js';

export class ServerRegenSystem {
  private static readonly TICK_INTERVAL = 2.5;
  private static readonly REGEN_AMOUNT = 2;
  private static readonly MANA_REGEN_DELAY = 5;
  private static readonly RESTING_MANA_MULTIPLIER = 4; // 300% increase = 4x total

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
    while (this.tickAccumulator >= ServerRegenSystem.TICK_INTERVAL) {
      this.tickAccumulator -= ServerRegenSystem.TICK_INTERVAL;
      this.tick();
    }
  }

  private tick(): void {
    for (const entity of this.getEntities()) {
      if (entity.dead) continue;

      if (!entity.inCombat && entity.hp < entity.maxHp) {
        entity.hp = Math.min(entity.maxHp, entity.hp + ServerRegenSystem.REGEN_AMOUNT);
      }

      if (entity.maxMana > 0 && entity.mana < entity.maxMana) {
        const timeSinceUse = this.manaUsedTimers.get(entity);
        if (timeSinceUse === undefined || timeSinceUse >= ServerRegenSystem.MANA_REGEN_DELAY) {
          const isResting = this.buffSystem?.hasBuff(entity, 'resting') ?? false;
          const regenAmount = isResting
            ? ServerRegenSystem.REGEN_AMOUNT * ServerRegenSystem.RESTING_MANA_MULTIPLIER
            : ServerRegenSystem.REGEN_AMOUNT;
          entity.mana = Math.min(entity.maxMana, entity.mana + regenAmount);
        }
      }
    }
  }
}
