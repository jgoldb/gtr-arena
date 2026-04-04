import type { Ability, BuffDefinition } from '@gtr/shared';
import type { EntitySnapshot, EntityBuffSnapshot, GasCloudSnapshot, ChemicalPoolSnapshot, CooldownSnapshot } from '@gtr/shared';
import type {
  S2C_CombatEvent, S2C_Flinch, S2C_AbilityEffect, S2C_CooldownUpdate,
  S2C_GasCloudSpawn, S2C_ChemPoolSpawn, S2C_Knockback, S2C_EntityDied,
  S2C_GameState, S2C_GameStateUpdate, S2C_GameStateSnapshot,
  S2C_PositionUpdate,
  EntityPositionData, EntityStateDelta,
  ServerMessage,
} from '@gtr/shared';
import { GLOBAL_COOLDOWN, yardsToUnits, isRangedAutoAttack, FartBombDebuff, ChemicalSpillSpeedBuff, ChemicalSpillDot, CrotchRotDot, RottenCrotchStun, KaboomStun, ArenaPreparationBuff, RestingBuff, ParanoidDebuff, ODStunDebuff, Sweep, TweakerSprint, TweakerSprintSlow, getBuffDescription, getCharacterStats, GasCloudSystem, DotSystem, ChemicalPoolSystem, FullRetardAuraSystem, ChargeSystem } from '@gtr/shared';
import { ServerEntity } from './ServerEntity.js';
import { ServerCombatSystem } from './ServerCombatSystem.js';
import { ServerBuffSystem } from './ServerBuffSystem.js';
import { ServerRegenSystem } from './ServerRegenSystem.js';
import { ServerCastingSystem } from './ServerCastingSystem.js';
import { ServerAutoAttackSystem } from './ServerAutoAttackSystem.js';
import { CollisionSystem } from './ServerMapManager.js';
import { ServerElevator } from './ServerElevator.js';

