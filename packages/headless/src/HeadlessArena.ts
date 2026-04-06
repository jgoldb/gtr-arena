/**
 * HeadlessArena — gym-style simulation environment for RL training.
 *
 * No Three.js, no rendering, no sound. Runs combat at maximum speed.
 * Exposes reset() / step() API for training harnesses.
 *
 * Remaining simplifications:
 * - 1v1 only
 * - No navigation / pathfinding
 */

import {
  getCharacterStats,
  isRangedAutoAttack,
  type CharacterId,
  type Ability,
  type BuffDefinition,
  BuffSystem,
  RegenSystem,
  AutoAttackSystem,
  GasCloudSystem,
  DotSystem,
  ChemicalPoolSystem,
  ChargeSystem,
  FullRetardAuraSystem,
  CastingSystem,
  CollisionSystem,
  type CircleCollider,
  MISS_CHANCE,
  yardsToUnits,
  MAPS,
  FartBombDebuff,
  ChemicalSpillSpeedBuff,
  ChemicalSpillDot,
  CrotchRotDot,
  ParanoidDebuff,
  Sweep,
  TweakerSprint,
  TweakerSprintSlow,
  KaboomStun,
  RecentlyBandagedDebuff,
  KABOOM_CONE_RANGE,
  KABOOM_CONE_HALF_ANGLE,
  RestingBuff,
} from '@gtr/shared';
import { HeadlessEntity } from './HeadlessEntity.js';
import { HeadlessCombat } from './HeadlessCombat.js';
import { HeadlessNpcBrain, type NpcBehaviorMode } from './HeadlessNpcBrain.js';

// ── Action / Observation Types ───────────────────────────────────────────

export interface AgentAction {
  /** Index into the entity's abilities array (null = no ability this tick). */
  abilityIndex: number | null;
  /** Movement: angle in radians (0 = +Z, pi/2 = +X). null = stand still. */
  moveAngle: number | null;
  /** Movement speed factor 0–1 (usually 1 = full speed, 0 = stand still). */
  moveSpeed: number;
  /** If true, cancel any active cast/channel this tick. */
  cancelCast?: boolean;
  /** Ground-target X for ground-targeted abilities (e.g. Bottle Chuck). */
  groundX?: number;
  /** Ground-target Z for ground-targeted abilities. */
  groundZ?: number;
  /** If true, attempt to start resting (sit down for accelerated mana regen). */
  rest?: boolean;
}

export interface EntityObservation {
  // Self — vitals & position
  hpPct: number;
  manaPct: number;
  x: number;
  z: number;
  y: number;           // elevation (normalized)
  rotY: number;
  // Self — CC & status
  isStunned: number;   // pure stun (not sleep)
  isSleeping: number;
  isBlinded: number;
  isDiscombobulated: number;
  isUntargetable: number;
  inCombat: number;
  isResting: number;
  // Self — buff multipliers (1.0 = normal)
  speedMult: number;
  dmgDealtMult: number;
  dmgTakenMult: number;
  // Self — ability state
  cooldowns: number[];  // normalized 0–1 per ability slot
  gcdPct: number;
  isCasting: number;
  castPct: number;        // 0–1 progress of current cast/channel
  isChanneling: number;

  // Opponent — vitals & position (relative)
  oppHpPct: number;
  oppManaPct: number;
  oppRelX: number;
  oppRelZ: number;
  oppDistance: number;
  oppRotY: number;
  // Opponent — CC & status
  oppIsStunned: number;
  oppIsSleeping: number;
  oppIsBlinded: number;
  oppIsDiscombobulated: number;
  oppIsUntargetable: number;
  oppIsResting: number;
  // Opponent — buff multipliers
  oppSpeedMult: number;
  oppDmgDealtMult: number;
  oppDmgTakenMult: number;
  // Opponent — ability & movement state
  oppIsCasting: number;
  oppCastPct: number;
  oppIsChanneling: number;
  oppIsMoving: number;

  // Spatial awareness
  oppLoS: number;        // 1 = have line of sight to opponent
  wallDist: number[];    // distances in 8 directions, normalized 0–1

  // Dynamic map features (Cage pillars)
  ewPillarUp: number;    // 1 = E/W pillars fully raised, 0 = fully submerged
  nsPillarUp: number;    // 1 = N/S pillars fully raised, 0 = fully submerged
  pillarPhasePct: number; // 0–1 progress through current pillar phase (1 = transition imminent)

  // Temporal context
  matchTimePct: number;  // 0 at match start, 1 at max duration — helps learn CD timing
}

export interface StepResult {
  observations: [EntityObservation, EntityObservation];
  rewards: [number, number];
  done: boolean;
  /** Which team won (1 or 2), or 0 if not done / draw. */
  winner: number;
  /** Total elapsed simulation time in seconds. */
  time: number;
}

export interface ArenaConfig {
  /** Characters for team 1 and team 2. */
  characters: [CharacterId, CharacterId];
  /** Map to simulate in (default 'cage'). Loads real obstacles, spawn points, and LoS. */
  mapId?: string;
  /** Fixed simulation timestep in seconds (default 0.1 = 10 Hz). */
  tickRate?: number;
  /** Max match duration in seconds before draw (default 120). */
  maxDuration?: number;
  /** If true, entity[1] is controlled by a scripted Master-level NPC brain. */
  scriptedOpponent?: boolean;
  /** Pool of opponent characters to randomly select from each episode (scripted mode). */
  opponentCharacters?: CharacterId[];
  /** Fraction of episodes (0–1) that use a scripted opponent instead of external actions.
   *  Overrides scriptedOpponent when set. E.g. 0.3 = 30% scripted, 70% external (self-play). */
  scriptedMixRate?: number;
  /** Number of ability slots unlocked (curriculum). null/undefined = all unlocked. */
  unlockedAbilities?: number;
}

// ── Pending AoE ──────��──────────────────────────────────────────────────

interface PendingAoeImpact {
  ability: Ability;
  groundX: number;
  groundZ: number;
  delay: number;
  elapsed: number;
  owner: HeadlessEntity;
}

interface ActiveBuffWindow {
  entityIdx: number;
  abilityId: string;
  buffId: string;
  /** Ability cooldown in seconds (for scaling waste penalty). */
  cooldown: number;
  /** Total ticks the buff has been active. */
  ticksActive: number;
  /** Ticks where the entity was in productive range of the opponent. */
  ticksProductive: number;
}

const BUFF_WASTE_BASE_PENALTY = 0.015;
const OFFENSIVE_BUFF_WASTE_MULTIPLIER = 1.3;

const BOTTLE_CHUCK_IMPACT_DELAY = 0.825;

// ── Arena ─────────────���────────────────────────────────��─────────────────

const ENTITY_COLLISION_RADIUS = 0.4;
const DEFAULT_TICK_RATE = 0.1;
const DEFAULT_MAX_DURATION = 120;

export class HeadlessArena {
  // Config
  private mapId: string;
  private tickRate: number;
  private maxDuration: number;
  /** Number of ability slots unlocked (curriculum). Infinity = all. */
  private unlockedAbilities: number;
  private spawnPoints: { x: number; y: number; z: number }[];
  /** Arena bounds for NPC spawn area (used for wall-aware movement). */
  private arenaBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Normalization scale for position observations (derived from map bounds). */
  private normScale: number;

  // Entities
  readonly entities: [HeadlessEntity, HeadlessEntity];

  // Systems
  private buffSystem: BuffSystem<HeadlessEntity>;
  private regenSystem: RegenSystem<HeadlessEntity>;
  private combat: HeadlessCombat;
  private collision: CollisionSystem;
  private castingSystem: CastingSystem<HeadlessEntity>;
  private autoAttack: AutoAttackSystem<HeadlessEntity>;
  private gasCloudSystem: GasCloudSystem<HeadlessEntity>;
  private dotSystem: DotSystem<HeadlessEntity>;
  private chemPoolSystem: ChemicalPoolSystem<HeadlessEntity>;
  private chargeSystem: ChargeSystem<HeadlessEntity>;
  private fullRetardAura: FullRetardAuraSystem<HeadlessEntity>;
  private pendingAoeImpacts: PendingAoeImpact[] = [];
  /** Scripted AI brain for entity[1] (opponent). Null if opponent is external. */
  private opponentBrain: HeadlessNpcBrain | null = null;

