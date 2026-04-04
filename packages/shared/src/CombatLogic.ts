import type { Ability } from './abilities.js';

// ── Shared types ─────────────────────────────────────────────────────────

export type CombatError = 'no-target' | 'out-of-range' | 'not-facing' | 'on-cooldown' | 'not-enough-mana' | 'dead' | 'not-in-los' | 'stunned' | 'casting' | 'moving' | 'locked';

export interface CombatResult {
  success: boolean;
  error?: CombatError;
  errorMessage?: string;
}

export type CombatTextType = 'damage' | 'heal' | 'crit' | 'miss' | 'dodge' | 'immune';

// ── Shared constants ─────────────────────────────────────────────────────

export const COMBAT_DURATION = 5; // seconds before leaving combat
export const MISS_CHANCE = 0.03; // 3% flat miss chance
export const GOD_MODE_DAMAGE_MULT = 11; // +1000% damage

// ── Pure helper functions ────────────────────────────────────────────────

/** Roll base damage for an ability (variable range or flat). */
export function rollAbilityBaseDamage(ability: Ability): number {
  if (ability.damageMin !== undefined && ability.damageMax !== undefined) {
    return ability.damageMin + Math.floor(
      Math.random() * (ability.damageMax - ability.damageMin + 1)
    );
  }
  return ability.damage;
}

/** Apply conditional bonus damage if the target has the required debuff. */
export function applyBonusDamage(baseDamage: number, ability: Ability, targetHasDebuff: boolean): number {
  if (ability.bonusDamagePercent && ability.bonusDamageRequiresDebuff && targetHasDebuff) {
    return Math.round(baseDamage * (1 + ability.bonusDamagePercent / 100));
  }
  return baseDamage;
}

/** Roll miss check. Returns true if the attack misses. */
export function rollMiss(): boolean {
  return Math.random() < MISS_CHANCE;
}

/** Check if an angle-based facing check passes (120° cone). */
export function isFacingCheck(forwardX: number, forwardZ: number, toTargetX: number, toTargetZ: number): boolean {
  const len = Math.sqrt(toTargetX * toTargetX + toTargetZ * toTargetZ);
  if (len < 0.001) return true;
  const dot = forwardX * (toTargetX / len) + forwardZ * (toTargetZ / len);
  return dot > 0.5; // cos(60°) = 0.5 → 120° cone
}
