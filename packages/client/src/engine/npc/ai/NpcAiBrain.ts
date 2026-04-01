import * as THREE from 'three';
import type { NpcController } from '../NpcController';
import type { Targetable } from '../../types';
import type { BuffSystem } from '../../combat/BuffSystem';
import type { CombatSystem } from '../../combat/CombatSystem';
import type { CollisionSystem } from '../../physics/CollisionSystem';
import { getCharacterStats, yardsToUnits, Bandage, RecentlyBandagedDebuff, type Ability } from '@gtr/shared';
import { MovementController } from './MovementController';
import { NpcCooldownTracker } from './NpcCooldownTracker';
import type { DifficultyProfile } from './DifficultyProfile';
import type { CharacterBehavior, ScoredAction } from './behaviors/BaseBehavior';
import { buildWorldState, type WorldState, type EntityInfo, type HazardInfo } from './WorldState';

interface NpcCastingState {
  ability: Ability;
  target: Targetable | null;
  elapsed: number;
  totalTime: number;
  isChannel: boolean;
  tickInterval: number;
  ticksDelivered: number;
  damageMultiplier: number;
}

/** Interface for the subset of Engine the AI brain needs. Avoids circular dependency. */
export interface AiEngineInterface {
  readonly buffSystem: BuffSystem;
  readonly combatSystem: CombatSystem;
  getCollisionSystem(): CollisionSystem;
  getArenaBounds(): { minX: number; maxX: number; minZ: number; maxZ: number };
  getAllTargetables(): Targetable[];
  getHazards(): HazardInfo[];
  npcUseAbility(npc: NpcController, abilityId: string, target: Targetable | null, groundPos?: THREE.Vector3): boolean;
  npcApplyChannelTick(npc: NpcController, target: Targetable, tickDamage: number, healAmount: number, damageMultiplier: number): void;
  isNpcCharging(npc: NpcController): boolean;
  isArenaPreparationActive(): boolean;
}

export class NpcAiBrain {
  readonly npc: NpcController;
  private engine: AiEngineInterface;
  private behavior: CharacterBehavior;
  private difficulty: DifficultyProfile;
  readonly movement: MovementController;
  readonly cooldowns: NpcCooldownTracker;
  private abilityLookup: Map<string, Ability>;

  private thinkTimer = 0;
  private currentTarget: EntityInfo | null = null;
  currentTargetEntity: Targetable | null = null;
  private casting: NpcCastingState | null = null;

  /** CC break reaction timer — counts down from reactionDelayMs before trinket is attempted */
  private ccReactionTimer = 0;
  private wasCCd = false;

  /** Discombobulate adaptation — tracks how long we've been scrambled */
  private discombobActive = false;
  private discombobElapsed = 0;

  constructor(
    npc: NpcController,
    engine: AiEngineInterface,
    behavior: CharacterBehavior,
    difficulty: DifficultyProfile
  ) {
    this.npc = npc;
    this.engine = engine;
    this.behavior = behavior;
    this.difficulty = difficulty;
    this.cooldowns = new NpcCooldownTracker();

    // Build ability lookup from character definition
    this.abilityLookup = new Map();
    const stats = getCharacterStats(npc.characterId);
    for (const ability of stats.abilities) {
      if (ability) this.abilityLookup.set(ability.id, ability);
    }

    this.movement = new MovementController(
      npc,
      engine.getCollisionSystem(),
      engine.getArenaBounds()
    );
    this.movement.speedScale = difficulty.movementSpeedScale;
    this.movement.hazardAvoidance = difficulty.hazardAvoidance;

    // Stagger initial think time so NPCs don't all think on the same frame
    this.thinkTimer = Math.random() * this.difficulty.thinkIntervalMs / 1000;
  }