interface PendingAoeImpact {
  ability: Ability;
  groundX: number;
  groundY: number;
  groundZ: number;
  delay: number;
  elapsed: number;
  owner: ServerEntity;
}

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
  private pendingAoeImpacts: PendingAoeImpact[] = [];
  private dumpsterDiveAutoTargets = new Map<string, string>(); // entityId -> saved auto-attack target id
  private nextEffectId = 1;

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
  private midTickCounter = 0; // separate counter for mid-tick broadcasts
  private static readonly KEYFRAME_INTERVAL = 150; // full snapshot every 5 seconds
  private static readonly BOTTLE_CHUCK_IMPACT_DELAY = 0.825; // animation wind-up + flight time
  // Range tolerance for residual latency (sub-tick timing, interpolation granularity).
  // Reduced from 2 yards now that server-side position rewind handles the bulk of lag compensation.
  private static readonly RANGE_TOLERANCE = yardsToUnits(1);

  // ── Lag compensation: position history for server-side rewind ──
  private positionHistory: Array<{
    serverTimestamp: number;
    positions: Map<string, { x: number; z: number; rotationY: number }>;
  }> = [];
  private static readonly MAX_REWIND_MS = 400;
  // ~14 ticks at 30Hz (400ms / 33ms = 12, +2 margin)
  private static readonly MAX_HISTORY_TICKS = Math.ceil(400 / ServerEngine.TICK_MS) + 2;

  // Ability queue — holds one pending ability per entity when request arrives slightly
  // before GCD/cast expires. Processed on the tick where GCD/cast clears.
  private static readonly ABILITY_QUEUE_TOLERANCE = 0.1; // 100ms — accept abilities arriving up to 3 ticks before GCD expires
  private static readonly ABILITY_QUEUE_MAX_AGE = 0.5;   // expire stale queued abilities after 500ms
  private abilityQueue = new Map<string, {
    abilityId: string; targetEntityId: string | null;
    groundTarget?: { x: number; y: number; z: number }; clientServerTimestamp?: number;
    age: number;
  }>();

  // Event queue (flushed each tick in the delta update for clients without immediate delivery)
  private pendingEvents: ServerMessage[] = [];

  // ── Immediate event types ────────────────────────────────────────────
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

  // Position tracking — only send when entity actually moved
  private lastBroadcastPosition = new Map<string, {
    x: number; y: number; z: number; rotationY: number; isMoving: boolean;
    vx: number; vz: number;
  }>();
  private static readonly POSITION_EPSILON = 0.001;
  private static readonly ROTATION_EPSILON = 0.001;

  // Delta tracking — previous broadcast state per entity
  private lastBroadcastState = new Map<string, {
    hp: number; maxHp: number; mana: number; maxMana: number;
    dead: boolean; inCombat: boolean; stunned: boolean; charging: boolean;
    isAutoAttacking: boolean;
    castingAbilityId: string | null; castingElapsed: number;
    castingTotalTime: number; castingIsChannel: boolean;
    targetEntityId: string | null;
    disconnected: boolean;
  }>();
  private lastBroadcastBuffs = new Map<string, string>(); // entityId -> buff signature
  // Track world effect IDs + consumed state to only send when actually changed
  private lastBroadcastGasCloudIds = '';
  private lastBroadcastChemPoolSig = '';

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
      triggerGcd: (entity) => this.triggerEntityGcd(entity),
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
          this.onAbilitySuccess(entity, ability, target);
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
      onSweepChargeEnd: (entity, savedTarget) => {
        this.emitEvent({
          type: 'ability_effect',
          entityId: entity.id,
          abilityId: 'sweep-finish',
        } as S2C_AbilityEffect);
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
        const savedTargetId = this.dumpsterDiveAutoTargets.get(target.id);
        if (savedTargetId) {
          this.dumpsterDiveAutoTargets.delete(target.id);
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
    this.dumpsterDiveAutoTargets.delete(entityId);
    this.targets.delete(entityId);
    this.lastBroadcastPosition.delete(entityId);
    this.lastBroadcastState.delete(entityId);
    this.lastBroadcastBuffs.delete(entityId);

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

  // ── Movement validation constants ───────────────────────────────────
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
    const entity = this.getEntity(entityId);
    if (!entity || this.frozenEntities.has(entityId)) return;

    const ability = entity.abilities.find(a => a !== null && a.id === abilityId);
    if (!ability) return;

    // Block during GCD (CC-immune abilities bypass GCD)
    if (!entity.godMode && !ability.usableWhileCCd && this.combatSystem.getGcdRemaining(entityId) > 0) {
      // Queue the ability if GCD is about to expire (within tolerance) — fires on next tick
      if (this.combatSystem.getGcdRemaining(entityId) <= ServerEngine.ABILITY_QUEUE_TOLERANCE) {
        this.abilityQueue.set(entityId, { abilityId, targetEntityId, groundTarget, clientServerTimestamp, age: 0 });
      }
      return;
    }

    // Cancel channel if starting new ability
    if (this.castingSystem.isCasting(entity) && this.combatSystem.getCooldownRemaining(entityId, abilityId) <= 0) {
      this.castingSystem.cancel(entity);
    }

    // Ground-targeted AoE abilities — no rewind (by design: lead your targets)
    if (ability.groundTargeted && groundTarget) {
      const result = this.useGroundTargetAbility(entity, ability, groundTarget.x, groundTarget.z);
      if (result.success) {
        this.onAbilitySuccess(entity, ability, undefined, groundTarget);
        this.triggerEntityGcd(entity);
      } else if (result.errorMessage) {
        this.onSendToPlayer?.(entityId, { type: 'error', message: result.errorMessage });
      }
      return;
    }

    // Auto self-cast for friendly abilities
    let target: ServerEntity | null = null;
    if (targetEntityId) {
      target = this.getEntity(targetEntityId) ?? null;
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
      targetPosOverride = this.getRewindPosition(target.id, clientServerTimestamp) ?? undefined;
    }

    if (ability.castTime) {
      this.serverStartCasting(entity, ability, target, targetPosOverride);
    } else {
      const result = this.combatSystem.useAbility(ability, entity, target, targetPosOverride);
      if (result.success) {
        this.onAbilitySuccess(entity, ability, target);
        if (!ability.usableWhileCCd) this.triggerEntityGcd(entity);
      } else if (result.errorMessage) {
        this.onSendToPlayer?.(entityId, { type: 'error', message: result.errorMessage });
      }
    }
  }

  cancelCastRequest(entityId: string): void {
    if (this.frozenEntities.has(entityId)) return;
    const entity = this.getEntity(entityId);
    if (entity) this.castingSystem.cancel(entity);
  }

  /** Process queued abilities — called each tick after GCD/cast updates. */
  private processAbilityQueue(dt: number): void {
    for (const [entityId, queued] of this.abilityQueue) {
      queued.age += dt;

      // Expire stale entries or clear if entity can no longer act
      const entity = this.getEntity(entityId);
      if (queued.age > ServerEngine.ABILITY_QUEUE_MAX_AGE || !entity || entity.dead || entity.stunned) {
        this.abilityQueue.delete(entityId);
        continue;
      }

      // Re-attempt — requestAbility will succeed now if GCD/cast cleared this tick
      if (this.combatSystem.getGcdRemaining(entityId) <= 0 && !this.castingSystem.isCasting(entity)) {
        this.abilityQueue.delete(entityId);
        this.requestAbility(entityId, queued.abilityId, queued.targetEntityId, queued.groundTarget, queued.clientServerTimestamp);
      }
    }
  }

  /** Execute a ground-targeted AoE ability at a world position. Consumes resources immediately, delays damage until impact. */
  private useGroundTargetAbility(entity: ServerEntity, ability: Ability, groundX: number, groundZ: number): { success: boolean; errorMessage?: string } {
    if (entity.dead) return { success: false, errorMessage: 'You are dead' };
    if (this.buffSystem.isStunned(entity) || this.buffSystem.isSleeping(entity)) return { success: false, errorMessage: 'You are stunned' };
    if (!entity.godMode && this.combatSystem.getCooldownRemaining(entity.id, ability.id) > 0) {
      return { success: false, errorMessage: 'Ability is not ready yet' };
    }

    // Validate range to ground target
    const dist = Math.sqrt((entity.x - groundX) ** 2 + (entity.z - groundZ) ** 2);
    if (ability.range && dist > ability.range + yardsToUnits(2)) {
      return { success: false, errorMessage: 'Out of range' };
    }

    if (!entity.godMode) {
      const effectiveCost = Math.round(ability.manaCost * this.buffSystem.getManaCostMultiplier(entity));
      if (entity.mana < effectiveCost) return { success: false, errorMessage: 'Not enough mana' };
      entity.mana -= effectiveCost;
      if (effectiveCost > 0) this.regenSystem.notifyManaUsed(entity);
    }

    if (!entity.godMode) {
      this.combatSystem.setCooldown(entity.id, ability.id, ability.cooldown);
    }

    // Schedule damage for when the projectile lands
    this.pendingAoeImpacts.push({
      ability,
      groundX,
      groundY: entity.y,
      groundZ,
      delay: ServerEngine.BOTTLE_CHUCK_IMPACT_DELAY,
      elapsed: 0,
      owner: entity,
    });

    return { success: true };
  }

  private updatePendingAoeImpacts(dt: number): void {
    for (let i = this.pendingAoeImpacts.length - 1; i >= 0; i--) {
      const impact = this.pendingAoeImpacts[i];
      impact.elapsed += dt;
      if (impact.elapsed < impact.delay) continue;

      // Impact! Damage all hostiles in radius
      const radius = impact.ability.aoeRadius ?? 0;
      for (const target of this.entities) {
        if (target === impact.owner || target.dead || !target.isHostileTo(impact.owner) || this.buffSystem.isUntargetable(target)) continue;
        const dx = target.x - impact.groundX;
        const dy = target.y - impact.groundY;
        const dz = target.z - impact.groundZ;
        if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
        this.combatSystem.applyAoeDamage(impact.owner, target, impact.ability);
      }

      this.pendingAoeImpacts.splice(i, 1);
    }
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
    this.positionHistory.length = 0;
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
      this.broadcastMidTickPositions();
    }, ServerEngine.MID_TICK_MS);
  }

  private broadcastMidTickPositions(): void {
    if (!this.onBroadcastUnreliable) return;

    this.midTickCounter++;
    const positions: EntityPositionData[] = [];
    for (const e of this.entities) {
      if (!e.isMoving && e.turnSpeed === 0) continue; // skip stationary entities
      positions.push({
        id: e.id, x: e.x, y: e.y, z: e.z,
        rotationY: e.rotationY, isMoving: e.isMoving,
        vx: e.vx, vz: e.vz,
        moveFlags: e.moveFlags, moveSpeed: e.moveSpeed, vy: e.vy, turnSpeed: e.turnSpeed,
      });
    }

    if (positions.length === 0) return;

    const posMsg: S2C_PositionUpdate = {
      type: 'position_update',
      tick: this.tick, // same tick number — client uses receiveTime for interpolation
      timestamp: Date.now(),
      positions,
    };
    this.onBroadcastUnreliable(posMsg);
  }

  // ── Lag compensation: position history ────────────────────────────────

  /** Record all entity positions for this tick (called once per broadcast). */
  private recordPositionHistory(serverTimestamp: number): void {
    const positions = new Map<string, { x: number; z: number; rotationY: number }>();
    for (const e of this.entities) {
      positions.set(e.id, { x: e.x, z: e.z, rotationY: e.rotationY });
    }
    this.positionHistory.push({ serverTimestamp, positions });
    while (this.positionHistory.length > ServerEngine.MAX_HISTORY_TICKS) {
      this.positionHistory.shift();
    }
  }

  /**
   * Get the rewound position for an entity at a past server timestamp.
   * Returns null if the timestamp is too old, in the future, or the entity
   * has no history — caller should fall back to current positions.
   */
  private getRewindPosition(entityId: string, clientServerTimestamp: number): { x: number; z: number; rotationY: number } | null {
    if (this.positionHistory.length === 0) return null;

    const now = Date.now();
    const rewindAmount = now - clientServerTimestamp;

    // Reject timestamps in the future or too far in the past
    if (rewindAmount < 0 || rewindAmount > ServerEngine.MAX_REWIND_MS) return null;

    // Find the two history entries bracketing the requested timestamp
    for (let i = 0; i < this.positionHistory.length - 1; i++) {
      const before = this.positionHistory[i];
      const after = this.positionHistory[i + 1];
      if (before.serverTimestamp <= clientServerTimestamp && after.serverTimestamp > clientServerTimestamp) {
        const beforePos = before.positions.get(entityId);
        const afterPos = after.positions.get(entityId);
        if (!beforePos && !afterPos) return null;
        if (!beforePos) return afterPos ? { ...afterPos } : null;
        if (!afterPos) return { ...beforePos };

        const totalTime = after.serverTimestamp - before.serverTimestamp;
        const elapsed = clientServerTimestamp - before.serverTimestamp;
        const t = totalTime > 0 ? Math.max(0, Math.min(1, elapsed / totalTime)) : 1;
        return {
          x: beforePos.x + (afterPos.x - beforePos.x) * t,
          z: beforePos.z + (afterPos.z - beforePos.z) * t,
          rotationY: beforePos.rotationY + (afterPos.rotationY - beforePos.rotationY) * t,
        };
      }
    }

    // Timestamp is at or after our latest entry — use latest
    const last = this.positionHistory[this.positionHistory.length - 1];
    if (last.serverTimestamp <= clientServerTimestamp) {
      const pos = last.positions.get(entityId);
      return pos ? { ...pos } : null;
    }

    // Timestamp is before all history entries — too old
    return null;
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
    this.updatePendingAoeImpacts(dt);
    this.fullRetardAuraSystem.update(dt);

    // Update systems
    this.combatSystem.update(dt);
    this.buffSystem.update(dt);
    this.regenSystem.update(dt);

    // Process queued abilities — fire any that are no longer blocked after GCD/cast updates
    this.processAbilityQueue(dt);

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

  // ── Casting ──────────────────────────────────────────────────────────

  /** Validate and start a cast/channel — server-side entry point with lag compensation. */
  private serverStartCasting(entity: ServerEntity, ability: Ability, target: ServerEntity | null,
                       targetPosOverride?: { x: number; z: number; rotationY: number }): void {
    if (this.castingSystem.isCasting(entity)) {
      this.onSendToPlayer?.(entity.id, { type: 'error', message: 'Already casting' });
      return;
    }
    if (entity.isMoving || !entity.grounded) {
      this.onSendToPlayer?.(entity.id, { type: 'error', message: 'Cannot cast while moving' });
      return;
    }

    // Use rewound position for initial cast validation only — mid-cast checks use current positions
    const validation = this.combatSystem.validateAbility(ability, entity, target, targetPosOverride);
    if (!validation.success) {
      if (validation.errorMessage) {
        this.onSendToPlayer?.(entity.id, { type: 'error', message: validation.errorMessage });
      }
      return;
    }

    const result = this.castingSystem.start(entity, ability, target);
    if (!result.started && result.errorMessage) {
      this.onSendToPlayer?.(entity.id, { type: 'error', message: result.errorMessage });
    }
  }


  // ── Ability success effects ─────────────────────────────────────────

  private static readonly MELEE_AUTO_ATTACK_ABILITIES = ['mop', 'big-boot', 'jimmy-legs', 'shank', 'gank'];

  private onAbilitySuccess(entity: ServerEntity, ability: Ability, target?: ServerEntity | null, groundTarget?: { x: number; y: number; z: number }): void {
    const abilityEvent: S2C_AbilityEffect = {
      type: 'ability_effect',
      entityId: entity.id,
      abilityId: ability.id,
      ...(target ? { targetId: target.id } : {}),
      ...(groundTarget ? { groundTargetX: groundTarget.x, groundTargetY: groundTarget.y, groundTargetZ: groundTarget.z } : {}),
    };
    this.emitEvent(abilityEvent);

    // Send cooldown update to the entity's player (skip in god mode)
    if (ability.cooldown > 0 && !entity.godMode) {
      this.onSendToPlayer?.(entity.id, {
        type: 'cooldown_update',
        abilityId: ability.id,
        remaining: ability.cooldown,
        total: ability.cooldown,
      } as S2C_CooldownUpdate);
    }

    if (ability.id === 'fart-bomb') {
      const gcRadius = yardsToUnits(5);
      const gcId = `gc_${this.nextEffectId++}`;
      this.gasCloudSystem.spawn(entity, entity.x, entity.y, entity.z, gcRadius, 8, FartBombDebuff, 592, 2, gcId);
      this.onBroadcast?.({
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
      this.chemPoolSystem.spawn(entity, entity.x, entity.y, entity.z, cpRadius, 30, ChemicalSpillSpeedBuff, ChemicalSpillDot, 297, 349, 600, 2, 6, 2, cpId);
      this.onBroadcast?.({
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
      this.buffSystem.addStacks(entity, 'tweaking', 15);
      if (this.buffSystem.getStacks(entity, 'tweaking') >= 100 && !this.buffSystem.hasDebuff(entity, 'paranoid')) {
        this.buffSystem.apply(entity, ParanoidDebuff);
      }
    }
    if (ability.id === 'gank') {
      const target = this.getTarget(entity.id);
      if (target && (target.dead || target.hp / target.maxHp < 0.30)) {
        this.combatSystem.clearCooldown(entity.id, 'gank');
        this.onSendToPlayer?.(entity.id, {
          type: 'cooldown_update',
          abilityId: 'gank',
          remaining: 0,
          total: 0,
        } as S2C_CooldownUpdate);
      }
    }
    if (ability.id === 'crack-rock') {
      this.combatSystem.applyHeal(entity, entity, 400);
      this.buffSystem.addStacks(entity, 'tweaking', 25);
      if (this.buffSystem.getStacks(entity, 'tweaking') >= 100 && !this.buffSystem.hasDebuff(entity, 'paranoid')) {
        this.buffSystem.apply(entity, ParanoidDebuff);
      }
    }
    if (ability.id === 'sticky-fingers') {
      const target = this.getTarget(entity.id);
      if (target) {
        const stealable = this.buffSystem.getBuffs(target).filter(b => !b.definition.unremovable);
        if (stealable.length > 0) {
          const stolen = stealable[Math.floor(Math.random() * stealable.length)];
          const remainingTime = stolen.remaining;
          this.buffSystem.remove(target, stolen.definition.id, true);
          this.buffSystem.apply(entity, stolen.definition);
          this.buffSystem.setRemaining(entity, stolen.definition.id, remainingTime);
        } else {
          const drain = Math.min(150, target.mana);
          target.mana -= drain;
          entity.mana = Math.min(entity.mana + 150, entity.maxMana);
          abilityEvent.manaStolen = 150;
        }
      }
    }
    if (ability.id === 'dumpster-dive') {
      this.buffSystem.addStacks(entity, 'tweaking', 15);
      if (this.buffSystem.getStacks(entity, 'tweaking') >= 100 && !this.buffSystem.hasDebuff(entity, 'paranoid')) {
        this.buffSystem.apply(entity, ParanoidDebuff);
      }
      // Save auto-attack target for re-engage on emerge
      const aaTarget = this.autoAttackSystem.getTarget(entity);
      if (aaTarget) this.dumpsterDiveAutoTargets.set(entity.id, aaTarget.id);
      // Stop auto-attack while in the dumpster
      this.stopAutoAttack(entity.id);
      // Force all enemies targeting this entity to lose their target
      for (const [eid, targetId] of this.targets) {
        if (targetId === entity.id) {
          const other = this.getEntity(eid);
          if (other && other.isHostileTo(entity)) {
            this.targets.set(eid, null);
            this.stopAutoAttack(eid);
            this.onSendToPlayer?.(eid, { type: 'force_clear_target' });
          }
        }
      }
    }
    if (ability.id === 'pvp-trinket') {
      this.buffSystem.removeAllCCEffects(entity, true);
    }
    if (ability.id === 'crotch-rot') {
      const target = this.getTarget(entity.id);
      if (target && !target.dead) {
        this.dotSystem.add({
          target, debuff: CrotchRotDot,
          totalDuration: 12, elapsed: 0,
          tickInterval: 3, nextTickAt: 3,
          damagePerTick: 180, owner: entity,
        });
      }
    }

    // Melee abilities automatically engage auto-attack on the target
    if (ServerEngine.MELEE_AUTO_ATTACK_ABILITIES.includes(ability.id)) {
      const target = this.getTarget(entity.id);
      if (target && target.isHostileTo(entity) && !target.dead) {
        this.requestAutoAttack(entity.id, target.id);
      }
    }
  }

  private triggerEntityGcd(entity: ServerEntity): void {
    if (entity.godMode) return;
    this.combatSystem.triggerGcd(entity.id, GLOBAL_COOLDOWN);
    this.onSendToPlayer?.(entity.id, {
      type: 'cooldown_update',
      abilityId: '__gcd__',
      remaining: GLOBAL_COOLDOWN,
      total: GLOBAL_COOLDOWN,
    } as S2C_CooldownUpdate);
  }

  private startSweepCharge(entity: ServerEntity): void {
    const savedAutoAttackTarget = this.autoAttackSystem.getTarget(entity);
    this.stopAutoAttack(entity.id);
    entity.charging = true;
    this.chargeSystem.startSweepCharge(
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
    const target = this.getTarget(entity.id);
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

    const savedAutoAttackTarget = this.autoAttackSystem.getTarget(entity);
    this.stopAutoAttack(entity.id);
    entity.charging = true;
    this.chargeSystem.startTweakerSprintCharge(
      entity, dirX, dirZ, speed, duration,
      TweakerSprint.chargeMaxDamage!, savedAutoAttackTarget,
    );
  }

  private executeKaboom(entity: ServerEntity): void {
    this.chargeSystem.executeKaboom(entity, entity.rotationY);
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

  // ── State broadcast ─────────────────────────────────────────────────

  private broadcastGameState(): void {
    // Capture timestamp once — used for both broadcast and position history
    // so the client's serverTimestamp matches our rewind buffer exactly.
    const serverTimestamp = Date.now();
    this.recordPositionHistory(serverTimestamp);

    const isKeyframe = this.tick % ServerEngine.KEYFRAME_INTERVAL === 0;

    if (isKeyframe) {
      this.broadcastKeyframe(serverTimestamp);
      // On keyframe ticks, flush events separately (keyframe msg type has no events field)
      for (const event of this.pendingEvents) {
        this.onBroadcast?.(event);
      }
    } else {
      // On delta ticks, bundle events into the update message to reduce WebSocket frames
      this.broadcastDelta(serverTimestamp);
    }
    this.pendingEvents = [];
  }

  /** Full keyframe — sent periodically and used by clients to reset state. */
  private broadcastKeyframe(serverTimestamp: number): void {
    const entities: EntitySnapshot[] = this.entities.map(e => {
      const snapshot = e.toSnapshot();
      const casting = this.castingSystem.getState(e);
      if (casting) {
        snapshot.castingAbilityId = casting.ability.id;
        snapshot.castingElapsed = casting.elapsed;
        snapshot.castingTotalTime = casting.totalTime;
        snapshot.castingIsChannel = casting.isChannel;
      }
      // While channeling, lock targetEntityId to the channel target so the
      // beam doesn't follow UI re-targets.
      snapshot.targetEntityId = (casting?.isChannel && casting.target)
        ? casting.target.id
        : (this.targets.get(e.id) ?? null);
      return snapshot;
    });

    const buffs = this.buildBuffSnapshots();
    const gasClouds = this.buildGasCloudSnapshots();
    const chemicalPools = this.buildChemPoolSnapshots();

    const msg: S2C_GameStateSnapshot = {
      type: 'game_state_snapshot',
      tick: this.tick,
      timestamp: serverTimestamp,
      entities,
      buffs,
      gasClouds,
      chemicalPools,
    };

    this.onBroadcast?.(msg);

    // Update last-broadcast tracking to match keyframe
    for (const e of entities) {
      this.lastBroadcastState.set(e.id, {
        hp: e.hp, maxHp: e.maxHp, mana: e.mana, maxMana: e.maxMana,
        dead: e.dead, inCombat: e.inCombat, stunned: e.stunned, charging: e.charging,
        isAutoAttacking: e.isAutoAttacking,
        castingAbilityId: e.castingAbilityId, castingElapsed: e.castingElapsed,
        castingTotalTime: e.castingTotalTime, castingIsChannel: e.castingIsChannel,
        targetEntityId: e.targetEntityId,
        disconnected: e.disconnected ?? false,
      });
    }
    for (const b of buffs) {
      this.lastBroadcastBuffs.set(b.entityId, b.buffs.map(buf => `${buf.id}:${buf.shieldRemaining ?? ''}`).join(','));
    }
    this.lastBroadcastGasCloudIds = gasClouds.map(gc => gc.id).join(',');
    this.lastBroadcastChemPoolSig = chemicalPools.map(cp => `${cp.id}:${cp.consumed}`).join(',');
  }

  /** Delta update — positions always, state/buffs only when changed. */
  private broadcastDelta(serverTimestamp: number): void {
    // Positions: only include entities whose position/rotation actually changed
    const positions: EntityPositionData[] = [];
    for (const e of this.entities) {
      const prev = this.lastBroadcastPosition.get(e.id);
      if (!prev
        || Math.abs(prev.x - e.x) > ServerEngine.POSITION_EPSILON
        || Math.abs(prev.y - e.y) > ServerEngine.POSITION_EPSILON
        || Math.abs(prev.z - e.z) > ServerEngine.POSITION_EPSILON
        || Math.abs(prev.rotationY - e.rotationY) > ServerEngine.ROTATION_EPSILON
        || prev.isMoving !== e.isMoving
      ) {
        positions.push({
          id: e.id, x: e.x, y: e.y, z: e.z,
          rotationY: e.rotationY, isMoving: e.isMoving,
          vx: e.vx, vz: e.vz,
          moveFlags: e.moveFlags, moveSpeed: e.moveSpeed, vy: e.vy, turnSpeed: e.turnSpeed,
        });
        this.lastBroadcastPosition.set(e.id, {
          x: e.x, y: e.y, z: e.z,
          rotationY: e.rotationY, isMoving: e.isMoving,
          vx: e.vx, vz: e.vz,
        });
      }
    }

    // State deltas: only entities whose combat/status state changed
    const states: EntityStateDelta[] = [];
    for (const e of this.entities) {
      const casting = this.castingSystem.getState(e);
      const castingAbilityId = casting?.ability.id ?? null;
      const castingElapsed = casting?.elapsed ?? 0;
      const castingTotalTime = casting?.totalTime ?? 0;
      const castingIsChannel = casting?.isChannel ?? false;
      // Lock to channel target while channeling (same as keyframe)
      const targetEntityId = (casting?.isChannel && casting?.target)
        ? casting.target.id
        : (this.targets.get(e.id) ?? null);

      const prev = this.lastBroadcastState.get(e.id);
      if (!prev) {
        // First time seeing this entity — send full state
        const delta: EntityStateDelta = {
          id: e.id,
          hp: e.hp, maxHp: e.maxHp, mana: e.mana, maxMana: e.maxMana,
          dead: e.dead, inCombat: e.inCombat, stunned: e.stunned, charging: e.charging,
          isAutoAttacking: e.isAutoAttacking,
          castingAbilityId, castingElapsed, castingTotalTime, castingIsChannel,
          targetEntityId,
          disconnected: e.disconnected,
        };
        states.push(delta);
        this.lastBroadcastState.set(e.id, {
          hp: e.hp, maxHp: e.maxHp, mana: e.mana, maxMana: e.maxMana,
          dead: e.dead, inCombat: e.inCombat, stunned: e.stunned, charging: e.charging,
          isAutoAttacking: e.isAutoAttacking,
          castingAbilityId, castingElapsed, castingTotalTime, castingIsChannel,
          targetEntityId,
          disconnected: e.disconnected,
        });
        continue;
      }

      // Build delta of only changed fields
      const delta: EntityStateDelta = { id: e.id };
      let hasChanges = false;

      if (prev.hp !== e.hp) { delta.hp = e.hp; prev.hp = e.hp; hasChanges = true; }
      if (prev.maxHp !== e.maxHp) { delta.maxHp = e.maxHp; prev.maxHp = e.maxHp; hasChanges = true; }
      if (prev.mana !== e.mana) { delta.mana = e.mana; prev.mana = e.mana; hasChanges = true; }
      if (prev.maxMana !== e.maxMana) { delta.maxMana = e.maxMana; prev.maxMana = e.maxMana; hasChanges = true; }
      if (prev.dead !== e.dead) { delta.dead = e.dead; prev.dead = e.dead; hasChanges = true; }
      if (prev.inCombat !== e.inCombat) { delta.inCombat = e.inCombat; prev.inCombat = e.inCombat; hasChanges = true; }
      if (prev.stunned !== e.stunned) { delta.stunned = e.stunned; prev.stunned = e.stunned; hasChanges = true; }
      if (prev.charging !== e.charging) { delta.charging = e.charging; prev.charging = e.charging; hasChanges = true; }
      if (prev.isAutoAttacking !== e.isAutoAttacking) { delta.isAutoAttacking = e.isAutoAttacking; prev.isAutoAttacking = e.isAutoAttacking; hasChanges = true; }
      if (prev.castingAbilityId !== castingAbilityId) { delta.castingAbilityId = castingAbilityId; prev.castingAbilityId = castingAbilityId; hasChanges = true; }
      // Only send castingElapsed on significant events (cast start, pushback, interrupt),
      // not every tick. Clients advance it locally at 60fps for smooth animation.
      // Detect significant change: abilityId changed OR totalTime changed (pushback) OR elapsed reset
      const castingEvent = prev.castingAbilityId !== castingAbilityId
        || prev.castingTotalTime !== castingTotalTime
        || (castingElapsed < prev.castingElapsed && castingAbilityId !== null);
      if (castingEvent && prev.castingElapsed !== castingElapsed) { delta.castingElapsed = castingElapsed; hasChanges = true; }
      prev.castingElapsed = castingElapsed;
      if (prev.castingTotalTime !== castingTotalTime) { delta.castingTotalTime = castingTotalTime; prev.castingTotalTime = castingTotalTime; hasChanges = true; }
      if (prev.castingIsChannel !== castingIsChannel) { delta.castingIsChannel = castingIsChannel; prev.castingIsChannel = castingIsChannel; hasChanges = true; }
      if (prev.targetEntityId !== targetEntityId) { delta.targetEntityId = targetEntityId; prev.targetEntityId = targetEntityId; hasChanges = true; }
      if (prev.disconnected !== e.disconnected) { delta.disconnected = e.disconnected; prev.disconnected = e.disconnected; hasChanges = true; }

      if (hasChanges) states.push(delta);
    }

    // Buffs: only include entities whose buff list changed in a meaningful way.
    // Use a lightweight signature (buff ids + shield values + remaining rounded up)
    // instead of JSON.stringify. Remaining is rounded to avoid sending every tick,
    // but still detects duration refreshes (e.g. 0.3s → 8s).
    const allBuffs = this.buildBuffSnapshots();
    const changedBuffs: EntityBuffSnapshot[] = [];
    for (const b of allBuffs) {
      const drSig = b.drTimers ? b.drTimers.map(dr => `dr:${dr.category}:${dr.count}:${Math.ceil(dr.remaining)}`).join(',') : '';
      const sig = b.buffs.map(buf => `${buf.id}:${buf.shieldRemaining ?? ''}:${Math.ceil(buf.remaining)}`).join(',') + '|' + drSig;
      const prevSig = this.lastBroadcastBuffs.get(b.entityId);
      if (sig !== prevSig) {
        changedBuffs.push(b);
        this.lastBroadcastBuffs.set(b.entityId, sig);
      }
    }

    // World effects: only include when the set of active effects actually changed
    // (spawn/despawn/consumed state change), not every tick while they exist
    const gasClouds = this.buildGasCloudSnapshots();
    const chemPools = this.buildChemPoolSnapshots();
    const gasIdSig = gasClouds.map(gc => gc.id).join(',');
    const chemSig = chemPools.map(cp => `${cp.id}:${cp.consumed}`).join(',');
    const gasChanged = gasIdSig !== this.lastBroadcastGasCloudIds;
    const chemChanged = chemSig !== this.lastBroadcastChemPoolSig;
    if (gasChanged) this.lastBroadcastGasCloudIds = gasIdSig;
    if (chemChanged) this.lastBroadcastChemPoolSig = chemSig;

    // Always send at least a heartbeat so clients keep their interpolation
    // buffer calibrated — skipping ticks causes jitter spikes in the adaptive delay.
    const hasPositions = positions.length > 0;
    const hasStates = states.length > 0;
    const hasBuffs = changedBuffs.length > 0;
    const hasEvents = this.pendingEvents.length > 0;

    // ── Unreliable channel: positions only ──
    // Sent via WebRTC DataChannel to bypass TCP head-of-line blocking.
    // If unreliable callback isn't wired, positions are included in the reliable msg below.
    const hasUnreliable = !!this.onBroadcastUnreliable;
    if (hasUnreliable) {
      const posMsg: S2C_PositionUpdate = {
        type: 'position_update',
        tick: this.tick,
        timestamp: serverTimestamp,
        positions,
      };
      this.onBroadcastUnreliable!(posMsg);
    }

    // ── Reliable channel: state deltas, buffs, events ──
    // Positions are always included for clients without a DataChannel (fallback)
    // and for the snapshot buffer's tick/timestamp calibration. Clients with a DC
    // get positions twice — unreliable arrives first, reliable is a harmless no-op.
    const msg: S2C_GameStateUpdate = {
      type: 'game_state_update',
      tick: this.tick,
      timestamp: serverTimestamp,
      positions,
    };

    if (hasStates) msg.states = states;
    if (hasBuffs) msg.buffs = changedBuffs;
    if (gasChanged) msg.gasClouds = gasClouds;
    if (chemChanged) msg.chemicalPools = chemPools;
    if (hasEvents) msg.events = this.pendingEvents as S2C_GameStateUpdate['events'];

    this.onBroadcast?.(msg);
  }

  private buildBuffSnapshots(): EntityBuffSnapshot[] {
    return this.entities.map(e => {
      const drTimers = this.buffSystem.getDRTimers(e);
      return {
        entityId: e.id,
        buffs: this.buffSystem.getAllBuffs(e).map(b => ({
          id: b.definition.id,
          name: b.definition.name,
          icon: b.definition.icon,
          type: b.definition.type,
          remaining: b.remaining,
          duration: b.definition.duration,
          description: getBuffDescription(b.definition, b.stacks),
          shieldRemaining: b.shieldRemaining,
          effects: b.definition.effects.length > 0 ? b.definition.effects : undefined,
          unremovable: b.definition.unremovable || undefined,
          stacks: b.stacks,
          maxStacks: b.definition.maxStacks,
        })),
        drTimers: drTimers.length > 0 ? drTimers : undefined,
      };
    });
  }

  private buildGasCloudSnapshots(): GasCloudSnapshot[] {
    return this.gasCloudSystem.clouds.map(gc => ({
      id: gc.id,
      x: gc.centerX, y: gc.centerY, z: gc.centerZ,
      radius: gc.radius, elapsed: gc.elapsed, duration: gc.duration,
    }));
  }

  private buildChemPoolSnapshots(): ChemicalPoolSnapshot[] {
    return this.chemPoolSystem.pools.map(cp => ({
      id: cp.id,
      x: cp.centerX, y: cp.centerY, z: cp.centerZ,
      radius: cp.radius, elapsed: cp.elapsed, duration: cp.duration,
      activationDelay: cp.activationDelay, consumed: cp.consumed,
    }));
  }

  /** Returns full current state for a rejoining player. */
  getFullState(): { buffs: EntityBuffSnapshot[]; gasClouds: GasCloudSnapshot[]; chemicalPools: ChemicalPoolSnapshot[]; cooldowns: CooldownSnapshot[] } {
    return {
      buffs: this.buildBuffSnapshots(),
      gasClouds: this.buildGasCloudSnapshots(),
      chemicalPools: this.buildChemPoolSnapshots(),
      cooldowns: this.combatSystem.getAllCooldowns(),
    };
  }

  // ── Elevator (Celestial Ballroom) ───────────────────────────────────

  /** Compute the current elevator Y position from game elapsed time. */
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
