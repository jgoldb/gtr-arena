import type { Ability } from '@gtr/shared';
import type {
  S2C_AbilityEffect, S2C_CooldownUpdate,
  S2C_GasCloudSpawn, S2C_ChemPoolSpawn,
  ServerMessage,
} from '@gtr/shared';
import { GLOBAL_COOLDOWN, yardsToUnits, FartBombDebuff, ChemicalSpillSpeedBuff, ChemicalSpillDot, CrotchRotDot, ParanoidDebuff, Sweep, TweakerSprint, ChargeSystem, abilityCooldown } from '@gtr/shared';
import type { ServerEntity } from './ServerEntity.js';
import type { ServerCombatSystem } from './ServerCombatSystem.js';
import type { ServerBuffSystem } from './ServerBuffSystem.js';
import type { ServerRegenSystem } from './ServerRegenSystem.js';
import type { ServerCastingSystem } from './ServerCastingSystem.js';
import type { ServerAutoAttackSystem } from './ServerAutoAttackSystem.js';
import type { ServerLagCompensation } from './ServerLagCompensation.js';
import type { GasCloudSystem, DotSystem, ChemicalPoolSystem } from '@gtr/shared';

interface PendingAoeImpact {
  ability: Ability;
  groundX: number;
  groundY: number;
  groundZ: number;
  delay: number;
  elapsed: number;
  owner: ServerEntity;
}

// Ability queue entry — holds one pending ability per entity when request arrives
// slightly before GCD/cast expires. Processed on the tick where GCD/cast clears.
interface QueuedAbility {
  abilityId: string;
  targetEntityId: string | null;
  groundTarget?: { x: number; y: number; z: number };
  clientServerTimestamp?: number;
  age: number;
}

export class ServerAbilityHandler {
  private static readonly ABILITY_QUEUE_TOLERANCE = 0.1; // 100ms — accept abilities arriving up to 3 ticks before GCD expires
  private static readonly ABILITY_QUEUE_MAX_AGE = 0.5;   // expire stale queued abilities after 500ms
  private static readonly BOTTLE_CHUCK_IMPACT_DELAY = 0.825; // animation wind-up + flight time
  private static readonly MELEE_AUTO_ATTACK_ABILITIES = ['mop', 'big-boot', 'jimmy-legs', 'shank', 'gank'];

  private abilityQueue = new Map<string, QueuedAbility>();
  private pendingAoeImpacts: PendingAoeImpact[] = [];
  private dumpsterDiveAutoTargets = new Map<string, string>(); // entityId -> saved auto-attack target id
  nextEffectId = 1;

  private readonly rangeTolerance: number;

  constructor(rangeTolerance: number) {
    this.rangeTolerance = rangeTolerance;
  }

  /** Helpers injected by ServerEngine — avoids circular dependency */
  private deps!: {
    getEntity: (id: string) => ServerEntity | undefined;
    getEntities: () => readonly ServerEntity[];
    getTarget: (entityId: string) => ServerEntity | null;
    isFrozen: (entityId: string) => boolean;
    targets: Map<string, string | null>;
    combatSystem: ServerCombatSystem;
    buffSystem: ServerBuffSystem;
    regenSystem: ServerRegenSystem;
    castingSystem: ServerCastingSystem;
    autoAttackSystem: ServerAutoAttackSystem;
    chargeSystem: ChargeSystem<ServerEntity>;
    lagCompensation: ServerLagCompensation;
    gasCloudSystem: GasCloudSystem<ServerEntity>;
    dotSystem: DotSystem<ServerEntity>;
    chemPoolSystem: ChemicalPoolSystem<ServerEntity>;
    emitEvent: (event: ServerMessage) => void;
    onSendToPlayer?: (entityId: string, msg: ServerMessage) => void;
    onBroadcast?: (msg: ServerMessage) => void;
    requestAutoAttack: (entityId: string, targetEntityId: string) => void;
    stopAutoAttack: (entityId: string) => void;
  };

  wire(deps: ServerAbilityHandler['deps']): void {
    this.deps = deps;
  }

  removeEntity(entityId: string): void {
    this.dumpsterDiveAutoTargets.delete(entityId);
  }

  saveDumpsterDiveAutoTarget(entityId: string, targetId: string): void {
    this.dumpsterDiveAutoTargets.set(entityId, targetId);
  }

  getDumpsterDiveAutoTarget(entityId: string): string | undefined {
    return this.dumpsterDiveAutoTargets.get(entityId);
  }