  // Dynamic pillars (Cage map only)
  private readonly PILLAR_Y_UP = 3;
  private readonly PILLAR_Y_DOWN = -2.7;
  private readonly PILLAR_DROP_ANIM = 2;
  private readonly PILLAR_DOWN_TIME = 30;
  private readonly PILLAR_RISE_ANIM = 2;
  private readonly PILLAR_INITIAL_UP_TIME = 30;
  private readonly PILLAR_UP_TIME = 30;
  private hasPillars = false;
  private ewPillarColliders: CircleCollider[] = [];
  private nsPillarColliders: CircleCollider[] = [];
  private pillarState: 'up' | 'dropping' | 'down' | 'rising' = 'up';
  private pillarStateTimer = 0;
  private currentPillarUpDuration = 30;
  /** 0 = fully raised, 1 = fully submerged (matches CageArenaScript convention). */
  private ewPillarProgress = 0;
  private nsPillarProgress = 1;

  // State
  private elapsed = 0;
  private done = false;
  private winner = 0;

  // Reward accumulators (reset each step)
  private damageDealt: [number, number] = [0, 0];
  private damageTaken: [number, number] = [0, 0];
  private healingDone: [number, number] = [0, 0];
  private abilityUsedCount: [number, number] = [0, 0];
  private abilityFailedCount: [number, number] = [0, 0];
  private ccAppliedCount: [number, number] = [0, 0];
  private autoAttackHits: [number, number] = [0, 0];
  /** Accumulated buff waste penalty for the current step (replaces flat selfBuffWasted). */
  private buffWastePenalty: [number, number] = [0, 0];
  /** Tracks trinket uses while not CC'd (wasted). */
  private trinketWastedCount: [number, number] = [0, 0];
  /** Accumulated penalty for offensive self-buffs used far from opponent (distance-scaled). */
  private prematureCooldownPenalty: [number, number] = [0, 0];
  /** Damage dealt by charge abilities (Sweep, etc.) — tracked separately for bonus reward. */
  private chargeDamageDealt: [number, number] = [0, 0];
  /** Count of Sweep charges that finished without hitting anyone. */
  private sweepWhiffCount: [number, number] = [0, 0];
  /** Tracks unique ability IDs used per step for diversity bonus. */
  private abilitiesUsedThisStep: [Set<string>, Set<string>] = [new Set(), new Set()];
  /** Running ability usage counts (EMA) for intrinsic curiosity reward. Persists across episodes. */
  private abilityUsageEma: [Float64Array, Float64Array] = [new Float64Array(0), new Float64Array(0)];
  /** Accumulated intrinsic curiosity bonus per step (from underrepresented ability usage). */
  private curiosityBonus: [number, number] = [0, 0];
  /** Active self-buff windows being tracked for utilization. Persists across steps. */
  private activeBuffWindows: ActiveBuffWindow[] = [];
  /** Mana snapshot at start of step, for tracking mana gained while resting. */
  private manaAtStepStart: [number, number] = [0, 0];

  // Opponent config
  /** 0–1 fraction of episodes using scripted AI. 1.0 = pure scripted, 0 = pure external. */
  private scriptedMixRate: number;
  private opponentCharacters: CharacterId[];
  private defaultOpponentCharacter: CharacterId;

