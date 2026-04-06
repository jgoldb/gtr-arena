import type { Ability, BuffDefinition } from '@gtr/shared';
import type { EntitySnapshot, EntityBuffSnapshot, GasCloudSnapshot, ChemicalPoolSnapshot, CooldownSnapshot } from '@gtr/shared';
import type {
  S2C_CombatEvent, S2C_Flinch, S2C_CooldownUpdate,
  S2C_Knockback,
  ServerMessage,
} from '@gtr/shared';
import { yardsToUnits, isRangedAutoAttack, RottenCrotchStun, KaboomStun, ArenaPreparationBuff, RestingBuff, ParanoidDebuff, ODStunDebuff, TweakerSprintSlow, getCharacterStats, GasCloudSystem, DotSystem, ChemicalPoolSystem, FullRetardAuraSystem, ChargeSystem } from '@gtr/shared';
import { ServerEntity } from './ServerEntity.js';
import { ServerCombatSystem } from './ServerCombatSystem.js';
import { ServerBuffSystem } from './ServerBuffSystem.js';
import { ServerRegenSystem } from './ServerRegenSystem.js';
import { ServerCastingSystem } from './ServerCastingSystem.js';
import { ServerAutoAttackSystem } from './ServerAutoAttackSystem.js';
import { CollisionSystem } from './ServerMapManager.js';
import { ServerElevator } from './ServerElevator.js';
import { ServerBroadcast } from './ServerBroadcast.js';
import { ServerLagCompensation } from './ServerLagCompensation.js';
import { ServerAbilityHandler } from './ServerAbilityHandler.js';

export class ServerEngine {
  private entities: ServerEntity[] = [];
  private collision: CollisionSystem;
  private combatSystem: ServerCombatSystem;
  private buffSystem: ServerBuffSystem;
  private regenSystem: ServerRegenSystem;

  // Per-entity state
  private frozenEntities = new Set<string>();
  private targets = new Map<string, string | null>(); // entityId -> targetEntityId
  private castingSystem!: ServerCastingSystem;
  private autoAttackSystem!: ServerAutoAttackSystem;
  private chargeSystem!: ChargeSystem<ServerEntity>;
  private fullRetardAuraSystem!: FullRetardAuraSystem<ServerEntity>;

  // World state
  private gasCloudSystem!: GasCloudSystem<ServerEntity>;
  private dotSystem!: DotSystem<ServerEntity>;
  private chemPoolSystem!: ChemicalPoolSystem<ServerEntity>;

  // Extracted subsystems
  private broadcast = new ServerBroadcast();
  private lagCompensation: ServerLagCompensation;
  private abilityHandler: ServerAbilityHandler;

  // Event queue (flushed each tick in the delta update for clients without immediate delivery)
  private pendingEvents: ServerMessage[] = [];

  // ── Immediate event types ─────��──────────────────────────────────────
  // Combat events that are time-sensitive get broadcast immediately when they
  // happen, rather than waiting up to 33ms for the next tick bundle. This
  // removes a full half-tick of average latency from combat feedback.
  // These events are ALSO included in the tick-bundled update for reliability
  // (the client deduplicates or simply processes them idempotently).
  private static readonly IMMEDIATE_EVENT_TYPES: ReadonlySet<string> = new Set([
    'ability_effect',
    'combat_event',
    'auto_attack_swing',
    'knockback',
    'entity_died',
    'flinch',
  ]);

  // Tick
  private tick = 0;
  private tickTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private midTickTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private nextTickTarget = 0;
  private lastTickTime = 0;
  private static readonly TICK_RATE = 30;
  private static readonly TICK_MS = 1000 / ServerEngine.TICK_RATE;
  // Mid-tick position broadcasts at 60Hz — halves dead reckoning distance
  // by sending position-only updates between full 30Hz ticks.
  private static readonly MID_TICK_MS = ServerEngine.TICK_MS / 2;
  private static readonly KEYFRAME_INTERVAL = 150; // full snapshot every 5 seconds
  // Range tolerance for residual latency (sub-tick timing, interpolation granularity).
  // Reduced from 2 yards now that server-side position rewind handles the bulk of lag compensation.
  private static readonly RANGE_TOLERANCE = yardsToUnits(1);

  onBroadcast?: (msg: ServerMessage) => void;
  /** Broadcast via unreliable DataChannel (positions). Falls back to reliable if not wired. */
  onBroadcastUnreliable?: (msg: ServerMessage) => void;
  onSendToPlayer?: (entityId: string, msg: ServerMessage) => void;
  /** Relay a position update to all clients EXCEPT the sender — called immediately on receipt for low-latency dead reckoning. */
  onPositionRelay?: (senderEntityId: string, msg: ServerMessage) => void;
  /** Relay via unreliable DataChannel. Falls back to onPositionRelay if not wired. */
  onPositionRelayUnreliable?: (senderEntityId: string, msg: ServerMessage) => void;
  onGameOver?: (winningTeam: number) => void;
  /** Fired whenever damage is dealt (sourceEntityId, targetEntityId, amount). */
  onStatDamage?: (sourceEntityId: string, targetEntityId: string, amount: number) => void;
  /** Fired whenever healing is done (sourceEntityId, targetEntityId, amount). */
  onStatHeal?: (sourceEntityId: string, targetEntityId: string, amount: number) => void;
  /** Fired when an entity is killed (killerEntityId, victimEntityId). */
  onStatKill?: (killerEntityId: string, victimEntityId: string) => void;
  private gameOverFired = false;

  // ── Map-specific state ─────────────────────────────────────────────
  private readonly mapId: string;
  private startTime = 0; // Date.now() when start() was called (matches ArenaScript elapsed=0)

  // Celestial Ballroom elevator (null on other maps)
  private elevator: ServerElevator | null = null;

