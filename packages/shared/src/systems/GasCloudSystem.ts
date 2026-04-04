import type { Positionable } from '../types.js';
import type { BuffDefinition } from '../abilities.js';
import type { BuffSystem } from '../BuffSystem.js';

export interface ActiveGasCloud<T extends Positionable> {
  id: string;
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  duration: number;
  elapsed: number;
  debuff: BuffDefinition;
  damagePerTick: number;
  tickInterval: number;
  nextTickAt: number;
  owner: T;
  affectedTargets: Set<T>;
}

export interface GasCloudCallbacks<T extends Positionable> {
  /** Return {x,y,z} position of the given entity. */
  getPosition(entity: T): { x: number; y: number; z: number };
  /** Return all entities hostile to the cloud owner. */
  getHostileEntities(owner: T): T[];
  /** Return true if this entity should take 0 damage (god mode). */
  isGodModeImmune(entity: T): boolean;
  /** Apply damage absorption / damage-taken multipliers and return the actual damage dealt. */
  processDamageAbsorb(target: T, amount: number, source: T): number;
  /** Enter combat for the given entity. */
  enterCombat(entity: T): void;
  /** Called when a damage tick lands. Platform emits combat events / combat text here. */
  onDamageDealt(source: T, target: T, amount: number): void;
  /** Called when an entity's HP reaches 0 and it dies. */
  onEntityDied(target: T, killer: T): void;
  /** Called when a cloud is removed (duration expired). Platform disposes visuals here. */
  onCloudExpired?(cloud: ActiveGasCloud<T>): void;
}

export class GasCloudSystem<T extends Positionable> {
  readonly clouds: ActiveGasCloud<T>[] = [];

  constructor(
    private readonly buffSystem: BuffSystem<T>,
    private readonly callbacks: GasCloudCallbacks<T>,
    /** If true, buff removal uses silent=true (server behavior). */
    private readonly silentBuffRemoval = false,
  ) {}

  spawn(
    owner: T,
    posX: number, posY: number, posZ: number,
    radius: number,
    duration: number,
    debuff: BuffDefinition,
    totalDamage: number,
    tickInterval: number,
    id = '',
  ): ActiveGasCloud<T> {
    const tickCount = Math.floor(duration / tickInterval);
    const cloud: ActiveGasCloud<T> = {
      id,
      centerX: posX,
      centerY: posY,
      centerZ: posZ,
      radius,
      duration,
      elapsed: 0,
      debuff,
      damagePerTick: Math.round(totalDamage / tickCount),
      tickInterval,
      nextTickAt: tickInterval,
      owner,
      affectedTargets: new Set(),
    };
    this.clouds.push(cloud);
    return cloud;
  }

  update(dt: number): void {
    const cb = this.callbacks;
    const silent = this.silentBuffRemoval;

    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const cloud = this.clouds[i];
      cloud.elapsed += dt;

      // Determine which hostile entities are currently inside the cloud
      const inCloud = new Set<T>();
      const hostiles = cb.getHostileEntities(cloud.owner);
      for (const entity of hostiles) {
        if (entity.dead || this.buffSystem.isUntargetable(entity)) continue;
        const pos = cb.getPosition(entity);
        const dx = pos.x - cloud.centerX;
        const dy = pos.y - cloud.centerY;
        const dz = pos.z - cloud.centerZ;
        if (dx * dx + dy * dy + dz * dz <= cloud.radius * cloud.radius) {
          inCloud.add(entity);
          const isNew = !cloud.affectedTargets.has(entity);
          this.buffSystem.apply(entity, cloud.debuff);
          cloud.affectedTargets.add(entity);
          if (isNew) {
            cb.enterCombat(cloud.owner);
            cb.enterCombat(entity);
          }
        }
      }

      // Remove debuff from entities that left the cloud or died
      for (const entity of cloud.affectedTargets) {
        if (!inCloud.has(entity) || entity.dead) {
          this.buffSystem.remove(entity, cloud.debuff.id, silent);
          cloud.affectedTargets.delete(entity);
        }
      }

      // Discrete damage ticks
      while (cloud.elapsed >= cloud.nextTickAt && cloud.nextTickAt <= cloud.duration) {
        for (const entity of cloud.affectedTargets) {
          if (entity.dead) continue;
          const actualDmg = cb.isGodModeImmune(entity)
            ? 0
            : cb.processDamageAbsorb(entity, cloud.damagePerTick, cloud.owner);
          entity.hp = Math.max(0, entity.hp - actualDmg);
          if (actualDmg > 0) cb.onDamageDealt(cloud.owner, entity, actualDmg);
          cb.enterCombat(entity);
          if (entity.hp <= 0 && !entity.dead) {
            entity.die();
            cb.onEntityDied(entity, cloud.owner);
          }
        }
        cloud.nextTickAt += cloud.tickInterval;
      }

      // Cleanup when duration expires
      if (cloud.elapsed >= cloud.duration) {
        for (const entity of cloud.affectedTargets) {
          this.buffSystem.remove(entity, cloud.debuff.id, silent);
        }
        cb.onCloudExpired?.(cloud);
        this.clouds.splice(i, 1);
      }
    }
  }

  clear(): void {
    for (const cloud of this.clouds) {
      for (const entity of cloud.affectedTargets) {
        this.buffSystem.remove(entity, cloud.debuff.id, this.silentBuffRemoval);
      }
      this.callbacks.onCloudExpired?.(cloud);
    }
    this.clouds.length = 0;
  }
}
