import { getCharacterStats, yardsToUnits, JanitorsHelper } from '@gtr/shared';
import type { CharacterBehavior, ScoredAction } from './BaseBehavior';
import type { WorldState, EntityInfo } from '../WorldState';
import type { NpcCooldownTracker } from '../NpcCooldownTracker';
import type { DifficultyProfile } from '../DifficultyProfile';
import type { MovementIntent } from '../MovementController';

const MELEE_RANGE = yardsToUnits(3);

export class JanitorBehavior implements CharacterBehavior {
  readonly characterId = 'janitor' as const;
  private readonly attackRange: number;

  constructor() {
    this.attackRange = getCharacterStats('janitor').autoAttackRange;
  }

  scoreActions(
    world: WorldState,
    cooldowns: NpcCooldownTracker,
    difficulty: DifficultyProfile,
    currentTarget: EntityInfo | null
  ): ScoredAction[] {
    const actions: ScoredAction[] = [];
    if (!currentTarget) return actions;

    const selfMana = world.self.entity.mana;
    const targetDist = currentTarget.distance;
    const targetHasDebuff = (id: string) => currentTarget.debuffs.some(b => b.definition.id === id);

    // ── Bucket Splash (ranged debuff, sets up Mop combo) ──
    if (cooldowns.isReady('bucket-splash') && selfMana >= 65) {
      let score = 30;
      // Much higher score if target doesn't have the debuff yet (setup)
      if (!targetHasDebuff('covered-in-piss')) score += 40;
      else score -= 20; // already has it, low priority
      // Only if in range
      if (targetDist <= yardsToUnits(10) && currentTarget.inLineOfSight) {
        actions.push({
          type: 'ability', score, abilityId: 'bucket-splash', target: currentTarget,
          execute: () => {},
        });
      }
    }

    // ── Mop (melee, bonus damage on debuffed target) ──
    if (cooldowns.isReady('mop') && selfMana >= 30 && targetDist <= MELEE_RANGE) {
      let score = 35;
      // Much higher if target has Covered in Piss (+125% damage)
      if (targetHasDebuff('covered-in-piss')) score += 50;
      if (currentTarget.inLineOfSight) {
        actions.push({
          type: 'ability', score, abilityId: 'mop', target: currentTarget,
          execute: () => {},
        });
      }
    }

    // ── Big Boot (3s stun) ──
    if (cooldowns.isReady('big-boot') && selfMana >= 180 && targetDist <= MELEE_RANGE) {
      let score = 25;
      // Very high score to interrupt channels/casts
      if (currentTarget.isChanneling || currentTarget.isCasting) {
        score += 60 * difficulty.interruptChance;
      }
      // Good setup for burst
      if (currentTarget.hpPercent < 0.5) score += 15;
      if (currentTarget.inLineOfSight) {
        actions.push({
          type: 'ability', score, abilityId: 'big-boot', target: currentTarget,
          execute: () => {},
        });
      }
    }

    // ── Fart Bomb (self-centered AoE DoT + slow) ──
    if (cooldowns.isReady('fart-bomb') && selfMana >= 140) {
      let score = 20;
      // Count nearby enemies
      const nearbyEnemies = world.enemies.filter(e => e.distance <= yardsToUnits(5));
      score += nearbyEnemies.length * 15;
      if (nearbyEnemies.length === 0) score = 0; // No point if nobody is close
      actions.push({
        type: 'ability', score, abilityId: 'fart-bomb',
        execute: () => {},
      });
    }

    // ── Crash Out (+300% auto-attack speed) ──
    if (cooldowns.isReady('crash-out') && selfMana >= 280) {
      let score = 15;
      // Best used when target is stunned or debuffed (burst window)
      if (currentTarget.isStunned) score += 30;
      if (targetHasDebuff('covered-in-piss')) score += 25;
      // Better when we're at high HP (aggressive play)
      if (world.self.hpPercent > 0.6) score += 10;
      // Less useful at low HP (defensive)
      if (world.self.hpPercent < 0.3) score -= 20;
      if (targetDist <= MELEE_RANGE) {
        actions.push({
          type: 'ability', score, abilityId: 'crash-out',
          execute: () => {},
        });
      }
    }

    // ── Jimmy Legs (slow, or root if already slowed) ──
    if (cooldowns.isReady('jimmy-legs') && selfMana >= 100 && targetDist <= MELEE_RANGE) {
      let score = 30;
      // Higher if target already has Jimmy Legs (root upgrade)
      if (targetHasDebuff('jimmy-legs')) score += 35;
      // Good for chasing
      if (targetDist > this.attackRange * 1.5) score += 15;
      if (currentTarget.inLineOfSight) {
        actions.push({
          type: 'ability', score, abilityId: 'jimmy-legs', target: currentTarget,
          execute: () => {},
        });
      }
    }

    // ── Janitor's Helper (0.5s cast, sleep 10s) ──
    if (cooldowns.isReady('janitors-helper') && selfMana >= 175 && targetDist <= MELEE_RANGE) {
      let score = 25;
      // Don't use on already CC'd targets
      if (currentTarget.isStunned || currentTarget.isSleeping || currentTarget.isBlinded) score -= 40;
      // Good for CC chaining or peeling
      if (currentTarget.hpPercent > 0.5) score += 10; // better on high HP targets (control)
      if (currentTarget.inLineOfSight) {
        actions.push({
          type: 'ability', score, abilityId: 'janitors-helper', target: currentTarget,
          ability: JanitorsHelper, isCastTime: true,
          execute: () => {},
        });
      }
    }

    // ── Sweep (charge gap-closer) ──
    if (cooldowns.isReady('sweep') && selfMana >= 130) {
      let score = 20;
      // Great gap closer when target is far
      if (targetDist > yardsToUnits(8)) score += 40;
      if (targetDist > yardsToUnits(12)) score += 20;
      // Not useful in melee
      if (targetDist <= MELEE_RANGE) score -= 30;
      if (currentTarget.inLineOfSight) {
        actions.push({
          type: 'ability', score, abilityId: 'sweep', target: currentTarget,
          execute: () => {},
        });
      }
    }

    // ── PvP Trinket (break CC) ──
    if (cooldowns.isReady('pvp-trinket') && (world.self.isStunned || world.self.isSleeping || world.self.isBlinded)) {
      actions.push({
        type: 'ability', score: 200, abilityId: 'pvp-trinket',
        execute: () => {},
      });
    }

    return actions;
  }

  getDesiredRange(): number {
    return this.attackRange;
  }

  getMovementIntent(_world: WorldState, currentTarget: EntityInfo | null): MovementIntent {
    if (!currentTarget) return { type: 'idle' };
    return {
      type: 'moveToward',
      target: currentTarget.position,
      stopDistance: this.attackRange * 0.85,
    };
  }
}
