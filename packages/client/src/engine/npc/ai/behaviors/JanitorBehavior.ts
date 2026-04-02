import { getCharacterStats, yardsToUnits, JanitorsHelper, Sweep } from '@gtr/shared';
import type { CharacterBehavior, ScoredAction } from './BaseBehavior';
import type { WorldState, EntityInfo } from '../WorldState';
import type { NpcCooldownTracker } from '../NpcCooldownTracker';
import type { DifficultyProfile } from '../DifficultyProfile';
import type { MovementIntent } from '../MovementController';

const MELEE_RANGE = yardsToUnits(3);
const SWEEP_CHARGE_YARDS = 28 * Sweep.chargeDuration!;  // ~20 yards
const SWEEP_CHARGE_SPEED_YDS = 28;

export class JanitorBehavior implements CharacterBehavior {
  readonly characterId = 'janitor' as const;
  private readonly attackRange: number;

  // Target velocity tracking for sweep aim leading
  private lastTargetX = 0;
  private lastTargetZ = 0;
  private lastTargetTime = 0;
  private targetVelX = 0;
  private targetVelZ = 0;

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
      let score = 45;
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
      const nearbyEnemies = world.enemies.filter(e => e.distance <= yardsToUnits(5));
      if (nearbyEnemies.length > 0) {
        let score = 30;
        score += nearbyEnemies.length * 15;
        actions.push({
          type: 'ability', score, abilityId: 'fart-bomb',
          execute: () => {},
        });
      }
    }

    // ── Crash Out (+300% auto-attack speed) ──
    if (cooldowns.isReady('crash-out') && selfMana >= 280 && targetDist <= MELEE_RANGE) {
      let score = 30;
      // Best used when target is stunned or debuffed (burst window)
      if (currentTarget.isStunned) score += 30;
      if (targetHasDebuff('covered-in-piss')) score += 25;
      // Better when we're at high HP (aggressive play)
      if (world.self.hpPercent > 0.6) score += 10;
      // Less useful at low HP (defensive)
      if (world.self.hpPercent < 0.3) score -= 20;
      actions.push({
        type: 'ability', score, abilityId: 'crash-out',
        execute: () => {},
      });
    }

    // ── Jimmy Legs (slow, or root if already slowed) ──
    if (cooldowns.isReady('jimmy-legs') && selfMana >= 100 && targetDist <= MELEE_RANGE) {
      let score = 40;
      // Higher if target already has Jimmy Legs (root upgrade)
      if (targetHasDebuff('jimmy-legs')) score += 35;
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

    // ── Sweep (charge gap-closer, max damage at ~20yd) ──
    // Difficulty-aware: Master aims perfectly and only uses at optimal range;
    // Easy uses it at bad distances and with poor aim.
    if (cooldowns.isReady('sweep') && selfMana >= 130) {
      // Update target velocity tracking for aim prediction
      const now = performance.now() * 0.001;
      const tdt = now - this.lastTargetTime;
      if (this.lastTargetTime > 0 && tdt > 0.01 && tdt < 2) {
        this.targetVelX = (currentTarget.position.x - this.lastTargetX) / tdt;
        this.targetVelZ = (currentTarget.position.z - this.lastTargetZ) / tdt;
      }
      this.lastTargetX = currentTarget.position.x;
      this.lastTargetZ = currentTarget.position.z;
      this.lastTargetTime = now;

      const distYards = targetDist / yardsToUnits(1);

      // sweepSkill: 0 (hopeless) → 1 (perfect).  Derived from wastefulness:
      //   easy 0.3, medium 0.6, hard 0.85, expert 0.98, master 1.0
      const sweepSkill = 1 - difficulty.wastefulness;

      // Optimal distance: charge ~20 yd, end just before the target center so the
      // sweep path connects, the AoE burst lands, and the NPC faces the target.
      const optimalDist = SWEEP_CHARGE_YARDS + 0.25;

      // Distance window is centered on optimalDist.  Master waits until it's
      // within ~1 yd of optimal before firing; easy fires from any distance.
      //   master: ±1 yd  →  19.25-21.25 yd
      //   easy:   ±11 yd →   9.25-31.25 yd
      const halfWindow = 1 + (1 - sweepSkill) * 14;
      const minDist = Math.max(2, optimalDist - halfWindow);
      const maxDist = optimalDist + halfWindow;

      if (distYards >= minDist && distYards <= maxDist && currentTarget.inLineOfSight) {
        const distFromOptimal = Math.abs(distYards - optimalDist);

        // Score peaks sharply for skilled NPCs, stays flat for unskilled
        const sharpness = 1 + sweepSkill * 4;
        let score = Math.max(5, 90 - distFromOptimal * sharpness);

        // ── Aim leading based on difficulty ──
        const npcPos = world.self.position;
        const timeToReach = Math.min(distYards / SWEEP_CHARGE_SPEED_YDS, Sweep.chargeDuration!);

        // Predict where the target will be when the sweep arrives
        const leadFactor = sweepSkill; // 0 = no leading, 1 = perfect leading
        const predictedX = currentTarget.position.x + this.targetVelX * timeToReach * leadFactor;
        const predictedZ = currentTarget.position.z + this.targetVelZ * timeToReach * leadFactor;

        // Aim rotation toward the predicted position
        const dx = predictedX - npcPos.x;
        const dz = predictedZ - npcPos.z;
        let aimRotation = Math.atan2(dx, dz);

        // Add random aim error for lower difficulties (up to ~29° for easy)
        const aimError = (1 - sweepSkill) * 0.5;
        aimRotation += (Math.random() - 0.5) * 2 * aimError;

        actions.push({
          type: 'ability', score, abilityId: 'sweep', target: currentTarget,
          aimRotation,
          execute: () => {},
        });
      }
    }

    return actions;
  }

  getDesiredRange(): number {
    return this.attackRange;
  }

  getMovementIntent(_world: WorldState, currentTarget: EntityInfo | null, cooldowns: NpcCooldownTracker, difficulty: DifficultyProfile): MovementIntent {
    if (!currentTarget) return { type: 'idle' };

    const meleeStop = this.attackRange * 0.85 - yardsToUnits(1);

    // When Sweep is ready, higher-difficulty NPCs stop at optimal charge distance
    // instead of rushing to melee range — so the charge lands right before the target.
    if (cooldowns.isReady('sweep') && currentTarget.inLineOfSight
        && currentTarget.distance > yardsToUnits(SWEEP_CHARGE_YARDS)) {
      const sweepSkill = 1 - difficulty.wastefulness; // 0.3 (easy) → 1.0 (master)
      // Blend between melee range (easy) and optimal sweep range (master)
      const sweepStop = yardsToUnits(SWEEP_CHARGE_YARDS + 0.25);
      const stopDistance = meleeStop + (sweepStop - meleeStop) * sweepSkill;
      return {
        type: 'moveToward',
        target: currentTarget.position,
        stopDistance,
      };
    }

    return {
      type: 'moveToward',
      target: currentTarget.position,
      stopDistance: meleeStop,
    };
  }
}
