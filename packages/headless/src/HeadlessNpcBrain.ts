/**
 * HeadlessNpcBrain — scripted AI opponent for headless RL training.
 *
 * Ports the client NPC behavior scoring (JanitorBehavior, CrackheadBehavior,
 * DrRetardoBehavior) to work with HeadlessEntity (no Three.js). Runs at Master
 * difficulty: no score fuzz, no waste, instant reactions, 100% ability usage.
 *
 * Used to bootstrap RL training: the neural agent trains against a competent
 * scripted opponent before transitioning to self-play.
 */

import { HeadlessEntity } from './HeadlessEntity.js';
import type { AgentAction } from './HeadlessArena.js';
import {
  getCharacterStats,
  yardsToUnits,
  type CharacterId,
  type Ability,
  type BuffSystem,
  type CollisionSystem,
  Sweep,
  Bandage,
} from '@gtr/shared';

// ── Types ─────────────────────────────────────────────────────────────

interface ScoredAction {
  abilityIndex: number;
  score: number;
  ability?: Ability;
  isCastTime?: boolean;
  aimRotation?: number;
  /** Whether target is the opponent (hostile) vs self. */
  targetsSelf?: boolean;
}

// ── Behavior modes ───────────────────────────────────────────────────

/**
 * Controls the NPC's overall playstyle during training episodes.
 * - `aggressive`: (default) Chases opponent, uses abilities proactively.
 * - `passive`: Stands ground, only fights when opponent is close. Teaches
 *   the RL agent to initiate combat rather than waiting.
 * - `kiting`: Maintains distance, runs away from melee. Teaches the RL
 *   agent to close gaps and deal with evasive opponents.
 * - `punching-bag`: Never attacks. Wanders slowly. Lets the RL agent
 *   freely experiment with ability combos without pressure.
 */
export type NpcBehaviorMode = 'aggressive' | 'passive' | 'kiting' | 'punching-bag';

// ── Constants ─────────────────────────────────────────────────────────

const MELEE_RANGE = yardsToUnits(3);
const SWEEP_CHARGE_YARDS = 28 * (Sweep.chargeDuration ?? 0.7);
const SWEEP_CHARGE_SPEED_YDS = 28;

// ── Brain ─────────────────────────────────────────────────────────────

export class HeadlessNpcBrain {
  private entity: HeadlessEntity;
  private opponent: HeadlessEntity;
  private buffSystem: BuffSystem<HeadlessEntity>;
  private collision: CollisionSystem;
  private bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  private characterId: CharacterId;
  private abilities: readonly (Ability | null)[];
  /** Map ability id → index in abilities array. */
  private abilityIdx: Map<string, number>;
  /** Controls overall playstyle — randomized per episode to create training diversity. */
  behaviorMode: NpcBehaviorMode = 'aggressive';

  // Sweep aim-leading state (janitor)
  private lastTargetX = 0;
  private lastTargetZ = 0;
  private targetVelX = 0;
  private targetVelZ = 0;
  private tickCount = 0;

  // Punching-bag wander state
  private punchingBagAngle = 0;
  private punchingBagTimer = 0;

  constructor(
    entity: HeadlessEntity,
    opponent: HeadlessEntity,
    buffSystem: BuffSystem<HeadlessEntity>,
    collision: CollisionSystem,
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
    behaviorMode?: NpcBehaviorMode,
  ) {
    this.entity = entity;
    this.opponent = opponent;
    this.buffSystem = buffSystem;
    this.collision = collision;
    this.bounds = bounds;
    this.characterId = entity.characterId;
    this.behaviorMode = behaviorMode ?? 'aggressive';

    const stats = getCharacterStats(entity.characterId);
    this.abilities = stats.abilities;

    this.abilityIdx = new Map();
    for (let i = 0; i < this.abilities.length; i++) {
      const a = this.abilities[i];
      if (a) this.abilityIdx.set(a.id, i);
    }
  }