  constructor(obstacles: import('@gtr/shared').ObstacleConfig[], mapId: string = '') {
    this.mapId = mapId;
    this.collision = new CollisionSystem();
    this.collision.buildFromObstacles(obstacles);

    // Create elevator for Celestial Ballroom
    if (mapId === 'celestial-ballroom') {
      this.elevator = new ServerElevator(this.collision);
    }

    this.lagCompensation = new ServerLagCompensation(ServerEngine.TICK_MS);
    this.abilityHandler = new ServerAbilityHandler(ServerEngine.RANGE_TOLERANCE);

    this.buffSystem = new ServerBuffSystem();
    this.regenSystem = new ServerRegenSystem(() => this.entities);
    this.regenSystem.setBuffSystem(this.buffSystem);
    this.combatSystem = new ServerCombatSystem(this.regenSystem, this.buffSystem, this.collision);

    this.castingSystem = new ServerCastingSystem({
      isGodMode: (entity) => entity.godMode,
      shouldCancel: (entity) => entity.dead || entity.stunned || entity.isMoving || !entity.grounded,
      getPosition: (entity) => ({ x: entity.x, z: entity.z }),
      getManaCostMultiplier: (entity) => this.buffSystem.getManaCostMultiplier(entity),
      getDamageDealtMultiplier: (entity) => this.buffSystem.getDamageDealtMultiplier(entity),
      applyBuff: (target, def) => this.buffSystem.apply(target, def),
      removeBuff: (target, id, silent) => this.buffSystem.remove(target, id, silent),
      setBuffRemaining: (target, id, remaining) => this.buffSystem.setRemaining(target, id, remaining),
      consumeMana: (entity, amount) => { entity.mana -= amount; },
      notifyManaUsed: (entity) => this.regenSystem.notifyManaUsed(entity),
      triggerGcd: (entity) => this.abilityHandler.triggerEntityGcd(entity),
      setCooldown: (entity, abilityId, duration) => {
        if (!entity.godMode) {
          this.combatSystem.setCooldown(entity.id, abilityId, duration);
          if (duration > 0) {
            this.onSendToPlayer?.(entity.id, {
              type: 'cooldown_update', abilityId, remaining: duration, total: duration,
            } as S2C_CooldownUpdate);
          }
        }
      },
      clearCooldown: (entity, abilityId) => this.combatSystem.clearCooldown(entity.id, abilityId),
      rollMiss: () => this.combatSystem.rollMiss(),
      enterCombat: (entity) => this.combatSystem.enterCombat(entity),
      applyHeal: (healer, target, amount) => this.combatSystem.applyHeal(healer, target, amount),
      applyChannelTickDamage: (attacker, target, damage, multiplier) =>
        this.combatSystem.applyChannelTickDamage(attacker, target, damage, multiplier),
      useAbility: (entity, ability, target) => {
        const result = this.combatSystem.useAbility(ability, entity, target);
        if (result.success) {
          this.abilityHandler.onAbilitySuccessFromCasting(entity, ability, target);
        } else if (result.errorMessage) {
          this.onSendToPlayer?.(entity.id, { type: 'error', message: result.errorMessage });
        }
        return result;
      },
      onHostileAction: (attacker, target) => {
        // Hostile channel start — notify for auto-targeting
        this.emitEvent({
          type: 'combat_event',
          sourceEntityId: attacker.id,
          targetEntityId: target.id,
          amount: 0,
          combatType: 'damage',
        } as S2C_CombatEvent);
      },
      onChannelMiss: (attacker, target) => {
        this.emitEvent({
          type: 'combat_event',
          sourceEntityId: attacker.id,
          targetEntityId: target.id,
          amount: 0,
          combatType: 'miss',
        } as S2C_CombatEvent);
      },
    });
    this.castingSystem.rangeTolerance = ServerEngine.RANGE_TOLERANCE;

    this.autoAttackSystem = new ServerAutoAttackSystem({
      getPosition: (e) => ({ x: e.x, y: e.y, z: e.z }),
      getRotationY: (e) => e.rotationY,
      isMoving: (e) => e.isMoving,
      isCasting: (e) => this.castingSystem.isCasting(e),
      isUntargetable: (e) => this.buffSystem.isUntargetable(e),
      isRanged: (e) => isRangedAutoAttack(getCharacterStats(e.characterId)),
      getAutoAttackSpeed: (e) => e.autoAttackSpeed,
      getAttackSpeedMultiplier: (e) => this.buffSystem.getAutoAttackSpeedMultiplier(e) * (e.godMode ? 6 : 1),
      rollDamage: (e) => e.rollAutoAttackDamage(),
      hasLineOfSight: (a, t) => this.combatSystem.hasLineOfSight(a.x, a.z, t.x, t.z, a.y, t.y),
      applyMeleeDamage: (a, t, dmg) => this.combatSystem.applyAutoAttackDamage(a, t, dmg),
      applyProjectileDamage: (a, t, dmg) => this.combatSystem.applyAutoAttackDamage(a, t, dmg, false),
      onSwing: (attacker, target, _isRanged, isCrit) => {
        this.emitEvent({
          type: 'auto_attack_swing',
          entityId: attacker.id,
          targetEntityId: target.id,
          ...(isCrit && { isCrit: true }),
        });
      },
      onAutoAttackError: (entity, msg) => {
        this.onSendToPlayer?.(entity.id, { type: 'error', message: msg });
      },
      onStopped: (entity) => {
        entity.isAutoAttacking = false;
      },
    });
    this.autoAttackSystem.rangeTolerance = ServerEngine.RANGE_TOLERANCE;

    this.gasCloudSystem = new GasCloudSystem<ServerEntity>(this.buffSystem, {
      getPosition: (e) => ({ x: e.x, y: e.y, z: e.z }),
      getHostileEntities: (owner) => this.entities.filter(e => !e.dead && e.isHostileTo(owner)),
      isGodModeImmune: (e) => e.godMode,
      processDamageAbsorb: (target, amount, source) => this.combatSystem.processDamageAbsorb(target, amount, source),
      enterCombat: (e) => this.combatSystem.enterCombat(e),
      onDamageDealt: (source, target, amount) => {
        this.emitEvent({
          type: 'combat_event', sourceEntityId: source.id, targetEntityId: target.id, amount, combatType: 'damage',
        } as S2C_CombatEvent);
        this.onStatDamage?.(source.id, target.id, amount);
      },
      onEntityDied: (target, killer) => {
        this.recordKill(killer.id, target.id);
      },
    }, true /* silentBuffRemoval */);

    const sharedDamageCallbacks = {
      isGodModeImmune: (e: ServerEntity) => e.godMode,
      processDamageAbsorb: (target: ServerEntity, amount: number, source: ServerEntity) => this.combatSystem.processDamageAbsorb(target, amount, source),
      enterCombat: (e: ServerEntity) => this.combatSystem.enterCombat(e),
      onDamageDealt: (source: ServerEntity, target: ServerEntity, amount: number) => {
        this.emitEvent({
          type: 'combat_event', sourceEntityId: source.id, targetEntityId: target.id, amount, combatType: 'damage',
        } as S2C_CombatEvent);
        this.onStatDamage?.(source.id, target.id, amount);
      },
      onEntityDied: (target: ServerEntity, killer: ServerEntity) => {
        this.recordKill(killer.id, target.id);
      },
    };

    this.dotSystem = new DotSystem<ServerEntity>(sharedDamageCallbacks);

    this.chemPoolSystem = new ChemicalPoolSystem<ServerEntity>(this.buffSystem, this.dotSystem, {
      getPosition: (e) => ({ x: e.x, y: e.y, z: e.z }),
      getAllEntities: () => [...this.entities],
      ...sharedDamageCallbacks,
    }, true /* silentBuffRemoval */);

    this.fullRetardAuraSystem = new FullRetardAuraSystem<ServerEntity>(this.buffSystem, {
      getPosition: (e) => ({ x: e.x, y: e.y, z: e.z }),
      getAllEntities: () => [...this.entities],
      ...sharedDamageCallbacks,
      applyHeal: (source, target, amount) => this.combatSystem.applyHeal(source, target, amount),
    });

    this.chargeSystem = new ChargeSystem<ServerEntity>({
      getPosition: (e) => ({ x: e.x, z: e.z }),
      moveEntity: (e, dx, dz) => {
        // Sub-step movement to prevent tunneling through thin walls at high speed
        const totalDist = Math.sqrt(dx * dx + dz * dz);
        const maxStep = 0.25;
        const numSteps = Math.max(1, Math.ceil(totalDist / maxStep));
        const stepDx = dx / numSteps;
        const stepDz = dz / numSteps;
        for (let i = 0; i < numSteps; i++) {
          e.x += stepDx;
          e.z += stepDz;
          const resolved = this.collision.resolve(e.x, e.z, e.y, 0.4);
          e.x = resolved.x;
          e.z = resolved.z;
        }
      },
      getHostileEntities: (e) => this.entities.filter(o => o !== e && o.isHostileTo(e)),
      isUntargetable: (e) => this.buffSystem.isUntargetable(e),
      isDead: (e) => e.dead,
      getAutoAttackRange: (e) => e.autoAttackRange,
      applySweepDamage: (source, target, damage) => this.combatSystem.applySweepDamage(source, target, damage),
      applyTweakerSprintSlow: (target) => this.buffSystem.apply(target, TweakerSprintSlow),
      enterCombat: (e) => this.combatSystem.enterCombat(e),
      applyKnockbackStun: (target) => this.buffSystem.apply(target, KaboomStun),
      onSweepChargeEnd: (entity, savedTarget, _hitCount) => {
        this.emitEvent({
          type: 'ability_effect',
          entityId: entity.id,
          abilityId: 'sweep-finish',
        });
        if (savedTarget && !savedTarget.dead && savedTarget.isHostileTo(entity)) {
          this.requestAutoAttack(entity.id, savedTarget.id);
        }
        entity.charging = false;
        entity.lastPositionUpdateTime = 0;
      },
      onTweakerSprintChargeEnd: (entity, savedTarget) => {
        if (savedTarget && !savedTarget.dead && savedTarget.isHostileTo(entity)) {
          this.requestAutoAttack(entity.id, savedTarget.id);
        }
        entity.charging = false;
        entity.lastPositionUpdateTime = 0;
      },
      onKnockbackCreated: (target, kb) => {
        this.castingSystem.cancel(target);
        this.emitEvent({
          type: 'knockback',
          entityId: target.id,
          dirX: kb.dirX,
          dirZ: kb.dirZ,
          distance: kb.distance,
          duration: kb.duration,
        } as S2C_Knockback);
      },
      onKnockbackEnd: (target) => {
        target.lastPositionUpdateTime = 0;
      },
      moveKnockbackTarget: (target, dirX, dirZ, speed, dt) => {
        target.x += dirX * speed * dt;
        target.z += dirZ * speed * dt;
        const resolved = this.collision.resolve(target.x, target.z, target.y, 0.4);
        target.x = resolved.x;
        target.z = resolved.z;
      },
    });

    this.combatSystem.onCombatText = (source, target, amount, type, ability, isAutoAttack) => {
      this.emitEvent({
        type: 'combat_event',
        sourceEntityId: source.id,
        targetEntityId: target.id,
        amount,
        combatType: type,
        ...(ability?.suppressAutoTarget ? { suppressAutoTarget: true } : {}),
        ...(isAutoAttack ? { isAutoAttack: true } : {}),
        ...(ability ? { abilityId: ability.id } : {}),
      } as S2C_CombatEvent);
      // Track match stats
      if (amount > 0) {
        if (type === 'heal') {
          this.onStatHeal?.(source.id, target.id, amount);
        } else if (type === 'damage' || type === 'crit') {
          this.onStatDamage?.(source.id, target.id, amount);
        }
      }
    };

    this.combatSystem.onFlinchDamage = (target) => {
      this.emitEvent({ type: 'flinch', entityId: target.id } as S2C_Flinch);
    };

    this.buffSystem.onBuffExpired = (target, definition) => {
      if (definition.id === 'paranoid') {
        this.buffSystem.removeStacks(target, 'tweaking', 100);
      }
      if (definition.id === 'crotch-rot') {
        this.buffSystem.apply(target, RottenCrotchStun);
      }
      if (definition.id === 'overdosing') {
        this.buffSystem.apply(target, ODStunDebuff);
      }
      if (definition.id === 'od-stun') {
        // Set Tweaking to 100 stacks
        this.buffSystem.removeStacks(target, 'tweaking', 100);
        this.buffSystem.addStacks(target, 'tweaking', 100);
        if (!this.buffSystem.hasDebuff(target, 'paranoid')) {
          this.buffSystem.apply(target, ParanoidDebuff);
        }
      }
      if (definition.id === 'dumpster-diving') {
        // AoE damage on emerge: 150 damage to nearby enemies within 5 yards
        const radius = yardsToUnits(5);
        for (const entity of this.entities) {
          if (entity === target || entity.dead || !entity.isHostileTo(target)) continue;
          if (this.buffSystem.isUntargetable(entity)) continue;
          const dx = target.x - entity.x;
          const dz = target.z - entity.z;
          if (dx * dx + dz * dz <= radius * radius) {
            let dmg = 150;
            const damageMult = this.buffSystem.getDamageDealtMultiplier(target);
            dmg = Math.round(dmg * damageMult);
            const actualDmg = entity.godMode ? 0 : this.combatSystem.processDamageAbsorb(entity, dmg, target);
            entity.hp = Math.max(0, entity.hp - actualDmg);
            if (actualDmg > 0) {
              this.combatSystem.onCombatText?.(target, entity, actualDmg, 'damage');
              this.combatSystem.onFlinchDamage?.(entity);
            }
            this.combatSystem.enterCombat(target);
            this.combatSystem.enterCombat(entity);
            if (entity.hp <= 0 && !entity.dead) {
              entity.die();
              this.combatSystem.onEntityKilled?.(target, entity);
            }
          }
        }
        // Re-engage auto-attack if the player was auto-attacking before diving
        const savedTargetId = this.abilityHandler.getDumpsterDiveAutoTarget(target.id);
        if (savedTargetId) {
          this.abilityHandler.deleteDumpsterDiveAutoTarget(target.id);
          const currentTargetId = this.targets.get(target.id);
          if (currentTargetId === savedTargetId) {
            this.requestAutoAttack(target.id, savedTargetId);
          }
        }
      }
    };

    this.combatSystem.onDirectDamageDealt = (target) => {
      if (this.buffSystem.isSleeping(target)) {
        this.buffSystem.removeSleepEffects(target);
      }
      this.cancelResting(target.id);
      this.castingSystem.applyPushback(target);
    };

    this.combatSystem.onEntityKilled = (killer, victim) => {
      this.recordKill(killer.id, victim.id);
    };

    this.combatSystem.onSleepApplied = (attacker, target) => {
      if (this.autoAttackSystem.getTarget(attacker) === target) {
        this.stopAutoAttack(attacker.id);
      }
    };

    this.combatSystem.onBlindApplied = (_attacker, target) => {
      // Blinded entity loses target and stops auto-attacking
      this.targets.set(target.id, null);
      this.stopAutoAttack(target.id);
    };

    // Wire ability handler dependencies
    this.abilityHandler.wire({
      getEntity: (id) => this.getEntity(id),
      getEntities: () => this.entities,
      getTarget: (entityId) => this.getTarget(entityId),
      isFrozen: (entityId) => this.frozenEntities.has(entityId),
      targets: this.targets,
      combatSystem: this.combatSystem,
      buffSystem: this.buffSystem,
      regenSystem: this.regenSystem,
      castingSystem: this.castingSystem,
      autoAttackSystem: this.autoAttackSystem,
      chargeSystem: this.chargeSystem,
      lagCompensation: this.lagCompensation,
      gasCloudSystem: this.gasCloudSystem,
      dotSystem: this.dotSystem,
      chemPoolSystem: this.chemPoolSystem,
      emitEvent: (event) => this.emitEvent(event),
      onSendToPlayer: undefined, // will be set via property forwarding
      onBroadcast: undefined,
      requestAutoAttack: (entityId, targetEntityId) => this.requestAutoAttack(entityId, targetEntityId),
      stopAutoAttack: (entityId) => this.stopAutoAttack(entityId),
    });
  }

