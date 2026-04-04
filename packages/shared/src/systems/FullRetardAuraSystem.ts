import type { Positionable } from '../types.js';
import type { BuffSystem } from '../BuffSystem.js';

export interface ActiveAura<T extends Positionable> {
  entity: T;
  elapsed: number;
  nextTickAt: number;
}

export interface FullRetardAuraCallbacks<T extends Positionable> {
  getPosition(entity: T): { x: number; y: number; z: number };
  getAllEntities(): T[];
  isGodModeImmune(entity: T): boolean;
  processDamageAbsorb(target: T, amount: number, source: T): number;
  enterCombat(entity: T): void;
  applyHeal(source: T, target: T, amount: number): void;
  onDamageDealt(source: T, target: T, amount: number): void;
  onEntityDied(target: T, killer: T): void;
  onAuraStarted?(entity: T): void;
  onAuraStopped?(entity: T): void;
}

const BUFF_ID = 'full-retard';
const TICK_INTERVAL = 1;
const DAMAGE_PER_TICK = 200;
const SELF_HEAL = 125;
const ALLY_HEAL = 300;

export class FullRetardAuraSystem<T extends Positionable> {
  readonly auras = new Map<T, ActiveAura<T>>();

  constructor(
    private readonly buffSystem: BuffSystem<T>,
    private readonly callbacks: FullRetardAuraCallbacks<T>,
  ) {}

  update(dt: number): void {
    const cb = this.callbacks;
    const entities = cb.getAllEntities();

    // Sync auras with buff state
    for (const entity of entities) {
      const hasBuff = this.buffSystem.hasBuff(entity, BUFF_ID);
      const hasAura = this.auras.has(entity);

      if (hasBuff && !hasAura) {
        this.auras.set(entity, { entity, elapsed: 0, nextTickAt: TICK_INTERVAL });
        cb.onAuraStarted?.(entity);
      } else if (!hasBuff && hasAura) {
        this.auras.delete(entity);
        cb.onAuraStopped?.(entity);
      }
    }

    // Process ticks
    for (const aura of this.auras.values()) {
      aura.elapsed += dt;
      const ownerPos = cb.getPosition(aura.entity);
      const meleeRange = aura.entity.autoAttackRange;
      const rangeSq = meleeRange * meleeRange;

      while (aura.elapsed >= aura.nextTickAt) {
        // Damage hostiles in melee range
        for (const other of entities) {
          if (other.dead || !other.isHostileTo(aura.entity) || this.buffSystem.isUntargetable(other)) continue;
          const otherPos = cb.getPosition(other);
          const dx = ownerPos.x - otherPos.x;
          const dz = ownerPos.z - otherPos.z;
          if (dx * dx + dz * dz > rangeSq) continue;

          const dmg = cb.isGodModeImmune(other)
            ? 0
            : cb.processDamageAbsorb(other, DAMAGE_PER_TICK, aura.entity);
          other.hp = Math.max(0, other.hp - dmg);
          if (dmg > 0) cb.onDamageDealt(aura.entity, other, dmg);
          cb.enterCombat(aura.entity);
          cb.enterCombat(other);
          if (other.hp <= 0 && !other.dead) {
            other.die();
            cb.onEntityDied(other, aura.entity);
          }
        }

        // Heal friendlies in melee range (self = 125, allies = 300)
        for (const other of entities) {
          if (other.dead || other.isHostileTo(aura.entity)) continue;
          const otherPos = cb.getPosition(other);
          const dx = ownerPos.x - otherPos.x;
          const dz = ownerPos.z - otherPos.z;
          if (dx * dx + dz * dz > rangeSq) continue;

          const heal = other === aura.entity ? SELF_HEAL : ALLY_HEAL;
          cb.applyHeal(aura.entity, other, heal);
        }

        aura.nextTickAt += TICK_INTERVAL;
      }
    }
  }

  clear(): void {
    const cb = this.callbacks;
    for (const aura of this.auras.values()) {
      cb.onAuraStopped?.(aura.entity);
    }
    this.auras.clear();
  }
}
