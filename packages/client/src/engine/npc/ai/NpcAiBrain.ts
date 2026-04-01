import * as THREE from 'three';
import type { NpcController } from '../NpcController';
import type { Targetable } from '../../types';
import type { BuffSystem } from '../../combat/BuffSystem';
import type { CombatSystem } from '../../combat/CombatSystem';
import type { CollisionSystem } from '../../physics/CollisionSystem';
import type { Ability } from '@gtr/shared';
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

  private thinkTimer = 0;
  private currentTarget: EntityInfo | null = null;
  currentTargetEntity: Targetable | null = null;
  private casting: NpcCastingState | null = null;

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

    if (this.npc.stunned) {
      this.movement.intent = { type: 'idle' };
      this.movement.update(dt);
      // Stun cancels casting/channeling
      if (this.casting) this.cancelCasting();
      // Check if we should trinket out of CC
      this.checkCCBreak();
      return;
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
    }
    // Regular casts: mana/cooldown handled on completion via npcUseAbility

    this.cooldowns.triggerGcd();

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

    // Set casting state on NPC for nameplate display
    this.npc.castingAbilityName = ability.name;
    this.npc.castingElapsed = 0;
    this.npc.castingTotalTime = ability.castTime;
    this.npc.castingIsChannel = isChannel;

    // Trigger animation
    this.npc.model.triggerAbilityAnimation(ability.id, target?.mesh.position.clone());

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

    // Clear nameplate
    this.npc.castingAbilityName = null;
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
    this.npc.castingElapsed = 0;
    this.npc.castingTotalTime = 0;
    this.npc.castingIsChannel = false;
  }

  get isCasting(): boolean {
    return this.casting !== null;
  }

  private think(): void {
    const world = this.buildWorldState();

    // Update hazards for movement controller
    this.movement.hazards = world.hazards;

    // No enemies alive — idle
    if (world.enemies.length === 0) {
      this.currentTarget = null;
      this.currentTargetEntity = null;
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

      if (actions.length > 0) {
        // Apply difficulty fuzzing
        this.fuzzScores(actions);

        // Sort by score descending
        actions.sort((a, b) => b.score - a.score);

        // Try to execute the best action
        const best = actions[0];
        if (best && best.score > 0 && best.abilityId) {
          const target = best.target?.entity ?? null;
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

  private checkCCBreak(): void {
    const isCC = this.engine.buffSystem.isStunned(this.npc)
      || this.engine.buffSystem.isSleeping(this.npc)
      || this.engine.buffSystem.isBlinded(this.npc);
    if (!isCC) return;
    if (!this.cooldowns.isReady('pvp-trinket')) return;

    // Use trinket based on difficulty reaction chance
    if (Math.random() > this.difficulty.interruptChance) return;

    this.engine.npcUseAbility(this.npc, 'pvp-trinket', null);
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