  constructor(config: ArenaConfig) {
    this.scriptedMixRate = config.scriptedMixRate ?? (config.scriptedOpponent ? 1.0 : 0);
    this.opponentCharacters = config.opponentCharacters ?? [];
    this.defaultOpponentCharacter = config.characters[1];
    this.mapId = config.mapId ?? 'cage';
    this.tickRate = config.tickRate ?? DEFAULT_TICK_RATE;
    this.maxDuration = config.maxDuration ?? DEFAULT_MAX_DURATION;
    this.unlockedAbilities = config.unlockedAbilities ?? Infinity;

    // Load map data
    const mapInfo = MAPS[this.mapId];
    if (!mapInfo) throw new Error(`Unknown map: ${this.mapId}`);
    // Use npcSpawnBounds for combat spawn positions (map spawnPoints are pre-match pens)
    const bounds = mapInfo.npcSpawnBounds;
    this.arenaBounds = bounds;
    this.spawnPoints = [
      { x: (bounds.minX + bounds.maxX) / 2, y: 0, z: bounds.maxZ * 0.7 },
      { x: (bounds.minX + bounds.maxX) / 2, y: 0, z: bounds.minZ * 0.7 },
    ];
    // Normalization scale: largest axis extent of the playable area
    this.normScale = Math.max(
      Math.abs(bounds.maxX), Math.abs(bounds.minX),
      Math.abs(bounds.maxZ), Math.abs(bounds.minZ),
    ) || 30;

    // Build collision system from map obstacles
    this.collision = new CollisionSystem();
    this.collision.buildFromObstacles(mapInfo.obstacles);

    // Add dynamic pillars for Cage map
    if (this.mapId === 'cage') {
      this.hasPillars = true;
      // East/West pillars — start UP
      for (const px of [-11, 11]) {
        const collider: CircleCollider = {
          type: 'circle', cx: px, cz: 0, radius: 1.8,
          centerY: this.PILLAR_Y_UP, halfH: 3,
        };
        this.collision.addCollider(collider);
        this.ewPillarColliders.push(collider);
      }
      // North/South pillars — start DOWN (opposite phase)
      for (const pz of [-11, 11]) {
        const collider: CircleCollider = {
          type: 'circle', cx: 0, cz: pz, radius: 1.8,
          centerY: this.PILLAR_Y_DOWN, halfH: 3,
        };
        this.collision.addCollider(collider);
        this.nsPillarColliders.push(collider);
      }
    }

    // Create entities
    this.entities = [
      new HeadlessEntity(config.characters[0], 1, 'Agent1'),
      new HeadlessEntity(config.characters[1], 2, 'Agent2'),
    ];

    // Initialize systems
    this.buffSystem = new BuffSystem<HeadlessEntity>();
    const allEntities = () => [...this.entities] as HeadlessEntity[];
    this.regenSystem = new RegenSystem<HeadlessEntity>(allEntities);
    this.regenSystem.setBuffSystem(this.buffSystem);
    this.combat = new HeadlessCombat(this.buffSystem);

    // Wire combat callbacks for reward tracking
    this.combat.onDamageDealt = (attacker, _target, amount) => {
      const idx = this.entities.indexOf(attacker);
      if (idx >= 0) {
        this.damageDealt[idx] += amount;
        this.damageTaken[1 - idx] += amount;
      }
    };
    this.combat.onHealDone = (source, _target, amount) => {
      const idx = this.entities.indexOf(source);
      if (idx >= 0) this.healingDone[idx] += amount;
    };
    this.combat.onDeath = (victim, _killer) => {
      if (!this.done) {
        this.done = true;
        // Winner is the other team
        this.winner = victim.team === 1 ? 2 : 1;
      }
    };
    this.combat.hasLineOfSight = (a, b) => this.collision.hasLineOfSight(a.x, a.z, b.x, b.z, a.y, b.y);

    // Casting system
    this.castingSystem = new CastingSystem<HeadlessEntity>({
      isGodMode: () => false,
      shouldCancel: (entity) =>
        entity.dead || entity.stunned || this.buffSystem.isSleeping(entity) || entity.isMoving,
      getPosition: (entity) => ({ x: entity.x, z: entity.z }),
      getManaCostMultiplier: (entity) => this.buffSystem.getManaCostMultiplier(entity),
      getDamageDealtMultiplier: (entity) => this.buffSystem.getDamageDealtMultiplier(entity),
      applyBuff: (target, def) => this.buffSystem.apply(target, def),
      removeBuff: (target, id, silent) => this.buffSystem.remove(target, id, silent),
      setBuffRemaining: (target, id, remaining) => this.buffSystem.setRemaining(target, id, remaining),
      consumeMana: (entity, amount) => { entity.mana -= amount; },
      notifyManaUsed: (entity) => this.regenSystem.notifyManaUsed(entity),
      triggerGcd: (entity) => entity.cooldowns.triggerGcd(),
      setCooldown: (entity, abilityId, duration) => entity.cooldowns.setCooldown(abilityId, duration),
      clearCooldown: (entity, abilityId) => entity.cooldowns.clearCooldown(abilityId),
      rollMiss: () => Math.random() < MISS_CHANCE,
      enterCombat: (entity) => this.combat.enterCombat(entity),
      applyHeal: (healer, target, amount) => this.combat.applyHeal(target, amount, healer),
      applyChannelTickDamage: (attacker, target, damage, multiplier) =>
        this.combat.applyChannelTickDamage(attacker, target, damage, multiplier),
      useAbility: (entity, ability, target) => {
        // Called when a non-channel cast completes — route to combat + post-effects
        const opponent = this.entities[0] === entity ? this.entities[1] : this.entities[0];
        const result = this.combat.useAbility(ability, entity, target);
        if (result.success) {
          this.handleAbilityPostEffects(entity, ability, target, opponent);
        }
        return result;
      },
    });

    // Cast pushback + cancel resting on direct damage
    this.combat.onDirectDamageDealt = (target) => {
      this.castingSystem.applyPushback(target);
      if (this.buffSystem.hasBuff(target, 'resting')) {
        this.buffSystem.remove(target, 'resting', true);
      }
    };

    // Auto-attack system
    this.autoAttack = new AutoAttackSystem<HeadlessEntity>({
      getPosition: (e) => ({ x: e.x, y: e.y, z: e.z }),
      getRotationY: (e) => e.rotY,
      isMoving: (e) => e.isMoving,
      isCasting: (e) => e.castingAbilityName !== null,
      isUntargetable: (e) => this.buffSystem.isUntargetable(e),
      isRanged: (e) => isRangedAutoAttack(getCharacterStats(e.characterId)),
      getAutoAttackSpeed: (e) => getCharacterStats(e.characterId).autoAttackSpeed,
      getAttackSpeedMultiplier: (e) => this.buffSystem.getAutoAttackSpeedMultiplier(e),
      rollDamage: (e) => {
        const stats = getCharacterStats(e.characterId);
        return stats.autoAttackDamageMin + Math.floor(
          Math.random() * (stats.autoAttackDamageMax - stats.autoAttackDamageMin + 1),
        );
      },
      hasLineOfSight: (a, b) => this.collision.hasLineOfSight(a.x, a.z, b.x, b.z, a.y, b.y),
      applyMeleeDamage: (a, t, dmg) => {
        const result = this.combat.applyAutoAttackDamage(a, t, dmg);
        const idx = this.entities.indexOf(a);
        if (idx >= 0) this.autoAttackHits[idx]++;
        return result;
      },
      applyProjectileDamage: (a, t, dmg) => { this.combat.applyAutoAttackDamage(a, t, dmg, false); },
    });

    // Gas cloud system
    this.gasCloudSystem = new GasCloudSystem<HeadlessEntity>(this.buffSystem, {
      getPosition: (e) => ({ x: e.x, y: e.y, z: e.z }),
      getHostileEntities: (owner) => this.entities.filter(e => e.isHostileTo(owner) && !e.dead),
      isGodModeImmune: () => false,
      processDamageAbsorb: (target, amount, source) => this.combat.processDamageAbsorb(target, amount, source),
      enterCombat: (e) => this.combat.enterCombat(e),
      onDamageDealt: (source, target, amount) => this.combat.onDamageDealt?.(source, target, amount),
      onEntityDied: (target, killer) => this.combat.onDeath?.(target, killer),
    });

    // DOT system
    this.dotSystem = new DotSystem<HeadlessEntity>({
      isGodModeImmune: () => false,
      processDamageAbsorb: (target, amount, source) => this.combat.processDamageAbsorb(target, amount, source),
      enterCombat: (e) => this.combat.enterCombat(e),
      onDamageDealt: (source, target, amount) => this.combat.onDamageDealt?.(source, target, amount),
      onEntityDied: (target, killer) => this.combat.onDeath?.(target, killer),
    });

    // Chemical pool system
    this.chemPoolSystem = new ChemicalPoolSystem<HeadlessEntity>(this.buffSystem, this.dotSystem, {
      getPosition: (e) => ({ x: e.x, y: e.y, z: e.z }),
      getAllEntities: () => [...this.entities].filter(e => !e.dead),
      isGodModeImmune: () => false,
      processDamageAbsorb: (target, amount, source) => this.combat.processDamageAbsorb(target, amount, source),
      enterCombat: (e) => this.combat.enterCombat(e),
      onDamageDealt: (source, target, amount) => this.combat.onDamageDealt?.(source, target, amount),
      onEntityDied: (target, killer) => this.combat.onDeath?.(target, killer),
    });

    // Charge system
    this.chargeSystem = new ChargeSystem<HeadlessEntity>({
      getPosition: (e) => ({ x: e.x, z: e.z }),
      moveEntity: (e, dx, dz) => {
        const resolved = this.collision.resolve(e.x + dx, e.z + dz, e.y, ENTITY_COLLISION_RADIUS);
        e.x = resolved.x;
        e.z = resolved.z;
        e.y = resolved.groundY;
      },
      getHostileEntities: (e) => this.entities.filter(o => o.isHostileTo(e) && !o.dead),
      isUntargetable: (e) => this.buffSystem.isUntargetable(e),
      isDead: (e) => e.dead,
      getAutoAttackRange: (e) => e.autoAttackRange,
      applySweepDamage: (source, target, damage) => {
        const result = this.combat.applySweepDamage(source, target, damage);
        const idx = this.entities.indexOf(source);
        if (idx >= 0) this.chargeDamageDealt[idx] += damage;
        return result;
      },
      applyTweakerSprintSlow: (target) => {
        this.buffSystem.apply(target, TweakerSprintSlow);
      },
      enterCombat: (e) => this.combat.enterCombat(e),
      applyKnockbackStun: (target) => {
        this.buffSystem.apply(target, KaboomStun);
      },
      onSweepChargeEnd: (entity, savedTarget, hitCount) => {
        if (savedTarget && !savedTarget.dead) entity.autoAttackTarget = savedTarget;
        if (hitCount === 0) {
          const idx = this.entities.indexOf(entity);
          if (idx >= 0) this.sweepWhiffCount[idx]++;
        }
      },
      onTweakerSprintChargeEnd: (entity, savedTarget) => {
        if (savedTarget && !savedTarget.dead) entity.autoAttackTarget = savedTarget;
      },
      moveKnockbackTarget: (target, dirX, dirZ, speed, dt, _t) => {
        const resolved = this.collision.resolve(
          target.x + dirX * speed * dt, target.z + dirZ * speed * dt,
          target.y, ENTITY_COLLISION_RADIUS,
        );
        target.x = resolved.x;
        target.z = resolved.z;
        target.y = resolved.groundY;
      },
    });

    // Full Retard aura system
    this.fullRetardAura = new FullRetardAuraSystem<HeadlessEntity>(this.buffSystem, {
      getPosition: (e) => ({ x: e.x, y: e.y, z: e.z }),
      getAllEntities: () => [...this.entities],
      isGodModeImmune: () => false,
      processDamageAbsorb: (target, amount, source) => this.combat.processDamageAbsorb(target, amount, source),
      enterCombat: (e) => this.combat.enterCombat(e),
      applyHeal: (_source, target, amount) => this.combat.applyHeal(target, amount),
      onDamageDealt: (source, target, amount) => this.combat.onDamageDealt?.(source, target, amount),
      onEntityDied: (target, killer) => this.combat.onDeath?.(target, killer),
    });

    // Scripted opponent brain (Master-level AI for entity[1]).
    // In mix mode (0 < rate < 1) reset() handles per-episode brain creation.
    if (this.scriptedMixRate >= 1.0) {
      this.opponentBrain = new HeadlessNpcBrain(
        this.entities[1], this.entities[0],
        this.buffSystem, this.collision, this.arenaBounds,
      );
    }

    // Init ability usage EMA (indexed by ability slot). Seeded uniform so no
    // ability starts with an artificial rarity bonus.
    const numSlots = this.entities[0].abilities.length;
    const seed = 1 / Math.max(numSlots, 1);
    this.abilityUsageEma = [
      new Float64Array(numSlots).fill(seed),
      new Float64Array(numSlots).fill(seed),
    ];
  }

  // ── Collision helper ────────────────────────────────────────────────────

  private resolvePosition(x: number, z: number, y: number): { x: number; z: number; y: number } {
    const resolved = this.collision.resolve(x, z, y, ENTITY_COLLISION_RADIUS);
    return { x: resolved.x, z: resolved.z, y: resolved.groundY };
  }

