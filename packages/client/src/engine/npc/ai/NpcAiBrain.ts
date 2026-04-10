import * as THREE from 'three';
import type { NpcController } from '../NpcController';
import type { Targetable } from '../../types';
import type { BuffSystem } from '../../combat/BuffSystem';
import type { CombatSystem } from '../../combat/CombatSystem';
import type { CollisionSystem } from '../../physics/CollisionSystem';
import { getCharacterStats, yardsToUnits, isFacingCheck, Bandage, RecentlyBandagedDebuff, abilityCooldown, type Ability } from '@gtr/shared';
import { MovementController } from './MovementController';
import { NpcCooldownTracker } from './NpcCooldownTracker';
import { NpcNavigation } from './NpcNavigation';
import type { DifficultyProfile } from './DifficultyProfile';
import type { CharacterBehavior, ScoredAction } from './behaviors/BaseBehavior';
import { buildWorldState, type WorldState, type EntityInfo, type HazardInfo } from './WorldState';

/**
 * Controls the NPC's overall playstyle.
 * - `aggressive`: (default) Chases opponent, uses abilities proactively.
 * - `passive`: Stands ground, only fights when opponent is close.
 * - `kiting`: Maintains distance, runs away from melee.
 */
export type NpcBehaviorMode = 'aggressive' | 'passive' | 'kiting';

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
  getNpcSpawnBounds(): { minX: number; maxX: number; minZ: number; maxZ: number };
  getAllTargetables(): Targetable[];
  getHazards(): HazardInfo[];
  npcUseAbility(npc: NpcController, abilityId: string, target: Targetable | null, groundPos?: THREE.Vector3): boolean;
  npcApplyChannelTick(npc: NpcController, target: Targetable, tickDamage: number, healAmount: number, damageMultiplier: number): void;
  isNpcCharging(npc: NpcController): boolean;
  isArenaPreparationActive(): boolean;
  getPillarState(): { ewPillarUp: number; nsPillarUp: number; pillarPhasePct: number };
  getMatchTimePct(): number;
  npcSetResting(npc: NpcController, resting: boolean): void;
}

export class NpcAiBrain {
  readonly npc: NpcController;
  private engine: AiEngineInterface;
  private behavior: CharacterBehavior;
  private difficulty: DifficultyProfile;
  readonly movement: MovementController;
  readonly cooldowns: NpcCooldownTracker;
  /** Controls overall playstyle — defaults to aggressive. */
  behaviorMode: NpcBehaviorMode = 'aggressive';
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

  private readonly navigation: NpcNavigation;

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

    this.navigation = new NpcNavigation(
      () => engine.getCollisionSystem(),
      npc.characterId,
    );

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

    // If think() just started a charge (e.g. Sweep), skip movement this frame —
    // the charge system will take over next frame.
    if (this.engine.isNpcCharging(this.npc)) {
      return;
    }

