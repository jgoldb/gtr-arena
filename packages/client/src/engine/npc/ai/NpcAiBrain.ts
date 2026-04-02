import * as THREE from 'three';
import type { NpcController } from '../NpcController';
import type { Targetable } from '../../types';
import type { BuffSystem } from '../../combat/BuffSystem';
import type { CombatSystem } from '../../combat/CombatSystem';
import type { CollisionSystem, NavigationPath } from '../../physics/CollisionSystem';
import { getCharacterStats, yardsToUnits, Bandage, RecentlyBandagedDebuff, MELEE_RANGE_THRESHOLD, type Ability } from '@gtr/shared';
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

  /** DEBUG: navigation logging timer */
  private _navDebugTimer = 0;

  /** Navigation commitment — prevents frame-by-frame waypoint oscillation.
   *  When the NPC picks a navigation target, it commits for a short duration
   *  before re-evaluating, preventing rapid flipping between waypoints. */
  private cachedNavResult: { type: 'waypoint'; target: THREE.Vector3; stopDistance: number } | { type: 'wait' } | null = null;
  private navCommitTimer = 0;
  private navCommitTargetPos: THREE.Vector3 | null = null;

  /** Re-usable result type for detectPathSurface */
  private static readonly PATH_SURFACE_MAX_Y_GAP = 1.5;
  private static readonly PATH_SURFACE_MAX_XZ_DIST = 4;

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
      this.navCommitTimer -= dt;
      const navResult = this.resolveNavigation(this.currentTargetEntity.mesh.position);
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
      // DEBUG: log navigation state once per second
      this._navDebugTimer = (this._navDebugTimer ?? 0) + dt;
      if (this._navDebugTimer > 1) {
        this._navDebugTimer = 0;
        const p = this.npc.mesh.position;
        const tp = this.currentTargetEntity.mesh.position;
        const nr = navResult;
        const wp = nr && nr.type === 'waypoint' ? nr.target : null;
        console.log(`[NAV] npc=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}) target=(${tp.x.toFixed(1)},${tp.y.toFixed(1)},${tp.z.toFixed(1)}) nav=${nr ? nr.type : 'null'}${wp ? ` wp=(${wp.x.toFixed(1)},${wp.y.toFixed(1)},${wp.z.toFixed(1)}) stop=${(nr as any).stopDistance?.toFixed(1)}` : ''} intent=${this.movement.intent.type} isMoving=${this.npc.isMoving} stuck=${(this.movement as any).stuckDuration?.toFixed(1)}`);
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
    const movementIntent = this.behavior.getMovementIntent(world, this.currentTarget, this.cooldowns, this.difficulty);

    // Override movement for navigation paths (archways), elevator, or LoS issues
    const navResult = this.resolveNavigation(this.currentTarget.position);

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
   * Returns a (possibly cached) navigation result, preventing frame-by-frame
   * oscillation between waypoints. Recalculates when: the commit timer expires,
   * the NPC reaches its current waypoint, or the target entity moves significantly.
   */
  private resolveNavigation(
    targetPos: THREE.Vector3
  ): { type: 'waypoint'; target: THREE.Vector3; stopDistance: number } | { type: 'wait' } | null {
    const npcPos = this.npc.mesh.position;

    const targetMoved = this.navCommitTargetPos &&
      this.navCommitTargetPos.distanceTo(targetPos) > 5;
    const reachedWaypoint = this.cachedNavResult?.type === 'waypoint' &&
      npcPos.distanceTo(this.cachedNavResult.target) < this.cachedNavResult.stopDistance + 0.5;
    const needsRecalc = this.navCommitTimer <= 0 || targetMoved || reachedWaypoint;

    if (needsRecalc) {
      this.cachedNavResult = this.getNavigationTarget(targetPos);
      // Wait states (elevator) re-evaluate faster since platform Y changes continuously
      this.navCommitTimer = this.cachedNavResult?.type === 'wait' ? 0.3 : 1.0;
      this.navCommitTargetPos = targetPos.clone();
    }

    return this.cachedNavResult;
  }

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
    const isMelee = getCharacterStats(this.npc.characterId).autoAttackRange
                    <= MELEE_RANGE_THRESHOLD;

    for (const platform of platforms) {
      const surfaceY = platform.getY();
      const isCircular = platform.isCircular ?? false;

      // XZ containment check (circular for pillars, box for elevators)
      const npcInXZ = isCircular
        ? this.horizDist(npcPos, { x: platform.cx, z: platform.cz }) <= platform.halfW + 0.5
        : (Math.abs(npcPos.x - platform.cx) <= platform.halfW + 0.5 &&
           Math.abs(npcPos.z - platform.cz) <= platform.halfD + 0.5);

      const targetInXZ = isCircular
        ? this.horizDist(targetPos, { x: platform.cx, z: platform.cz }) <= platform.halfW + 0.3
        : (Math.abs(targetPos.x - platform.cx) <= platform.halfW &&
           Math.abs(targetPos.z - platform.cz) <= platform.halfD);

      const npcOnPlatform = npcInXZ && Math.abs(npcPos.y - surfaceY) < 1.5;
      const targetOnPlatform = targetInXZ && Math.abs(targetPos.y - surfaceY) < 0.8;

      // ── Auto-cycling platform anticipation (pillars) ──
      const isCycling = platform.cyclesAutomatically === true
                        && platform.maxY !== undefined
                        && platform.minY !== undefined;

      const isSubmerged = isCycling && surfaceY < (platform.minY! + 1.5);
      const isRaised = isCycling && surfaceY > (platform.maxY! - 1.5);

      // Target is on/near a submerged cycling platform — melee NPCs should
      // move onto the footprint so they ride up together when it rises.
      if (isCycling && targetInXZ && isSubmerged && isMelee) {
        // Use a tight check: NPC must be well inside the actual collider radius
        // (not just the generous npcInXZ tolerance) to guarantee it rides the
        // pillar up. halfW IS the collider radius for circular platforms.
        const npcDistToCenter = this.horizDist(npcPos, { x: platform.cx, z: platform.cz });
        if (npcDistToCenter < platform.halfW - 0.3) {
          // Firmly on the platform — fight normally.
          // When the pillar rises, both entities ride up together.
          return null;
        }
        // Not centered enough — walk to the platform center
        return { type: 'waypoint',
                 target: new THREE.Vector3(platform.cx, npcPos.y, platform.cz),
                 stopDistance: 0.3 };
      }

      // Target is on a raised cycling platform the NPC isn't on —
      // walk to base and wait for it to descend.
      if (isCycling && targetOnPlatform && isRaised && !npcOnPlatform) {
        const distToPlat = this.horizDist(npcPos, { x: platform.cx, z: platform.cz });
        if (distToPlat > platform.halfW + 1) {
          return { type: 'waypoint',
                   target: new THREE.Vector3(platform.cx, npcPos.y, platform.cz),
                   stopDistance: 0.5 };
        }
        return { type: 'wait' };
      }

      // Ranged NPC vs raised cycling platform: re-route if height diff
      // makes attacks impractical.
      if (isCycling && targetOnPlatform && isRaised && !npcOnPlatform && !isMelee) {
        if (Math.abs(surfaceY - npcPos.y) > 4) {
          const distToPlat = this.horizDist(npcPos, { x: platform.cx, z: platform.cz });
          if (distToPlat > platform.halfW + 2) {
            return { type: 'waypoint',
                     target: new THREE.Vector3(platform.cx, npcPos.y, platform.cz),
                     stopDistance: platform.halfW + 1 };
          }
          return { type: 'wait' };
        }
      }

      // ── Standard elevator/platform logic ──
      if (npcOnPlatform) {
        if (surfaceY < 2 && !targetOnPlatform) {
          // Platform at ground level and target is elsewhere — step off
          continue;
        }
        // Elevated — if target is here and reachable, fight normally
        if (targetOnPlatform && Math.abs(npcPos.y - targetPos.y) < 3) return null;
        // Otherwise ride the platform (wait for it to reach target or ground)
        return { type: 'wait' };
      }

      if (targetOnPlatform) {
        // Target is on the platform, NPC is not
        if (Math.abs(surfaceY - npcPos.y) < 3) {
          // Platform is at NPC's level — walk onto it
          return { type: 'waypoint',
                   target: new THREE.Vector3(platform.cx, surfaceY, platform.cz),
                   stopDistance: 1.0 };
        }
        // Platform is at a different level — walk to its XZ position and wait
        const distToPlat = this.horizDist(npcPos, { x: platform.cx, z: platform.cz });
        if (distToPlat > 2) {
          return { type: 'waypoint',
                   target: new THREE.Vector3(platform.cx, npcPos.y, platform.cz),
                   stopDistance: 1.0 };
        }
        return { type: 'wait' };
      }
    }

    // Target above all archway peaks — only reachable by elevator.
    // Find the non-cycling platform (elevator) specifically.
    if (targetPos.y > 18) {
      const elevator = platforms.find(p => !p.cyclesAutomatically);
      if (elevator) {
        const surfaceY = elevator.getY();
        if (Math.abs(surfaceY - npcPos.y) < 3) {
          return { type: 'waypoint',
                   target: new THREE.Vector3(elevator.cx, surfaceY, elevator.cz),
                   stopDistance: 1.0 };
        }
        const distToPlat = this.horizDist(npcPos, { x: elevator.cx, z: elevator.cz });
        if (distToPlat > 2) {
          return { type: 'waypoint',
                   target: new THREE.Vector3(elevator.cx, npcPos.y, elevator.cz),
                   stopDistance: 1.0 };
        }
        return { type: 'wait' };
      }
    }

    // ── Archway path-following ──────────────────────────────────────────
    // Uses Y-aligned surface detection instead of elevation thresholds.
    // An entity is "on a path" when it's near a waypoint AND at the same
    // elevation (within step height). This prevents an NPC underneath an
    // arch tube from matching to waypoints on the surface above.
    const paths = collision.getNavigationPaths();
    if (paths.length === 0) return null;

    let npcOnPath = this.detectPathSurface(paths, npcPos);
    const targetOnPath = this.detectPathSurface(paths, targetPos);

    // If the NPC is barely on a low ramp WP and the target is on the ground,
    // the NPC is effectively at ground level — skip path navigation so it
    // walks directly toward the target instead of being routed up the arch.
    if (npcOnPath && !targetOnPath && npcPos.y < 1.0) {
      const wp = npcOnPath.path.waypoints[npcOnPath.wpIdx];
      if (wp.y < 2.0) npcOnPath = null;
    }

    // ── Both on the same archway — follow waypoints toward target ──
    if (npcOnPath && targetOnPath && npcOnPath.path === targetOnPath.path) {
      if (Math.abs(npcOnPath.wpIdx - targetOnPath.wpIdx) <= 1) return null;
      const dir = targetOnPath.wpIdx > npcOnPath.wpIdx ? 1 : -1;
      const wps = npcOnPath.path.waypoints;
      const nextIdx = this.advanceAlongChain(wps, npcPos, npcOnPath.wpIdx + dir, dir, targetOnPath.wpIdx);
      const wp = wps[nextIdx];
      return { type: 'waypoint', target: new THREE.Vector3(wp.x, wp.y, wp.z), stopDistance: 0.8 };
    }

    // ── NPC on a path, target elsewhere — exit toward target ──
    if (npcOnPath) {
      return this.navigateExitPath(npcOnPath, npcPos, targetPos);
    }

    // ── NPC on ground, target on a path — enter via approach waypoint ──
    if (targetOnPath) {
      return this.navigateEnterPath(targetOnPath, npcPos);
    }

    // ── Both on the ground — check if NPC still needs to clear a ramp ──
    if (npcPos.y > 0.5) {
      return this.findNearbyArchwayExit(paths, npcPos, targetPos);
    }
    return null;
  }

  /** Detect which archway path surface an entity is physically standing on.
   *  Matches by Y-alignment (within step height) + horizontal proximity, so
   *  an entity underneath a tube won't match to waypoints on the surface above. */
  private detectPathSurface(
    paths: readonly NavigationPath[],
    pos: THREE.Vector3,
  ): { path: NavigationPath; wpIdx: number } | null {
    const MAX_Y = NpcAiBrain.PATH_SURFACE_MAX_Y_GAP;
    const MAX_XZ = NpcAiBrain.PATH_SURFACE_MAX_XZ_DIST;

    let bestPath: NavigationPath | null = null;
    let bestIdx = -1;
    let bestScore = Infinity;

    for (const path of paths) {
      const wps = path.waypoints;
      for (let i = 0; i < wps.length; i++) {
        const wp = wps[i];
        const yGap = Math.abs(pos.y - wp.y);
        if (yGap > MAX_Y) continue;
        const dx = pos.x - wp.x;
        const dz = pos.z - wp.z;
        const xzDist = Math.sqrt(dx * dx + dz * dz);
        if (xzDist > MAX_XZ) continue;
        const score = xzDist + yGap * 2; // Weight Y alignment heavily
        if (score < bestScore) {
          bestScore = score;
          bestPath = path;
          bestIdx = i;
        }
      }
    }

    return bestPath && bestScore < 5 ? { path: bestPath, wpIdx: bestIdx } : null;
  }

  /** NPC is on a path surface, target is elsewhere — route toward the best exit. */
  private navigateExitPath(
    npcOnPath: { path: NavigationPath; wpIdx: number },
    npcPos: THREE.Vector3,
    targetPos: THREE.Vector3,
  ): { type: 'waypoint'; target: THREE.Vector3; stopDistance: number } | null {
    const wps = npcOnPath.path.waypoints;
    const npcWpIdx = npcOnPath.wpIdx;

    // Pick exit (chain end) that minimises total travel:
    // actual walk distance along chain to exit + horizontal distance from exit to target
    const startWp = wps[0];
    const endWp = wps[wps.length - 1];
    const startCost = this.chainDistance(wps, npcWpIdx, 0) +
      Math.sqrt((startWp.x - targetPos.x) ** 2 + (startWp.z - targetPos.z) ** 2);
    const endCost = this.chainDistance(wps, npcWpIdx, wps.length - 1) +
      Math.sqrt((endWp.x - targetPos.x) ** 2 + (endWp.z - targetPos.z) ** 2);
    const exitIdx = startCost < endCost ? 0 : wps.length - 1;

    // Close to exit approach WP — safe to disengage
    const exitWp = wps[exitIdx];
    const dx = npcPos.x - exitWp.x;
    const dy = npcPos.y - exitWp.y;
    const dz = npcPos.z - exitWp.z;
    if (dx * dx + dy * dy + dz * dz < 4) return null; // Within 2 units

    // Follow chain toward exit, skipping nearby waypoints
    if (Math.abs(npcWpIdx - exitIdx) <= 1) {
      // 0-1 steps from exit but > 2 units away — route directly to exit WP
      return { type: 'waypoint', target: new THREE.Vector3(exitWp.x, exitWp.y, exitWp.z), stopDistance: 0.8 };
    }
    const dir = exitIdx > npcWpIdx ? 1 : -1;
    const nextIdx = this.advanceAlongChain(wps, npcPos, npcWpIdx + dir, dir, exitIdx);
    const wp = wps[nextIdx];
    return { type: 'waypoint', target: new THREE.Vector3(wp.x, wp.y, wp.z), stopDistance: 0.8 };
  }

  /** NPC is on the ground, target is on a path — route to the best approach WP. */
  private navigateEnterPath(
    targetOnPath: { path: NavigationPath; wpIdx: number },
    npcPos: THREE.Vector3,
  ): { type: 'waypoint'; target: THREE.Vector3; stopDistance: number } {
    const wps = targetOnPath.path.waypoints;
    const targetWpIdx = targetOnPath.wpIdx;

    // Pick approach WP (chain end) that minimises total travel:
    // horizontal distance NPC → approach + actual walk distance along chain to target
    const startWp = wps[0];
    const endWp = wps[wps.length - 1];
    const startCost = this.horizDist(npcPos, startWp) + this.chainDistance(wps, 0, targetWpIdx);
    const endCost = this.horizDist(npcPos, endWp) + this.chainDistance(wps, wps.length - 1, targetWpIdx);
    const approachWp = startCost < endCost ? startWp : endWp;

    return { type: 'waypoint', target: new THREE.Vector3(approachWp.x, 0, approachWp.z), stopDistance: 2.0 };
  }

  private horizDist(a: THREE.Vector3, b: { x: number; z: number }): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /** Advance along a waypoint chain from startIdx toward destIdx, skipping
   *  waypoints that are too close to the NPC (< 2 units). At archway peaks
   *  the curve flattens and consecutive waypoints cluster tightly — without
   *  this the NPC "arrives" instantly and stalls. */
  private advanceAlongChain(
    wps: readonly { readonly x: number; readonly y: number; readonly z: number }[],
    npcPos: THREE.Vector3,
    startIdx: number,
    dir: number,
    destIdx: number,
  ): number {
    let idx = startIdx;
    while (idx !== destIdx) {
      const wp = wps[idx];
      const dx = npcPos.x - wp.x;
      const dy = npcPos.y - wp.y;
      const dz = npcPos.z - wp.z;
      if (dx * dx + dy * dy + dz * dz >= 4) break; // >= 2 units away
      const next = idx + dir;
      if (next < 0 || next >= wps.length) break;
      idx = next;
    }
    return idx;
  }

  /** Compute the actual walk distance along the waypoint chain between two indices. */
  private chainDistance(
    wps: readonly { readonly x: number; readonly y: number; readonly z: number }[],
    fromIdx: number,
    toIdx: number,
  ): number {
    let dist = 0;
    const step = toIdx > fromIdx ? 1 : -1;
    for (let i = fromIdx; i !== toIdx; i += step) {
      const a = wps[i];
      const b = wps[i + step];
      dist += Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
    }
    return dist;
  }

  /** When the NPC is slightly elevated (below the archway threshold but still
   *  on a ramp), find the nearest archway exit approach waypoint to guide it
   *  off the ramp before allowing direct movement toward the target. */
  private findNearbyArchwayExit(
    paths: readonly NavigationPath[],
    npcPos: THREE.Vector3,
    targetPos: THREE.Vector3,
  ): { type: 'waypoint'; target: THREE.Vector3; stopDistance: number } | null {
    for (const path of paths) {
      const wps = path.waypoints;
      for (let i = 0; i < wps.length; i++) {
        const wp = wps[i];
        if (wp.y < 0.5) continue; // Skip ground-level approach WPs
        const dx = npcPos.x - wp.x;
        const dy = npcPos.y - wp.y;
        const dz = npcPos.z - wp.z;
        if (dx * dx + dy * dy + dz * dz < 9) { // Within 3 units of an elevated WP
          // Route to the chain end that minimises total travel to the target
          const s = wps[0];
          const e = wps[wps.length - 1];
          const sDist = this.horizDist(npcPos, s);
          const eDist = this.horizDist(npcPos, e);
          const sToTarget = Math.sqrt((s.x - targetPos.x) ** 2 + (s.z - targetPos.z) ** 2);
          const eToTarget = Math.sqrt((e.x - targetPos.x) ** 2 + (e.z - targetPos.z) ** 2);
          const exitWp = (sDist + sToTarget) < (eDist + eToTarget) ? s : e;
          return { type: 'waypoint', target: new THREE.Vector3(exitWp.x, 0, exitWp.z), stopDistance: 1.0 };
        }
      }
    }
    return null;
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
