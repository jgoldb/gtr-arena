import { getCharacterStats, yardsToUnits, BottleChuck, Discombobulate, Chudmax, CrotchRot, FullRetard } from '@gtr/shared';
import type { CharacterBehavior, ScoredAction } from './BaseBehavior';
import type { WorldState, EntityInfo } from '../WorldState';
import type { NpcCooldownTracker } from '../NpcCooldownTracker';
import type { DifficultyProfile } from '../DifficultyProfile';
import type { MovementIntent } from '../MovementController';

const DESIRED_RANGE = yardsToUnits(15);
const MELEE_RANGE = yardsToUnits(3);

export class DrRetardoBehavior implements CharacterBehavior {
  readonly characterId = 'dr-retardo' as const;
  private readonly attackRange: number;

  constructor() {
    this.attackRange = getCharacterStats('dr-retardo').autoAttackRange;
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

    // ── Bottle Chuck (ground-targeted AoE + slow) ──
    if (cooldowns.isReady('bottle-chuck') && selfMana >= 180) {
      let score = 45;
      // Higher with multiple enemies grouped up
      const nearTarget = world.enemies.filter(e =>
        e.position.distanceTo(currentTarget.position) < yardsToUnits(4)
      );
      score += (nearTarget.length - 1) * 20;
      if (targetDist <= yardsToUnits(24) && currentTarget.inLineOfSight) {
        actions.push({
          type: 'ability', score, abilityId: 'bottle-chuck', target: currentTarget,
          execute: () => {},
        });
      }
    }

    // ── Discombobulate (1.5s cast, scrambles movement) ──
    if (cooldowns.isReady('discombobulate') && selfMana >= 245 && targetDist <= yardsToUnits(20)) {
      let score = 30;
      // Great against melee enemies chasing us
      if (targetDist < yardsToUnits(8)) score += 25;
      // Don't use on already CC'd targets
      if (currentTarget.isStunned || currentTarget.isSleeping || currentTarget.isBlinded) score -= 40;
      if (currentTarget.inLineOfSight) {
        actions.push({
          type: 'ability', score, abilityId: 'discombobulate', target: currentTarget,
          ability: Discombobulate, isCastTime: true,
          execute: () => {},
        });
      }
    }

    // ── Chudmax (3s channel — damage enemy or heal ally) ──
    if (cooldowns.isReady('chudmax') && selfMana >= 275) {
      // Evaluate healing an ally
      const lowestAlly = world.allies.length > 0
        ? world.allies.reduce((a, b) => a.hpPercent < b.hpPercent ? a : b)
        : null;
      if (lowestAlly && lowestAlly.hpPercent < 0.6 && lowestAlly.distance <= yardsToUnits(15) && lowestAlly.inLineOfSight) {
        let healScore = 50;
        healScore += (1 - lowestAlly.hpPercent) * 60; // higher priority for lower HP
        actions.push({
          type: 'ability', score: healScore, abilityId: 'chudmax', target: lowestAlly,
          ability: Chudmax, isCastTime: true,
          execute: () => {},
        });
      }

      // Evaluate damaging enemy
      if (targetDist <= yardsToUnits(15) && currentTarget.inLineOfSight) {
        let dmgScore = 35;
        if (currentTarget.isStunned) dmgScore += 20; // guaranteed channel
        actions.push({
          type: 'ability', score: dmgScore, abilityId: 'chudmax', target: currentTarget,
          ability: Chudmax, isCastTime: true,
          execute: () => {},
        });
      }
    }

    // ── Chemical Spill (self-centered AoE) ──
    if (cooldowns.isReady('chemical-spill') && selfMana >= 175) {
      const nearbyEnemies = world.enemies.filter(e => e.distance <= yardsToUnits(6));
      const nearbyAllies = world.allies.filter(e => e.distance <= yardsToUnits(6));
      if (nearbyEnemies.length > 0 || nearbyAllies.length > 0) {
        let score = 20;
        score += nearbyEnemies.length * 20;
        score += nearbyAllies.length * 10;
        // Extra value when being chased in melee
        if (world.enemies.some(e => e.distance < yardsToUnits(4))) score += 15;
        actions.push({
          type: 'ability', score, abilityId: 'chemical-spill',
          execute: () => {},
        });
      }
    }

    // ── Retard Strength (shield + reflect + damage buff) ──
    if (cooldowns.isReady('retard-strength') && selfMana >= 300) {
      // Only use when enemies are within engagement range
      const enemiesInRange = world.enemies.some(e => e.distance < yardsToUnits(15));
      if (enemiesInRange) {
        let score = 15;
        // High score when about to take damage (melee enemy in range)
        if (world.enemies.some(e => e.distance < yardsToUnits(5))) score += 30;
        // Higher when HP is dropping
        if (selfHpPct < 0.5) score += 25;
        if (selfHpPct < 0.3) score += 20;
        actions.push({
          type: 'ability', score, abilityId: 'retard-strength',
          execute: () => {},
        });
      }
    }

    // ── Full Retard (1s cast, melee AoE aura) ──
    if (cooldowns.isReady('full-retard') && selfMana >= 360) {
      const nearbyEnemies = world.enemies.filter(e => e.distance <= MELEE_RANGE);
      if (nearbyEnemies.length > 0) {
        let score = 25;
        score += nearbyEnemies.length * 25;
        actions.push({
          type: 'ability', score, abilityId: 'full-retard',
          ability: FullRetard, isCastTime: true,
          execute: () => {},
        });
      }
    }

    // ── Crotch Rot (0.5s cast, DoT → stun) ──
    if (cooldowns.isReady('crotch-rot') && selfMana >= 200 && targetDist <= yardsToUnits(15)) {
      let score = 40;
      // Great pressure ability — always good to have a DoT ticking
      const targetHasCrotchRot = currentTarget.debuffs.some(b => b.definition.id === 'crotch-rot');
      if (targetHasCrotchRot) score -= 30; // already has it
      if (currentTarget.inLineOfSight) {
        actions.push({
          type: 'ability', score, abilityId: 'crotch-rot', target: currentTarget,
          ability: CrotchRot, isCastTime: true,
          execute: () => {},
        });
      }
    }

    // ── Kaboom (knockback, self-peel) ──
    if (cooldowns.isReady('kaboom') && selfMana >= 235) {
      const nearbyEnemies = world.enemies.filter(e => e.distance <= yardsToUnits(10));
      if (nearbyEnemies.length > 0) {
        let score = 40;
        // Great for peeling melee off self
        if (nearbyEnemies.length > 1) score += 20;
        // Extra value when enemies are very close (melee pressure)
        if (nearbyEnemies.some(e => e.distance <= MELEE_RANGE)) score += 20;
        // Extra value when being pressured at low HP
        if (selfHpPct < 0.4) score += 15;
        actions.push({
          type: 'ability', score, abilityId: 'kaboom',
          execute: () => {},
        });
      }
    }

    return actions;
  }

  getDesiredRange(): number {
    return DESIRED_RANGE;
  }

  getMovementIntent(world: WorldState, currentTarget: EntityInfo | null, _cooldowns: NpcCooldownTracker, _difficulty: DifficultyProfile): MovementIntent {
    if (!currentTarget) return { type: 'idle' };

    // Caster: kite melee enemies
    const closestEnemy = world.enemies[0];
    if (closestEnemy && closestEnemy.distance < yardsToUnits(8)) {
      return {
        type: 'kiteFrom',
        threat: closestEnemy.position,
        maxRange: DESIRED_RANGE + yardsToUnits(3),
        preferredRange: DESIRED_RANGE,
      };
    }

    // Move toward target if out of ability range
    if (currentTarget.distance > yardsToUnits(20)) {
      return {
        type: 'moveToward',
        target: currentTarget.position,
        stopDistance: DESIRED_RANGE * 0.85,
      };
    }

    // In range — idle (just auto-attack and use abilities)
    return { type: 'idle' };
  }
}