    // Per-frame navigation — corrects movement for archway path-following and
    // elevator awareness without waiting for the next think interval
    if (this.currentTargetEntity && !this.currentTargetEntity.dead) {
      this.navigation.commitTimer -= dt;
      const navResult = this.navigation.resolveNavigation(this.npc.mesh.position, this.currentTargetEntity.mesh.position);
      if (navResult) {
        if (navResult.type === 'wait') {
          this.movement.intent = { type: 'idle' };
        } else {
          // Use NPC's current Y for nav waypoints — the movement controller
          // handles XZ navigation while the collision system handles Y via
          // ground following. This prevents the elevation check from stalling
          // the NPC when the WP's stored Y doesn't match actual ground height.
          const t = navResult.target;
          this.movement.intent = {
            type: 'moveToward',
            target: new THREE.Vector3(t.x, this.npc.mesh.position.y, t.z),
            stopDistance: navResult.stopDistance,
          };
        }
      } else if (this.movement.intent.type === 'moveToward') {
        // Nav disengaged — if the NPC has arrived at the old nav WP, replace
        // with direct chase to prevent stalling until the next think() cycle.
        const i = this.movement.intent;
        const dx = i.target.x - this.npc.mesh.position.x;
        const dz = i.target.z - this.npc.mesh.position.z;
        if (dx * dx + dz * dz <= (i.stopDistance + 0.3) ** 2) {
          this.movement.intent = {
            type: 'moveToward',
            target: this.currentTargetEntity.mesh.position.clone(),
            stopDistance: 0.5,
          };
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

    // Validate range, facing, and line of sight for hostile-targeted abilities
    if (ability.requiresHostileTarget && target) {
      const selfPos = this.npc.mesh.position;
      const targetPos = target.mesh.position;
      const dist = selfPos.distanceTo(targetPos);
      if (ability.range && dist > ability.range) return false;
      if (ability.minRange && dist < ability.minRange) return false;
      if (ability.requiresFacing !== false) {
        const fwdX = Math.sin(this.npc.mesh.rotation.y);
        const fwdZ = Math.cos(this.npc.mesh.rotation.y);
        if (!isFacingCheck(fwdX, fwdZ, targetPos.x - selfPos.x, targetPos.z - selfPos.z)) return false;
      }
      const collision = this.engine.getCollisionSystem();
      if (!collision.hasLineOfSight(selfPos.x, selfPos.z, targetPos.x, targetPos.z, selfPos.y, targetPos.y)) return false;
    }

    // Validate range for friendly-targeted abilities (non-self)
    if (ability.requiresTarget && !ability.requiresHostileTarget && target && target !== this.npc) {
      const dist = this.npc.mesh.position.distanceTo(target.mesh.position);
      if (ability.range && dist > ability.range) return false;
    }

    // Check blockedByTargetDebuff (e.g. RecentlyBandaged prevents Bandage spam)
    if (ability.blockedByTargetDebuff) {
      const effectiveTarget = target ?? this.npc;
      if (this.engine.buffSystem.hasDebuff(effectiveTarget, ability.blockedByTargetDebuff)) {
        return false;
      }
    }

    const effectiveCost = Math.round(ability.manaCost * this.engine.buffSystem.getManaCostMultiplier(this.npc));
    if (this.npc.mana < effectiveCost) return false;

    if (ability.isChannel) {
      // Channels: deduct mana and set cooldown upfront (player behavior)
      this.npc.mana -= effectiveCost;
      this.cooldowns.setCooldown(ability.id, abilityCooldown(ability));
      if (!ability.offGcd) {
        this.cooldowns.triggerGcd();
      }
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
    // Reset GCD when a non-channel cast is canceled
    if (this.casting && !this.casting.isChannel) {
      this.cooldowns.resetGcd();
    }
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

    // Always trigger neural inference so the model gets fresh observations every
    // think cycle — matching the headless arena where the agent always receives new
    // observations. Without this, resting creates a feedback loop: rest=1 → brain
    // returns early → scoreActions never called → no new inference → stuck forever.
    this.behavior.updateInference?.(this.cooldowns, this.currentTarget);

    // Neural rest: only actually rest when conditions allow it.
    // In the headless arena (training), rest=1 fails silently when inCombat/isMoving
    // and movement+abilities still process. Match that behavior here: only commit to
    // resting when it would actually succeed, otherwise fall through to normal combat.
    const wantsRest = this.behavior.wantsRest?.() ?? false;
    if (wantsRest && !this.npc.inCombat && !this.npc.isMoving) {
      this.npc.autoAttackTarget = null;
      this.currentTargetEntity = this.currentTarget.entity;
      this.movement.intent = { type: 'idle' };
      this.movement.faceTarget = null;
      this.engine.npcSetResting(this.npc, true);
      return;
    }
    // Cancel resting if we were resting but no longer want to (or can't)
    this.engine.npcSetResting(this.npc, false);

    // Set auto-attack target
    this.npc.autoAttackTarget = this.currentTarget.entity;
    this.currentTargetEntity = this.currentTarget.entity;

    // Enter combat — rule-based behaviors force combat on engagement so
    // auto-attacks start immediately. Neural behaviors enter combat organically
    // through damage events, matching the training environment.
    if (!this.npc.inCombat && !this.behavior.updateInference) {
      this.engine.combatSystem.enterCombat(this.npc);
    }

    // Always face our target
    this.movement.faceTarget = this.currentTarget.position;

    // Get movement intent — behavior mode can override the character behavior's movement
    let movementIntent = this.behavior.getMovementIntent(world, this.currentTarget, this.cooldowns, this.difficulty);
    if (this.behaviorMode === 'passive') {
      // Passive: stand ground, don't chase
      movementIntent = { type: 'idle' };
    } else if (this.behaviorMode === 'kiting') {
      // Kiting: use kiteFrom intent — wall avoidance is handled by MovementController
      const desiredRange = yardsToUnits(18);
      movementIntent = {
        type: 'kiteFrom',
        threat: this.currentTarget.position,
        maxRange: desiredRange + yardsToUnits(5),
        preferredRange: desiredRange,
      };
    }

    // Override movement for navigation paths (archways), elevator, or LoS issues
    const navResult = this.navigation.resolveNavigation(this.npc.mesh.position, this.currentTarget.position);

    if (navResult) {
      if (navResult.type === 'wait') {
        this.movement.intent = { type: 'idle' };
      } else {
        this.movement.intent = { type: 'moveToward', target: navResult.target, stopDistance: navResult.stopDistance };
      }
    } else if (!this.currentTarget.inLineOfSight) {
      // No special navigation needed but no LoS — chase target directly
      this.movement.intent = {
        type: 'moveToward',
        target: this.currentTarget.position,
        stopDistance: 0.5,
      };
    } else {
      this.movement.intent = movementIntent;
    }

    // Behavior mode ability gating — passive NPCs only use abilities reactively when close,
    // kiting NPCs only when within their comfortable range
    const abilityGateDistance = this.behaviorMode === 'passive' ? yardsToUnits(8)
      : this.behaviorMode === 'kiting' ? yardsToUnits(15) : Infinity;
    const behaviorAllowsAbilities = this.currentTarget.distance <= abilityGateDistance;

    // Score and execute ability actions — skip if no LoS (abilities will fail validation)
    if (behaviorAllowsAbilities && this.currentTarget.inLineOfSight && Math.random() < this.difficulty.abilityUsageRate) {
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
          // Apply aim override for skill-shot abilities (e.g. Sweep leading)
          if (best.aimRotation != null) {
            this.npc.mesh.rotation.y = best.aimRotation;
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
      if (enemy.isStunned || enemy.isSleeping || enemy.isDisoriented) score += 10;

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
      || this.engine.buffSystem.isDisoriented(this.npc)
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