  toggleGodMode(entityId: string): boolean {
    const entity = this.getEntity(entityId);
    if (!entity) return false;
    entity.godMode = !entity.godMode;
    if (entity.godMode) {
      entity.hp = entity.maxHp;
      entity.mana = entity.maxMana;
      entity.dead = false;
    }
    return entity.godMode;
  }

  addEntity(entity: ServerEntity): void {
    this.entities.push(entity);
  }

  /** Record a kill: fire stats callback + broadcast entity_died event. */
  private recordKill(killerEntityId: string, victimEntityId: string): void {
    this.onStatKill?.(killerEntityId, victimEntityId);
    this.emitEvent({
      type: 'entity_died',
      entityId: victimEntityId,
      killerEntityId,
    } as import('@gtr/shared').S2C_EntityDied);
  }

  private applyFallDamage(entity: ServerEntity, fallDistance: number): void {
    if (entity.dead || entity.godMode) return;
    const SAFE_FALL = 8;   // ~13 yards — no damage below this
    const FATAL_FALL = 40; // ~67 yards — 100% HP damage
    if (fallDistance <= SAFE_FALL) return;
    const pct = Math.min(1, (fallDistance - SAFE_FALL) / (FATAL_FALL - SAFE_FALL));
    const damage = Math.round(entity.maxHp * pct);
    if (damage <= 0) return;
    entity.hp = Math.max(0, entity.hp - damage);
    this.emitEvent({
      type: 'combat_event',
      sourceEntityId: entity.id,
      targetEntityId: entity.id,
      amount: damage,
      combatType: 'damage',
    } as S2C_CombatEvent);
    if (entity.hp <= 0 && !entity.dead) {
      entity.die();
      this.recordKill(entity.id, entity.id);
    }
  }

