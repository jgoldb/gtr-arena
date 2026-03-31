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
import { GLOBAL_COOLDOWN, yardsToUnits, BULLET_SPEED, isRangedAutoAttack, FartBombDebuff, ChemicalSpillSpeedBuff, ChemicalSpillDot, CrotchRotDot, RottenCrotchStun, KaboomStun, ArenaPreparationBuff, RestingBuff, ParanoidDebuff, ODStunDebuff, RecentlyBandagedDebuff, Sweep, TweakerSprint, TweakerSprintSlow, getBuffDescription, getCharacterStats } from '@gtr/shared';
import { ServerEntity } from './ServerEntity.js';
import { ServerCombatSystem } from './ServerCombatSystem.js';
import { ServerBuffSystem } from './ServerBuffSystem.js';
import { ServerRegenSystem } from './ServerRegenSystem.js';
import { CollisionSystem, type BoxCollider } from './ServerMapManager.js';


interface CastingState {
  ability: Ability;
  target: ServerEntity | null;
  elapsed: number;
  totalTime: number;
  originalCastTime: number;
  isChannel: boolean;
  tickInterval: number;
  ticksDelivered: number;
  damageMultiplier: number;
}

interface AutoAttackState {
  target: ServerEntity;
  timer: number;
  rangedResumeDelay: number; // GCD-length delay before first/resumed ranged shot
  wasMoving: boolean; // tracks movement→stop transition for ranged delay
}

interface PendingAutoAttackProjectile {
  attacker: ServerEntity;
  target: ServerEntity;
  damage: number;
  remainingTime: number;
}

interface SweepCharge {
  elapsed: number;
  duration: number;
  dirX: number;
  dirZ: number;
  speed: number;
  hitTargets: Set<ServerEntity>;
  maxDamage: number;
  savedAutoAttackTarget: ServerEntity | null;
}

interface TweakerSprintCharge {
  elapsed: number;
  duration: number;
  dirX: number;
  dirZ: number;
  speed: number;
  hitTargets: Set<ServerEntity>;
  damage: number;
  savedAutoAttackTarget: ServerEntity | null;
}

interface ActiveGasCloud {
  id: string;
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  duration: number;
  elapsed: number;
  debuff: BuffDefinition;
  damagePerTick: number;
  tickInterval: number;
  nextTickAt: number;
  owner: ServerEntity;
  affectedTargets: Set<ServerEntity>;
}

interface ActiveChemicalPool {
  id: string;
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  duration: number;
  elapsed: number;
  speedBuff: BuffDefinition;
  dot: BuffDefinition;
  initialDamageMin: number;
  initialDamageMax: number;
  dotDamagePerTick: number;
  dotTickInterval: number;
  dotDuration: number;
  owner: ServerEntity;
  activationDelay: number;
  consumed: boolean;
}

interface ActiveDot {
  target: ServerEntity;
  debuff: BuffDefinition;
  totalDuration: number;
  elapsed: number;
  tickInterval: number;
  nextTickAt: number;
  damagePerTick: number;
  owner: ServerEntity;
}

interface FullRetardAura {
  entity: ServerEntity;
  elapsed: number;
  nextTickAt: number;
}

interface PendingAoeImpact {
  ability: Ability;
  groundX: number;
  groundY: number;
  groundZ: number;
  delay: number;
  elapsed: number;
  owner: ServerEntity;
}

interface ActiveKnockback {
  target: ServerEntity;
  dirX: number;
  dirZ: number;
  distance: number;
  duration: number;
  elapsed: number;
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
  private castingStates = new Map<string, CastingState>();
  private autoAttacks = new Map<string, AutoAttackState>();
  private swingTimers = new Map<string, number>(); // entityId -> time since last swing (persists across toggle)
  private pendingAutoAttackProjectiles: PendingAutoAttackProjectile[] = [];
  private sweepCharges = new Map<string, SweepCharge>();
  private tweakerSprintCharges = new Map<string, TweakerSprintCharge>();
  private fullRetardAuras = new Map<string, FullRetardAura>();

  // World state
  private gasClouds: ActiveGasCloud[] = [];
  private chemicalPools: ActiveChemicalPool[] = [];
  private activeDots: ActiveDot[] = [];
  private pendingAoeImpacts: PendingAoeImpact[] = [];
  private activeKnockbacks: ActiveKnockback[] = [];
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
  private static readonly CAST_PUSHBACK = 0.5;
  private static readonly INTERRUPT_COOLDOWN = 1;
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

  // Celestial Ballroom elevator
  private elevatorCollider: BoxCollider | null = null;
  private static readonly ELEVATOR_CX = 1;
  private static readonly ELEVATOR_CZ = -1;
  private static readonly ELEVATOR_HALF_W = 4;
  private static readonly ELEVATOR_HALF_D = 4;
  private static readonly ELEVATOR_HALF_H = 0.2;
  private static readonly ELEVATOR_FLOORS = [0.2, 13.5, 40];
  private static readonly ELEVATOR_STOPS  = [0, 1, 2, 1];
  private static readonly ELEVATOR_IDLE   = 8;
  private static readonly ELEVATOR_TRAVEL = 3;
  private static readonly ELEVATOR_PHASE  = 8 + 3; // IDLE + TRAVEL
  private static readonly ELEVATOR_CYCLE  = 4 * (8 + 3); // STOPS.length * PHASE

  constructor(obstacles: import('@gtr/shared').ObstacleConfig[], mapId: string = '') {
    this.mapId = mapId;
    this.collision = new CollisionSystem();
    this.collision.buildFromObstacles(obstacles);

    // Create elevator collider for Celestial Ballroom
    if (mapId === 'celestial-ballroom') {
      this.elevatorCollider = {
        type: 'box',
        cx: ServerEngine.ELEVATOR_CX,
        cz: ServerEngine.ELEVATOR_CZ,
        halfW: ServerEngine.ELEVATOR_HALF_W,
        halfD: ServerEngine.ELEVATOR_HALF_D,
        cosY: 1,
        sinY: 0,
        centerY: 0.2,
        halfH: ServerEngine.ELEVATOR_HALF_H,
        rotZ: 0,
      };
      this.collision.addCollider(this.elevatorCollider);
    }

    this.buffSystem = new ServerBuffSystem();
    this.regenSystem = new ServerRegenSystem(() => this.entities);
    this.regenSystem.setBuffSystem(this.buffSystem);
    this.combatSystem = new ServerCombatSystem(this.regenSystem, this.buffSystem, this.collision);

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
      const casting = this.castingStates.get(target.id);
      if (casting) {
        if (casting.isChannel) {
          casting.totalTime = Math.max(0, casting.totalTime - ServerEngine.CAST_PUSHBACK);
        } else {
          const maxTime = casting.originalCastTime * 2;
          casting.totalTime = Math.min(casting.totalTime + ServerEngine.CAST_PUSHBACK, maxTime);
        }
      }
    };

