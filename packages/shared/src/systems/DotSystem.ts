import type { Positionable } from '../types.js';
import type { BuffDefinition } from '../abilities.js';

export interface ActiveDot<T extends Positionable> {
  target: T;
  debuff: BuffDefinition;
  totalDuration: number;
  elapsed: number;
  tickInterval: number;
  nextTickAt: number;
  damagePerTick: number;
  owner: T;
}

export interface DotCallbacks<T extends Positionable> {
  isGodModeImmune(entity: T): boolean;
  processDamageAbsorb(target: T, amount: number, source: T): number;
  enterCombat(entity: T): void;
  onDamageDealt(source: T, target: T, amount: number): void;
  onEntityDied(target: T, killer: T): void;
}

export class DotSystem<T extends Positionable> {
  readonly dots: ActiveDot<T>[] = [];

  constructor(private readonly callbacks: DotCallbacks<T>) {}

  add(dot: ActiveDot<T>): void {
    this.dots.push(dot);
  }

  update(dt: number): void {
    const cb = this.callbacks;

    for (let i = this.dots.length - 1; i >= 0; i--) {
      const dot = this.dots[i];
      dot.elapsed += dt;

      while (dot.elapsed >= dot.nextTickAt && dot.nextTickAt <= dot.totalDuration) {
        if (!dot.target.dead) {
          const actualDmg = cb.isGodModeImmune(dot.target)
            ? 0
            : cb.processDamageAbsorb(dot.target, dot.damagePerTick, dot.owner);
          dot.target.hp = Math.max(0, dot.target.hp - actualDmg);
          if (actualDmg > 0) cb.onDamageDealt(dot.owner, dot.target, actualDmg);
          cb.enterCombat(dot.target);
          if (dot.target.hp <= 0 && !dot.target.dead) {
            dot.target.die();
            cb.onEntityDied(dot.target, dot.owner);
          }
        }
        dot.nextTickAt += dot.tickInterval;
      }

      if (dot.elapsed >= dot.totalDuration || dot.target.dead) {
        this.dots.splice(i, 1);
      }
    }
  }

  removeByTarget(target: T): void {
    for (let i = this.dots.length - 1; i >= 0; i--) {
      if (this.dots[i].target === target) {
        this.dots.splice(i, 1);
      }
    }
  }

  clear(): void {
    this.dots.length = 0;
  }
}