  /** Check LoS between two entities using the collision system. */
  hasLineOfSight(a: HeadlessEntity, b: HeadlessEntity): boolean {
    return this.collision.hasLineOfSight(a.x, a.z, b.x, b.z, a.y, b.y);
  }

  // ── Pillar state machine (Cage map) ─────────────────────────────────────

  private tickPillars(dt: number): void {
    this.pillarStateTimer += dt;

    switch (this.pillarState) {
      case 'up':
        if (this.pillarStateTimer >= this.currentPillarUpDuration) {
          this.pillarState = 'dropping';
          this.pillarStateTimer = 0;
        }
        break;
      case 'dropping': {
        const t = Math.min(this.pillarStateTimer / this.PILLAR_DROP_ANIM, 1);
        this.ewPillarProgress = t;       // E/W: up → down
        this.nsPillarProgress = 1 - t;   // N/S: down → up
        if (t >= 1) {
          this.pillarState = 'down';
          this.pillarStateTimer = 0;
        }
        break;
      }
      case 'down':
        if (this.pillarStateTimer >= this.PILLAR_DOWN_TIME) {
          this.pillarState = 'rising';
          this.pillarStateTimer = 0;
        }
        break;
      case 'rising': {
        const t = Math.min(this.pillarStateTimer / this.PILLAR_RISE_ANIM, 1);
        this.ewPillarProgress = 1 - t;   // E/W: down → up
        this.nsPillarProgress = t;       // N/S: up → down
        if (t >= 1) {
          this.pillarState = 'up';
          this.pillarStateTimer = 0;
          this.currentPillarUpDuration = this.PILLAR_UP_TIME;
        }
        break;
      }
    }

    this.updatePillarColliderY();
  }

  private updatePillarColliderY(): void {
    const ewY = this.PILLAR_Y_UP + (this.PILLAR_Y_DOWN - this.PILLAR_Y_UP) * this.ewPillarProgress;
    for (const c of this.ewPillarColliders) c.centerY = ewY;
    const nsY = this.PILLAR_Y_UP + (this.PILLAR_Y_DOWN - this.PILLAR_Y_UP) * this.nsPillarProgress;
    for (const c of this.nsPillarColliders) c.centerY = nsY;
  }

  private getPillarPhasePct(): number {
    if (!this.hasPillars) return 0;
    switch (this.pillarState) {
      case 'up': return this.pillarStateTimer / this.currentPillarUpDuration;
      case 'dropping': return this.pillarStateTimer / this.PILLAR_DROP_ANIM;
      case 'down': return this.pillarStateTimer / this.PILLAR_DOWN_TIME;
      case 'rising': return this.pillarStateTimer / this.PILLAR_RISE_ANIM;
    }
  }

  // ── Reset ──────────────────────────────────────────────────────────────

  reset(): [EntityObservation, EntityObservation] {
    this.elapsed = 0;
    this.done = false;
    this.winner = 0;
    this.damageDealt = [0, 0];
    this.damageTaken = [0, 0];
    this.healingDone = [0, 0];
    this.abilityUsedCount = [0, 0];
    this.abilityFailedCount = [0, 0];
    this.ccAppliedCount = [0, 0];
    this.autoAttackHits = [0, 0];
    this.buffWastePenalty = [0, 0];
    this.trinketWastedCount = [0, 0];
    this.sweepWhiffCount = [0, 0];
    this.activeBuffWindows = [];
    this.abilitiesUsedThisStep = [new Set(), new Set()];

    // Clear all system state (before potential entity swap)
    this.buffSystem.clearEntity(this.entities[0]);
    this.buffSystem.clearEntity(this.entities[1]);
    this.combat.clearEntity(this.entities[0]);
    this.combat.clearEntity(this.entities[1]);
    this.castingSystem.clear();
    this.autoAttack.stop(this.entities[0]);
    this.autoAttack.stop(this.entities[1]);
    this.gasCloudSystem.clouds.length = 0;
    this.dotSystem.dots.length = 0;
    this.chemPoolSystem.pools.length = 0;
    this.pendingAoeImpacts.length = 0;

    // Per-episode opponent selection
    if (this.scriptedMixRate > 0) {
      const useScripted = Math.random() < this.scriptedMixRate;
      if (useScripted) {
        // Scripted episode — pick random character from pool (or keep default)
        if (this.opponentCharacters.length > 0) {
          const charId = this.opponentCharacters[
            Math.floor(Math.random() * this.opponentCharacters.length)
          ];
          this.entities[1] = new HeadlessEntity(charId, 2, 'Agent2');
        }
        // Randomize behavior mode: 25% aggressive, 30% passive, 30% kiting, 15% punching-bag
        // More passive/kiting opponents force the agent to learn to initiate and chase
        const modeRoll = Math.random();
        const behaviorMode: NpcBehaviorMode = modeRoll < 0.25 ? 'aggressive'
          : modeRoll < 0.55 ? 'passive'
          : modeRoll < 0.85 ? 'kiting'
          : 'punching-bag';
        this.opponentBrain = new HeadlessNpcBrain(
          this.entities[1], this.entities[0],
          this.buffSystem, this.collision, this.arenaBounds,
          behaviorMode,
        );
      } else {
        // External episode (self-play / random) — restore default character if swapped
        if (this.entities[1].characterId !== this.defaultOpponentCharacter) {
          this.entities[1] = new HeadlessEntity(this.defaultOpponentCharacter, 2, 'Agent2');
        }
        this.opponentBrain = null;
      }
    }

    // Reset entities to real map spawn points
    const sp0 = this.spawnPoints[0] ?? { x: 0, y: 0, z: 10 };
    const sp1 = this.spawnPoints[1] ?? { x: 0, y: 0, z: -10 };
    this.entities[0].respawn(sp0.x, sp0.z, sp0.y);
    this.entities[1].respawn(sp1.x, sp1.z, sp1.y);
    // Face each other
    this.entities[0].faceToward(this.entities[1]);
    this.entities[1].faceToward(this.entities[0]);

    // Randomize pillar phase so the model experiences transitions throughout episodes
    if (this.hasPillars) {
      const upT = this.PILLAR_UP_TIME;
      const dropT = this.PILLAR_DROP_ANIM;
      const downT = this.PILLAR_DOWN_TIME;
      const riseT = this.PILLAR_RISE_ANIM;
      const cycleLen = upT + dropT + downT + riseT;
      const t = Math.random() * cycleLen;

      if (t < upT) {
        this.pillarState = 'up';
        this.pillarStateTimer = t;
        this.currentPillarUpDuration = upT;
        this.ewPillarProgress = 0;
        this.nsPillarProgress = 1;
      } else if (t < upT + dropT) {
        this.pillarState = 'dropping';
        this.pillarStateTimer = t - upT;
        this.currentPillarUpDuration = upT;
        const p = this.pillarStateTimer / dropT;
        this.ewPillarProgress = p;
        this.nsPillarProgress = 1 - p;
      } else if (t < upT + dropT + downT) {
        this.pillarState = 'down';
        this.pillarStateTimer = t - upT - dropT;
        this.currentPillarUpDuration = upT;
        this.ewPillarProgress = 1;
        this.nsPillarProgress = 0;
      } else {
        this.pillarState = 'rising';
        this.pillarStateTimer = t - upT - dropT - downT;
        this.currentPillarUpDuration = upT;
        const p = this.pillarStateTimer / riseT;
        this.ewPillarProgress = 1 - p;
        this.nsPillarProgress = p;
      }
      this.updatePillarColliderY();
    }

    // Apply starting buffs
    for (const entity of this.entities) {
      const stats = getCharacterStats(entity.characterId);
      if (stats.startingBuffs) {
        for (const buff of stats.startingBuffs) {
          this.buffSystem.apply(entity, buff);
        }
      }
    }

    return this.buildObservations();
  }

  // ── Step ───────────────────────────────────────────────────────────────

