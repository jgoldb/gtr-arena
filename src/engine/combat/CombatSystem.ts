import * as THREE from 'three';
import type { Ability } from './Ability';
import type { Targetable } from '../types';
import type { RegenSystem } from './RegenSystem';

export type CombatError = 'no-target' | 'out-of-range' | 'not-facing' | 'on-cooldown' | 'not-enough-mana' | 'dead';

export interface CombatResult {
  success: boolean;
  error?: CombatError;
  errorMessage?: string;
}

export class CombatSystem {
  private cooldowns = new Map<string, number>(); // ability id → remaining seconds
  private static readonly COMBAT_DURATION = 5; // seconds before leaving combat
  private combatTimers = new Map<Targetable, number>(); // entity → seconds remaining
  private regenSystem: RegenSystem;

  constructor(regenSystem: RegenSystem) {
    this.regenSystem = regenSystem;
  }

  enterCombat(entity: Targetable): void {
    if (entity.dead) return;
    entity.inCombat = true;
    this.combatTimers.set(entity, CombatSystem.COMBAT_DURATION);
  }

  isInCombat(entity: Targetable): boolean {
    return this.combatTimers.has(entity);
  }

  /** Check facing: is attacker looking roughly toward the target? (120° cone) */
  private isFacing(
    attackerPos: THREE.Vector3,
    attackerRotY: number,
    targetPos: THREE.Vector3
  ): boolean {
    const toTarget = new THREE.Vector3()
      .subVectors(targetPos, attackerPos)
      .normalize();
    // Player forward is along +Z in local space, rotated by mesh.rotation.y
    const forward = new THREE.Vector3(
      Math.sin(attackerRotY),
      0,
      Math.cos(attackerRotY)
    );
    const dot = forward.dot(new THREE.Vector3(toTarget.x, 0, toTarget.z).normalize());
    // cos(60°) = 0.5 → 120° cone in front
    return dot > 0.5;
  }

  private getDistance(a: THREE.Vector3, b: THREE.Vector3): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  update(dt: number): void {
    for (const [id, remaining] of this.cooldowns) {
      const next = remaining - dt;
      if (next <= 0) {
        this.cooldowns.delete(id);
      } else {
        this.cooldowns.set(id, next);
      }
    }

    for (const [entity, remaining] of this.combatTimers) {
      if (entity.dead) {
        this.combatTimers.delete(entity);
        continue;
      }
      const next = remaining - dt;
      if (next <= 0) {
        this.combatTimers.delete(entity);
        entity.inCombat = false;
      } else {
        this.combatTimers.set(entity, next);
      }
    }
  }

  getCooldownRemaining(abilityId: string): number {
    return this.cooldowns.get(abilityId) ?? 0;
  }

  useAbility(
    ability: Ability,
    attacker: Targetable,
    attackerRotY: number,
    target: Targetable | null
  ): CombatResult {
    // Dead checks
    if (attacker.dead) {
      return { success: false, error: 'dead', errorMessage: 'You are dead' };
    }
    if (target?.dead) {
      return { success: false, error: 'dead', errorMessage: 'Target is dead' };
    }

    // Check cooldown
    if (this.cooldowns.has(ability.id)) {
      return { success: false, error: 'on-cooldown', errorMessage: 'Ability is not ready yet' };
    }

    // Check target requirement
    if (ability.requiresHostileTarget) {
      if (!target || !target.hostile) {
        return { success: false, error: 'no-target', errorMessage: 'No hostile target' };
      }
    }

    // Check mana
    if (attacker.mana < ability.manaCost) {
      return { success: false, error: 'not-enough-mana', errorMessage: 'Not enough mana' };
    }

    // Check range
    if (target) {
      const dist = this.getDistance(attacker.mesh.position, target.mesh.position);
      if (dist > ability.range) {
        return { success: false, error: 'out-of-range', errorMessage: 'Out of range' };
      }

      // Check facing
      if (!this.isFacing(attacker.mesh.position, attackerRotY, target.mesh.position)) {
        return { success: false, error: 'not-facing', errorMessage: 'Not facing target' };
      }
    }

    // Success — apply effects
    attacker.mana -= ability.manaCost;
    if (ability.manaCost > 0) {
      this.regenSystem.notifyManaUsed(attacker);
    }
    if (target) {
      target.hp = Math.max(0, target.hp - ability.damage);

      // Check for kill
      if (target.hp <= 0 && !target.dead) {
        target.die();
        this.combatTimers.delete(target);
      }

      // Combat entry rules
      if (target.hostile) {
        // Hostile action: both characters enter combat
        this.enterCombat(attacker);
        this.enterCombat(target);
      } else if (target.inCombat) {
        // Friendly action on an in-combat ally: initiator enters combat
        this.enterCombat(attacker);
      }
    }
    this.cooldowns.set(ability.id, ability.cooldown);

    return { success: true };
  }
}