  update(dt: number): void {
    if (this.npc.dead) {
      this.movement.intent = { type: 'idle' };
      return;
    }

    // Don't think or move while gates are closed
    if (this.engine.isArenaPreparationActive()) {
      this.movement.intent = { type: 'idle' };
      return;
    }

    this.cooldowns.update(dt);

    // Update movement speed from buffs
    this.movement.speedMultiplier = this.engine.buffSystem.getMovementSpeedMultiplier(this.npc);
    this.movement.updateBounds(this.engine.getArenaBounds());

    // Check CC break (trinket) for all CC types — covers stun, sleep, and blind
    this.checkCCBreak(dt);

    if (this.npc.stunned) {
      this.movement.intent = { type: 'idle' };
      this.movement.update(dt);
      // Stun cancels casting/channeling
      if (this.casting) this.cancelCasting();
      return;
    }

    // Blinded — can't see anything. Lose target, wander aimlessly, cancel casts.
    const isBlinded = this.engine.buffSystem.isBlinded(this.npc);
    if (isBlinded) {
      this.currentTarget = null;
      this.currentTargetEntity = null;
      this.npc.autoAttackTarget = null;
      this.movement.faceTarget = null;
      if (this.casting) this.cancelCasting();
      this.movement.intent = { type: 'wander' };
      this.movement.update(dt);
      return;
    }

    // Discombobulate — WASD-style scrambled movement, adapts over time based on difficulty
    const isDiscombob = this.engine.buffSystem.isDiscombobulated(this.npc);
    if (isDiscombob) {
      if (!this.discombobActive) {
        // Just got discombobulated — generate a key scramble (derangement)
        this.discombobActive = true;
        this.discombobElapsed = 0;
        this.movement.generateDiscombobScramble();
      }
      this.discombobElapsed += dt;
      // Adaptation: NPC "figures out" the scramble over time.
      // adaptTime: easy ~5s (never fully adapts in 5s debuff), expert ~1.5s
      const adaptTime = 1.5 + (1 - this.difficulty.abilityUsageRate) * 6;
      const adaptProgress = Math.min(1, this.discombobElapsed / adaptTime);
      // Ease-in: adaptation is slow at first, then accelerates as NPC "gets it"
      this.movement.discombobAdaptation = adaptProgress * adaptProgress;
    } else {
      if (this.discombobActive) {
        this.discombobActive = false;
        this.movement.discombobActive = false;
        this.movement.discombobAdaptation = 0;
      }
    }

    // Don't think or move while charging (Engine moves us directly)
    if (this.engine.isNpcCharging(this.npc)) {
      return;
    }

    // Update casting/channeling
    if (this.casting) {
      this.updateCasting(dt);
      // Don't think or move while casting
      this.movement.intent = { type: 'idle' };
      this.movement.update(dt);
      return;
    }

    // Think at intervals
    this.thinkTimer += dt;
    const thinkInterval = this.difficulty.thinkIntervalMs / 1000;
    if (this.thinkTimer >= thinkInterval) {
      this.thinkTimer -= thinkInterval;
      this.think();
    }

    // Per-frame elevation routing — immediately corrects movement when target
    // is elevated, instead of waiting for the next think interval
    if (this.currentTargetEntity && !this.currentTargetEntity.dead) {
      const elevDiff = Math.abs(this.currentTargetEntity.mesh.position.y - this.npc.mesh.position.y);
      if (elevDiff > 2 && this.npc.mesh.position.y < 1) {
        const waypoint = this.findElevationWaypoint(this.currentTargetEntity.mesh.position);
        if (waypoint) {
          this.movement.intent = { type: 'moveToward', target: waypoint, stopDistance: 1.0 };
        } else {
          // Near access point — chase target directly to start climbing
          this.movement.intent = { type: 'moveToward', target: this.currentTargetEntity.mesh.position, stopDistance: 0.5 };
        }
      }
    }

    // Movement runs every frame for smooth motion
    this.movement.update(dt);
  }