  deleteDumpsterDiveAutoTarget(entityId: string): void {
    this.dumpsterDiveAutoTargets.delete(entityId);
  }

  requestAbility(entityId: string, abilityId: string, targetEntityId: string | null,
                 groundTarget?: { x: number; y: number; z: number }, clientServerTimestamp?: number): void {
    const entity = this.deps.getEntity(entityId);
    if (!entity || this.deps.isFrozen(entityId)) return;

    const ability = entity.abilities.find(a => a !== null && a.id === abilityId);
    if (!ability) return;

    // Block during GCD (CC-immune and off-GCD abilities bypass GCD)
    if (!entity.godMode && !ability.usableWhileCCd && !ability.offGcd && this.deps.combatSystem.getGcdRemaining(entityId) > 0) {
      // Queue the ability if GCD is about to expire (within tolerance) — fires on next tick
      if (this.deps.combatSystem.getGcdRemaining(entityId) <= ServerAbilityHandler.ABILITY_QUEUE_TOLERANCE) {
        this.abilityQueue.set(entityId, { abilityId, targetEntityId, groundTarget, clientServerTimestamp, age: 0 });
      }
      return;
    }

    // Block CC-immune abilities (e.g. PvP Trinket) during normal casts, but allow during channels
    if (ability.usableWhileCCd && this.deps.castingSystem.isCasting(entity) && !this.deps.castingSystem.isChanneling(entity)) {
      return;
    }
    // Cancel channel if starting new ability
    if (this.deps.castingSystem.isCasting(entity) && this.deps.combatSystem.getCooldownRemaining(entityId, abilityId) <= 0) {
      this.deps.castingSystem.cancel(entity);
    }

    // Ground-targeted AoE abilities — no rewind (by design: lead your targets)
    if (ability.groundTargeted && groundTarget) {
      const result = this.useGroundTargetAbility(entity, ability, groundTarget.x, groundTarget.z);
      if (result.success) {
        this.onAbilitySuccess(entity, ability, undefined, groundTarget);
        this.triggerEntityGcd(entity);
      } else if (result.errorMessage) {
        this.deps.onSendToPlayer?.(entityId, { type: 'error', message: result.errorMessage });
      }
      return;
    }

    // Auto self-cast for friendly abilities
    let target: ServerEntity | null = null;
    if (targetEntityId) {
      target = this.deps.getEntity(targetEntityId) ?? null;
    }
    if (ability.requiresFriendlyTarget && target && target.isHostileTo(entity)) {
      target = entity;
    }
    if (!target && ability.requiresTarget && !ability.requiresHostileTarget) {
      target = entity;
    }

    // Lag compensation: rewind target to where the client saw them
    let targetPosOverride: { x: number; z: number; rotationY: number } | undefined;
    if (target && clientServerTimestamp !== undefined) {
      targetPosOverride = this.deps.lagCompensation.getRewindPosition(target.id, clientServerTimestamp) ?? undefined;
    }

    if (ability.castTime) {
      this.serverStartCasting(entity, ability, target, targetPosOverride);
    } else {
      const result = this.deps.combatSystem.useAbility(ability, entity, target, targetPosOverride);
      if (result.success) {
        this.onAbilitySuccess(entity, ability, target);
        if (!ability.offGcd) this.triggerEntityGcd(entity);
      } else if (result.errorMessage) {
        this.deps.onSendToPlayer?.(entityId, { type: 'error', message: result.errorMessage });
      }
    }
  }

  cancelCastRequest(entityId: string, frozenEntities: Set<string>): void {
    if (frozenEntities.has(entityId)) return;
    const entity = this.deps.getEntity(entityId);
    if (entity) this.deps.castingSystem.cancel(entity);
  }

  /** Process queued abilities — called each tick after GCD/cast updates. */
  processAbilityQueue(dt: number): void {
    for (const [entityId, queued] of this.abilityQueue) {
      queued.age += dt;

      // Expire stale entries or clear if entity can no longer act
      const entity = this.deps.getEntity(entityId);
      if (queued.age > ServerAbilityHandler.ABILITY_QUEUE_MAX_AGE || !entity || entity.dead || entity.stunned) {
        this.abilityQueue.delete(entityId);
        continue;
      }

      // Re-attempt — requestAbility will succeed now if GCD/cast cleared this tick
      if (this.deps.combatSystem.getGcdRemaining(entityId) <= 0 && !this.deps.castingSystem.isCasting(entity)) {
        this.abilityQueue.delete(entityId);
        this.requestAbility(entityId, queued.abilityId, queued.targetEntityId, queued.groundTarget, queued.clientServerTimestamp);
      }
    }
  }