  getEntity(entityId: string): ServerEntity | undefined {
    return this.entities.find(e => e.id === entityId);
  }

  getEntityByUserId(userId: string): ServerEntity | undefined {
    return this.entities.find(e => e.userId === userId);
  }

  getAllEntities(): readonly ServerEntity[] {
    return this.entities;
  }

  applyArenaPreparation(): void {
    for (const entity of this.entities) {
      this.buffSystem.apply(entity, ArenaPreparationBuff);
      this.applyStartingBuffs(entity);
    }
  }

  private applyStartingBuffs(entity: ServerEntity): void {
    const stats = getCharacterStats(entity.characterId);
    if (stats.startingBuffs) {
      for (const buff of stats.startingBuffs) {
        this.buffSystem.apply(entity, buff);
      }
    }
  }

  removeArenaPreparation(): void {
    for (const entity of this.entities) {
      this.buffSystem.remove(entity, ArenaPreparationBuff.id, true);
    }
  }

  cancelBuff(entityId: string, buffId: string): void {
    const entity = this.getEntity(entityId);
    if (!entity || this.frozenEntities.has(entityId)) return;
    const buffs = this.buffSystem.getBuffs(entity);
    const buff = buffs.find(b => b.definition.id === buffId);
    if (buff && buff.definition.type === 'buff' && !buff.definition.unremovable) {
      this.buffSystem.remove(entity, buffId, true);
    }
  }