  /** Start a cast-time or channeled ability */
  startCasting(ability: Ability, target: Targetable | null): boolean {
    if (this.casting) return false;
    if (!ability.castTime) return false;

    const effectiveCost = Math.round(ability.manaCost * this.engine.buffSystem.getManaCostMultiplier(this.npc));
    if (this.npc.mana < effectiveCost) return false;

    if (ability.isChannel) {
      // Channels: deduct mana and set cooldown upfront (player behavior)
      this.npc.mana -= effectiveCost;
      this.cooldowns.setCooldown(ability.id, ability.cooldown);
      this.cooldowns.triggerGcd();
    }
    // Regular casts: mana/cooldown/GCD handled on completion via npcUseAbility

    const isChannel = !!ability.isChannel;
    const totalTicks = ability.channelTicks ?? 1;
    const tickInterval = ability.castTime / totalTicks;

    this.casting = {
      ability,
      target,
      elapsed: 0,
      totalTime: ability.castTime,
      isChannel,
      tickInterval,
      ticksDelivered: 0,
      damageMultiplier: this.engine.buffSystem.getDamageDealtMultiplier(this.npc),
    };

    // Set casting state on NPC for nameplate display, animation, and beam
    this.npc.castingAbilityName = ability.name;
    this.npc.castingAbilityId = ability.id;
    this.npc.castingTarget = target;
    this.npc.castingElapsed = 0;
    this.npc.castingTotalTime = ability.castTime;
    this.npc.castingIsChannel = isChannel;

    // Trigger animation
    this.npc.model.triggerAbilityAnimation(ability.id, target?.mesh.position.clone());

    // Apply blockedByTargetDebuff at channel start (e.g. Recently Bandaged)
    if (isChannel && ability.id === 'bandage' && target) {
      this.engine.buffSystem.apply(target, RecentlyBandagedDebuff);
    }

    return true;
  }

  private updateCasting(dt: number): void {
    if (!this.casting) return;
    const cast = this.casting;
    cast.elapsed += dt;

    // Update nameplate
    this.npc.castingElapsed = cast.elapsed;

    // Check if target died
    if (cast.target && cast.target.dead) {
      this.cancelCasting();
      return;
    }

    if (cast.isChannel) {
      // Channel: deliver ticks at intervals
      while (cast.ticksDelivered < (cast.ability.channelTicks ?? 1) &&
             cast.elapsed >= cast.tickInterval * (cast.ticksDelivered + 1)) {
        cast.ticksDelivered++;
        if (cast.target) {
          const totalTicks = cast.ability.channelTicks ?? 1;
          const tickDamage = cast.ability.damage > 0 ? Math.round(cast.ability.damage / totalTicks) : 0;
          const tickHeal = cast.ability.healAmount ? Math.round(cast.ability.healAmount / totalTicks) : 0;
          this.engine.npcApplyChannelTick(this.npc, cast.target, tickDamage, tickHeal, cast.damageMultiplier);
        }
      }

      // Channel complete
      if (cast.elapsed >= cast.totalTime) {
        this.completeCasting();
      }
    } else {
      // Regular cast: complete after cast time
      if (cast.elapsed >= cast.totalTime) {
        this.completeCasting();
      }
    }
  }

  private completeCasting(): void {
    if (!this.casting) return;
    const { ability, target, isChannel } = this.casting;
    this.casting = null;

    // Clear nameplate, animation, and beam
    this.npc.castingAbilityName = null;
    this.npc.castingAbilityId = null;
    this.npc.castingTarget = null;
    this.npc.castingElapsed = 0;
    this.npc.castingTotalTime = 0;
    this.npc.castingIsChannel = false;

    // For regular casts (not channels), execute the ability now
    // Skip cooldown check — was set when casting started
    if (!isChannel) {
      this.engine.npcUseAbility(this.npc, ability.id, target);
    }
    // Channels already delivered their ticks during updateCasting
  }

  private cancelCasting(): void {
    this.casting = null;
    this.npc.castingAbilityName = null;
    this.npc.castingAbilityId = null;
    this.npc.castingTarget = null;
    this.npc.castingElapsed = 0;
    this.npc.castingTotalTime = 0;
    this.npc.castingIsChannel = false;
  }

  get isCasting(): boolean {
    return this.casting !== null;
  }

  /** Apply spell pushback when NPC takes direct damage while casting/channeling. */
  applyPushback(): void {
    if (!this.casting) return;
    const cast = this.casting;
    const originalCastTime = cast.ability.castTime ?? cast.totalTime;
    if (cast.isChannel) {
      // Channel pushback: lose 35% of full channel duration per hit (WoW-style)
      cast.totalTime = Math.max(cast.elapsed, cast.totalTime - originalCastTime * 0.35);
      this.npc.castingTotalTime = cast.totalTime;
    } else {
      // Cast pushback: increase cast time (capped at 2x original)
      const maxTime = originalCastTime * 2;
      cast.totalTime = Math.min(cast.totalTime + 0.5, maxTime);
      this.npc.castingTotalTime = cast.totalTime;
    }
  }

