import type { Positionable } from '../types.js';
import type { BuffDefinition } from '../abilities.js';
import type { BuffSystem } from '../BuffSystem.js';
import type { DotSystem } from './DotSystem.js';

export interface ActiveChemicalPool<T extends Positionable> {
  id: string;
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  duration: number;
  elapsed: number;
  speedBuff: BuffDefinition;
  dot: BuffDefinition;
  initialDamageMin: number;
  initialDamageMax: number;
  dotDamagePerTick: number;
  dotTickInterval: number;
  dotDuration: number;
  owner: T;
  activationDelay: number;
  consumed: boolean;
}

export interface ChemPoolCallbacks<T extends Positionable> {
  getPosition(entity: T): { x: number; y: number; z: number };
  /** Return all entities that could be affected (hostile AND friendly). */
  getAllEntities(owner: T): T[];
  isGodModeImmune(entity: T): boolean;
  processDamageAbsorb(target: T, amount: number, source: T): number;
  enterCombat(entity: T): void;
  onDamageDealt(source: T, target: T, amount: number): void;
  onEntityDied(target: T, killer: T): void;
  /** Called when a pool is consumed (triggered). */
  onPoolConsumed?(pool: ActiveChemicalPool<T>, triggeredBy: T): void;
  /** Called when a pool is removed (duration expired or consumed cleanup). */
  onPoolExpired?(pool: ActiveChemicalPool<T>): void;
}

export class ChemicalPoolSystem<T extends Positionable> {
  readonly pools: ActiveChemicalPool<T>[] = [];

  constructor(
    private readonly buffSystem: BuffSystem<T>,
    private readonly dotSystem: DotSystem<T>,
    private readonly callbacks: ChemPoolCallbacks<T>,
    private readonly silentBuffRemoval = false,
  ) {}

  spawn(
    owner: T,
    posX: number, posY: number, posZ: number,
    radius: number, duration: number,
    speedBuff: BuffDefinition, dot: BuffDefinition,
    initialDamageMin: number, initialDamageMax: number,
    dotTotalDamage: number, dotTickInterval: number, dotDuration: number,
    activationDelay: number,
    id = '',
  ): ActiveChemicalPool<T> {
    const dotTickCount = Math.floor(dotDuration / dotTickInterval);
    const pool: ActiveChemicalPool<T> = {
      id,
      centerX: posX, centerY: posY, centerZ: posZ,
      radius, duration, elapsed: 0,
      speedBuff, dot,
      initialDamageMin, initialDamageMax,
      dotDamagePerTick: Math.round(dotTotalDamage / dotTickCount),
      dotTickInterval, dotDuration,
      owner, activationDelay, consumed: false,
    };
    this.pools.push(pool);
    return pool;
  }

  update(dt: number): void {
    const cb = this.callbacks;

    for (let i = this.pools.length - 1; i >= 0; i--) {
      const pool = this.pools[i];
      pool.elapsed += dt;

      if (pool.consumed || pool.elapsed >= pool.duration) {
        cb.onPoolExpired?.(pool);
        this.pools.splice(i, 1);
        continue;
      }

      if (pool.elapsed < pool.activationDelay) continue;

      const entities = cb.getAllEntities(pool.owner);
      for (const entity of entities) {
        if (entity.dead || this.buffSystem.isUntargetable(entity)) continue;
        const pos = cb.getPosition(entity);
        const dx = pos.x - pool.centerX;
        const dy = pos.y - pool.centerY;
        const dz = pos.z - pool.centerZ;
        if (dx * dx + dy * dy + dz * dz > pool.radius * pool.radius) continue;

        if (entity.isHostileTo(pool.owner)) {
          // Hostile: initial damage + apply DoT
          const rolledDmg = pool.initialDamageMin + Math.floor(Math.random() * (pool.initialDamageMax - pool.initialDamageMin + 1));
          const actualDmg = cb.isGodModeImmune(entity)
            ? 0
            : cb.processDamageAbsorb(entity, rolledDmg, pool.owner);
          entity.hp = Math.max(0, entity.hp - actualDmg);
          if (actualDmg > 0) cb.onDamageDealt(pool.owner, entity, actualDmg);
          cb.enterCombat(pool.owner);
          cb.enterCombat(entity);
          if (entity.hp <= 0 && !entity.dead) {
            entity.die();
            cb.onEntityDied(entity, pool.owner);
          } else {
            this.buffSystem.apply(entity, pool.dot);
            this.dotSystem.add({
              target: entity, debuff: pool.dot,
              totalDuration: pool.dotDuration, elapsed: 0,
              tickInterval: pool.dotTickInterval, nextTickAt: pool.dotTickInterval,
              damagePerTick: pool.dotDamagePerTick, owner: pool.owner,
            });
          }
        } else {
          // Friendly: apply speed buff
          this.buffSystem.apply(entity, pool.speedBuff);
        }

        pool.consumed = true;
        cb.onPoolConsumed?.(pool, entity);
        break;
      }
    }
  }

  clear(): void {
    for (const pool of this.pools) {
      this.callbacks.onPoolExpired?.(pool);
    }
    this.pools.length = 0;
  }
}