  step(actions: [AgentAction, AgentAction]): StepResult {
    if (this.done) {
      return {
        observations: this.buildObservations(),
        rewards: [0, 0],
        done: true,
        winner: this.winner,
        time: this.elapsed,
      };
    }

    const dt = this.tickRate;

    // Override agent 1's action with scripted brain if active
    if (this.opponentBrain) {
      actions[1] = this.opponentBrain.decide(dt);
      // Scripted NPC enters combat immediately (matches client NpcAiBrain behavior)
      // so auto-attacks start as soon as a target is available.
      // Exception: punching-bag never enters combat (no auto-attacks).
      const npc = this.entities[1];
      if (!npc.dead && !npc.inCombat && !this.entities[0].dead
          && this.opponentBrain.behaviorMode !== 'punching-bag') {
        this.combat.enterCombat(npc);
      }
    }

    // Tick pillar state machine
    if (this.hasPillars) this.tickPillars(dt);

    // Reset per-step accumulators
    this.damageDealt = [0, 0];
    this.damageTaken = [0, 0];
    this.healingDone = [0, 0];
    this.abilityUsedCount = [0, 0];
    this.abilityFailedCount = [0, 0];
    this.ccAppliedCount = [0, 0];
    this.autoAttackHits = [0, 0];
    this.buffWastePenalty = [0, 0];
    this.trinketWastedCount = [0, 0];
    this.prematureCooldownPenalty = [0, 0];
    this.chargeDamageDealt = [0, 0];
    this.sweepWhiffCount = [0, 0];
    this.abilitiesUsedThisStep = [new Set(), new Set()];
    this.curiosityBonus = [0, 0];
    this.manaAtStepStart = [this.entities[0].mana, this.entities[1].mana];

    // Process actions for each entity
    for (let i = 0; i < 2; i++) {
      const entity = this.entities[i];
      const action = actions[i];
      const opponent = this.entities[1 - i];

      if (entity.dead) continue;

      // Sync CC state from buffs
      entity.stunned = this.buffSystem.isStunned(entity) || this.buffSystem.isSleeping(entity);
      entity.blinded = this.buffSystem.isBlinded(entity);

      // Skip actions while stunned
      if (entity.stunned) {
        entity.isMoving = false;
        continue;
      }

      // Skip actions while charging
      if (this.chargeSystem.isCharging(entity)) continue;

      // ── Movement ───────────────────────────────────────────────
      if (action.moveAngle !== null && action.moveSpeed > 0 && !entity.blinded) {
        const baseSpeed = yardsToUnits(8); // ~8 yd/s base run speed
        const speedMult = this.buffSystem.getMovementSpeedMultiplier(entity);
        const speed = baseSpeed * speedMult * action.moveSpeed;
        const dx = Math.sin(action.moveAngle) * speed * dt;
        const dz = Math.cos(action.moveAngle) * speed * dt;
        const resolved = this.resolvePosition(entity.x + dx, entity.z + dz, entity.y);
        entity.x = resolved.x;
        entity.z = resolved.z;
        entity.y = resolved.y;
        entity.isMoving = true;
      } else {
        entity.isMoving = false;
      }

      // Blinded entities wander randomly
      if (entity.blinded) {
        const wanderAngle = Math.random() * Math.PI * 2;
        const speed = yardsToUnits(3) * dt;
        const resolved = this.resolvePosition(
          entity.x + Math.sin(wanderAngle) * speed,
          entity.z + Math.cos(wanderAngle) * speed,
          entity.y,
        );
        entity.x = resolved.x;
        entity.z = resolved.z;
        entity.y = resolved.y;
        entity.isMoving = true;
        entity.autoAttackTarget = null;
        continue;
      }

      // ── Rest ────────────────────────────────────────────────
      // Cancel resting on movement, combat, stun, or casting
      if (this.buffSystem.hasBuff(entity, 'resting')) {
        if (entity.isMoving || entity.inCombat || entity.stunned
            || this.castingSystem.isCasting(entity)) {
          this.buffSystem.remove(entity, 'resting', true);
        }
      }
      // Start resting if requested and conditions are met
      if (action.rest && !this.buffSystem.hasBuff(entity, 'resting')) {
        if (!entity.inCombat && !entity.isMoving && !entity.stunned
            && !this.buffSystem.isSleeping(entity)
            && !this.castingSystem.isCasting(entity)) {
          this.autoAttack.stop(entity);
          entity.autoAttackTarget = null;
          this.buffSystem.apply(entity, RestingBuff);
        }
      }
      // Stop resting if agent is no longer requesting it
      if (!action.rest && this.buffSystem.hasBuff(entity, 'resting')) {
        this.buffSystem.remove(entity, 'resting', true);
      }

      // ── Face opponent (auto) ──────────────────────────────────
      if (!opponent.dead) {
        entity.faceToward(opponent);
      }

      // ── Cancel cast ─────────────────────────────────────────
      if (action.cancelCast) {
        this.castingSystem.cancel(entity);
      }

      // ── Ability usage ──────────────────────────────────────────
      if (action.abilityIndex !== null) {
        // Cancel resting when using an ability
        if (this.buffSystem.hasBuff(entity, 'resting')) {
          this.buffSystem.remove(entity, 'resting', true);
        }
        // Curriculum gate: silently ignore locked ability slots
        if (action.abilityIndex >= this.unlockedAbilities) {
          // Locked — treat as no-op (no fail penalty)
        } else {
        const ability = entity.abilities[action.abilityIndex];
        if (ability && !ability.isAutoAttack) {
          if (this.castingSystem.isCasting(entity)) {
            // Trying to use ability while casting — wasted action
            this.abilityFailedCount[i]++;
          } else if (ability.groundTargeted && action.groundX !== undefined && action.groundZ !== undefined) {
            // Ground-targeted AoE (e.g. Bottle Chuck)
            const ok = this.useGroundTargetAbility(entity, ability, action.groundX, action.groundZ);
            if (ok) {
              this.abilityUsedCount[i]++;
              this.abilitiesUsedThisStep[i].add(ability.id);
              this.recordAbilityForCuriosity(i, action.abilityIndex!);
              if (ability.appliesDebuff && this.isDebuffCC(ability.appliesDebuff)) {
                this.ccAppliedCount[i]++;
              }
            } else {
              this.abilityFailedCount[i]++;
            }
          } else if (ability.castTime) {
            // Cast-time or channeled ability — route through CastingSystem
            let target: HeadlessEntity | null = null;
            if (ability.requiresHostileTarget) {
              target = opponent;
            } else if (ability.requiresTarget && !ability.requiresFriendlyTarget) {
              target = entity;
            } else if (ability.requiresFriendlyTarget) {
              target = entity; // 1v1: only self
            }
            const validation = this.combat.validateAbility(ability, entity, target);
            if (validation.success) {
              const castResult = this.castingSystem.start(entity, ability, target);
              if (castResult.started) {
                this.abilityUsedCount[i]++;
                this.abilitiesUsedThisStep[i].add(ability.id);
                this.recordAbilityForCuriosity(i, action.abilityIndex!);
                if (ability.appliesSelfBuff) {
                  this.activeBuffWindows.push({
                    entityIdx: i, abilityId: ability.id,
                    buffId: ability.appliesSelfBuff.id,
                    cooldown: ability.cooldown, ticksActive: 0, ticksProductive: 0,
                  });
                }
                if (ability.appliesDebuff && this.isDebuffCC(ability.appliesDebuff)) {
                  this.ccAppliedCount[i]++;
                }
              } else {
                this.abilityFailedCount[i]++;
              }
            } else {
              this.abilityFailedCount[i]++;
            }
          } else {
            // Instant ability (existing path)
            let target: HeadlessEntity | null = null;
            if (ability.requiresHostileTarget) {
              target = opponent;
            } else if (ability.requiresTarget && !ability.requiresFriendlyTarget) {
              target = entity;
            } else if (ability.requiresFriendlyTarget) {
              target = entity;
            }
            const result = this.combat.useAbility(ability, entity, target);
            if (result.success) {
              // Track trinket used while not CC'd (before post-effects clear CC)
              if (ability.id === 'pvp-trinket' &&
                  !this.buffSystem.isStunned(entity) &&
                  !this.buffSystem.isSleeping(entity) &&
                  !this.buffSystem.isBlinded(entity)) {
                this.trinketWastedCount[i]++;
              }
              // Track offensive self-buff used while far from opponent (distance-scaled penalty)
              if (ability.appliesSelfBuff && !ability.healAmount &&
                  ability.cooldown >= 15) {
                const buffDist = entity.distanceTo(opponent);
                const productiveRange = entity.autoAttackRange * 1.5;
                if (buffDist > productiveRange) {
                  // Estimate fraction of buff duration wasted running to opponent
                  const buffDuration = ability.appliesSelfBuff.duration ?? 10;
                  const timeToClose = (buffDist - productiveRange) / yardsToUnits(8);
                  const wastedFraction = Math.min(timeToClose / buffDuration, 0.9);
                  // Higher-CD abilities are more costly to waste (60s CD = 2x, 30s = 1x)
                  const cdImportance = ability.cooldown / 30;
                  this.prematureCooldownPenalty[i] += wastedFraction * cdImportance * 0.025;
                }
              }
              this.handleAbilityPostEffects(entity, ability, target, opponent);
              this.abilityUsedCount[i]++;
              this.abilitiesUsedThisStep[i].add(ability.id);
              this.recordAbilityForCuriosity(i, action.abilityIndex!);
              if (ability.appliesSelfBuff) {
                this.activeBuffWindows.push({
                  entityIdx: i, abilityId: ability.id,
                  buffId: ability.appliesSelfBuff.id,
                  cooldown: ability.cooldown, ticksActive: 0, ticksProductive: 0,
                });
              }
              if (ability.appliesDebuff && this.isDebuffCC(ability.appliesDebuff)) {
                this.ccAppliedCount[i]++;
              }
            } else {
              this.abilityFailedCount[i]++;
            }
          }
        }
        } // end curriculum else
      }

      // ── Auto-attack engage ────────────────────────────────────
      if (!opponent.dead && entity.inCombat) {
        if (!this.autoAttack.isAttacking(entity)) {
          this.autoAttack.start(entity, opponent);
        }
        entity.autoAttackTarget = opponent;
      }
    }

    // ── Tick all systems ───────────────────────────────────────────────
    for (const e of this.entities) {
      e.cooldowns.update(dt);
      this.castingSystem.update(e, dt);
      // Sync casting state to entity fields (for observations + isCasting checks)
      const casting = this.castingSystem.getState(e);
      if (casting) {
        e.castingAbilityName = casting.ability.name;
        e.castingAbilityId = casting.ability.id;
        e.castingElapsed = casting.elapsed;
        e.castingTotalTime = casting.totalTime;
        e.castingIsChannel = casting.isChannel;
      } else {
        e.castingAbilityName = null;
        e.castingAbilityId = null;
        e.castingElapsed = 0;
        e.castingTotalTime = 0;
        e.castingIsChannel = false;
      }
      this.autoAttack.update(e, dt);
    }
    this.autoAttack.updateProjectiles(dt);
    this.chargeSystem.update(dt);
    this.gasCloudSystem.update(dt);
    this.chemPoolSystem.update(dt);
    this.dotSystem.update(dt);
    this.updatePendingAoeImpacts(dt);
    this.fullRetardAura.update(dt);
    this.combat.update(dt);
    this.buffSystem.update(dt);
    this.regenSystem.update(dt);

    // Re-sync CC state after tick
    for (const e of this.entities) {
      e.stunned = this.buffSystem.isStunned(e) || this.buffSystem.isSleeping(e);
      e.blinded = this.buffSystem.isBlinded(e);
    }

    // Update buff utilization windows (after buffSystem.update so expired buffs are gone)
    for (let w = this.activeBuffWindows.length - 1; w >= 0; w--) {
      const win = this.activeBuffWindows[w];
      const entity = this.entities[win.entityIdx];
      const opponent = this.entities[1 - win.entityIdx];

      if (this.buffSystem.hasBuff(entity, win.buffId)) {
        // Buff still active — track utilization
        win.ticksActive++;
        if (!entity.dead && !opponent.dead
            && entity.distanceTo(opponent) <= entity.autoAttackRange * 1.5) {
          win.ticksProductive++;
        }
      } else {
        // Buff expired — evaluate utilization and apply penalty if wasted
        if (win.ticksActive > 0) {
          const utilization = win.ticksProductive / win.ticksActive;
          // Scale penalty by cooldown: 60s CD with 0% util = 2x penalty (cap at 2)
          const cdScale = Math.min(win.cooldown / 30, 2);
          // Offensive buffs (attack speed / damage boosts) penalized more heavily
          const ent = this.entities[win.entityIdx];
          const abil = ent.abilities.find(a => a?.id === win.abilityId);
          const buffEffects = abil?.appliesSelfBuff?.effects ?? [];
          const isOffensive = buffEffects.some(e =>
            e.type === 'autoAttackSpeedPercent' || e.type === 'damageDealtPercent');
          const offensiveMult = isOffensive ? OFFENSIVE_BUFF_WASTE_MULTIPLIER : 1;
          this.buffWastePenalty[win.entityIdx] += (1 - utilization) * cdScale * BUFF_WASTE_BASE_PENALTY * offensiveMult;
        }
        this.activeBuffWindows.splice(w, 1);
      }
    }

    this.elapsed += dt;

    // Check timeout
    if (!this.done && this.elapsed >= this.maxDuration) {
      this.done = true;
      this.winner = 0; // draw
    }

    // ── Compute rewards ────────────────────────────────────────────────
    const rewards: [number, number] = [0, 0];
    for (let i = 0; i < 2; i++) {
      const entity = this.entities[i];
      const opponent = this.entities[1 - i];

      // Damage / healing shaping — heavily reward dealing damage, low penalty for taking it
      // (encourages aggressive trading rather than risk-averse kiting)
      rewards[i] += this.damageDealt[i] * 0.00025;
      rewards[i] -= this.damageTaken[i] * 0.00001;
      rewards[i] += this.healingDone[i] * 0.00003;

      // HP differential bonus — reward for being ahead in HP %
      if (!entity.dead && !opponent.dead && entity.maxHp > 0 && opponent.maxHp > 0) {
        const myHpPct = entity.hp / entity.maxHp;
        const oppHpPct = opponent.hp / opponent.maxHp;
        rewards[i] += (myHpPct - oppHpPct) * 0.002;
      }

      // Ability usage — small flat bonus; effective use rewarded via damage/CC
      rewards[i] += this.abilityUsedCount[i] * 0.001;
      rewards[i] -= this.abilityFailedCount[i] * 0.002;

      // Ability diversity bonus — reward using multiple distinct abilities per step
      const uniqueAbilities = this.abilitiesUsedThisStep[i].size;
      if (uniqueAbilities >= 2) {
        rewards[i] += (uniqueAbilities - 1) * 0.003;
      }

      // Intrinsic curiosity ��� bonus for using abilities underrepresented in recent history
      rewards[i] += this.curiosityBonus[i];

      // Buff waste penalty — duration-aware, scaled by cooldown length
      rewards[i] -= this.buffWastePenalty[i];

      // Trinket wasted penalty — used while not CC'd
      rewards[i] -= this.trinketWastedCount[i] * 0.04;

      // Premature cooldown penalty — offensive buff used far from opponent (distance-scaled)
      rewards[i] -= this.prematureCooldownPenalty[i];

      // Charge ability damage bonus — extra reward for landing Sweep/charge damage
      // (on top of general damage reward; encourages learning skill-shot positioning)
      rewards[i] += this.chargeDamageDealt[i] * 0.0002;

      // Sweep whiff penalty — wasted cooldown + mana when charge hits nobody
      rewards[i] -= this.sweepWhiffCount[i] * 0.03;

      // CC application bonus (stun/sleep/blind)
      rewards[i] += this.ccAppliedCount[i] * 0.008;

      // Auto-attack hit bonus — directly rewards melee engagement
      rewards[i] += this.autoAttackHits[i] * 0.005;

      // Resting — reward mana recovered while resting, penalize resting near enemies
      if (this.buffSystem.hasBuff(entity, 'resting') && !entity.dead) {
        const manaGained = entity.mana - this.manaAtStepStart[i];
        if (manaGained > 0) {
          // Reward proportional to mana recovered (normalized by max mana)
          rewards[i] += (manaGained / entity.maxMana) * 0.05;
        }
        // Penalty for resting while opponent is close — guaranteed crits are dangerous
        if (!opponent.dead) {
          const dist = entity.distanceTo(opponent);
          if (dist < yardsToUnits(15)) {
            rewards[i] -= 0.01;
          }
        }
      }

      // Proximity reward — encourages closing distance and melee engagement
      if (!entity.dead && !opponent.dead) {
        const dist = entity.distanceTo(opponent);
        // Continuous gradient: closer = more reward
        const maxRewardDist = yardsToUnits(30);
        rewards[i] += 0.001 * Math.max(0, 1 - dist / maxRewardDist);
        // Melee engagement bonus for being in auto-attack range
        if (dist <= entity.autoAttackRange * 1.5) {
          rewards[i] += 0.004;
        }
      }

      // Step penalty — increases over time to create urgency (fight faster, don't stall)
      const timePressure = 1 + (this.elapsed / this.maxDuration) * 2; // 1x → 3x over match
      rewards[i] -= 0.001 * timePressure;
    }
    // Terminal rewards
    if (this.done) {
      if (this.winner === 1) { rewards[0] += 1; rewards[1] -= 1; }
      else if (this.winner === 2) { rewards[0] -= 1; rewards[1] += 1; }
      // Draw: significant penalty — fights should end decisively
      else { rewards[0] -= 0.5; rewards[1] -= 0.5; }
    }

    return {
      observations: this.buildObservations(),
      rewards,
      done: this.done,
      winner: this.winner,
      time: this.elapsed,
    };
  }