  private think(): void {
    const world = this.buildWorldState();

    // Update hazards for movement controller
    this.movement.hazards = world.hazards;

    // No enemies alive (or all invisible) — drop target and idle
    if (world.enemies.length === 0) {
      this.currentTarget = null;
      this.currentTargetEntity = null;
      this.npc.autoAttackTarget = null;
      this.movement.intent = { type: 'idle' };
      this.movement.faceTarget = null;
      return;
    }

    // Target evaluation
    this.evaluateTarget(world);

    if (!this.currentTarget) {
      this.movement.intent = { type: 'idle' };
      return;
    }

    // Set auto-attack target
    this.npc.autoAttackTarget = this.currentTarget.entity;
    this.currentTargetEntity = this.currentTarget.entity;

    // Enter combat
    if (!this.npc.inCombat) {
      this.engine.combatSystem.enterCombat(this.npc);
    }

    // Always face our target
    this.movement.faceTarget = this.currentTarget.position;

    // Get movement intent from behavior
    const movementIntent = this.behavior.getMovementIntent(world, this.currentTarget);

    // Override movement based on elevation or line-of-sight
    const elevationDiff = Math.abs(this.currentTarget.position.y - this.npc.mesh.position.y);
    const needsElevation = elevationDiff > 2;
    const onGround = this.npc.mesh.position.y < 1;

    if (needsElevation && onGround) {
      // NPC is on the ground, target is elevated — route via elevation access point
      const waypoint = this.findElevationWaypoint(this.currentTarget.position);
      if (waypoint) {
        this.movement.intent = {
          type: 'moveToward',
          target: waypoint,
          stopDistance: 1.0,
        };
      } else {
        this.movement.intent = {
          type: 'moveToward',
          target: this.currentTarget.position,
          stopDistance: 0.5,
        };
      }
    } else if (!this.currentTarget.inLineOfSight || needsElevation) {
      // On elevated surface or no LoS — chase target directly
      this.movement.intent = {
        type: 'moveToward',
        target: this.currentTarget.position,
        stopDistance: 0.5,
      };
    } else {
      this.movement.intent = movementIntent;
    }

    // Score and execute ability actions — skip if no LoS (abilities will fail validation)
    if (this.currentTarget.inLineOfSight && Math.random() < this.difficulty.abilityUsageRate) {
      const actions = this.behavior.scoreActions(
        world, this.cooldowns, this.difficulty, this.currentTarget
      );

      // Score common abilities (Bandage) available to all characters
      this.scoreCommonActions(actions, world);

      if (actions.length > 0) {
        // Apply general smart filters (penalize wasteful uses)
        this.applySmartFilters(actions, world);

        // Apply difficulty fuzzing
        this.fuzzScores(actions);

        // Sort by score descending
        actions.sort((a, b) => b.score - a.score);

        // Try to execute the best action
        const best = actions[0];
        if (best && best.score > 0 && best.abilityId) {
          let target = best.target?.entity ?? null;
          // Self-targeting for self-heal channels (e.g. Bandage)
          if (!target && best.ability?.isChannel && best.ability?.healAmount && !best.ability?.requiresHostileTarget) {
            target = this.npc;
          }
          if (best.isCastTime && best.ability) {
            // Cast-time or channel ability — start casting
            this.startCasting(best.ability, target);
          } else {
            // Instant ability — execute immediately
            const groundPos = best.target?.position;
            this.engine.npcUseAbility(this.npc, best.abilityId, target, groundPos);
          }
        }
      }
    }
  }