  /** Execute a ground-targeted AoE ability at a world position. Consumes resources immediately, delays damage until impact. */
  private useGroundTargetAbility(entity: ServerEntity, ability: Ability, groundX: number, groundZ: number): { success: boolean; errorMessage?: string } {
    if (entity.dead) return { success: false, errorMessage: 'You are dead' };
    if (this.deps.buffSystem.isStunned(entity) || this.deps.buffSystem.isSleeping(entity)) return { success: false, errorMessage: 'You are stunned' };
    if (!entity.godMode && this.deps.combatSystem.getCooldownRemaining(entity.id, ability.id) > 0) {
      return { success: false, errorMessage: 'Ability is not ready yet' };
    }

    // Validate range to ground target
    const dist = Math.sqrt((entity.x - groundX) ** 2 + (entity.z - groundZ) ** 2);
    if (ability.range && dist > ability.range + yardsToUnits(2)) {
      return { success: false, errorMessage: 'Out of range' };
    }

    if (!entity.godMode) {
      const effectiveCost = Math.round(ability.manaCost * this.deps.buffSystem.getManaCostMultiplier(entity));
      if (entity.mana < effectiveCost) return { success: false, errorMessage: 'Not enough mana' };
      entity.mana -= effectiveCost;
      if (effectiveCost > 0) this.deps.regenSystem.notifyManaUsed(entity);
    }

    if (!entity.godMode) {
      this.deps.combatSystem.setCooldown(entity.id, ability.id, abilityCooldown(ability));
    }

    // Schedule damage for when the projectile lands
    this.pendingAoeImpacts.push({
      ability,
      groundX,
      groundY: entity.y,
      groundZ,
      delay: ServerAbilityHandler.BOTTLE_CHUCK_IMPACT_DELAY,
      elapsed: 0,
      owner: entity,
    });

    return { success: true };
  }

  updatePendingAoeImpacts(dt: number): void {
    for (let i = this.pendingAoeImpacts.length - 1; i >= 0; i--) {
      const impact = this.pendingAoeImpacts[i];
      impact.elapsed += dt;
      if (impact.elapsed < impact.delay) continue;

      // Impact! Damage all hostiles in radius
      const radius = impact.ability.aoeRadius ?? 0;
      for (const target of this.deps.getEntities()) {
        if (target === impact.owner || target.dead || !target.isHostileTo(impact.owner) || this.deps.buffSystem.isUntargetable(target)) continue;
        const dx = target.x - impact.groundX;
        const dy = target.y - impact.groundY;
        const dz = target.z - impact.groundZ;
        if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
        this.deps.combatSystem.applyAoeDamage(impact.owner, target, impact.ability);
      }

      this.pendingAoeImpacts.splice(i, 1);
    }
  }

  /** Validate and start a cast/channel — server-side entry point with lag compensation. */
  private serverStartCasting(entity: ServerEntity, ability: Ability, target: ServerEntity | null,
                       targetPosOverride?: { x: number; z: number; rotationY: number }): void {
    if (this.deps.castingSystem.isCasting(entity)) {
      this.deps.onSendToPlayer?.(entity.id, { type: 'error', message: 'Already casting' });
      return;
    }
    if (entity.isMoving || !entity.grounded) {
      this.deps.onSendToPlayer?.(entity.id, { type: 'error', message: 'Cannot cast while moving' });
      return;
    }

    // Use rewound position for initial cast validation only — mid-cast checks use current positions
    const validation = this.deps.combatSystem.validateAbility(ability, entity, target, targetPosOverride);
    if (!validation.success) {
      if (validation.errorMessage) {
        this.deps.onSendToPlayer?.(entity.id, { type: 'error', message: validation.errorMessage });
      }
      return;
    }

    const result = this.deps.castingSystem.start(entity, ability, target);
    if (!result.started && result.errorMessage) {
      this.deps.onSendToPlayer?.(entity.id, { type: 'error', message: result.errorMessage });
    }
  }

  /** Called from ServerEngine when casting system completes a cast successfully. */
  onAbilitySuccessFromCasting(entity: ServerEntity, ability: Ability, target?: ServerEntity | null): void {
    this.onAbilitySuccess(entity, ability, target);
  }