  freezeEntity(entityId: string): void {
    const entity = this.getEntity(entityId);
    if (!entity) return;
    this.frozenEntities.add(entityId);
    entity.disconnected = true;
    entity.isMoving = false;
    entity.vx = 0;
    entity.vz = 0;
    entity.moveFlags = 0;
    entity.moveSpeed = 0;
    entity.turnSpeed = 0;
    this.castingSystem.cancel(entity);
    this.stopAutoAttack(entityId);
    this.cancelResting(entityId);
    this.targets.set(entityId, null);
    if (entity.charging) {
      entity.charging = false;
      this.chargeSystem.cancelCharges(entity);
    }

    // Check if the entity is airborne — if so, keep vy so gravity simulation
    // continues the fall. Otherwise snap to elevator / zero vy as before.
    const resolved = this.collision.resolve(entity.x, entity.z, entity.y, entity.collisionRadius);
    const airborne = entity.y > resolved.groundY + 0.1;
    if (airborne) {
      // Preserve vy so the server gravity sim continues the fall.
      // Track the fall peak if not already set.
      if (entity.fallPeakY < entity.y) {
        entity.fallPeakY = entity.y;
      }
    } else {
      entity.vy = 0;
      // Snap to elevator surface so the entity doesn't float after the
      // elevator moves away during the disconnect grace period.
      const snapEntity = this.getEntity(entityId);
      if (snapEntity) this.elevator?.snapEntity(snapEntity);
    }

    // Immediately broadcast the frozen position with zero horizontal velocities
    // so remote clients don't dead-reckon any residual drift before the next tick.
    const relayMsg: ServerMessage = {
      type: 'position_relay',
      id: entityId,
      x: entity.x, y: entity.y, z: entity.z,
      rotationY: entity.rotationY,
      isMoving: false,
      vx: 0, vz: 0,
      moveFlags: 0, moveSpeed: 0, vy: entity.vy, turnSpeed: 0,
    };
    this.onPositionRelay?.(entityId, relayMsg);
  }

  /** Fully remove an entity from the game world (not a kill). */
  removeEntity(entityId: string): void {
    const idx = this.entities.findIndex(e => e.id === entityId);
    if (idx === -1) return;

    // Clean up all per-entity state
    const entity = this.entities[idx];
    this.frozenEntities.delete(entityId);
    this.castingSystem.cancel(entity);
    this.autoAttackSystem.removeEntity(entity);
    this.chargeSystem.removeEntity(entity);
    this.abilityHandler.removeEntity(entityId);
    this.broadcast.removeEntity(entityId);
    this.targets.delete(entityId);

    // Clear other entities' targets pointing at this entity
    for (const [eid, targetId] of this.targets) {
      if (targetId === entityId) this.targets.set(eid, null);
    }

    // Remove dots involving this entity
    for (let j = this.dotSystem.dots.length - 1; j >= 0; j--) {
      const d = this.dotSystem.dots[j];
      if (d.target.id === entityId || d.owner.id === entityId) {
        this.dotSystem.dots.splice(j, 1);
      }
    }

    // Remove buffs and aura
    this.fullRetardAuraSystem.auras.delete(entity);
    this.buffSystem.clearEntity(entity);

    this.entities.splice(idx, 1);
  }

  unfreezeEntity(entityId: string): void {
    const entity = this.getEntity(entityId);
    if (!entity) return;
    this.frozenEntities.delete(entityId);
    entity.disconnected = false;
  }