  /**
   * Score common abilities available to all characters (e.g. Bandage).
   * Appends scored actions to the provided array.
   */
  private scoreCommonActions(actions: ScoredAction[], world: WorldState): void {
    // ── Bandage (8s channel, heal 1000) ──
    if (this.abilityLookup.has('bandage') && this.cooldowns.isReady('bandage')) {
      // Check for Recently Bandaged debuff
      const hasRecentlyBandaged = world.self.debuffs.some(b => b.definition.id === 'recently-bandaged');
      if (!hasRecentlyBandaged && world.self.hpPercent < 0.5) {
        const closestEnemyDist = world.enemies.length > 0 ? world.enemies[0].distance : Infinity;
        // Only bandage when enemies are far enough away (>15yd) that we won't be interrupted
        if (closestEnemyDist > yardsToUnits(15)) {
          let score = 20;
          // Score scales with missing HP
          score += (1 - world.self.hpPercent) * 60;
          // Much higher when very low
          if (world.self.hpPercent < 0.3) score += 30;
          actions.push({
            type: 'ability', score, abilityId: 'bandage',
            ability: Bandage, isCastTime: true,
            execute: () => {},
          });
        }
      }
    }
  }

  private evaluateTarget(world: WorldState): void {
    const enemies = world.enemies;
    if (enemies.length === 0) {
      this.currentTarget = null;
      return;
    }

    // If we have a current target and it's still alive + in LoS, stick with it
    // (unless difficulty says we should consider switching)
    if (this.currentTarget) {
      const stillValid = enemies.find(e => e.entity === this.currentTarget!.entity);
      if (stillValid) {
        this.currentTarget = stillValid;
        // Chance to evaluate switching based on difficulty
        if (Math.random() > this.difficulty.targetSwitchFrequency) {
          return; // Keep current target
        }
      }
    }

    // Score each enemy as a target
    let bestTarget: EntityInfo | null = null;
    let bestScore = -Infinity;

    for (const enemy of enemies) {
      let score = 0;

      // Prefer low HP targets (execute potential)
      score += (1 - enemy.hpPercent) * 40;

      // Prefer targets in LoS
      if (enemy.inLineOfSight) score += 20;

      // Prefer closer targets (slightly)
      score += Math.max(0, 20 - enemy.distance) * 0.5;

      // Prefer targets that are casting/channeling (interrupt opportunity)
      if (enemy.isCasting || enemy.isChanneling) score += 15;

      // Prefer CC'd targets (easy damage)
      if (enemy.isStunned || enemy.isSleeping) score += 10;

      // Slight bonus for current target (avoid flip-flopping)
      if (this.currentTarget && enemy.entity === this.currentTarget.entity) {
        score += 5;
      }

      if (score > bestScore) {
        bestScore = score;
        bestTarget = enemy;
      }
    }

    this.currentTarget = bestTarget;
  }

  private checkCCBreak(dt: number): void {
    const isCC = this.engine.buffSystem.isStunned(this.npc)
      || this.engine.buffSystem.isSleeping(this.npc)
      || this.engine.buffSystem.isBlinded(this.npc);

    if (!isCC) {
      this.wasCCd = false;
      this.ccReactionTimer = 0;
      return;
    }

    if (!this.cooldowns.isReady('pvp-trinket')) return;

    // Start reaction timer when CC is first detected
    if (!this.wasCCd) {
      this.wasCCd = true;
      this.ccReactionTimer = this.difficulty.reactionDelayMs / 1000;
    }

    // Wait for reaction time to elapse
    this.ccReactionTimer -= dt;
    if (this.ccReactionTimer > 0) return;

    // Roll for trinket use (one attempt per CC application)
    if (Math.random() > this.difficulty.interruptChance) {
      // Failed the roll — don't retry every frame; wait for next CC application
      this.wasCCd = false;
      return;
    }

    this.engine.npcUseAbility(this.npc, 'pvp-trinket', null);
  }