  private onAbilitySuccess(entity: ServerEntity, ability: Ability, target?: ServerEntity | null, groundTarget?: { x: number; y: number; z: number }): void {
    const abilityEvent: S2C_AbilityEffect = {
      type: 'ability_effect',
      entityId: entity.id,
      abilityId: ability.id,
      ...(target ? { targetId: target.id } : {}),
      ...(groundTarget ? { groundTargetX: groundTarget.x, groundTargetY: groundTarget.y, groundTargetZ: groundTarget.z } : {}),
    };
    this.deps.emitEvent(abilityEvent);

    // Send cooldown update to the entity's player (skip in god mode)
    const cd = abilityCooldown(ability);
    if (cd > 0 && !entity.godMode) {
      this.deps.onSendToPlayer?.(entity.id, {
        type: 'cooldown_update',
        abilityId: ability.id,
        remaining: cd,
        total: cd,
      } as S2C_CooldownUpdate);
    }

    if (ability.id === 'fart-bomb') {
      const gcRadius = yardsToUnits(5);
      const gcId = `gc_${this.nextEffectId++}`;
      this.deps.gasCloudSystem.spawn(entity, entity.x, entity.y, entity.z, gcRadius, 8, FartBombDebuff, 592, 2, gcId);
      this.deps.onBroadcast?.({
        type: 'gas_cloud_spawn',
        id: gcId, x: entity.x, y: entity.y, z: entity.z, radius: gcRadius, duration: 8,
      } as S2C_GasCloudSpawn);
    }
    if (ability.id === 'sweep') {
      this.startSweepCharge(entity);
    }
    if (ability.id === 'chemical-spill') {
      const cpRadius = yardsToUnits(3);
      const cpId = `cp_${this.nextEffectId++}`;
      this.deps.chemPoolSystem.spawn(entity, entity.x, entity.y, entity.z, cpRadius, 30, ChemicalSpillSpeedBuff, ChemicalSpillDot, 297, 349, 600, 2, 6, 2, cpId);
      this.deps.onBroadcast?.({
        type: 'chem_pool_spawn',
        id: cpId, x: entity.x, y: entity.y, z: entity.z, radius: cpRadius, duration: 30, activationDelay: 2,
      } as S2C_ChemPoolSpawn);
    }
    if (ability.id === 'kaboom') {
      this.executeKaboom(entity);
    }
    if (ability.id === 'tweaker-sprint') {
      this.startTweakerSprintCharge(entity);
    }
    if (ability.id === 'shank' || ability.id === 'pocket-sand' || ability.id === 'sticky-fingers' || ability.id === 'tweaker-sprint' || ability.id === 'gank') {
      this.deps.buffSystem.addStacks(entity, 'tweaking', 15);
      if (this.deps.buffSystem.getStacks(entity, 'tweaking') >= 100 && !this.deps.buffSystem.hasDebuff(entity, 'paranoid')) {
        this.deps.buffSystem.apply(entity, ParanoidDebuff);
      }
    }
    if (ability.id === 'gank') {
      const target = this.deps.getTarget(entity.id);
      if (target && (target.dead || target.hp / target.maxHp < 0.30)) {
        this.deps.combatSystem.clearCooldown(entity.id, 'gank');
        this.deps.onSendToPlayer?.(entity.id, {
          type: 'cooldown_update',
          abilityId: 'gank',
          remaining: 0,
          total: 0,
        } as S2C_CooldownUpdate);
      }
    }
    if (ability.id === 'crack-rock') {
      this.deps.combatSystem.applyHeal(entity, entity, 400);
      this.deps.buffSystem.addStacks(entity, 'tweaking', 25);
      if (this.deps.buffSystem.getStacks(entity, 'tweaking') >= 100 && !this.deps.buffSystem.hasDebuff(entity, 'paranoid')) {
        this.deps.buffSystem.apply(entity, ParanoidDebuff);
      }
    }
    if (ability.id === 'sticky-fingers') {
      const target = this.deps.getTarget(entity.id);
      if (target) {
        const stealable = this.deps.buffSystem.getBuffs(target).filter(b => !b.definition.unremovable);
        if (stealable.length > 0) {
          const stolen = stealable[Math.floor(Math.random() * stealable.length)];
          const remainingTime = stolen.remaining;
          this.deps.buffSystem.remove(target, stolen.definition.id, true);
          this.deps.buffSystem.apply(entity, stolen.definition);
          this.deps.buffSystem.setRemaining(entity, stolen.definition.id, remainingTime);
        } else {
          const drain = Math.min(150, target.mana);
          target.mana -= drain;
          entity.mana = Math.min(entity.mana + 150, entity.maxMana);
          abilityEvent.manaStolen = 150;
        }
      }
    }
    if (ability.id === 'dumpster-dive') {
      this.deps.buffSystem.addStacks(entity, 'tweaking', 15);
      if (this.deps.buffSystem.getStacks(entity, 'tweaking') >= 100 && !this.deps.buffSystem.hasDebuff(entity, 'paranoid')) {
        this.deps.buffSystem.apply(entity, ParanoidDebuff);
      }
      // Save auto-attack target for re-engage on emerge
      const aaTarget = this.deps.autoAttackSystem.getTarget(entity);
      if (aaTarget) this.dumpsterDiveAutoTargets.set(entity.id, aaTarget.id);
      // Stop auto-attack while in the dumpster
      this.deps.stopAutoAttack(entity.id);
      // Force all enemies targeting this entity to lose their target
      for (const [eid, targetId] of this.deps.targets) {
        if (targetId === entity.id) {
          const other = this.deps.getEntity(eid);
          if (other && other.isHostileTo(entity)) {
            this.deps.targets.set(eid, null);
            this.deps.stopAutoAttack(eid);
            this.deps.onSendToPlayer?.(eid, { type: 'force_clear_target' });
          }
        }
      }
    }
    if (ability.id === 'pvp-trinket') {
      this.deps.buffSystem.removeAllCCEffects(entity, true);
    }
    if (ability.id === 'crotch-rot') {
      const target = this.deps.getTarget(entity.id);
      if (target && !target.dead) {
        this.deps.dotSystem.add({
          target, debuff: CrotchRotDot,
          totalDuration: 12, elapsed: 0,
          tickInterval: 3, nextTickAt: 3,
          damagePerTick: 180, owner: entity,
        });
      }
    }

    // Melee abilities automatically engage auto-attack on the target
    if (ServerAbilityHandler.MELEE_AUTO_ATTACK_ABILITIES.includes(ability.id)) {
      const target = this.deps.getTarget(entity.id);
      if (target && target.isHostileTo(entity) && !target.dead) {
        this.deps.requestAutoAttack(entity.id, target.id);
      }
    }
  }