  /** Simulate gravity for frozen (disconnected) entities so they don't float. */
  private updateFrozenGravity(dt: number): void {
    for (const entityId of this.frozenEntities) {
      const entity = this.getEntity(entityId);
      if (!entity || entity.dead) continue;

      const resolved = this.collision.resolve(entity.x, entity.z, entity.y, entity.collisionRadius);
      const onGround = entity.y <= resolved.groundY + 0.1;
      if (onGround) continue;

      // Apply gravity
      entity.vy -= entity.gravity * dt;
      entity.y += entity.vy * dt;

      // Track peak height
      if (entity.y > entity.fallPeakY) {
        entity.fallPeakY = entity.y;
      }

      // Check if landed
      const resolvedAfter = this.collision.resolve(entity.x, entity.z, entity.y, entity.collisionRadius);
      if (entity.y <= resolvedAfter.groundY + 0.1) {
        entity.y = resolvedAfter.groundY;
        entity.vy = 0;

        // Apply fall damage
        if (entity.fallPeakY > resolvedAfter.groundY + 0.5) {
          const fallDistance = entity.fallPeakY - resolvedAfter.groundY;
          entity.fallPeakY = 0;
          this.applyFallDamage(entity, fallDistance);
        } else {
          entity.fallPeakY = 0;
        }
      }
    }
  }

  // ── Movement validation constants ─────��─────────────────────────────
  // Speed tolerance: allow up to 50% over computed max speed to account for
  // network jitter, tick misalignment, and rapid acceleration/deceleration.
  private static readonly SPEED_TOLERANCE = 1.5;
  // Flat distance buffer (world units) added on top of speed-based max distance.
  // Covers turning, strafing, sub-tick movement bursts, and minor desync.
  private static readonly POSITION_TOLERANCE_FLAT = 1.5;
  // If more than this many seconds have passed since last position update,
  // skip distance validation (handles reconnects, knockbacks, etc.).
  private static readonly VALIDATION_GAP_THRESHOLD = 0.5; // 500ms

  updateEntityPosition(entityId: string, x: number, y: number, z: number, rotationY: number, isMoving: boolean, vx: number, vz: number, moveFlags?: number, moveSpeed?: number, vy?: number, turnSpeed?: number, grounded?: boolean): void {
    const entity = this.getEntity(entityId);
    if (!entity || entity.dead || this.frozenEntities.has(entityId)) return;
    // During a charge, the server is authoritative about position — ignore client updates
    if (this.chargeSystem.isCharging(entity)) return;

    // ── Speed validation: clamp velocity magnitude to max possible speed ──
    const maxSpeed = entity.speed * entity.movementSpeedModifier;
    const clientSpeed = Math.sqrt(vx * vx + vz * vz);
    if (!entity.godMode && clientSpeed > maxSpeed * ServerEngine.SPEED_TOLERANCE) {
      const scale = maxSpeed / clientSpeed;
      vx *= scale;
      vz *= scale;
    }

    // ── Position validation: reject if distance traveled exceeds what's possible ──
    const now = performance.now();
    const timeSinceLastUpdate = entity.lastPositionUpdateTime > 0
      ? (now - entity.lastPositionUpdateTime) / 1000
      : 0;

    // Skip distance validation when there's a large time gap (reconnect, knockback, first update)
    if (timeSinceLastUpdate > 0 && timeSinceLastUpdate < ServerEngine.VALIDATION_GAP_THRESHOLD && !entity.godMode) {
      const maxDistance = maxSpeed * ServerEngine.SPEED_TOLERANCE * timeSinceLastUpdate
        + ServerEngine.POSITION_TOLERANCE_FLAT;
      const dx = x - entity.x;
      const dz = z - entity.z;
      const distance = Math.sqrt(dx * dx + dz * dz);

      if (distance > maxDistance) {
        // Rubber-band: reject the position and send correction
        this.onSendToPlayer?.(entityId, {
          type: 'position_correction',
          x: entity.x,
          y: entity.y,
          z: entity.z,
          rotationY: entity.rotationY,
        } as any);
        entity.lastPositionUpdateTime = now;
        return;
      }
    }

    entity.lastPositionUpdateTime = now;
    entity.x = x;
    entity.y = y;
    entity.z = z;
    entity.rotationY = rotationY;
    entity.isMoving = isMoving;
    entity.vx = vx;
    entity.vz = vz;
    if (moveFlags !== undefined) entity.moveFlags = moveFlags;
    if (moveSpeed !== undefined) entity.moveSpeed = moveSpeed;
    if (vy !== undefined) entity.vy = vy;
    if (turnSpeed !== undefined) entity.turnSpeed = turnSpeed;
    if (grounded !== undefined) entity.grounded = grounded;
    if (isMoving) this.cancelResting(entityId);

    // Immediately relay to other clients for low-latency dead reckoning.
    // Prefer unreliable DataChannel — avoids TCP head-of-line blocking.
    const relayMsg: ServerMessage = {
      type: 'position_relay',
      id: entityId, x, y, z, rotationY, isMoving, vx, vz,
      moveFlags, moveSpeed, vy, turnSpeed,
    };
    if (this.onPositionRelayUnreliable) {
      this.onPositionRelayUnreliable(entityId, relayMsg);
    } else {
      this.onPositionRelay?.(entityId, relayMsg);
    }

    // Fall damage detection: track peak Y while airborne
    const resolved = this.collision.resolve(x, z, y, entity.collisionRadius);
    const onGround = y <= resolved.groundY + 0.1;
    if (!onGround) {
      // If the client reports ~zero vertical velocity while above server-known
      // ground, the player is riding a dynamic surface (e.g. moving platform).
      // Reset the peak so we don't accumulate phantom fall height that
      // triggers lethal damage on descent.
      if (vy !== undefined && Math.abs(vy) < 0.5) {
        entity.fallPeakY = 0;
      } else if (y > entity.fallPeakY) {
        entity.fallPeakY = y;
      }
    } else if (entity.fallPeakY > resolved.groundY + 0.5) {
      const fallDistance = entity.fallPeakY - resolved.groundY;
      entity.fallPeakY = 0;
      this.applyFallDamage(entity, fallDistance);
    } else {
      entity.fallPeakY = 0;
    }
  }