    this.combatSystem.onEntityKilled = (killer, victim) => {
      this.recordKill(killer.id, victim.id);
    };

    this.combatSystem.onSleepApplied = (attacker, target) => {
      const aa = this.autoAttacks.get(attacker.id);
      if (aa && aa.target === target) {
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
      this.buffSystem.remove(entity, ArenaPreparationBuff.id);
    }
  }

  cancelBuff(entityId: string, buffId: string): void {
    const entity = this.getEntity(entityId);
    if (!entity || this.frozenEntities.has(entityId)) return;
    const buffs = this.buffSystem.getBuffs(entity);
    const buff = buffs.find(b => b.definition.id === buffId);
    if (buff && buff.definition.type === 'buff' && !buff.definition.unremovable) {
      this.buffSystem.remove(entity, buffId);
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
    this.cancelCasting(entityId);
    this.stopAutoAttack(entityId);
    this.cancelResting(entityId);
    this.targets.set(entityId, null);
    if (entity.charging) {
      entity.charging = false;
      this.sweepCharges.delete(entityId);
      this.tweakerSprintCharges.delete(entityId);
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
      this.snapEntityToElevator(entityId);
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
    this.frozenEntities.delete(entityId);
    this.castingStates.delete(entityId);
    this.autoAttacks.delete(entityId);
    this.swingTimers.delete(entityId);
    this.sweepCharges.delete(entityId);
    this.tweakerSprintCharges.delete(entityId);
    this.fullRetardAuras.delete(entityId);
    this.dumpsterDiveAutoTargets.delete(entityId);
    this.targets.delete(entityId);
    this.lastBroadcastPosition.delete(entityId);
    this.lastBroadcastState.delete(entityId);
    this.lastBroadcastBuffs.delete(entityId);

    // Clear other entities' targets/auto-attacks pointing at this entity
    for (const [eid, targetId] of this.targets) {
      if (targetId === entityId) this.targets.set(eid, null);
    }
    for (const [eid, state] of this.autoAttacks) {
      if (state.target.id === entityId) this.autoAttacks.delete(eid);
    }

    // Remove dots involving this entity
    this.activeDots = this.activeDots.filter(d => d.target.id !== entityId && d.owner.id !== entityId);

    // Remove buffs
    const entity = this.entities[idx];
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
    if (this.sweepCharges.has(entityId) || this.tweakerSprintCharges.has(entityId)) return;

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
    const aa = this.autoAttacks.get(entityId);
    if (aa && (!targetEntityId || aa.target.id !== targetEntityId)) {
      this.stopAutoAttack(entityId);
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

    const existing = this.autoAttacks.get(entityId);
    if (existing && existing.target === target) return;

    // Use persistent swing timer so toggling can't bypass the cooldown
    const timeSinceLastSwing = this.swingTimers.get(entityId) ?? Infinity;
    const stats = getCharacterStats(entity.characterId);
    const rangedDelay = isRangedAutoAttack(stats) ? GLOBAL_COOLDOWN : 0;
    this.autoAttacks.set(entityId, {
      target,
      timer: Math.min(timeSinceLastSwing, entity.autoAttackSpeed),
      rangedResumeDelay: rangedDelay,
      wasMoving: entity.isMoving,
    });
    entity.isAutoAttacking = true;
  }

  stopAutoAttack(entityId: string): void {
    // Save the current timer before deleting state
    const state = this.autoAttacks.get(entityId);
    if (state) {
      this.swingTimers.set(entityId, state.timer);
    }
    this.autoAttacks.delete(entityId);
    const entity = this.getEntity(entityId);
    if (entity) entity.isAutoAttacking = false;
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
    if (this.castingStates.has(entityId) && this.combatSystem.getCooldownRemaining(entityId, abilityId) <= 0) {
      this.cancelCasting(entityId);
    }

    // Ground-targeted AoE abilities — no rewind (by design: lead your targets)
    if (ability.groundTargeted && groundTarget) {
      const result = this.useGroundTargetAbility(entity, ability, groundTarget.x, groundTarget.z);
      if (result.success) {
        this.onAbilitySuccess(entity, ability, groundTarget);
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
      this.startCasting(entity, ability, target, targetPosOverride);
    } else {
      const result = this.combatSystem.useAbility(ability, entity, target, targetPosOverride);
      if (result.success) {
        this.onAbilitySuccess(entity, ability);
        if (!ability.usableWhileCCd) this.triggerEntityGcd(entity);
      } else if (result.errorMessage) {
        this.onSendToPlayer?.(entityId, { type: 'error', message: result.errorMessage });
      }
    }
  }

  cancelCastRequest(entityId: string): void {
    if (this.frozenEntities.has(entityId)) return;
    this.cancelCasting(entityId);
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
      if (this.combatSystem.getGcdRemaining(entityId) <= 0 && !this.castingStates.has(entityId)) {
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
      if (this.castingStates.has(entityId)) return;
      this.stopAutoAttack(entityId);
      this.buffSystem.apply(entity, RestingBuff);
    } else {
      this.buffSystem.remove(entity, RestingBuff.id);
    }
  }

  private cancelResting(entityId: string): void {
    const entity = this.getEntity(entityId);
    if (!entity) return;
    if (this.buffSystem.hasBuff(entity, RestingBuff.id)) {
      this.buffSystem.remove(entity, RestingBuff.id);
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
    this.updateElevator();

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
        if (this.sweepCharges.has(entity.id)) {
          entity.charging = false;
          this.sweepCharges.delete(entity.id);
        }
        if (this.tweakerSprintCharges.has(entity.id)) {
          entity.charging = false;
          this.tweakerSprintCharges.delete(entity.id);
        }
      }


      // Cancel resting if entity entered combat
      if (entity.inCombat) {
        this.cancelResting(entity.id);
      }
    }

    // Update casting/channeling
    for (const entity of this.entities) {
      this.updateCasting(entity, dt);
    }

    // Update sweep charges
    for (const entity of this.entities) {
      this.updateSweepCharge(entity, dt);
    }

    // Update tweaker sprint charges
    for (const entity of this.entities) {
      this.updateTweakerSprintCharge(entity, dt);
    }

    // Tick persistent swing timers (even for entities not currently auto-attacking)
    for (const [id, t] of this.swingTimers) {
      this.swingTimers.set(id, t + dt);
    }

    // Update auto-attacks
    for (const entity of this.entities) {
      this.updateAutoAttack(entity, dt);
    }
    this.updatePendingAutoAttackProjectiles(dt);

    // Update area effects
    this.updateGasClouds(dt);
    this.updateChemicalPools(dt);
    this.updateActiveDots(dt);
    this.updatePendingAoeImpacts(dt);
    this.updateKnockbacks(dt);
    this.updateFullRetardAuras(dt);

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

  private startCasting(entity: ServerEntity, ability: Ability, target: ServerEntity | null,
                       targetPosOverride?: { x: number; z: number; rotationY: number }): void {
    if (this.castingStates.has(entity.id)) {
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

    // Trigger GCD at cast/channel start
    this.triggerEntityGcd(entity);

    const isChannel = ability.isChannel ?? false;

    if (isChannel) {
      if (!entity.godMode) {
        const effectiveCost = Math.round(ability.manaCost * this.buffSystem.getManaCostMultiplier(entity));
        entity.mana -= effectiveCost;
        if (effectiveCost > 0) this.regenSystem.notifyManaUsed(entity);
        this.combatSystem.setCooldown(entity.id, ability.id, ability.cooldown);
        if (ability.cooldown > 0) {
          this.onSendToPlayer?.(entity.id, {
            type: 'cooldown_update',
            abilityId: ability.id,
            remaining: ability.cooldown,
            total: ability.cooldown,
          } as S2C_CooldownUpdate);
        }
      }

      if (target && target.isHostileTo(entity)) {
        this.combatSystem.enterCombat(entity);
        this.combatSystem.enterCombat(target);
        if (this.combatSystem.rollMiss()) {
          this.emitEvent({
            type: 'combat_event',
            sourceEntityId: entity.id,
            targetEntityId: target.id,
            amount: 0,
            combatType: 'miss',
          } as S2C_CombatEvent);
          return;
        }
        // Hostile channel start — notify for auto-targeting
        this.emitEvent({
          type: 'combat_event',
          sourceEntityId: entity.id,
          targetEntityId: target.id,
          amount: 0,
          combatType: 'damage',
        } as S2C_CombatEvent);
      }
    }

    if (!isChannel && !entity.godMode) {
      this.combatSystem.setCooldown(entity.id, ability.id, ServerEngine.INTERRUPT_COOLDOWN);
      this.onSendToPlayer?.(entity.id, {
        type: 'cooldown_update',
        abilityId: ability.id,
        remaining: ServerEngine.INTERRUPT_COOLDOWN,
        total: ServerEngine.INTERRUPT_COOLDOWN,
      } as S2C_CooldownUpdate);
    }

    this.castingStates.set(entity.id, {
      ability,
      target,
      elapsed: 0,
      totalTime: ability.castTime!,
      originalCastTime: ability.castTime!,
      isChannel,
      tickInterval: isChannel ? ability.castTime! / ability.channelTicks! : 0,
      ticksDelivered: 0,
      damageMultiplier: isChannel ? this.buffSystem.getDamageDealtMultiplier(entity) : 1,
    });

    // Apply blockedByTargetDebuff at channel start (e.g. Recently Bandaged)
    if (isChannel && target && ability.id === 'bandage') {
      this.buffSystem.apply(target, RecentlyBandagedDebuff);
    }

    if (isChannel && target) {
      const isFriendly = !target.isHostileTo(entity);
      this.buffSystem.apply(target, {
        id: `channel-${ability.id}`,
        name: ability.name,
        icon: ability.icon,
        duration: ability.castTime!, // remaining managed manually in tick loop
        type: isFriendly ? 'buff' : 'debuff',
        description: ability.description,
        effects: [],
        unremovable: true,
      });
    }
  }

  private cancelCasting(entityId: string): void {
    const casting = this.castingStates.get(entityId);
    if (!casting) return;
    if (casting.isChannel && casting.target) {
      this.buffSystem.remove(casting.target, `channel-${casting.ability.id}`);
    }
    this.castingStates.delete(entityId);
  }

  private updateCasting(entity: ServerEntity, dt: number): void {
    const casting = this.castingStates.get(entity.id);
    if (!casting) return;

    casting.elapsed += dt;

    // Cancel if dead, stunned, moving, or falling
    if (entity.dead || entity.stunned || entity.isMoving || !entity.grounded) {
      this.cancelCasting(entity.id);
      return;
    }

    // Validate target mid-cast
    if (casting.ability.requiresHostileTarget || casting.ability.requiresTarget) {
      const ct = casting.target;
      if (!ct || ct.dead) {
        this.cancelCasting(entity.id);
        return;
      }
      if (casting.isChannel && casting.ability.range) {
        const dx = entity.x - ct.x;
        const dz = entity.z - ct.z;
        if (Math.sqrt(dx * dx + dz * dz) > casting.ability.range + ServerEngine.RANGE_TOLERANCE) {
          this.cancelCasting(entity.id);
          return;
        }
      }
    }

    // Channel tick delivery
    if (casting.isChannel) {
      const totalTicks = casting.ability.channelTicks!;
      while (
        casting.ticksDelivered < totalTicks &&
        casting.elapsed >= (casting.ticksDelivered + 1) * casting.tickInterval
      ) {
        const tickTime = (casting.ticksDelivered + 1) * casting.tickInterval;
        if (tickTime <= casting.totalTime && casting.target && !casting.target.dead) {
          this.deliverChannelTick(entity, casting);
        }
        casting.ticksDelivered++;
      }

      // Update channel aura remaining
      if (casting.target) {
        const remaining = Math.max(0, casting.totalTime - casting.elapsed);
        this.buffSystem.setRemaining(casting.target, `channel-${casting.ability.id}`, remaining);
      }

      if (casting.elapsed >= casting.totalTime) {
        if (casting.target) {
          this.buffSystem.remove(casting.target, `channel-${casting.ability.id}`);
        }
        this.castingStates.delete(entity.id);
      }
      return;
    }

    // Regular cast completion
    if (casting.elapsed >= casting.totalTime) {
      const { ability, target } = casting;
      this.castingStates.delete(entity.id);

      this.combatSystem.clearCooldown(entity.id, ability.id);
      const result = this.combatSystem.useAbility(ability, entity, target);
      if (result.success) {
        this.onAbilitySuccess(entity, ability);
      } else if (result.errorMessage) {
        this.onSendToPlayer?.(entity.id, { type: 'error', message: result.errorMessage });
      }
    }
  }

  private deliverChannelTick(entity: ServerEntity, casting: CastingState): void {
    if (!casting.target || casting.target.dead) return;
    const { ability, target } = casting;
    const isFriendly = !target.isHostileTo(entity);

    if (isFriendly && ability.healAmount) {
      const healPerTick = Math.round(ability.healAmount / ability.channelTicks! * casting.damageMultiplier);
      this.combatSystem.applyHeal(entity, target, healPerTick);
      if (target.inCombat) {
        this.combatSystem.enterCombat(entity);
      }
    } else if (!isFriendly && ability.damage > 0) {
      const damagePerTick = Math.round(ability.damage / ability.channelTicks!);
      this.combatSystem.applyChannelTickDamage(entity, target, damagePerTick, casting.damageMultiplier);
    }
  }

  // ── Auto-attack ──────────────────────────────────────────────────────

  private updateAutoAttack(entity: ServerEntity, dt: number): void {
    const state = this.autoAttacks.get(entity.id);
    if (!state) return;

    if (entity.dead || state.target.dead || !state.target.isHostileTo(entity)
      || this.buffSystem.isUntargetable(state.target) || this.buffSystem.isUntargetable(entity)) {
      this.stopAutoAttack(entity.id);
      return;
    }

    // Always tick swing timer (ranged movement check is at fire time)
    state.timer += dt;
    // Keep persistent swing timer in sync while auto-attacking
    this.swingTimers.set(entity.id, state.timer);

    // Ranged: detect movement→stop transition and add GCD delay
    const stats = getCharacterStats(entity.characterId);
    const isRanged = isRangedAutoAttack(stats);
    if (isRanged && state.wasMoving && !entity.isMoving) {
      state.rangedResumeDelay = GLOBAL_COOLDOWN;
    }
    state.wasMoving = entity.isMoving;
    if (state.rangedResumeDelay > 0) {
      state.rangedResumeDelay = Math.max(0, state.rangedResumeDelay - dt);
    }

    const atkSpeedMult = this.buffSystem.getAutoAttackSpeedMultiplier(entity) * (entity.godMode ? 6 : 1);
    if (state.timer >= entity.autoAttackSpeed / atkSpeedMult) {
      // Ranged auto-attacks can't fire while moving, and have a GCD delay on start/resume
      if (isRanged && (entity.isMoving || state.rangedResumeDelay > 0)) return;

      // Don't swing while casting — timer stays ready so swing resumes quickly after cast
      if (this.castingStates.has(entity.id)) return;

      const dx = entity.x - state.target.x;
      const dy = entity.y - state.target.y;
      const dz = entity.z - state.target.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > entity.autoAttackRange + ServerEngine.RANGE_TOLERANCE) {
        state.timer = entity.autoAttackSpeed;
        this.swingTimers.set(entity.id, state.timer);
        return;
      }
      if (!this.combatSystem.hasLineOfSight(entity.x, entity.z, state.target.x, state.target.z, entity.y, state.target.y)) {
        state.timer = entity.autoAttackSpeed;
        this.swingTimers.set(entity.id, state.timer);
        this.onSendToPlayer?.(entity.id, { type: 'error', message: 'Not in line of sight' });
        return;
      }
      // Facing check
      const toX = state.target.x - entity.x;
      const toZ = state.target.z - entity.z;
      const len = Math.sqrt(toX * toX + toZ * toZ);
      if (len > 0.001) {
        const fwdX = Math.sin(entity.rotationY);
        const fwdZ = Math.cos(entity.rotationY);
        if (fwdX * (toX / len) + fwdZ * (toZ / len) <= 0.5) {
          state.timer = 0;
          this.swingTimers.set(entity.id, 0);
          this.onSendToPlayer?.(entity.id, { type: 'error', message: 'Not facing target' });
          return;
        }
      }

      state.timer = 0;
      this.swingTimers.set(entity.id, 0);

      let isCrit = false;
      if (isRangedAutoAttack(stats)) {
        // Ranged: delay damage by bullet travel time
        const travelTime = dist / BULLET_SPEED;
        this.pendingAutoAttackProjectiles.push({
          attacker: entity,
          target: state.target,
          damage: entity.rollAutoAttackDamage(),
          remainingTime: travelTime,
        });
      } else {
        // Melee: resolve damage first so we know if it crit
        isCrit = this.combatSystem.applyAutoAttackDamage(entity, state.target, entity.rollAutoAttackDamage());
      }

      // Notify clients to play swing animation
      this.emitEvent({
        type: 'auto_attack_swing',
        entityId: entity.id,
        targetEntityId: state.target.id,
        ...(isCrit && { isCrit: true }),
      });
    }
  }

  private updatePendingAutoAttackProjectiles(dt: number): void {
    for (let i = this.pendingAutoAttackProjectiles.length - 1; i >= 0; i--) {
      const p = this.pendingAutoAttackProjectiles[i];
      p.remainingTime -= dt;
      if (p.remainingTime <= 0) {
        this.pendingAutoAttackProjectiles.splice(i, 1);
        // Apply damage on impact (skip if target died or became untargetable mid-flight)
        if (!p.target.dead && !this.buffSystem.isUntargetable(p.target)) {
          this.combatSystem.applyAutoAttackDamage(p.attacker, p.target, p.damage, false);
        }
      }
    }
  }

  // ── Sweep charge ────────────────────────────────────────────────────

  private updateSweepCharge(entity: ServerEntity, dt: number): void {
    const charge = this.sweepCharges.get(entity.id);
    if (!charge) return;

    charge.elapsed += dt;

    // Sub-step movement to prevent tunneling through thin walls at high speed
    const totalDx = charge.dirX * charge.speed * dt;
    const totalDz = charge.dirZ * charge.speed * dt;
    const totalDist = Math.sqrt(totalDx * totalDx + totalDz * totalDz);
    const maxStep = 0.25; // Must be less than thinnest wall halfWidth + collision radius
    const numSteps = Math.max(1, Math.ceil(totalDist / maxStep));
    const stepDx = totalDx / numSteps;
    const stepDz = totalDz / numSteps;
    for (let i = 0; i < numSteps; i++) {
      entity.x += stepDx;
      entity.z += stepDz;
      const resolved = this.collision.resolve(entity.x, entity.z, entity.y, 0.4);
      entity.x = resolved.x;
      entity.z = resolved.z;
    }

    // Hit detection
    const hitRadius = 1.0;
    for (const other of this.entities) {
      if (other.dead || charge.hitTargets.has(other) || !other.isHostileTo(entity) || this.buffSystem.isUntargetable(other)) continue;
      const dx = entity.x - other.x;
      const dz = entity.z - other.z;
      if (Math.sqrt(dx * dx + dz * dz) <= hitRadius) {
        charge.hitTargets.add(other);
        const damagePercent = Math.min(1, charge.elapsed / charge.duration);
        const baseDamage = Math.round(charge.maxDamage * damagePercent);
        if (baseDamage > 0) {
          this.combatSystem.applySweepDamage(entity, other, baseDamage);
        }
      }
    }

    if (charge.elapsed >= charge.duration) {
      // AoE burst at end
      for (const other of this.entities) {
        if (other.dead || !other.isHostileTo(entity) || this.buffSystem.isUntargetable(other)) continue;
        const dx = entity.x - other.x;
        const dz = entity.z - other.z;
        if (Math.sqrt(dx * dx + dz * dz) <= entity.autoAttackRange) {
          this.combatSystem.applySweepDamage(entity, other, charge.maxDamage);
        }
      }

      // Broadcast sweep finish animation event
      this.emitEvent({
        type: 'ability_effect',
        entityId: entity.id,
        abilityId: 'sweep-finish',
      } as S2C_AbilityEffect);

      // Re-engage auto-attack if we were auto-attacking before sweep
      const savedTarget = charge.savedAutoAttackTarget;
      if (savedTarget && !savedTarget.dead && savedTarget.isHostileTo(entity)) {
        this.requestAutoAttack(entity.id, savedTarget.id);
      }

      entity.charging = false;
      entity.lastPositionUpdateTime = 0; // skip validation on next client position update
      this.sweepCharges.delete(entity.id);
    }
  }

  // ── Ability success effects ─────────────────────────────────────────

  private static readonly MELEE_AUTO_ATTACK_ABILITIES = ['mop', 'big-boot', 'jimmy-legs', 'shank', 'gank'];

  private onAbilitySuccess(entity: ServerEntity, ability: Ability, groundTarget?: { x: number; y: number; z: number }): void {
    const abilityEvent: S2C_AbilityEffect = {
      type: 'ability_effect',
      entityId: entity.id,
      abilityId: ability.id,
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
      this.spawnGasCloud(entity, yardsToUnits(5), 8, FartBombDebuff, 592, 2);
    }
    if (ability.id === 'sweep') {
      this.startSweepCharge(entity);
    }
    if (ability.id === 'chemical-spill') {
      this.spawnChemicalPool(entity, yardsToUnits(3), 30, ChemicalSpillSpeedBuff, ChemicalSpillDot, 297, 349, 600, 2, 6, 2);
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
          this.buffSystem.remove(target, stolen.definition.id);
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
      const aa = this.autoAttacks.get(entity.id);
      if (aa) this.dumpsterDiveAutoTargets.set(entity.id, aa.target.id);
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
      this.buffSystem.removeAllCCEffects(entity);
    }
    if (ability.id === 'crotch-rot') {
      const target = this.getTarget(entity.id);
      if (target && !target.dead) {
        this.activeDots.push({
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
    const savedAutoAttackTarget = this.autoAttacks.get(entity.id)?.target ?? null;
    this.stopAutoAttack(entity.id);
    entity.charging = true;
    this.sweepCharges.set(entity.id, {
      elapsed: 0,
      duration: Sweep.chargeDuration!,
      dirX: Math.sin(entity.rotationY),
      dirZ: Math.cos(entity.rotationY),
      speed: Sweep.chargeSpeed!,
      hitTargets: new Set(),
      maxDamage: Sweep.chargeMaxDamage!,
      savedAutoAttackTarget,
    });
  }

  // ── Tweaker Sprint charge ───────────────────────────────────────────

  private startTweakerSprintCharge(entity: ServerEntity): void {
    const target = this.getTarget(entity.id);
    if (!target) return;

    const dx = target.x - entity.x;
    const dz = target.z - entity.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01) return;

    const dirX = dx / dist;
    const dirZ = dz / dist;
    // Face the target
    entity.rotationY = Math.atan2(dirX, dirZ);

    const speed = TweakerSprint.chargeSpeed!;
    const chargeDist = Math.max(0, dist - yardsToUnits(1)); // stop 1 yard short
    const duration = chargeDist / speed;

    const savedAutoAttackTarget = this.autoAttacks.get(entity.id)?.target ?? null;
    this.stopAutoAttack(entity.id);
    entity.charging = true;
    this.tweakerSprintCharges.set(entity.id, {
      elapsed: 0,
      duration,
      dirX,
      dirZ,
      speed,
      hitTargets: new Set(),
      damage: TweakerSprint.chargeMaxDamage!,
      savedAutoAttackTarget,
    });
  }

  private updateTweakerSprintCharge(entity: ServerEntity, dt: number): void {
    const charge = this.tweakerSprintCharges.get(entity.id);
    if (!charge) return;

    charge.elapsed += dt;

    // Sub-step movement to prevent tunneling through thin walls at high speed
    const totalDx = charge.dirX * charge.speed * dt;
    const totalDz = charge.dirZ * charge.speed * dt;
    const totalDist = Math.sqrt(totalDx * totalDx + totalDz * totalDz);
    const maxStep = 0.25;
    const numSteps = Math.max(1, Math.ceil(totalDist / maxStep));
    const stepDx = totalDx / numSteps;
    const stepDz = totalDz / numSteps;
    for (let i = 0; i < numSteps; i++) {
      entity.x += stepDx;
      entity.z += stepDz;
      const resolved = this.collision.resolve(entity.x, entity.z, entity.y, 0.4);
      entity.x = resolved.x;
      entity.z = resolved.z;
    }

    // Hit detection: flat damage + slow debuff
    const hitRadius = 1.0;
    for (const other of this.entities) {
      if (other.dead || charge.hitTargets.has(other) || !other.isHostileTo(entity) || this.buffSystem.isUntargetable(other)) continue;
      const dx = entity.x - other.x;
      const dz = entity.z - other.z;
      if (Math.sqrt(dx * dx + dz * dz) <= hitRadius) {
        charge.hitTargets.add(other);
        this.combatSystem.applySweepDamage(entity, other, charge.damage);
        this.buffSystem.apply(other, TweakerSprintSlow);
      }
    }

    if (charge.elapsed >= charge.duration) {
      // Re-engage auto-attack
      const savedTarget = charge.savedAutoAttackTarget;
      if (savedTarget && !savedTarget.dead && savedTarget.isHostileTo(entity)) {
        this.requestAutoAttack(entity.id, savedTarget.id);
      }

      entity.charging = false;
      entity.lastPositionUpdateTime = 0;
      this.tweakerSprintCharges.delete(entity.id);
    }
  }

  // ── Kaboom cone AoE with knockback ──────────────────────────────────

  private static readonly KABOOM_CONE_RANGE = yardsToUnits(8);
  private static readonly KABOOM_CONE_HALF_ANGLE = Math.PI / 6; // 60° total cone
  private static readonly KABOOM_KNOCKBACK_DISTANCE = yardsToUnits(8);
  private static readonly KABOOM_KNOCKBACK_DURATION = 0.5; // seconds

  private executeKaboom(entity: ServerEntity): void {
    const forwardX = Math.sin(entity.rotationY);
    const forwardZ = Math.cos(entity.rotationY);
    const range = ServerEngine.KABOOM_CONE_RANGE;
    const cosHalf = Math.cos(ServerEngine.KABOOM_CONE_HALF_ANGLE);

    for (const other of this.entities) {
      if (other === entity || other.dead || !other.isHostileTo(entity) || this.buffSystem.isUntargetable(other)) continue;
      const dx = other.x - entity.x;
      const dz = other.z - entity.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > range || dist < 0.01) continue;

      // Cone angle check
      const toTargetX = dx / dist;
      const toTargetZ = dz / dist;
      const dot = forwardX * toTargetX + forwardZ * toTargetZ;
      if (dot < cosHalf) continue;

      // Target is in cone — interrupt casting and knock them back
      this.combatSystem.enterCombat(entity);
      this.combatSystem.enterCombat(other);
      this.cancelCasting(other.id);

      this.activeKnockbacks.push({
        target: other,
        dirX: toTargetX,
        dirZ: toTargetZ,
        distance: ServerEngine.KABOOM_KNOCKBACK_DISTANCE,
        duration: ServerEngine.KABOOM_KNOCKBACK_DURATION,
        elapsed: 0,
      });

      this.emitEvent({
        type: 'knockback',
        entityId: other.id,
        dirX: toTargetX,
        dirZ: toTargetZ,
        distance: ServerEngine.KABOOM_KNOCKBACK_DISTANCE,
        duration: ServerEngine.KABOOM_KNOCKBACK_DURATION,
      } as S2C_Knockback);
    }
  }

  private updateKnockbacks(dt: number): void {
    for (let i = this.activeKnockbacks.length - 1; i >= 0; i--) {
      const kb = this.activeKnockbacks[i];
      kb.elapsed += dt;
      const t = Math.min(1, kb.elapsed / kb.duration);

      // Move target along knockback direction
      const speed = kb.distance / kb.duration;
      kb.target.x += kb.dirX * speed * dt;
      kb.target.z += kb.dirZ * speed * dt;

      // Resolve collision
      const resolved = this.collision.resolve(kb.target.x, kb.target.z, kb.target.y, 0.4);
      kb.target.x = resolved.x;
      kb.target.z = resolved.z;

      if (t >= 1) {
        // Land — apply stun
        this.buffSystem.apply(kb.target, KaboomStun);
        // Reset validation timer so the client's next position update isn't rejected
        kb.target.lastPositionUpdateTime = 0;
        this.activeKnockbacks.splice(i, 1);
      }
    }
  }

  // ── Gas clouds ──────────────────────────────────────────────────────

  private spawnGasCloud(owner: ServerEntity, radius: number, duration: number, debuff: BuffDefinition, totalDamage: number, tickInterval: number): void {
    const tickCount = Math.floor(duration / tickInterval);
    const id = `gc_${this.nextEffectId++}`;
    this.gasClouds.push({
      id,
      centerX: owner.x,
      centerY: owner.y,
      centerZ: owner.z,
      radius, duration, elapsed: 0,
      debuff,
      damagePerTick: Math.round(totalDamage / tickCount),
      tickInterval,
      nextTickAt: tickInterval,
      owner,
      affectedTargets: new Set(),
    });
    this.onBroadcast?.({
      type: 'gas_cloud_spawn',
      id, x: owner.x, y: owner.y, z: owner.z, radius, duration,
    } as S2C_GasCloudSpawn);
  }

  private updateGasClouds(dt: number): void {
    for (let i = this.gasClouds.length - 1; i >= 0; i--) {
      const cloud = this.gasClouds[i];
      cloud.elapsed += dt;

      const inCloud = new Set<ServerEntity>();
      for (const entity of this.entities) {
        if (entity.dead || !entity.isHostileTo(cloud.owner) || this.buffSystem.isUntargetable(entity)) continue;
        const dx = entity.x - cloud.centerX;
        const dy = entity.y - cloud.centerY;
        const dz = entity.z - cloud.centerZ;
        if (dx * dx + dy * dy + dz * dz <= cloud.radius * cloud.radius) {
          inCloud.add(entity);
          const isNew = !cloud.affectedTargets.has(entity);
          this.buffSystem.apply(entity, cloud.debuff);
          cloud.affectedTargets.add(entity);
          if (isNew) {
            this.combatSystem.enterCombat(cloud.owner);
            this.combatSystem.enterCombat(entity);
          }
        }
      }

      for (const entity of cloud.affectedTargets) {
        if (!inCloud.has(entity) || entity.dead) {
          this.buffSystem.remove(entity, cloud.debuff.id);
          cloud.affectedTargets.delete(entity);
        }
      }

      while (cloud.elapsed >= cloud.nextTickAt && cloud.nextTickAt <= cloud.duration) {
        for (const entity of cloud.affectedTargets) {
          if (entity.dead) continue;
          const actualDmg = entity.godMode ? 0 : this.combatSystem.processDamageAbsorb(entity, cloud.damagePerTick, cloud.owner);
          entity.hp = Math.max(0, entity.hp - actualDmg);
          if (actualDmg > 0) {
            this.emitEvent({
              type: 'combat_event', sourceEntityId: cloud.owner.id, targetEntityId: entity.id, amount: actualDmg, combatType: 'damage',
            } as S2C_CombatEvent);
            this.onStatDamage?.(cloud.owner.id, entity.id, actualDmg);
          }
          this.combatSystem.enterCombat(entity);
          if (entity.hp <= 0 && !entity.dead) {
            entity.die();
            this.recordKill(cloud.owner.id, entity.id);
          }
        }
        cloud.nextTickAt += cloud.tickInterval;
      }

      if (cloud.elapsed >= cloud.duration) {
        for (const entity of cloud.affectedTargets) {
          this.buffSystem.remove(entity, cloud.debuff.id);
        }
        this.gasClouds.splice(i, 1);
      }
    }
  }

  // ── Chemical pools ──────────────────────────────────────────────────

  private spawnChemicalPool(
    owner: ServerEntity, radius: number, duration: number,
    speedBuff: BuffDefinition, dot: BuffDefinition,
    initialDamageMin: number, initialDamageMax: number, dotTotalDamage: number, dotTickInterval: number,
    dotDuration: number, activationDelay: number
  ): void {
    const dotTickCount = Math.floor(dotDuration / dotTickInterval);
    const id = `cp_${this.nextEffectId++}`;
    this.chemicalPools.push({
      id,
      centerX: owner.x, centerY: owner.y, centerZ: owner.z,
      radius, duration, elapsed: 0,
      speedBuff, dot,
      initialDamageMin, initialDamageMax,
      dotDamagePerTick: Math.round(dotTotalDamage / dotTickCount),
      dotTickInterval, dotDuration,
      owner, activationDelay, consumed: false,
    });
    this.onBroadcast?.({
      type: 'chem_pool_spawn',
      id, x: owner.x, y: owner.y, z: owner.z, radius, duration, activationDelay,
    } as S2C_ChemPoolSpawn);
  }

  private updateChemicalPools(dt: number): void {
    for (let i = this.chemicalPools.length - 1; i >= 0; i--) {
      const pool = this.chemicalPools[i];
      pool.elapsed += dt;

      if (pool.consumed || pool.elapsed >= pool.duration) {
        this.chemicalPools.splice(i, 1);
        continue;
      }

      if (pool.elapsed < pool.activationDelay) continue;

      for (const entity of this.entities) {
        if (entity.dead || this.buffSystem.isUntargetable(entity)) continue;
        const dx = entity.x - pool.centerX;
        const dy = entity.y - pool.centerY;
        const dz = entity.z - pool.centerZ;
        if (dx * dx + dy * dy + dz * dz > pool.radius * pool.radius) continue;

        if (entity.isHostileTo(pool.owner)) {
          const rolledDmg = pool.initialDamageMin + Math.floor(Math.random() * (pool.initialDamageMax - pool.initialDamageMin + 1));
          const actualDmg = entity.godMode ? 0 : this.combatSystem.processDamageAbsorb(entity, rolledDmg, pool.owner);
          entity.hp = Math.max(0, entity.hp - actualDmg);
          if (actualDmg > 0) {
            this.emitEvent({
              type: 'combat_event', sourceEntityId: pool.owner.id, targetEntityId: entity.id, amount: actualDmg, combatType: 'damage',
            } as S2C_CombatEvent);
            this.onStatDamage?.(pool.owner.id, entity.id, actualDmg);
          }
          this.combatSystem.enterCombat(pool.owner);
          this.combatSystem.enterCombat(entity);
          if (entity.hp <= 0 && !entity.dead) {
            entity.die();
            this.recordKill(pool.owner.id, entity.id);
          } else {
            this.buffSystem.apply(entity, pool.dot);
            this.activeDots.push({
              target: entity, debuff: pool.dot,
              totalDuration: pool.dotDuration, elapsed: 0,
              tickInterval: pool.dotTickInterval, nextTickAt: pool.dotTickInterval,
              damagePerTick: pool.dotDamagePerTick, owner: pool.owner,
            });
          }
        } else {
          this.buffSystem.apply(entity, pool.speedBuff);
        }

        pool.consumed = true;
        break;
      }
    }
  }

  // ── DoTs ────────────────────────────────────────────────────────────

  private updateActiveDots(dt: number): void {
    for (let i = this.activeDots.length - 1; i >= 0; i--) {
      const dot = this.activeDots[i];
      dot.elapsed += dt;

      while (dot.elapsed >= dot.nextTickAt && dot.nextTickAt <= dot.totalDuration) {
        if (!dot.target.dead) {
          const actualDmg = dot.target.godMode ? 0 : this.combatSystem.processDamageAbsorb(dot.target, dot.damagePerTick, dot.owner);
          dot.target.hp = Math.max(0, dot.target.hp - actualDmg);
          if (actualDmg > 0) {
            this.emitEvent({
              type: 'combat_event', sourceEntityId: dot.owner.id, targetEntityId: dot.target.id, amount: actualDmg, combatType: 'damage',
            } as S2C_CombatEvent);
            this.onStatDamage?.(dot.owner.id, dot.target.id, actualDmg);
          }
          this.combatSystem.enterCombat(dot.target);
          if (dot.target.hp <= 0 && !dot.target.dead) {
            dot.target.die();
            this.recordKill(dot.owner.id, dot.target.id);
          }
        }
        dot.nextTickAt += dot.tickInterval;
      }

      if (dot.elapsed >= dot.totalDuration || dot.target.dead) {
        this.activeDots.splice(i, 1);
      }
    }
  }

  // ── Full Retard aura ────────────────────────────────────────────────

  private updateFullRetardAuras(dt: number): void {
    for (const entity of this.entities) {
      const hasBuff = this.buffSystem.hasBuff(entity, 'full-retard');
      const hasAura = this.fullRetardAuras.has(entity.id);

      if (hasBuff && !hasAura) {
        this.fullRetardAuras.set(entity.id, { entity, elapsed: 0, nextTickAt: 1 });
      } else if (!hasBuff && hasAura) {
        this.fullRetardAuras.delete(entity.id);
      }
    }

    for (const [entityId, aura] of this.fullRetardAuras) {
      aura.elapsed += dt;
      const meleeRange = aura.entity.autoAttackRange;

      while (aura.elapsed >= aura.nextTickAt) {
        // Damage hostiles
        for (const other of this.entities) {
          if (other.dead || !other.isHostileTo(aura.entity) || this.buffSystem.isUntargetable(other)) continue;
          const dx = aura.entity.x - other.x;
          const dz = aura.entity.z - other.z;
          if (dx * dx + dz * dz <= meleeRange * meleeRange) {
            const dmg = this.combatSystem.processDamageAbsorb(other, 200, aura.entity);
            other.hp = Math.max(0, other.hp - dmg);
            if (dmg > 0) {
              this.emitEvent({
                type: 'combat_event', sourceEntityId: aura.entity.id, targetEntityId: other.id, amount: dmg, combatType: 'damage',
              } as S2C_CombatEvent);
              this.onStatDamage?.(aura.entity.id, other.id, dmg);
            }
            this.combatSystem.enterCombat(aura.entity);
            this.combatSystem.enterCombat(other);
            if (other.hp <= 0 && !other.dead) {
              other.die();
              this.recordKill(aura.entity.id, other.id);
            }
          }
        }

        // Heal friendlies (self heals 125, allies 300)
        for (const other of this.entities) {
          if (other.dead || other.isHostileTo(aura.entity)) continue;
          const dx = aura.entity.x - other.x;
          const dz = aura.entity.z - other.z;
          if (dx * dx + dz * dz <= meleeRange * meleeRange) {
            const heal = other === aura.entity ? 125 : 300;
            this.combatSystem.applyHeal(aura.entity, other, heal);
          }
        }

        aura.nextTickAt += 1;
      }
    }
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
      const casting = this.castingStates.get(e.id);
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
      const casting = this.castingStates.get(e.id);
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
    return this.gasClouds.map(gc => ({
      id: gc.id,
      x: gc.centerX, y: gc.centerY, z: gc.centerZ,
      radius: gc.radius, elapsed: gc.elapsed, duration: gc.duration,
    }));
  }

  private buildChemPoolSnapshots(): ChemicalPoolSnapshot[] {
    return this.chemicalPools.map(cp => ({
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
  private computeElevatorY(gameElapsed: number): number {
    const { ELEVATOR_FLOORS: FLOORS, ELEVATOR_STOPS: STOPS, ELEVATOR_IDLE: IDLE,
            ELEVATOR_TRAVEL: TRAVEL, ELEVATOR_PHASE: PHASE, ELEVATOR_CYCLE: CYCLE } = ServerEngine;

    const t = gameElapsed % CYCLE;
    const stopIdx = Math.floor(t / PHASE);
    const phaseT  = t - stopIdx * PHASE;

    const fromY = FLOORS[STOPS[stopIdx]];
    const toY   = FLOORS[STOPS[(stopIdx + 1) % STOPS.length]];

    if (phaseT < IDLE) {
      // Idling — replicate hover bob for accurate collision
      // Skip the bob at ground level so the platform sits still
      const isGroundFloor = STOPS[stopIdx] === 0;
      if (isGroundFloor) return fromY;
      const fadeIn  = Math.min(1, phaseT / 1.0);
      const fadeOut = Math.min(1, (IDLE - phaseT) / 1.0);
      return fromY + Math.sin(gameElapsed * 1.5) * 0.4 * fadeIn * fadeOut;
    }
    // Traveling — ease-in-out cubic
    const p = (phaseT - IDLE) / TRAVEL;
    const eased = p < 0.5
      ? 4 * p * p * p
      : 1 - Math.pow(-2 * p + 2, 3) / 2;
    return fromY + (toY - fromY) * eased;
  }

  /** Update the elevator collider position (called each tick). */
  private updateElevator(): void {
    if (!this.elevatorCollider) return;
    this.elevatorCollider.centerY = this.computeElevatorY(this.getGameElapsed());

    // Keep frozen (disconnected) entities riding the elevator surface so they
    // don't float in mid-air after the platform moves away.
    // Use expanded footprint (+ collisionRadius) to match the client collision
    // system's overlap detection — players can stand up to 0.4 units beyond
    // the box edge and still be "on" the platform.
    const surfaceY = this.elevatorCollider.centerY + ServerEngine.ELEVATOR_HALF_H;
    for (const entityId of this.frozenEntities) {
      const entity = this.getEntity(entityId);
      if (!entity || entity.dead) continue;
      const dx = entity.x - ServerEngine.ELEVATOR_CX;
      const dz = entity.z - ServerEngine.ELEVATOR_CZ;
      if (Math.abs(dx) <= ServerEngine.ELEVATOR_HALF_W + entity.collisionRadius &&
          Math.abs(dz) <= ServerEngine.ELEVATOR_HALF_D + entity.collisionRadius) {
        entity.y = surfaceY;
      }
    }
  }

  /** Seconds since the game engine started (matches client ArenaScript.elapsed). */
  getGameElapsed(): number {
    if (this.startTime === 0) return 0;
    return (Date.now() - this.startTime) / 1000;
  }

  /** Current elevator surface Y, or undefined if no elevator on this map. */
  getElevatorY(): number | undefined {
    if (!this.elevatorCollider) return undefined;
    return this.elevatorCollider.centerY + ServerEngine.ELEVATOR_HALF_H;
  }

  /**
   * If the entity is within the elevator's XZ footprint (+ collision radius),
   * snap its Y to the current elevator surface so it doesn't spawn in mid-air
   * on rejoin.  The expanded footprint matches the client collision system's
   * overlap detection — players can stand up to collisionRadius beyond the
   * box edge.
   */
  snapEntityToElevator(entityId: string): void {
    if (!this.elevatorCollider) return;
    const entity = this.getEntity(entityId);
    if (!entity || entity.dead) return;

    const dx = entity.x - ServerEngine.ELEVATOR_CX;
    const dz = entity.z - ServerEngine.ELEVATOR_CZ;
    if (Math.abs(dx) <= ServerEngine.ELEVATOR_HALF_W + entity.collisionRadius &&
        Math.abs(dz) <= ServerEngine.ELEVATOR_HALF_D + entity.collisionRadius) {
      entity.y = this.elevatorCollider.centerY + ServerEngine.ELEVATOR_HALF_H;
      entity.fallPeakY = 0;
    }
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