  /** Produce an AgentAction for this simulation tick. */
  decide(dt: number): AgentAction {
    const e = this.entity;
    const opp = this.opponent;

    // Dead / stunned / sleeping — no action
    if (e.dead || e.stunned || this.buffSystem.isSleeping(e)) {
      return { abilityIndex: null, moveAngle: null, moveSpeed: 0 };
    }

    // Blinded — wander randomly, no abilities
    if (e.blinded || this.buffSystem.isBlinded(e)) {
      return { abilityIndex: null, moveAngle: Math.random() * Math.PI * 2, moveSpeed: 1 };
    }

    // Punching bag — slow wander, never attacks or enters combat
    if (this.behaviorMode === 'punching-bag') {
      this.punchingBagTimer -= dt;
      if (this.punchingBagTimer <= 0) {
        this.punchingBagAngle = Math.random() * Math.PI * 2;
        this.punchingBagTimer = 1.5 + Math.random() * 2.5; // new direction every 1.5–4s
      }
      const angle = this.wallAwareFleeAngle(this.punchingBagAngle);
      return { abilityIndex: null, moveAngle: angle, moveSpeed: 0.35 };
    }

    // Currently casting/channeling — don't act, just stand still
    if (e.castingAbilityName !== null) {
      return { abilityIndex: null, moveAngle: null, moveSpeed: 0 };
    }

    const dist = e.distanceTo(opp);
    const dx = opp.x - e.x;
    const dz = opp.z - e.z;
    const hasLoS = !opp.dead && this.collision.hasLineOfSight(e.x, e.z, opp.x, opp.z, e.y, opp.y);

    // Score abilities — passive NPCs only use abilities reactively when
    // the opponent is already close; kiting NPCs use them defensively
    const useAbilities = this.behaviorMode === 'aggressive'
      || (this.behaviorMode === 'passive' && dist <= yardsToUnits(8))
      || (this.behaviorMode === 'kiting' && dist <= yardsToUnits(15));

    let abilityIndex: number | null = null;
    if (useAbilities) {
      const actions = this.scoreCharacterActions(dist, dx, dz, hasLoS);
      this.scoreCommonActions(actions, dist);
      if (actions.length > 0) {
        this.applySmartFilters(actions, dist);
        actions.sort((a, b) => b.score - a.score);
      }

      const best = actions[0];
      if (best && best.score > 0 && hasLoS) {
        abilityIndex = best.abilityIndex;
        if (best.aimRotation != null) {
          e.rotY = best.aimRotation;
        }
      }
    }

    // Check if chosen ability has a cast time (use the actual ability definition,
    // not just the scored action's flag, as a safety net).
    const chosenAbility = abilityIndex !== null ? this.abilities[abilityIndex] : null;
    const hasCastTime = chosenAbility != null && chosenAbility.castTime != null && chosenAbility.castTime > 0;

    // Compute movement — but STOP moving when starting a cast-time ability.
    // In the arena, movement is processed BEFORE ability usage. If isMoving is
    // true when CastingSystem.start() runs, it rejects the cast via shouldCancel.
    let movement: { angle: number | null; speed: number };
    if (hasCastTime) {
      movement = { angle: null, speed: 0 };
    } else {
      movement = this.getMovement(dist, dx, dz, hasLoS);
    }

    // Update velocity tracking for aim leading
    this.tickCount++;
    if (this.tickCount > 1 && dt > 0) {
      this.targetVelX = (opp.x - this.lastTargetX) / dt;
      this.targetVelZ = (opp.z - this.lastTargetZ) / dt;
    }
    this.lastTargetX = opp.x;
    this.lastTargetZ = opp.z;

    return {
      abilityIndex,
      moveAngle: movement.angle,
      moveSpeed: movement.speed,
      cancelCast: false,
      groundX: opp.x,
      groundZ: opp.z,
    };
  }

  // ── Helper queries ──────────────────────────────────────────────────

  private idx(abilityId: string): number {
    return this.abilityIdx.get(abilityId) ?? -1;
  }

  private ready(abilityId: string): boolean {
    return this.entity.cooldowns.isReady(abilityId);
  }

  private selfHpPct(): number {
    return this.entity.maxHp > 0 ? this.entity.hp / this.entity.maxHp : 0;
  }