  setTarget(entityId: string, targetEntityId: string | null): void {
    if (this.frozenEntities.has(entityId)) return;
    this.targets.set(entityId, targetEntityId);

    // Stop auto-attack if the player de-targets or switches to a different target
    const entity = this.getEntity(entityId);
    if (entity) {
      const aaTarget = this.autoAttackSystem.getTarget(entity);
      if (aaTarget && (!targetEntityId || aaTarget.id !== targetEntityId)) {
        this.stopAutoAttack(entityId);
      }
    }
  }

  getTarget(entityId: string): ServerEntity | null {
    const targetId = this.targets.get(entityId);
    if (!targetId) return null;
    return this.entities.find(e => e.id === targetId) ?? null;
  }

  requestAutoAttack(entityId: string, targetEntityId: string): void {
    const entity = this.getEntity(entityId);
    const target = this.getEntity(targetEntityId);
    if (!entity || !target || entity.dead || target.dead || this.frozenEntities.has(entityId)) return;
    if (!target.isHostileTo(entity)) return;
    this.autoAttackSystem.start(entity, target);
    entity.isAutoAttacking = true;
  }

  stopAutoAttack(entityId: string): void {
    const entity = this.getEntity(entityId);
    if (entity) this.autoAttackSystem.stop(entity);
    // onStopped callback handles entity.isAutoAttacking = false
  }

  requestAbility(entityId: string, abilityId: string, targetEntityId: string | null,
                 groundTarget?: { x: number; y: number; z: number }, clientServerTimestamp?: number): void {
    // Forward onSendToPlayer/onBroadcast to ability handler (they may be set after construction)
    this.abilityHandler['deps'].onSendToPlayer = this.onSendToPlayer;
    this.abilityHandler['deps'].onBroadcast = this.onBroadcast;
    this.abilityHandler.requestAbility(entityId, abilityId, targetEntityId, groundTarget, clientServerTimestamp);
  }

  cancelCastRequest(entityId: string): void {
    this.abilityHandler.cancelCastRequest(entityId, this.frozenEntities);
  }

  setResting(entityId: string, resting: boolean): void {
    const entity = this.getEntity(entityId);
    if (!entity || entity.dead || this.frozenEntities.has(entityId)) return;

    if (resting) {
      if (entity.inCombat) return;
      if (entity.isMoving) return;
      if (this.buffSystem.isStunned(entity) || this.buffSystem.isSleeping(entity)) return;
      if (this.castingSystem.isCasting(entity)) return;
      this.stopAutoAttack(entityId);
      this.buffSystem.apply(entity, RestingBuff);
    } else {
      this.buffSystem.remove(entity, RestingBuff.id, true);
    }
  }

  private cancelResting(entityId: string): void {
    const entity = this.getEntity(entityId);
    if (!entity) return;
    if (this.buffSystem.hasBuff(entity, RestingBuff.id)) {
      this.buffSystem.remove(entity, RestingBuff.id, true);
    }
  }

  /** Set elapsed time offset for restored sessions so getGameElapsed() returns the correct value. */
  setElapsedOffset(elapsedSeconds: number): void {
    this.startTime = Date.now() - elapsedSeconds * 1000;
  }

  start(): void {
    if (this.tickTimeoutId) return;
    // Only set startTime if not already set by setElapsedOffset()
    if (this.startTime === 0) {
      this.startTime = Date.now();
    }
    this.lastTickTime = performance.now();
    this.nextTickTarget = this.lastTickTime + ServerEngine.TICK_MS;
    this.scheduleNextTick();
  }

  stop(): void {
    if (this.tickTimeoutId) {
      clearTimeout(this.tickTimeoutId);
      this.tickTimeoutId = null;
    }
    if (this.midTickTimeoutId) {
      clearTimeout(this.midTickTimeoutId);
      this.midTickTimeoutId = null;
    }
    this.lagCompensation.clear();
  }

  /** Self-correcting tick scheduler — compensates for drift each iteration instead of accumulating it. */
  private scheduleNextTick(): void {
    const now = performance.now();
    const delay = Math.max(0, this.nextTickTarget - now);
    this.tickTimeoutId = setTimeout(() => {
      this.nextTickTarget += ServerEngine.TICK_MS;
      this.update();
      if (this.tickTimeoutId !== null) {
        // Schedule mid-tick position broadcast halfway to the next full tick.
        // Only fires if unreliable channel is available (no point over TCP).
        if (this.onBroadcastUnreliable) {
          this.scheduleMidTick();
        }
        this.scheduleNextTick();
      }
    }, delay);
  }

  /**
   * Mid-tick position-only broadcast at 60Hz via unreliable DataChannel.
   * Halves the time between position updates, reducing dead reckoning distance
   * and making turns/stops feel crisper. Only sends over the unreliable channel
   * to avoid doubling TCP bandwidth — clients without DataChannel still get
   * 30Hz positions from the full tick.
   */
  private scheduleMidTick(): void {
    this.midTickTimeoutId = setTimeout(() => {
      this.midTickTimeoutId = null;
      this.broadcast.onBroadcastUnreliable = this.onBroadcastUnreliable;
      this.broadcast.broadcastMidTickPositions(this.tick, this.entities);
    }, ServerEngine.MID_TICK_MS);
  }

  // ── Main tick ───────────────────────────────────────────────────────────

