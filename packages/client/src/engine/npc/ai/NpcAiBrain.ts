import * as THREE from 'three';
import type { NpcController } from '../NpcController';
import type { Targetable } from '../../types';
import type { BuffSystem } from '../../combat/BuffSystem';
import type { CombatSystem } from '../../combat/CombatSystem';
import type { CollisionSystem, NavigationPath } from '../../physics/CollisionSystem';
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

    // Per-frame navigation — corrects movement for archway path-following and
    // elevator awareness without waiting for the next think interval
    if (this.currentTargetEntity && !this.currentTargetEntity.dead) {
      const navResult = this.getNavigationTarget(this.currentTargetEntity.mesh.position);
      if (navResult) {
        if (navResult.type === 'wait') {
          this.movement.intent = { type: 'idle' };
        } else {
          this.movement.intent = { type: 'moveToward', target: navResult.target, stopDistance: navResult.stopDistance };
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

    // Override movement for navigation paths (archways), elevator, or LoS issues
    const navResult = this.getNavigationTarget(this.currentTarget.position);

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

  // ---------------------------------------------------------------------------
  // Navigation: archway path-following + elevator awareness
  // ---------------------------------------------------------------------------

  /**
   * Determines the next navigation waypoint for the NPC, or signals it should
   * wait (e.g. target on elevator at different level).
   *
   * Returns null when no special navigation is needed (normal behavior applies).
   */
  private getNavigationTarget(
    targetPos: THREE.Vector3
  ): { type: 'waypoint'; target: THREE.Vector3; stopDistance: number } | { type: 'wait' } | null {
    const npcPos = this.npc.mesh.position;
    const collision = this.engine.getCollisionSystem();

    // ── Elevator / moving-platform navigation ─────────────────────────
    const platforms = collision.getMovingPlatforms();
    for (const platform of platforms) {
      const surfaceY = platform.getY();

      // Is the NPC standing on this platform?
      const npcOnPlatform = Math.abs(npcPos.x - platform.cx) <= platform.halfW + 0.5 &&
                             Math.abs(npcPos.z - platform.cz) <= platform.halfD + 0.5 &&
                             Math.abs(npcPos.y - surfaceY) < 1.5;

      // Is the target standing on this platform?
      const targetOnPlatform = Math.abs(targetPos.x - platform.cx) <= platform.halfW &&
                                Math.abs(targetPos.z - platform.cz) <= platform.halfD &&
                                Math.abs(targetPos.y - surfaceY) < 0.8;

      if (npcOnPlatform) {
        // NPC is riding the elevator
        if (surfaceY < 2 && !targetOnPlatform) {
          // Platform at ground level and target is elsewhere — step off
          continue;
        }
        // Elevated — if target is here and reachable, fight normally
        if (targetOnPlatform && Math.abs(npcPos.y - targetPos.y) < 3) return null;
        // Otherwise ride the elevator (wait for it to reach target or ground)
        return { type: 'wait' };
      }

      if (targetOnPlatform) {
        // Target is on the elevator, NPC is not
        if (Math.abs(surfaceY - npcPos.y) < 3) {
          // Elevator is at NPC's level — walk onto it
          return { type: 'waypoint',
                   target: new THREE.Vector3(platform.cx, surfaceY, platform.cz),
                   stopDistance: 1.0 };
        }
        // Elevator is at a different level — walk to its XZ position and wait
        const distToPlat = this.horizDist(npcPos, { x: platform.cx, z: platform.cz });
        if (distToPlat > 2) {
          return { type: 'waypoint',
                   target: new THREE.Vector3(platform.cx, npcPos.y, platform.cz),
                   stopDistance: 1.0 };
        }
        return { type: 'wait' };
      }
    }

    // Target above all archway peaks — only reachable by elevator
    if (targetPos.y > 18 && platforms.length > 0) {
      const platform = platforms[0];
      const surfaceY = platform.getY();
      if (Math.abs(surfaceY - npcPos.y) < 3) {
        return { type: 'waypoint',
                 target: new THREE.Vector3(platform.cx, surfaceY, platform.cz),
                 stopDistance: 1.0 };
      }
      const distToPlat = this.horizDist(npcPos, { x: platform.cx, z: platform.cz });
      if (distToPlat > 2) {
        return { type: 'waypoint',
                 target: new THREE.Vector3(platform.cx, npcPos.y, platform.cz),
                 stopDistance: 1.0 };
      }
      return { type: 'wait' };
    }

    // ── Archway path-following ──────────────────────────────────────────
    const paths = collision.getNavigationPaths();
    if (paths.length === 0) return null;

    const npcElevated = npcPos.y > 2;
    const targetElevated = targetPos.y > 2;

    // Both on the ground — no path navigation needed
    if (!npcElevated && !targetElevated) return null;

    if (npcElevated) {
      return this.navigateFromElevated(paths, npcPos, targetPos, targetElevated);
    } else {
      // NPC on ground, target elevated — route to archway base
      return this.navigateFromGround(paths, npcPos, targetPos);
    }
  }

  /** NPC is elevated (on an archway) — follow path toward target or toward exit. */
  private navigateFromElevated(
    paths: readonly NavigationPath[],
    npcPos: THREE.Vector3,
    targetPos: THREE.Vector3,
    targetElevated: boolean,
  ): { type: 'waypoint'; target: THREE.Vector3; stopDistance: number } | null {
    // Find which path the NPC is on (nearest waypoint using 3D distance)
    let npcPath: NavigationPath | null = null;
    let npcWpIdx = 0;
    let npcWpDist = Infinity;

    for (const path of paths) {
      for (let i = 0; i < path.waypoints.length; i++) {
        const wp = path.waypoints[i];
        const dx = npcPos.x - wp.x;
        const dy = npcPos.y - wp.y;
        const dz = npcPos.z - wp.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < npcWpDist) {
          npcWpDist = dist;
          npcWpIdx = i;
          npcPath = path;
        }
      }
    }

    if (!npcPath || npcWpDist > 8) return null; // Not convincingly on any path

    const wps = npcPath.waypoints;

    if (targetElevated) {
      // Check if target is on the SAME path
      let targetWpIdx = 0;
      let targetWpDist = Infinity;
      for (let i = 0; i < wps.length; i++) {
        const wp = wps[i];
        const dx = targetPos.x - wp.x;
        const dy = targetPos.y - wp.y;
        const dz = targetPos.z - wp.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < targetWpDist) {
          targetWpDist = dist;
          targetWpIdx = i;
        }
      }

      if (targetWpDist < 8) {
        // Target is on the same path — follow waypoints toward it
        if (Math.abs(npcWpIdx - targetWpIdx) <= 1) return null; // Close, chase directly
        const dir = targetWpIdx > npcWpIdx ? 1 : -1;
        const nextIdx = npcWpIdx + dir;
        const wp = wps[nextIdx];
        return { type: 'waypoint', target: new THREE.Vector3(wp.x, wp.y, wp.z), stopDistance: 0.8 };
      }
    }

    // Target is on the ground or on a different path — pick the exit that
    // minimises total travel: waypoint steps to reach the exit + horizontal
    // distance from exit to target.
    const startWp = wps[0];
    const endWp = wps[wps.length - 1];
    const startCost = npcWpIdx +
      Math.sqrt((startWp.x - targetPos.x) ** 2 + (startWp.z - targetPos.z) ** 2);
    const endCost = (wps.length - 1 - npcWpIdx) +
      Math.sqrt((endWp.x - targetPos.x) ** 2 + (endWp.z - targetPos.z) ** 2);
    const exitIdx = startCost < endCost ? 0 : wps.length - 1;

    if (Math.abs(npcWpIdx - exitIdx) <= 1) return null; // Near exit, normal nav takes over

    const dir = exitIdx > npcWpIdx ? 1 : -1;
    const nextIdx = npcWpIdx + dir;
    const wp = wps[nextIdx];
    return { type: 'waypoint', target: new THREE.Vector3(wp.x, wp.y, wp.z), stopDistance: 0.8 };
  }

  /** NPC is on the ground, target is elevated — route along the correct archway path. */
  private navigateFromGround(
    paths: readonly NavigationPath[],
    npcPos: THREE.Vector3,
    targetPos: THREE.Vector3,
  ): { type: 'waypoint'; target: THREE.Vector3; stopDistance: number } | null {
    // Find which path the target is on
    let bestPath: NavigationPath | null = null;
    let bestTargetIdx = -1;
    let bestTargetDist = Infinity;

    for (const path of paths) {
      for (let i = 0; i < path.waypoints.length; i++) {
        const wp = path.waypoints[i];
        const dx = targetPos.x - wp.x;
        const dy = targetPos.y - wp.y;
        const dz = targetPos.z - wp.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < bestTargetDist) {
          bestTargetDist = dist;
          bestTargetIdx = i;
          bestPath = path;
        }
      }
    }

    if (!bestPath || bestTargetDist > 15) return null;

    const wps = bestPath.waypoints;

    // Determine which end of the path to use (nearest base)
    const startDist = this.horizDist(npcPos, wps[0]);
    const endDist = this.horizDist(npcPos, wps[wps.length - 1]);
    const baseIdx = startDist < endDist ? 0 : wps.length - 1;

    // ── Interior-side check ──
    // The archway tube blocks NPCs that try to walk to the base from underneath.
    // Detect if the NPC is on the interior (blocked) side and route it to the
    // approach waypoint at the end of the chain first.
    const approach = this.checkInteriorApproach(wps, baseIdx, npcPos);
    if (approach) return approach;

    // ── Normal routing: find nearest reachable waypoint and follow chain ──
    // Only match waypoints close to the NPC's current Y to prevent matching
    // mid-chain waypoints overhead while still on the ground/mound.
    let npcWpIdx = -1;
    let npcWpDist = Infinity;
    const maxWpY = npcPos.y + 2;

    for (let i = 0; i < wps.length; i++) {
      const wp = wps[i];
      if (wp.y > maxWpY) continue;
      const dx = npcPos.x - wp.x;
      const dy = npcPos.y - wp.y;
      const dz = npcPos.z - wp.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < npcWpDist) {
        npcWpDist = dist;
        npcWpIdx = i;
      }
    }

    // No nearby reachable waypoint — route to the base approach waypoint so
    // the NPC enters from the tube end where the surface starts at ground
    // level and rises gradually (each step within collision step-height).
    if (npcWpIdx < 0 || npcWpDist > 8) {
      const baseWp = wps[baseIdx];
      return { type: 'waypoint', target: new THREE.Vector3(baseWp.x, 0, baseWp.z), stopDistance: 1.0 };
    }

    // Close enough to the target's waypoint — let normal movement chase directly
    if (Math.abs(npcWpIdx - bestTargetIdx) <= 1) return null;

    // Walk toward the next waypoint in the direction of the target
    const dir = bestTargetIdx > npcWpIdx ? 1 : -1;
    const nextIdx = npcWpIdx + dir;
    const wp = wps[nextIdx];
    return { type: 'waypoint', target: new THREE.Vector3(wp.x, wp.y, wp.z), stopDistance: 0.8 };
  }

  /**
   * Check if the NPC is on the interior side of an archway (where the tube
   * overhead would block it from reaching the base). If so, return a waypoint
   * that routes the NPC to the approach point at the path end — positioned
   * beyond the arch extent where there is nothing overhead.
   */
  private checkInteriorApproach(
    wps: readonly { readonly x: number; readonly y: number; readonly z: number }[],
    baseIdx: number,
    npcPos: THREE.Vector3,
  ): { type: 'waypoint'; target: THREE.Vector3; stopDistance: number } | null {
    // The approach waypoints sit at wps[0] and wps[last]. The actual arch base
    // (where the tube surface meets the ground) is one step inward: wps[1] or wps[last-1].
    // We measure "interior side" relative to the REAL arch base, not the approach point.
    const realBaseIdx = baseIdx === 0 ? 1 : wps.length - 2;
    if (realBaseIdx < 0 || realBaseIdx >= wps.length) return null;
    const baseWp = wps[realBaseIdx];

    // Compute inward direction: from the real base toward the arch interior.
    // Use a waypoint several steps into the path for a stable direction.
    const inSteps = Math.min(8, Math.floor(wps.length / 3));
    const inIdx = baseIdx === 0 ? realBaseIdx + inSteps : realBaseIdx - inSteps;
    if (inIdx < 0 || inIdx >= wps.length) return null;
    const inWp = wps[inIdx];

    const inX = inWp.x - baseWp.x;
    const inZ = inWp.z - baseWp.z;
    const inLen = Math.sqrt(inX * inX + inZ * inZ);
    if (inLen < 1) return null;

    // How far the NPC is along the inward direction (projection onto inward axis)
    const relX = npcPos.x - baseWp.x;
    const relZ = npcPos.z - baseWp.z;
    const proj = (relX * inX + relZ * inZ) / inLen;

    // Not on the interior side — only trigger for NPCs clearly past the base
    if (proj <= 0) return null;

    // Route to the approach waypoint (first or last in the chain).
    // These sit beyond the arch extent where the tube is underground.
    const approachWp = baseIdx === 0 ? wps[0] : wps[wps.length - 1];
    const approachDist = this.horizDist(npcPos, approachWp);

    // Already near the approach — let normal routing take over
    if (approachDist < 3) return null;

    return { type: 'waypoint', target: new THREE.Vector3(approachWp.x, 0, approachWp.z), stopDistance: 2.0 };
  }

  private horizDist(a: THREE.Vector3, b: { x: number; z: number }): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
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