  // ── Intrinsic Curiosity ────────────────────────────────────────────────

  private static readonly EMA_ALPHA = 0.002;
  private static readonly CURIOSITY_SCALE = 0.004;

  /**
   * Update running ability usage EMA and add intrinsic curiosity bonus.
   * Rarely-used abilities get a larger bonus: scale * (1 - freq / maxFreq).
   */
  private recordAbilityForCuriosity(agentIdx: number, abilitySlot: number): void {
    const ema = this.abilityUsageEma[agentIdx];
    if (abilitySlot < 0 || abilitySlot >= ema.length) return;

    // Decay all slots, bump the used one
    const alpha = HeadlessArena.EMA_ALPHA;
    for (let j = 0; j < ema.length; j++) {
      ema[j] *= (1 - alpha);
    }
    ema[abilitySlot] += alpha;

    // Curiosity bonus: inverse of normalized frequency
    let maxFreq = 0;
    for (let j = 0; j < ema.length; j++) {
      if (ema[j] > maxFreq) maxFreq = ema[j];
    }
    if (maxFreq > 0) {
      const rarity = 1 - ema[abilitySlot] / maxFreq;
      this.curiosityBonus[agentIdx] += HeadlessArena.CURIOSITY_SCALE * rarity;
    }
  }

  // ── Ability Post-Effects ───────────────────────────────────────────────