  private oppHpPct(): number {
    return this.opponent.maxHp > 0 ? this.opponent.hp / this.opponent.maxHp : 0;
  }

  private oppIsStunned(): boolean {
    return this.buffSystem.isStunned(this.opponent) || this.buffSystem.isSleeping(this.opponent);
  }

  private oppIsSleeping(): boolean {
    return this.buffSystem.isSleeping(this.opponent);
  }

  private oppIsBlinded(): boolean {
    return this.buffSystem.isBlinded(this.opponent);
  }

  private oppIsCasting(): boolean {
    return this.opponent.castingAbilityName !== null && !this.opponent.castingIsChannel;
  }

  private oppIsChanneling(): boolean {
    return this.opponent.castingAbilityName !== null && this.opponent.castingIsChannel;
  }

  private oppHasDebuff(id: string): boolean {
    return this.buffSystem.hasDebuff(this.opponent, id);
  }

  private oppHasStealableBuff(): boolean {
    const buffs = this.buffSystem.getBuffs(this.opponent);
    return buffs.some(b => b.definition.type === 'buff' && !b.definition.unremovable);
  }

  private selfHasDebuff(id: string): boolean {
    return this.buffSystem.hasDebuff(this.entity, id);
  }

  /** Am I behind the opponent (their forward dot toward-me < 0)? */
  private iAmBehindOpponent(): boolean {
    const dx = this.opponent.x - this.entity.x;
    const dz = this.opponent.z - this.entity.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01) return false;
    // Opponent's forward vector
    const fwdX = Math.sin(this.opponent.rotY);
    const fwdZ = Math.cos(this.opponent.rotY);
    // Direction from opponent to me
    const toMeX = -dx / dist;
    const toMeZ = -dz / dist;
    // If opponent is facing away from me, I'm behind them
    const dot = fwdX * toMeX + fwdZ * toMeZ;
    return dot < 0;
  }

  /** Is opponent facing me? */
  private oppFacingMe(): boolean {
    const dx = this.entity.x - this.opponent.x;
    const dz = this.entity.z - this.opponent.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01) return true;
    const fwdX = Math.sin(this.opponent.rotY);
    const fwdZ = Math.cos(this.opponent.rotY);
    const dot = fwdX * (dx / dist) + fwdZ * (dz / dist);
    return dot > 0.5;
  }

  // ── Character-specific scoring ──────────────────────────────────────

  private scoreCharacterActions(dist: number, dx: number, dz: number, hasLoS: boolean): ScoredAction[] {
    switch (this.characterId) {
      case 'janitor': return this.scoreJanitor(dist, dx, dz, hasLoS);
      case 'crackhead': return this.scoreCrackhead(dist, hasLoS);
      case 'dr-retardo': return this.scoreDrRetardo(dist, hasLoS);
      default: return [];
    }
  }

  // ── Janitor ─────────────────────────────────────────────────────────

  private scoreJanitor(dist: number, dx: number, dz: number, hasLoS: boolean): ScoredAction[] {
    const actions: ScoredAction[] = [];
    const mana = this.entity.mana;

    // Bucket Splash (ranged debuff, setup for Mop combo)
    if (this.ready('bucket-splash') && mana >= 65
        && dist <= yardsToUnits(10) && hasLoS) {
      let score = 30;
      if (!this.oppHasDebuff('covered-in-piss')) score += 40;
      else score -= 20;
      actions.push({ abilityIndex: this.idx('bucket-splash'), score });
    }

    // Mop (melee, bonus on debuffed target)
    if (this.ready('mop') && mana >= 30 && dist <= MELEE_RANGE && hasLoS) {
      let score = 35;
      if (this.oppHasDebuff('covered-in-piss')) score += 50;
      actions.push({ abilityIndex: this.idx('mop'), score });
    }

    // Big Boot (3s stun)
    if (this.ready('big-boot') && mana >= 180 && dist <= MELEE_RANGE && hasLoS) {
      let score = 45;
      if (this.oppIsChanneling() || this.oppIsCasting()) score += 60;
      if (this.oppHpPct() < 0.5) score += 15;
      actions.push({ abilityIndex: this.idx('big-boot'), score });
    }

    // Fart Bomb (self-centered AoE)
    if (this.ready('fart-bomb') && mana >= 140 && dist <= yardsToUnits(5)) {
      let score = 30;
      score += 15; // 1v1: always 1 enemy if in range
      actions.push({ abilityIndex: this.idx('fart-bomb'), score });
    }

    // Crash Out (+300% auto-attack speed)
    if (this.ready('crash-out') && mana >= 280 && dist <= MELEE_RANGE) {
      let score = 30;
      if (this.oppIsStunned()) score += 30;
      if (this.oppHasDebuff('covered-in-piss')) score += 25;
      if (this.selfHpPct() > 0.6) score += 10;
      if (this.selfHpPct() < 0.3) score -= 20;
      actions.push({ abilityIndex: this.idx('crash-out'), score, targetsSelf: true });
    }

    // Jimmy Legs (slow / root)
    if (this.ready('jimmy-legs') && mana >= 100 && dist <= MELEE_RANGE && hasLoS) {
      let score = 40;
      if (this.oppHasDebuff('jimmy-legs')) score += 35;
      actions.push({ abilityIndex: this.idx('jimmy-legs'), score });
    }

    // Janitor's Helper (0.5s cast, sleep)
    if (this.ready('janitors-helper') && mana >= 175 && dist <= MELEE_RANGE && hasLoS) {
      let score = 25;
      if (this.oppIsStunned() || this.oppIsSleeping() || this.oppIsBlinded()) score -= 40;
      if (this.oppHpPct() > 0.5) score += 10;
      actions.push({ abilityIndex: this.idx('janitors-helper'), score, isCastTime: true });
    }

    // Sweep (charge gap-closer)
    if (this.ready('sweep') && mana >= 130) {
      const distYards = dist / yardsToUnits(1);
      const optimalDist = SWEEP_CHARGE_YARDS + 0.25;
      // Master: ±1 yd window
      const minDist = Math.max(2, optimalDist - 1);
      const maxDist = optimalDist + 1;

      if (distYards >= minDist && distYards <= maxDist && hasLoS) {
        const distFromOptimal = Math.abs(distYards - optimalDist);
        let score = Math.max(5, 90 - distFromOptimal * 5);

        // Aim leading (perfect for Master)
        const timeToReach = Math.min(distYards / SWEEP_CHARGE_SPEED_YDS, Sweep.chargeDuration ?? 0.7);
        const predictedX = this.opponent.x + this.targetVelX * timeToReach;
        const predictedZ = this.opponent.z + this.targetVelZ * timeToReach;
        const aimDx = predictedX - this.entity.x;
        const aimDz = predictedZ - this.entity.z;
        const aimRotation = Math.atan2(aimDx, aimDz);

        // Check charge path for ledges
        const chargeDirX = Math.sin(aimRotation);
        const chargeDirZ = Math.cos(aimRotation);
        const pathSafe = this.collision.hasGroundAlongPath(
          this.entity.x, this.entity.z, this.entity.y,
          chargeDirX, chargeDirZ, yardsToUnits(SWEEP_CHARGE_YARDS),
        );

        if (pathSafe) {
          actions.push({ abilityIndex: this.idx('sweep'), score, aimRotation });
        }
        // Master never takes unsafe paths
      }
    }

    return actions;
  }

  // ── Crackhead ───────────────────────────────────────────────────────

  private scoreCrackhead(dist: number, hasLoS: boolean): ScoredAction[] {
    const actions: ScoredAction[] = [];
    const mana = this.entity.mana;
    const selfHpPct = this.selfHpPct();
    const targetHpPct = this.oppHpPct();

    // Shank (melee, +50% from behind)
    if (this.ready('shank') && mana >= 145 && dist <= MELEE_RANGE && hasLoS) {
      let score = 30;
      if (this.iAmBehindOpponent()) score += 50;
      if (!this.iAmBehindOpponent() && this.oppFacingMe()) score -= 10;
      actions.push({ abilityIndex: this.idx('shank'), score });
    }

    // Pocket Sand (blind 4s)
    if (this.ready('pocket-sand') && mana >= 175 && dist <= yardsToUnits(10) && hasLoS) {
      let score = 25;
      if (selfHpPct < 0.35) score += 30;
      if (this.oppIsCasting() || this.oppIsChanneling()) score += 20;
      if (this.oppIsStunned() || this.oppIsSleeping() || this.oppIsBlinded()) score -= 40;
      actions.push({ abilityIndex: this.idx('pocket-sand'), score });
    }

    // Sticky Fingers (steal buff/mana)
    if (this.ready('sticky-fingers') && mana >= 100 && dist <= MELEE_RANGE && hasLoS) {
      let score = 20;
      if (this.oppHasStealableBuff()) score += 40;
      actions.push({ abilityIndex: this.idx('sticky-fingers'), score });
    }

    // Crack Rock (self heal 400 + speed)
    if (this.ready('crack-rock') && mana >= 150) {
      let score = 10;
      if (selfHpPct < 0.7) score += 20;
      if (selfHpPct < 0.5) score += 30;
      if (selfHpPct < 0.3) score += 40;
      actions.push({ abilityIndex: this.idx('crack-rock'), score, targetsSelf: true });
    }

    // Dumpster Dive (vanish)
    if (this.ready('dumpster-dive') && mana >= 80) {
      const enemiesNearby = dist <= yardsToUnits(10);
      if (enemiesNearby && selfHpPct < 0.35) {
        let score = 15;
        if (selfHpPct < 0.25) score += 50;
        if (selfHpPct < 0.15) score += 40;
        if (targetHpPct < 0.2) score -= 30;
        actions.push({ abilityIndex: this.idx('dumpster-dive'), score, targetsSelf: true });
      }
    }

    // Gank (execute, resets if target < 30%)
    if (this.ready('gank') && mana >= 100 && dist <= MELEE_RANGE && hasLoS) {
      let score = 35;
      if (targetHpPct < 0.30) score += 80;
      if (targetHpPct < 0.50) score += 20;
      if (this.oppIsStunned()) score += 15;
      actions.push({ abilityIndex: this.idx('gank'), score });
    }

    // Tweaker Sprint (dash gap-closer)
    if (this.ready('tweaker-sprint') && mana >= 115
        && dist >= yardsToUnits(5) && dist <= yardsToUnits(15) && hasLoS) {
      let score = 35;
      if (dist > yardsToUnits(8)) score += 25;
      if (targetHpPct < 0.3) score += 20;
      actions.push({ abilityIndex: this.idx('tweaker-sprint'), score });
    }

    // OD (mega burst + self stun)
    if (this.ready('od') && mana >= 200 && dist <= MELEE_RANGE && hasLoS) {
      let score = 15;
      if (this.oppIsStunned()) score += 40;
      if (selfHpPct > 0.6) score += 15;
      if (selfHpPct < 0.3) score -= 20;
      actions.push({ abilityIndex: this.idx('od'), score });
    }

    return actions;
  }

  // ── Dr. Retardo ─────────────────────────────────────────────────────

  private scoreDrRetardo(dist: number, hasLoS: boolean): ScoredAction[] {
    const actions: ScoredAction[] = [];
    const mana = this.entity.mana;
    const selfHpPct = this.selfHpPct();

    // Bottle Chuck (ground-targeted AoE)
    if (this.ready('bottle-chuck') && mana >= 180
        && dist <= yardsToUnits(24) && hasLoS) {
      const score = 45; // In 1v1 no grouping bonus
      actions.push({ abilityIndex: this.idx('bottle-chuck'), score });
    }

    // Discombobulate (1.5s cast, scramble movement)
    if (this.ready('discombobulate') && mana >= 245
        && dist <= yardsToUnits(20) && hasLoS) {
      let score = 30;
      if (dist < yardsToUnits(8)) score += 25;
      if (this.oppIsStunned() || this.oppIsSleeping() || this.oppIsBlinded()) score -= 40;
      actions.push({ abilityIndex: this.idx('discombobulate'), score, isCastTime: true });
    }

    // Chudmax (3s channel, damage enemy in 1v1)
    if (this.ready('chudmax') && mana >= 275
        && dist <= yardsToUnits(15) && hasLoS) {
      let score = 35;
      if (this.oppIsStunned()) score += 20;
      actions.push({ abilityIndex: this.idx('chudmax'), score, isCastTime: true });
    }

    // Chemical Spill (self-centered AoE)
    if (this.ready('chemical-spill') && mana >= 175 && dist <= yardsToUnits(6)) {
      let score = 20;
      score += 20; // 1v1: 1 enemy in range
      if (dist < yardsToUnits(4)) score += 15;
      actions.push({ abilityIndex: this.idx('chemical-spill'), score, targetsSelf: true });
    }

    // Retard Strength (shield + reflect + damage buff)
    if (this.ready('retard-strength') && mana >= 300) {
      const enemyInRange = dist < yardsToUnits(15);
      if (enemyInRange) {
        let score = 15;
        if (dist < yardsToUnits(5)) score += 30;
        if (selfHpPct < 0.5) score += 25;
        if (selfHpPct < 0.3) score += 20;
        actions.push({ abilityIndex: this.idx('retard-strength'), score, targetsSelf: true });
      }
    }

    // Full Retard (1s cast, melee aura)
    if (this.ready('full-retard') && mana >= 360 && dist <= MELEE_RANGE) {
      let score = 25;
      score += 25; // 1v1: 1 enemy in range
      actions.push({ abilityIndex: this.idx('full-retard'), score, isCastTime: true });
    }

    // Crotch Rot (0.5s cast, DoT → stun)
    if (this.ready('crotch-rot') && mana >= 200
        && dist <= yardsToUnits(15) && hasLoS) {
      let score = 40;
      if (this.oppHasDebuff('crotch-rot')) score -= 30;
      actions.push({ abilityIndex: this.idx('crotch-rot'), score, isCastTime: true });
    }

    // Kaboom (knockback, self-peel)
    if (this.ready('kaboom') && mana >= 235 && dist <= yardsToUnits(10)) {
      let score = 40;
      if (dist <= MELEE_RANGE) score += 20;
      if (selfHpPct < 0.4) score += 15;
      actions.push({ abilityIndex: this.idx('kaboom'), score, targetsSelf: true });
    }

    return actions;
  }

  // ── Common abilities ────────────────────────────────────────────────

  private scoreCommonActions(actions: ScoredAction[], dist: number): void {
    const bandageIdx = this.idx('bandage');
    if (bandageIdx < 0) return;

    if (this.ready('bandage') && !this.selfHasDebuff('recently-bandaged')
        && this.selfHpPct() < 0.5 && dist > yardsToUnits(15)) {
      let score = 20;
      score += (1 - this.selfHpPct()) * 60;
      if (this.selfHpPct() < 0.3) score += 30;
      actions.push({ abilityIndex: bandageIdx, score, isCastTime: true, targetsSelf: true });
    }
  }

  // ── Smart filters (Master = no waste) ───────────────────────────────

  private applySmartFilters(actions: ScoredAction[], dist: number): void {
    for (const action of actions) {
      const ability = this.abilities[action.abilityIndex];
      if (!ability) continue;

      // Self-heal at high HP — Master threshold: 0.65
      if (ability.healAmount && !ability.requiresHostileTarget && action.targetsSelf) {
        if (this.selfHpPct() > 0.65) {
          action.score -= 100;
        }
      }

      // Defensive self-buff with no pressure
      if (ability.appliesSelfBuff && !ability.requiresHostileTarget && !ability.healAmount) {
        const buff = ability.appliesSelfBuff;
        const isDefensive = buff.shieldAmount != null
          || buff.shieldReflectPercent != null
          || buff.effects.some(e => e.type === 'damageTakenPercent' && e.value < 0);
        if (isDefensive) {
          const noNearbyThreat = dist > yardsToUnits(8);
          if (this.selfHpPct() > 0.60 && noNearbyThreat) {
            action.score -= 80;
          }
        }
      }

      // Ability out of range
      if (ability.range && !action.targetsSelf) {
        if (dist > ability.range) {
          action.score -= 80;
        }
      }
    }
  }

  // ── Movement ────────────────────────────────────────────────────────

  private getMovement(dist: number, dx: number, dz: number, hasLoS: boolean): { angle: number | null; speed: number } {
    const opp = this.opponent;
    if (opp.dead) return { angle: null, speed: 0 };

    // ── Passive mode: stand ground, only engage when very close ──
    if (this.behaviorMode === 'passive') {
      // Only move if opponent is in melee range (fight back) or very far (slow wander)
      if (dist <= yardsToUnits(5) && hasLoS) {
        // In melee — stand and fight
        return { angle: null, speed: 0 };
      }
      // Otherwise idle — don't chase
      return { angle: null, speed: 0 };
    }

    // ── Kiting mode: maintain distance, run away from melee ──
    if (this.behaviorMode === 'kiting') {
      const desiredRange = yardsToUnits(18);
      const fleeRange = yardsToUnits(10);
      if (dist < fleeRange) {
        // Run away — avoid walls
        const rawAngle = Math.atan2(-dx, -dz);
        return { angle: this.wallAwareFleeAngle(rawAngle), speed: 1 };
      }
      if (dist > desiredRange + yardsToUnits(5)) {
        // Too far — close in a bit so the fight actually happens
        return { angle: Math.atan2(dx, dz), speed: 0.5 };
      }
      // Comfortable range — strafe (wall-aware)
      const rawStrafe = Math.atan2(dx, dz) + Math.PI * 0.5;
      return { angle: this.wallAwareFleeAngle(rawStrafe), speed: 0.6 };
    }

    // ── Aggressive mode (default): character-specific movement ──
    // No LoS: chase directly
    if (!hasLoS) {
      const angle = Math.atan2(dx, dz);
      return { angle, speed: 1 };
    }

    switch (this.characterId) {
      case 'janitor': return this.moveJanitor(dist, dx, dz);
      case 'crackhead': return this.moveCrackhead(dist, dx, dz);
      case 'dr-retardo': return this.moveDrRetardo(dist, dx, dz);
      default: return this.moveDefault(dist, dx, dz);
    }
  }

  private moveJanitor(dist: number, dx: number, dz: number): { angle: number | null; speed: number } {
    const attackRange = getCharacterStats('janitor').autoAttackRange;
    const meleeStop = attackRange * 0.85 - yardsToUnits(1);

    // When sweep is ready, stop at optimal charge distance
    if (this.ready('sweep') && dist > yardsToUnits(SWEEP_CHARGE_YARDS)) {
      const sweepStop = yardsToUnits(SWEEP_CHARGE_YARDS + 0.25);
      if (dist > sweepStop + 0.5) {
        return { angle: Math.atan2(dx, dz), speed: 1 };
      }
      return { angle: null, speed: 0 };
    }

    if (dist > meleeStop + 0.5) {
      return { angle: Math.atan2(dx, dz), speed: 1 };
    }
    return { angle: null, speed: 0 };
  }

  private moveCrackhead(dist: number, dx: number, dz: number): { angle: number | null; speed: number } {
    const attackRange = getCharacterStats('crackhead').autoAttackRange;
    const selfHpPct = this.selfHpPct();

    // Low HP and enemy close: kite away — wall-aware
    if (selfHpPct < 0.2 && dist < yardsToUnits(5)) {
      const rawAngle = Math.atan2(-dx, -dz);
      return { angle: this.wallAwareFleeAngle(rawAngle), speed: 1 };
    }

    // In melee range but not behind: strafe to get behind
    if (dist <= attackRange && !this.iAmBehindOpponent()) {
      // Perpendicular to direction-to-opponent (clockwise strafe)
      const angle = Math.atan2(dx, dz) + Math.PI * 0.5;
      return { angle, speed: 1 };
    }

    // Chase to melee
    const meleeStop = attackRange * 0.85 - yardsToUnits(1);
    if (dist > meleeStop + 0.5) {
      return { angle: Math.atan2(dx, dz), speed: 1 };
    }
    return { angle: null, speed: 0 };
  }

  private moveDrRetardo(dist: number, dx: number, dz: number): { angle: number | null; speed: number } {
    const desiredRange = yardsToUnits(15);

    // Kite if enemy is close (< 8yd) — wall-aware
    if (dist < yardsToUnits(8)) {
      const rawAngle = Math.atan2(-dx, -dz);
      return { angle: this.wallAwareFleeAngle(rawAngle), speed: 1 };
    }

    // Move toward if out of ability range
    if (dist > yardsToUnits(20)) {
      return { angle: Math.atan2(dx, dz), speed: 1 };
    }

    // In comfortable range: idle
    return { angle: null, speed: 0 };
  }

  private moveDefault(dist: number, dx: number, dz: number): { angle: number | null; speed: number } {
    const attackRange = getCharacterStats(this.characterId).autoAttackRange;
    const stopDist = attackRange * 0.85;
    if (dist > stopDist + 0.5) {
      return { angle: Math.atan2(dx, dz), speed: 1 };
    }
    return { angle: null, speed: 0 };
  }

  // ── Wall-aware flee ────────────────────────────────────────────────

  /**
   * Compute a flee angle that avoids running into walls/corners.
   * Uses raycasts to detect obstacles and arena boundaries in the flee direction,
   * and picks an alternative if the direct flee path is too short.
   */
  private wallAwareFleeAngle(rawAngle: number): number {
    const e = this.entity;
    const RAY_MAX = 8; // ~13 yards lookahead
    const WALL_DANGER_DIST = 5; // Start adjusting within ~8 yards

    const rawDirX = Math.sin(rawAngle);
    const rawDirZ = Math.cos(rawAngle);

    // Check wall/obstacle distance in the raw flee direction
    const wallDist = this.collision.raycastDistance(e.x, e.z, rawDirX, rawDirZ, RAY_MAX, e.y);
    const boundDist = this.boundaryDistInDir(e.x, e.z, rawDirX, rawDirZ);
    const effectiveDist = Math.min(wallDist, boundDist);

    if (effectiveDist > WALL_DANGER_DIST) return rawAngle; // Plenty of room

    // Wall is close — evaluate candidate directions
    // Ideal flee direction (normalized)
    const idealX = rawDirX;
    const idealZ = rawDirZ;

    let bestAngle = rawAngle;
    let bestScore = -Infinity;

    // Sample 13 directions: original + 12 alternatives spanning ±180°
    for (let i = -1; i < 12; i++) {
      let angle: number;
      if (i < 0) {
        angle = rawAngle;
      } else {
        const sign = i % 2 === 0 ? 1 : -1;
        const step = Math.ceil((i + 1) / 2);
        angle = rawAngle + sign * step * (Math.PI / 6); // 30° steps
      }

      const cx = Math.sin(angle);
      const cz = Math.cos(angle);

      const cWallDist = this.collision.raycastDistance(e.x, e.z, cx, cz, RAY_MAX, e.y);
      const cBoundDist = this.boundaryDistInDir(e.x, e.z, cx, cz);
      const cDist = Math.min(cWallDist, cBoundDist);

      // How much this direction aligns with ideal flee (1 = perfect, -1 = toward threat)
      const fleeDot = cx * idealX + cz * idealZ;

      const score = cDist * 3 + Math.max(0, fleeDot) * 2;

      if (score > bestScore) {
        bestScore = score;
        bestAngle = angle;
      }
    }

    return bestAngle;
  }

  /** Distance from (x,z) to the arena boundary in direction (dx,dz). */
  private boundaryDistInDir(x: number, z: number, dx: number, dz: number): number {
    let minT = Infinity;
    if (dx > 0.001) minT = Math.min(minT, (this.bounds.maxX - x) / dx);
    else if (dx < -0.001) minT = Math.min(minT, (this.bounds.minX - x) / dx);
    if (dz > 0.001) minT = Math.min(minT, (this.bounds.maxZ - z) / dz);
    else if (dz < -0.001) minT = Math.min(minT, (this.bounds.minZ - z) / dz);
    return minT < 0 ? 0 : minT;
  }
}