  /**
   * Apply general-purpose intelligence filters to scored actions.
   * Penalizes wasteful ability uses: heals at high HP, defensive buffs with no
   * pressure, targeted abilities out of range. The difficulty's `wastefulness`
   * parameter controls how strict these checks are — easy bots waste more.
   */
  private applySmartFilters(actions: ScoredAction[], world: WorldState): void {
    const w = this.difficulty.wastefulness;
    // penaltyScale: 0.3 for easy → 0.98 for expert
    const penaltyScale = 1 - w;

    for (const action of actions) {
      if (!action.abilityId) continue;
      const ability = this.abilityLookup.get(action.abilityId);
      if (!ability) continue;

      // ── Self-heal at high HP ──
      // Self-cast heal (no target = self): skip when healthy
      if (ability.healAmount && !ability.requiresHostileTarget && !action.target) {
        // threshold: easy ~0.86, expert ~0.66 — expert skips healing above 66% HP
        const threshold = 0.65 + 0.30 * w;
        if (world.self.hpPercent > threshold) {
          action.score -= 100 * penaltyScale;
        }
      }

      // ── Ally heal at high HP ──
      if (ability.healAmount && action.target) {
        const isAlly = !world.self.entity.isHostileTo(action.target.entity);
        if (isAlly) {
          const threshold = 0.65 + 0.30 * w;
          if (action.target.hpPercent > threshold) {
            action.score -= 100 * penaltyScale;
          }
        }
      }

      // ── Defensive self-buff with no pressure ──
      // Shield / damage-reduction buffs are wasteful at high HP with no nearby threats
      if (ability.appliesSelfBuff && !ability.requiresHostileTarget && !ability.healAmount) {
        const buff = ability.appliesSelfBuff;
        const isDefensive = buff.shieldAmount != null
          || buff.shieldReflectPercent != null
          || buff.effects.some(e => e.type === 'damageTakenPercent' && e.value < 0);
        if (isDefensive) {
          const threatRange = yardsToUnits(8);
          const noNearbyThreat = !world.enemies.some(e => e.distance < threatRange);
          const hpThreshold = 0.60 + 0.30 * w;
          if (world.self.hpPercent > hpThreshold && noNearbyThreat) {
            action.score -= 80 * penaltyScale;
          }
        }
      }

      // ── Targeted ability out of range (safety net) ──
      if (ability.range && action.target) {
        const rangeBuffer = ability.range * (1 + w * 0.3);
        if (action.target.distance > rangeBuffer) {
          action.score -= 80 * penaltyScale;
        }
      }
    }
  }

  private fuzzScores(actions: ScoredAction[]): void {
    const fuzz = this.difficulty.scoreFuzz;
    if (fuzz <= 0) return;

    for (const action of actions) {
      // Add random noise proportional to the fuzz factor
      action.score += (Math.random() - 0.5) * 2 * fuzz * 100;
    }
  }

  /**
   * Find the best elevation access point to route through when the target is elevated.
   * Strategy: find access points closest to the TARGET (same archway), then pick
   * the one nearest to the NPC for shortest path.
   * Returns a Vector3 waypoint, or null if no access points or already near one.
   */
  private findElevationWaypoint(targetPos: THREE.Vector3): THREE.Vector3 | null {
    const accessPoints = this.engine.getCollisionSystem().getElevationAccessPoints();
    if (accessPoints.length === 0) return null;

    const npcPos = this.npc.mesh.position;

    // Find the minimum distance from any access point to the target
    let minTargetDist = Infinity;
    for (const pt of accessPoints) {
      const dx = targetPos.x - pt.x;
      const dz = targetPos.z - pt.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < minTargetDist) minTargetDist = d;
    }

    // Consider access points within 20% of the minimum as "same structure"
    const threshold = minTargetDist * 1.2;
    let bestPoint: { x: number; z: number } | null = null;
    let bestNpcDist = Infinity;

    for (const pt of accessPoints) {
      const tdx = targetPos.x - pt.x;
      const tdz = targetPos.z - pt.z;
      if (Math.sqrt(tdx * tdx + tdz * tdz) > threshold) continue;

      const ndx = npcPos.x - pt.x;
      const ndz = npcPos.z - pt.z;
      const npcDist = Math.sqrt(ndx * ndx + ndz * ndz);

      if (npcDist < bestNpcDist) {
        bestNpcDist = npcDist;
        bestPoint = pt;
      }
    }

    if (!bestPoint) return null;

    // If already near the access point, return null so the caller chases directly
    if (bestNpcDist < 3) return null;

    return new THREE.Vector3(bestPoint.x, 0, bestPoint.z);
  }

  private buildWorldState(): WorldState {
    return buildWorldState(
      this.npc,
      this.engine.getAllTargetables(),
      this.engine.buffSystem,
      this.engine.getCollisionSystem(),
      this.engine.getArenaBounds(),
      this.engine.getHazards()
    );
  }
}