  private handleAbilityPostEffects(
    entity: HeadlessEntity,
    ability: Ability,
    target: HeadlessEntity | null,
    opponent: HeadlessEntity,
  ): void {
    // PvP Trinket
    if (ability.id === 'pvp-trinket') {
      this.buffSystem.removeAllCCEffects(entity);
    }

    // Fart Bomb — spawn gas cloud
    if (ability.id === 'fart-bomb') {
      this.gasCloudSystem.spawn(
        entity, entity.x, entity.y, entity.z,
        yardsToUnits(5), 8, FartBombDebuff, 592, 2,
      );
    }

    // Chemical Spill — spawn chemical pool
    if (ability.id === 'chemical-spill') {
      this.chemPoolSystem.spawn(
        entity, entity.x, entity.y, entity.z,
        yardsToUnits(3), 30, ChemicalSpillSpeedBuff, ChemicalSpillDot,
        297, 349, 600, 2, 6, 2,
      );
    }

    // Crotch Rot — spawn DOT
    if (ability.id === 'crotch-rot' && target && !target.dead) {
      const totalDamage = 720;
      const tickInterval = 3;
      const duration = 12;
      const tickCount = Math.floor(duration / tickInterval);
      this.dotSystem.add({
        target, debuff: CrotchRotDot, totalDuration: duration,
        elapsed: 0, tickInterval, nextTickAt: tickInterval,
        damagePerTick: Math.round(totalDamage / tickCount), owner: entity,
      });
    }

    // Sweep charge
    if (ability.id === 'sweep') {
      const dirX = Math.sin(entity.rotY);
      const dirZ = Math.cos(entity.rotY);
      this.chargeSystem.startSweepCharge(
        entity, dirX, dirZ,
        Sweep.chargeSpeed!, Sweep.chargeDuration!, Sweep.chargeMaxDamage!,
        entity.autoAttackTarget,
      );
    }

    // Tweaker Sprint charge
    if (ability.id === 'tweaker-sprint' && opponent && !opponent.dead) {
      const dx = opponent.x - entity.x;
      const dz = opponent.z - entity.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > 0.01) {
        const dirX = dx / dist;
        const dirZ = dz / dist;
        entity.rotY = Math.atan2(dirX, dirZ);
        const speed = TweakerSprint.chargeSpeed!;
        const chargeDist = Math.max(0, dist - yardsToUnits(1));
        const duration = chargeDist / speed;
        this.chargeSystem.startTweakerSprintCharge(
          entity, dirX, dirZ, speed, duration,
          TweakerSprint.chargeMaxDamage!, entity.autoAttackTarget,
        );
      }
    }

    // Kaboom — cone knockback
    if (ability.id === 'kaboom') {
      this.chargeSystem.executeKaboom(entity, entity.rotY);
    }

    // Crackhead tweaking stacks
    if (['shank', 'pocket-sand', 'sticky-fingers', 'dumpster-dive', 'tweaker-sprint', 'gank'].includes(ability.id)) {
      this.buffSystem.addStacks(entity, 'tweaking', 15);
      if (this.buffSystem.getStacks(entity, 'tweaking') >= 100 && !this.buffSystem.hasDebuff(entity, 'paranoid')) {
        this.buffSystem.apply(entity, ParanoidDebuff);
      }
    }

    // Crack Rock — self heal + stacks
    if (ability.id === 'crack-rock') {
      this.combat.applyHeal(entity, 400, entity);
      this.buffSystem.addStacks(entity, 'tweaking', 25);
      if (this.buffSystem.getStacks(entity, 'tweaking') >= 100 && !this.buffSystem.hasDebuff(entity, 'paranoid')) {
        this.buffSystem.apply(entity, ParanoidDebuff);
      }
    }

    // Gank — reset CD if target dead or low HP
    if (ability.id === 'gank' && target) {
      if (target.dead || target.hp / target.maxHp < 0.30) {
        entity.cooldowns.clearCooldown('gank');
      }
    }