  triggerEntityGcd(entity: ServerEntity): void {
    if (entity.godMode) return;
    this.deps.combatSystem.triggerGcd(entity.id, GLOBAL_COOLDOWN);
    this.deps.onSendToPlayer?.(entity.id, {
      type: 'cooldown_update',
      abilityId: '__gcd__',
      remaining: GLOBAL_COOLDOWN,
      total: GLOBAL_COOLDOWN,
    } as S2C_CooldownUpdate);
  }

  resetEntityGcd(entity: ServerEntity): void {
    if (entity.godMode) return;
    this.deps.combatSystem.triggerGcd(entity.id, 0);
    this.deps.onSendToPlayer?.(entity.id, {
      type: 'cooldown_update',
      abilityId: '__gcd__',
      remaining: 0,
      total: 0,
    } as S2C_CooldownUpdate);
  }

  private startSweepCharge(entity: ServerEntity): void {
    const savedAutoAttackTarget = this.deps.autoAttackSystem.getTarget(entity);
    this.deps.stopAutoAttack(entity.id);
    entity.charging = true;
    this.deps.chargeSystem.startSweepCharge(
      entity,
      Math.sin(entity.rotationY),
      Math.cos(entity.rotationY),
      Sweep.chargeSpeed!,
      Sweep.chargeDuration!,
      Sweep.chargeMaxDamage!,
      savedAutoAttackTarget,
    );
  }

  private startTweakerSprintCharge(entity: ServerEntity): void {
    const target = this.deps.getTarget(entity.id);
    if (!target) return;

    const dx = target.x - entity.x;
    const dz = target.z - entity.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01) return;

    const dirX = dx / dist;
    const dirZ = dz / dist;
    entity.rotationY = Math.atan2(dirX, dirZ);

    const speed = TweakerSprint.chargeSpeed!;
    const chargeDist = Math.max(0, dist - yardsToUnits(1));
    const duration = chargeDist / speed;

    const savedAutoAttackTarget = this.deps.autoAttackSystem.getTarget(entity);
    this.deps.stopAutoAttack(entity.id);
    entity.charging = true;
    this.deps.chargeSystem.startTweakerSprintCharge(
      entity, dirX, dirZ, speed, duration,
      TweakerSprint.chargeMaxDamage!, savedAutoAttackTarget,
    );
  }

  private executeKaboom(entity: ServerEntity): void {
    this.deps.chargeSystem.executeKaboom(entity, entity.rotationY);
  }
}