  private update(): void {
    const now = performance.now();
    const dt = Math.min((now - this.lastTickTime) / 1000, 0.1);
    this.lastTickTime = now;
    this.tick++;

    // Update dynamic map colliders (elevator) before entity processing
    this.elevator?.update(this.getGameElapsed(), this.frozenEntities, (id) => this.getEntity(id));

    // Simulate gravity for frozen (disconnected) entities
    this.updateFrozenGravity(dt);

    // Update buff-driven modifiers
    for (const entity of this.entities) {
      entity.movementSpeedModifier = this.buffSystem.getMovementSpeedMultiplier(entity)
        * (entity.godMode ? 4 : 1); // God mode: +300% movement speed
      entity.stunned = this.buffSystem.isStunned(entity) || this.buffSystem.isSleeping(entity);
      entity.setDiscombobulated(this.buffSystem.isDiscombobulated(entity));

      if (entity.stunned) {
        this.stopAutoAttack(entity.id);
        this.cancelResting(entity.id);
        if (this.chargeSystem.cancelCharges(entity)) {
          entity.charging = false;
        }
      }


      // Cancel resting if entity entered combat
      if (entity.inCombat) {
        this.cancelResting(entity.id);
      }
    }

    // Update casting/channeling
    for (const entity of this.entities) {
      this.castingSystem.update(entity, dt);
    }

    // Update charges (sweep, tweaker sprint, knockbacks)
    this.chargeSystem.update(dt);

    // Update auto-attacks (timer ticking + swing logic + projectiles)
    for (const entity of this.entities) {
      this.autoAttackSystem.update(entity, dt);
    }
    this.autoAttackSystem.updateProjectiles(dt);

    // Update area effects
    this.gasCloudSystem.update(dt);
    this.chemPoolSystem.update(dt);
    this.dotSystem.update(dt);
    this.abilityHandler.updatePendingAoeImpacts(dt);
    this.fullRetardAuraSystem.update(dt);

    // Update systems
    this.combatSystem.update(dt);
    this.buffSystem.update(dt);
    this.regenSystem.update(dt);

    // Process queued abilities — fire any that are no longer blocked after GCD/cast updates
    this.abilityHandler['deps'].onSendToPlayer = this.onSendToPlayer;
    this.abilityHandler['deps'].onBroadcast = this.onBroadcast;
    this.abilityHandler.processAbilityQueue(dt);

    // Build and broadcast state (events are bundled into delta updates)
    this.broadcastGameState();

    // Check for deaths
    for (const entity of this.entities) {
      if (entity.dead && entity.hp <= 0) {
        // Entity just died this tick - notify
      }
    }

    // Check win condition
    this.checkWinCondition();
  }

  // ── Immediate event emission ──────────────────────────────────────────
  // Time-sensitive combat events are broadcast immediately when generated,
  // removing up to 33ms (one tick) of latency from combat feedback.

  /**
   * Push a game event. Time-sensitive events are broadcast immediately
   * AND included in the tick update for reliability.
   */
  private emitEvent(event: ServerMessage): void {
    // Time-sensitive combat events are broadcast immediately rather than
    // waiting for the tick bundle — removes up to 33ms of latency.
    if (ServerEngine.IMMEDIATE_EVENT_TYPES.has(event.type)) {
      this.onBroadcast?.(event);
      // Don't add to pendingEvents — already sent, avoids client duplicates
      return;
    }
    // Non-immediate events get bundled into the tick update as before
    this.pendingEvents[this.pendingEvents.length] = event;
  }

  // ── State broadcast ──────���──────────────────────────────────────────

  private broadcastGameState(): void {
    // Capture timestamp once — used for both broadcast and position history
    // so the client's serverTimestamp matches our rewind buffer exactly.
    const serverTimestamp = Date.now();
    this.lagCompensation.recordPositionHistory(serverTimestamp, this.entities);

    // Sync callbacks to broadcast subsystem
    this.broadcast.onBroadcast = this.onBroadcast;
    this.broadcast.onBroadcastUnreliable = this.onBroadcastUnreliable;

    this.broadcast.broadcastGameState(
      this.tick,
      ServerEngine.KEYFRAME_INTERVAL,
      serverTimestamp,
      this.entities,
      this.pendingEvents,
      this.castingSystem,
      this.buffSystem,
      this.combatSystem,
      this.gasCloudSystem,
      this.chemPoolSystem,
      this.targets,
    );

    this.pendingEvents = [];
  }

  /** Returns full current state for a rejoining player. */
  getFullState(): { buffs: EntityBuffSnapshot[]; gasClouds: GasCloudSnapshot[]; chemicalPools: ChemicalPoolSnapshot[]; cooldowns: CooldownSnapshot[] } {
    return this.broadcast.getFullState(
      this.entities,
      this.buffSystem,
      this.combatSystem,
      this.gasCloudSystem,
      this.chemPoolSystem,
    );
  }

  // ── Elevator (Celestial Ballroom) ───��───────────────────────────────

  /** Seconds since the game engine started (matches client ArenaScript.elapsed). */
  getGameElapsed(): number {
    if (this.startTime === 0) return 0;
    return (Date.now() - this.startTime) / 1000;
  }

  /** Current elevator surface Y, or undefined if no elevator on this map. */
  getElevatorY(): number | undefined {
    return this.elevator?.getSurfaceY();
  }

  /** Snap entity to elevator surface if within its footprint. */
  snapEntityToElevator(entityId: string): void {
    const entity = this.getEntity(entityId);
    if (entity) this.elevator?.snapEntity(entity);
  }

  // ── Win condition ───────────────────────────────────────────────────

  private checkWinCondition(): void {
    if (this.gameOverFired) return;
    const teams = new Set(this.entities.map(e => e.team));
    for (const team of teams) {
      const teamEntities = this.entities.filter(e => e.team === team);
      if (teamEntities.every(e => e.dead)) {
        // This team is eliminated - the other team wins
        const winningTeam = this.entities.find(e => e.team !== team && !e.dead)?.team;
        if (winningTeam !== undefined) {
          this.gameOverFired = true;
          this.onGameOver?.(winningTeam);
        }
        return;
      }
    }
  }
}