    // Sticky Fingers — steal buff or drain mana
    if (ability.id === 'sticky-fingers' && target) {
      const stealable = this.buffSystem.getBuffs(target).filter(b => !b.definition.unremovable);
      if (stealable.length > 0) {
        const stolen = stealable[Math.floor(Math.random() * stealable.length)];
        const remaining = stolen.remaining;
        this.buffSystem.remove(target, stolen.definition.id);
        this.buffSystem.apply(entity, stolen.definition);
        this.buffSystem.setRemaining(entity, stolen.definition.id, remaining);
      } else {
        const drain = Math.min(150, target.mana);
        target.mana -= drain;
        entity.mana = Math.min(entity.mana + 150, entity.maxMana);
      }
    }
  }

  // ── Reward Helpers ──────────────────────────────────────────────────────

  private isDebuffCC(debuff: BuffDefinition): boolean {
    return debuff.effects.some(e =>
      e.type === 'stun' || e.type === 'sleep' || e.type === 'blind',
    );
  }

  // ── Ground-Targeted Abilities ───────────────────────────────────────────

  private useGroundTargetAbility(
    entity: HeadlessEntity,
    ability: Ability,
    groundX: number,
    groundZ: number,
  ): boolean {
    if (entity.dead) return false;
    if (entity.stunned || this.buffSystem.isSleeping(entity)) return false;
    if (!entity.cooldowns.isReady(ability.id)) return false;

    // Range check to ground position
    const dx = entity.x - groundX;
    const dz = entity.z - groundZ;
    if (ability.range && Math.sqrt(dx * dx + dz * dz) > ability.range + yardsToUnits(2)) return false;

    // Mana check + consume
    const effectiveCost = Math.round(ability.manaCost * this.buffSystem.getManaCostMultiplier(entity));
    if (entity.mana < effectiveCost) return false;
    entity.mana -= effectiveCost;
    if (effectiveCost > 0) this.regenSystem.notifyManaUsed(entity);

    // Cooldown + GCD
    entity.cooldowns.setCooldown(ability.id, ability.cooldown);
    entity.cooldowns.triggerGcd();

    // Schedule delayed impact
    this.pendingAoeImpacts.push({
      ability,
      groundX,
      groundZ,
      delay: BOTTLE_CHUCK_IMPACT_DELAY,
      elapsed: 0,
      owner: entity,
    });

    this.combat.enterCombat(entity);
    return true;
  }

  private updatePendingAoeImpacts(dt: number): void {
    for (let i = this.pendingAoeImpacts.length - 1; i >= 0; i--) {
      const impact = this.pendingAoeImpacts[i];
      impact.elapsed += dt;
      if (impact.elapsed < impact.delay) continue;

      const radius = impact.ability.aoeRadius ?? 0;
      for (const target of this.entities) {
        if (target === impact.owner || target.dead || !target.isHostileTo(impact.owner)) continue;
        if (this.buffSystem.isUntargetable(target)) continue;
        const dx = target.x - impact.groundX;
        const dz = target.z - impact.groundZ;
        if (dx * dx + dz * dz > radius * radius) continue;
        this.combat.applyAoeDamage(impact.owner, target, impact.ability);
      }

      this.pendingAoeImpacts.splice(i, 1);
    }
  }

  // ── Observations ───────────────────────────────────────────────────────

  private buildObservations(): [EntityObservation, EntityObservation] {
    return [
      this.buildObservation(0),
      this.buildObservation(1),
    ];
  }

  // 8 raycast directions for wall distance: N, NE, E, SE, S, SW, W, NW
  private static readonly WALL_RAY_DIRS: [number, number][] = [
    [0, 1], [0.707, 0.707], [1, 0], [0.707, -0.707],
    [0, -1], [-0.707, -0.707], [-1, 0], [-0.707, 0.707],
  ];
  private static readonly WALL_RAY_MAX = yardsToUnits(30);

  private buildObservation(entityIndex: number): EntityObservation {
    const self = this.entities[entityIndex];
    const opp = this.entities[1 - entityIndex];
    const stats = getCharacterStats(self.characterId);
    const maxRay = HeadlessArena.WALL_RAY_MAX;

    // Wall distances: 8-direction raycasts from self position
    const wallDist = HeadlessArena.WALL_RAY_DIRS.map(
      ([dx, dz]) => this.collision.raycastDistance(self.x, self.z, dx, dz, maxRay, self.y) / maxRay,
    );

    return {
      // Self — vitals & position
      hpPct: self.maxHp > 0 ? self.hp / self.maxHp : 0,
      manaPct: self.maxMana > 0 ? self.mana / self.maxMana : 0,
      x: self.x / this.normScale,
      z: self.z / this.normScale,
      y: self.y / 10, // normalized: 10 world units is a tall structure
      rotY: self.rotY / Math.PI,
      // Self — CC & status
      isStunned: this.buffSystem.isStunned(self) ? 1 : 0,
      isSleeping: this.buffSystem.isSleeping(self) ? 1 : 0,
      isBlinded: this.buffSystem.isBlinded(self) ? 1 : 0,
      isDiscombobulated: this.buffSystem.isDiscombobulated(self) ? 1 : 0,
      isUntargetable: this.buffSystem.isUntargetable(self) ? 1 : 0,
      inCombat: self.inCombat ? 1 : 0,
      isResting: this.buffSystem.hasBuff(self, 'resting') ? 1 : 0,
      // Self — buff multipliers (centered at 1.0)
      speedMult: this.buffSystem.getMovementSpeedMultiplier(self),
      dmgDealtMult: this.buffSystem.getDamageDealtMultiplier(self),
      dmgTakenMult: this.buffSystem.getDamageTakenMultiplier(self),
      // Self — ability state (locked slots show as 1.0 = on cooldown)
      cooldowns: self.cooldowns.getCooldownVector(stats.abilities).map(
        (cd, idx) => idx >= this.unlockedAbilities ? 1 : cd,
      ),
      gcdPct: self.cooldowns.getGcdRemaining() / 0.75,
      isCasting: self.castingAbilityName !== null ? 1 : 0,
      castPct: self.castingTotalTime > 0 ? self.castingElapsed / self.castingTotalTime : 0,
      isChanneling: self.castingIsChannel ? 1 : 0,

      // Opponent — vitals & position
      oppHpPct: opp.maxHp > 0 ? opp.hp / opp.maxHp : 0,
      oppManaPct: opp.maxMana > 0 ? opp.mana / opp.maxMana : 0,
      oppRelX: (opp.x - self.x) / this.normScale,
      oppRelZ: (opp.z - self.z) / this.normScale,
      oppDistance: self.distanceTo(opp) / (this.normScale * 2),
      oppRotY: opp.rotY / Math.PI,
      // Opponent — CC & status
      oppIsStunned: this.buffSystem.isStunned(opp) ? 1 : 0,
      oppIsSleeping: this.buffSystem.isSleeping(opp) ? 1 : 0,
      oppIsBlinded: this.buffSystem.isBlinded(opp) ? 1 : 0,
      oppIsDiscombobulated: this.buffSystem.isDiscombobulated(opp) ? 1 : 0,
      oppIsUntargetable: this.buffSystem.isUntargetable(opp) ? 1 : 0,
      oppIsResting: this.buffSystem.hasBuff(opp, 'resting') ? 1 : 0,
      // Opponent — buff multipliers
      oppSpeedMult: this.buffSystem.getMovementSpeedMultiplier(opp),
      oppDmgDealtMult: this.buffSystem.getDamageDealtMultiplier(opp),
      oppDmgTakenMult: this.buffSystem.getDamageTakenMultiplier(opp),
      // Opponent — ability & movement state
      oppIsCasting: opp.castingAbilityName !== null ? 1 : 0,
      oppCastPct: opp.castingTotalTime > 0 ? opp.castingElapsed / opp.castingTotalTime : 0,
      oppIsChanneling: opp.castingIsChannel ? 1 : 0,
      oppIsMoving: opp.isMoving ? 1 : 0,

      // Spatial awareness
      oppLoS: this.collision.hasLineOfSight(self.x, self.z, opp.x, opp.z, self.y, opp.y) ? 1 : 0,
      wallDist,

      // Dynamic map features (1 = fully raised, 0 = fully submerged)
      ewPillarUp: 1 - this.ewPillarProgress,
      nsPillarUp: 1 - this.nsPillarProgress,
      pillarPhasePct: this.getPillarPhasePct(),

      // Temporal context
      matchTimePct: this.elapsed / this.maxDuration,
    };
  }

  // ── Utilities ──────────────────────────────────────────────────────────

  get isDone(): boolean { return this.done; }
  get matchWinner(): number { return this.winner; }
  get matchTime(): number { return this.elapsed; }

  /** Update the number of unlocked ability slots (curriculum learning). */
  setUnlockedAbilities(n: number): void { this.unlockedAbilities = n; }

  /** Flatten an observation into a float array for neural network input. */
  static flattenObservation(obs: EntityObservation): number[] {
    return [
      // Self — vitals & position
      obs.hpPct, obs.manaPct, obs.x, obs.z, obs.y, obs.rotY,
      // Self — CC & status
      obs.isStunned, obs.isSleeping, obs.isBlinded,
      obs.isDiscombobulated, obs.isUntargetable, obs.inCombat, obs.isResting,
      // Self — buff multipliers
      obs.speedMult, obs.dmgDealtMult, obs.dmgTakenMult,
      // Self — ability state
      ...obs.cooldowns,
      obs.gcdPct,
      obs.isCasting, obs.castPct, obs.isChanneling,
      // Opponent — vitals & position
      obs.oppHpPct, obs.oppManaPct, obs.oppRelX, obs.oppRelZ, obs.oppDistance, obs.oppRotY,
      // Opponent — CC & status
      obs.oppIsStunned, obs.oppIsSleeping, obs.oppIsBlinded,
      obs.oppIsDiscombobulated, obs.oppIsUntargetable, obs.oppIsResting,
      // Opponent — buff multipliers
      obs.oppSpeedMult, obs.oppDmgDealtMult, obs.oppDmgTakenMult,
      // Opponent — ability & movement
      obs.oppIsCasting, obs.oppCastPct, obs.oppIsChanneling, obs.oppIsMoving,
      // Spatial
      obs.oppLoS,
      ...obs.wallDist,
      // Dynamic map features
      obs.ewPillarUp, obs.nsPillarUp, obs.pillarPhasePct,
      // Temporal context
      obs.matchTimePct,
    ];
  }
}
