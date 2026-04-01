import { getCharacterStats, yardsToUnits } from '@gtr/shared';
import type { CharacterBehavior, ScoredAction } from './BaseBehavior';
import type { WorldState, EntityInfo } from '../WorldState';
import type { NpcCooldownTracker } from '../NpcCooldownTracker';
import type { DifficultyProfile } from '../DifficultyProfile';
import type { MovementIntent } from '../MovementController';

const MELEE_RANGE = yardsToUnits(3);

export class CrackheadBehavior implements CharacterBehavior {
  readonly characterId = 'crackhead' as const;
  private readonly attackRange: number;

  constructor() {
    this.attackRange = getCharacterStats('crackhead').autoAttackRange;
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
    const selfHpPct = world.self.hpPercent;
    const targetDist = currentTarget.distance;
    const targetHpPct = currentTarget.hpPercent;

    // ── Shank (melee, +50% from behind) ──
    if (cooldowns.isReady('shank') && selfMana >= 145 && targetDist <= MELEE_RANGE) {
      let score = 30;
      // Much higher when behind target (backstab bonus)
      if (currentTarget.iAmBehindThem) score += 50;
      // Penalize frontal shanks — better to reposition first
      if (!currentTarget.iAmBehindThem && currentTarget.facingMe) score -= 10;
      if (currentTarget.inLineOfSight) {
        actions.push({
          type: 'ability', score, abilityId: 'shank', target: currentTarget,
          execute: () => {},
        });
      }
    }

    // ── Pocket Sand (blind 4s) ──
    if (cooldowns.isReady('pocket-sand') && selfMana >= 175 && targetDist <= yardsToUnits(10)) {
      let score = 25;
      // Good for setting up dumpster dive escape
      if (selfHpPct < 0.35) score += 30;
      // Good for peeling
      if (currentTarget.isCasting || currentTarget.isChanneling) score += 20;
      // Don't blind already CC'd targets
      if (currentTarget.isStunned || currentTarget.isSleeping || currentTarget.isBlinded) score -= 40;
      if (currentTarget.inLineOfSight) {
        actions.push({
          type: 'ability', score, abilityId: 'pocket-sand', target: currentTarget,
          execute: () => {},
        });
      }
    }

    // ── Sticky Fingers (steal buff/mana) ──
    if (cooldowns.isReady('sticky-fingers') && selfMana >= 100 && targetDist <= MELEE_RANGE) {
      let score = 20;
      // Much higher if target has stealable buffs
      const stealableBuffs = currentTarget.buffs.filter(b => !b.definition.unremovable);
      if (stealableBuffs.length > 0) score += 40;
      if (currentTarget.inLineOfSight) {
        actions.push({
          type: 'ability', score, abilityId: 'sticky-fingers', target: currentTarget,
          execute: () => {},
        });
      }
    }

    // ── Crack Rock (heal 400 + speed) ──
    if (cooldowns.isReady('crack-rock') && selfMana >= 150) {
      let score = 10;
      // Score scales with missing HP
      if (selfHpPct < 0.7) score += 20;
      if (selfHpPct < 0.5) score += 30;
      if (selfHpPct < 0.3) score += 40;
      actions.push({
        type: 'ability', score, abilityId: 'crack-rock',
        execute: () => {},
      });
    }

    // ── Dumpster Dive (vanish, escape) ──
    if (cooldowns.isReady('dumpster-dive') && selfMana >= 80) {
      // Only use when enemies are nearby and we're under pressure
      const enemiesNearby = world.enemies.some(e => e.distance <= yardsToUnits(10));
      if (enemiesNearby && selfHpPct < 0.35) {
        let score = 15;
        // Defensive — high score when low HP
        if (selfHpPct < 0.25) score += 50;
        if (selfHpPct < 0.15) score += 40;
        // Don't use when target is about to die
        if (targetHpPct < 0.2) score -= 30;
        actions.push({
          type: 'ability', score, abilityId: 'dumpster-dive',
          execute: () => {},
        });
      }
    }

    // ── Gank (execute, resets if target < 30% HP) ──
    if (cooldowns.isReady('gank') && selfMana >= 100 && targetDist <= MELEE_RANGE) {
      let score = 35;
      // Massive score if target is low (execute threshold)
      if (targetHpPct < 0.30) score += 80; // execute range = highest priority
      if (targetHpPct < 0.50) score += 20;
      if (currentTarget.isStunned) score += 15;
      if (currentTarget.inLineOfSight) {
        actions.push({
          type: 'ability', score, abilityId: 'gank', target: currentTarget,
          execute: () => {},
        });
      }
    }

    // ── Tweaker Sprint (targeted dash gap-closer) ──
    if (cooldowns.isReady('tweaker-sprint') && selfMana >= 115 && targetDist >= yardsToUnits(5) && targetDist <= yardsToUnits(15)) {
      let score = 35;
      // Great gap closer to reach target
      if (targetDist > yardsToUnits(8)) score += 25;
      // Even better if target is low HP (close the gap to finish)
      if (targetHpPct < 0.3) score += 20;
      if (currentTarget.inLineOfSight) {
        actions.push({
          type: 'ability', score, abilityId: 'tweaker-sprint', target: currentTarget,
          execute: () => {},
        });
      }
    }

    // ── OD (mega burst, then crash) ──
    if (cooldowns.isReady('od') && selfMana >= 200 && targetDist <= MELEE_RANGE) {
      let score = 15;
      // Best when target is locked down and we can burst
      if (currentTarget.isStunned) score += 40;
      // Better at higher HP (we'll be stunned after)
      if (selfHpPct > 0.6) score += 15;
      if (selfHpPct < 0.3) score -= 20; // risky when low
      if (currentTarget.inLineOfSight) {
        actions.push({
          type: 'ability', score, abilityId: 'od',
          execute: () => {},
        });
      }
    }

    return actions;
  }

  getDesiredRange(): number {
    return this.attackRange;
  }

  getMovementIntent(world: WorldState, currentTarget: EntityInfo | null): MovementIntent {
    if (!currentTarget) return { type: 'idle' };

    // If low HP and dumpster diving is on cooldown, try to kite briefly
    if (world.self.hpPercent < 0.2 && currentTarget.distance < yardsToUnits(5)) {
      return {
        type: 'kiteFrom',
        threat: currentTarget.position,
        maxRange: yardsToUnits(10),
        preferredRange: yardsToUnits(8),
      };
    }

    // In melee range: circle-strafe to get behind target (backstab positioning)
    if (currentTarget.distance <= this.attackRange && !currentTarget.iAmBehindThem) {
      return {
        type: 'strafeAround',
        center: currentTarget.position,
        clockwise: true,
        radius: this.attackRange * 0.7,
      };
    }

    // Otherwise, chase to melee range
    return {
      type: 'moveToward',
      target: currentTarget.position,
      stopDistance: this.attackRange * 0.85,
    };
  }
}
