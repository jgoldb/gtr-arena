/**
 * HeadlessArena — gym-style simulation environment for RL training.
 *
 * No Three.js, no rendering, no sound. Runs combat at maximum speed.
 * Exposes reset() / step() API for training harnesses.
 *
 * V1 simplifications:
 * - Flat arena (no obstacles, always LoS, ground Y = 0)
 * - 1v1 only
 * - No navigation / pathfinding
 * - No channeled abilities (bandage, chudmax) — instant-only for now
 * - No ground-targeted abilities (bottle chuck)
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
  yardsToUnits,
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
} from '@gtr/shared';
import { HeadlessEntity } from './HeadlessEntity.js';
import { HeadlessCombat } from './HeadlessCombat.js';

// ── Action / Observation Types ───────────────────────────────────────────

export interface AgentAction {
  /** Index into the entity's abilities array (null = no ability this tick). */
  abilityIndex: number | null;
  /** Movement: angle in radians (0 = +Z, pi/2 = +X). null = stand still. */
  moveAngle: number | null;
  /** Movement speed factor 0–1 (usually 1 = full speed, 0 = stand still). */
  moveSpeed: number;
}

export interface EntityObservation {
  // Self
  hpPct: number;
  manaPct: number;
  x: number;
  z: number;
  rotY: number;
  isStunned: number;
  isBlinded: number;
  inCombat: number;
  cooldowns: number[];  // normalized 0–1 per ability slot
  gcdPct: number;
  // Opponent (relative)
  oppHpPct: number;
  oppManaPct: number;
  oppRelX: number;     // relative position
  oppRelZ: number;
  oppDistance: number;
  oppRotY: number;
  oppIsStunned: number;
  oppIsBlinded: number;
  oppIsCasting: number;
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
  /** Arena half-size in world units (default 18, ~30 yards). */
  arenaSize?: number;
  /** Fixed simulation timestep in seconds (default 0.1 = 10 Hz). */
  tickRate?: number;
  /** Max match duration in seconds before draw (default 120). */
  maxDuration?: number;
}

// ── Arena ────────────────────────────────────────────────────────────────

const DEFAULT_ARENA_SIZE = yardsToUnits(30);
const DEFAULT_TICK_RATE = 0.1;
const DEFAULT_MAX_DURATION = 120;

export class HeadlessArena {
  // Config
  private arenaSize: number;
  private tickRate: number;
  private maxDuration: number;

  // Entities
  readonly entities: [HeadlessEntity, HeadlessEntity];

  // Systems
  private buffSystem: BuffSystem<HeadlessEntity>;
  private regenSystem: RegenSystem<HeadlessEntity>;
  private combat: HeadlessCombat;
  private autoAttack: AutoAttackSystem<HeadlessEntity>;
  private gasCloudSystem: GasCloudSystem<HeadlessEntity>;
  private dotSystem: DotSystem<HeadlessEntity>;
  private chemPoolSystem: ChemicalPoolSystem<HeadlessEntity>;
  private chargeSystem: ChargeSystem<HeadlessEntity>;
  private fullRetardAura: FullRetardAuraSystem<HeadlessEntity>;

  // State
  private elapsed = 0;
  private done = false;
  private winner = 0;

  // Reward accumulators (reset each step)
  private damageDealt: [number, number] = [0, 0];
  private damageTaken: [number, number] = [0, 0];
  private healingDone: [number, number] = [0, 0];

  constructor(config: ArenaConfig) {
    this.arenaSize = config.arenaSize ?? DEFAULT_ARENA_SIZE;
    this.tickRate = config.tickRate ?? DEFAULT_TICK_RATE;
    this.maxDuration = config.maxDuration ?? DEFAULT_MAX_DURATION;

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
      hasLineOfSight: () => true, // flat arena, always LoS
      applyMeleeDamage: (a, t, dmg) => this.combat.applyAutoAttackDamage(a, t, dmg),
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
        e.x = this.clampX(e.x + dx);
        e.z = this.clampZ(e.z + dz);
      },
      getHostileEntities: (e) => this.entities.filter(o => o.isHostileTo(e) && !o.dead),
      isUntargetable: (e) => this.buffSystem.isUntargetable(e),
      isDead: (e) => e.dead,
      getAutoAttackRange: (e) => e.autoAttackRange,
      applySweepDamage: (source, target, damage) => this.combat.applySweepDamage(source, target, damage),
      applyTweakerSprintSlow: (target) => {
        this.buffSystem.apply(target, TweakerSprintSlow);
      },
      enterCombat: (e) => this.combat.enterCombat(e),
      applyKnockbackStun: (target) => {
        this.buffSystem.apply(target, KaboomStun);
      },
      onSweepChargeEnd: (entity, savedTarget) => {
        if (savedTarget && !savedTarget.dead) entity.autoAttackTarget = savedTarget;
      },
      onTweakerSprintChargeEnd: (entity, savedTarget) => {
        if (savedTarget && !savedTarget.dead) entity.autoAttackTarget = savedTarget;
      },
      moveKnockbackTarget: (target, dirX, dirZ, speed, dt, _t) => {
        target.x = this.clampX(target.x + dirX * speed * dt);
        target.z = this.clampZ(target.z + dirZ * speed * dt);
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
  }

  // ── Bounds ─────────────────────────────────────────────────────────────

  private clampX(x: number): number {
    return Math.max(-this.arenaSize, Math.min(this.arenaSize, x));
  }

  private clampZ(z: number): number {
    return Math.max(-this.arenaSize, Math.min(this.arenaSize, z));
  }

  // ── Reset ──────────────────────────────────────────────────────────────

  reset(): [EntityObservation, EntityObservation] {
    this.elapsed = 0;
    this.done = false;
    this.winner = 0;
    this.damageDealt = [0, 0];
    this.damageTaken = [0, 0];
    this.healingDone = [0, 0];

    // Reset entities to spawn positions
    const spawnDist = this.arenaSize * 0.4;
    this.entities[0].respawn(-spawnDist, 0);
    this.entities[0].rotY = Math.PI / 2; // face right
    this.entities[1].respawn(spawnDist, 0);
    this.entities[1].rotY = -Math.PI / 2; // face left

    // Clear all system state
    this.buffSystem.clearEntity(this.entities[0]);
    this.buffSystem.clearEntity(this.entities[1]);
    this.combat.clearEntity(this.entities[0]);
    this.combat.clearEntity(this.entities[1]);
    this.autoAttack.stop(this.entities[0]);
    this.autoAttack.stop(this.entities[1]);
    this.gasCloudSystem.clouds.length = 0;
    this.dotSystem.dots.length = 0;
    this.chemPoolSystem.pools.length = 0;

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

    // Reset per-step accumulators
    this.damageDealt = [0, 0];
    this.damageTaken = [0, 0];
    this.healingDone = [0, 0];

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
        const stats = getCharacterStats(entity.characterId);
        const baseSpeed = yardsToUnits(8); // ~8 yd/s base run speed
        const speedMult = this.buffSystem.getMovementSpeedMultiplier(entity);
        const speed = baseSpeed * speedMult * action.moveSpeed;
        const dx = Math.sin(action.moveAngle) * speed * dt;
        const dz = Math.cos(action.moveAngle) * speed * dt;
        entity.x = this.clampX(entity.x + dx);
        entity.z = this.clampZ(entity.z + dz);
        entity.isMoving = true;
      } else {
        entity.isMoving = false;
      }

      // Blinded entities wander randomly
      if (entity.blinded) {
        const wanderAngle = Math.random() * Math.PI * 2;
        const speed = yardsToUnits(3) * dt;
        entity.x = this.clampX(entity.x + Math.sin(wanderAngle) * speed);
        entity.z = this.clampZ(entity.z + Math.cos(wanderAngle) * speed);
        entity.isMoving = true;
        entity.autoAttackTarget = null;
        continue;
      }

      // ── Face opponent (auto) ──────────────────────────────────
      if (!opponent.dead) {
        entity.faceToward(opponent);
      }

      // ── Ability usage ─────────────────────────────────────────
      if (action.abilityIndex !== null) {
        const ability = entity.abilities[action.abilityIndex];
        if (ability && !ability.isAutoAttack) {
          // Determine target
          let target: HeadlessEntity | null = null;
          if (ability.requiresHostileTarget) {
            target = opponent;
          } else if (ability.requiresTarget && !ability.requiresFriendlyTarget) {
            target = entity; // self-target
          } else if (ability.requiresFriendlyTarget) {
            target = entity; // self-heal
          }

          const result = this.combat.useAbility(ability, entity, target);
          if (result.success) {
            this.handleAbilityPostEffects(entity, ability, target, opponent);
          }
        }
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
      this.autoAttack.update(e, dt);
    }
    this.autoAttack.updateProjectiles(dt);
    this.chargeSystem.update(dt);
    this.gasCloudSystem.update(dt);
    this.chemPoolSystem.update(dt);
    this.dotSystem.update(dt);
    this.fullRetardAura.update(dt);
    this.combat.update(dt);
    this.buffSystem.update(dt);
    this.regenSystem.update(dt);

    // Re-sync CC state after tick
    for (const e of this.entities) {
      e.stunned = this.buffSystem.isStunned(e) || this.buffSystem.isSleeping(e);
      e.blinded = this.buffSystem.isBlinded(e);
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
      // Shaping rewards (small, scaled to ~0.01 per significant event)
      rewards[i] += this.damageDealt[i] * 0.00005;
      rewards[i] -= this.damageTaken[i] * 0.00003;
      rewards[i] += this.healingDone[i] * 0.00003;
    }
    // Terminal rewards
    if (this.done) {
      if (this.winner === 1) { rewards[0] += 1; rewards[1] -= 1; }
      else if (this.winner === 2) { rewards[0] -= 1; rewards[1] += 1; }
      // Draw: small penalty for both
      else { rewards[0] -= 0.2; rewards[1] -= 0.2; }
    }

    return {
      observations: this.buildObservations(),
      rewards,
      done: this.done,
      winner: this.winner,
      time: this.elapsed,
    };
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

  // ── Observations ───────────────────────────────────────────────────────

  private buildObservations(): [EntityObservation, EntityObservation] {
    return [
      this.buildObservation(0),
      this.buildObservation(1),
    ];
  }

  private buildObservation(entityIndex: number): EntityObservation {
    const self = this.entities[entityIndex];
    const opp = this.entities[1 - entityIndex];
    const stats = getCharacterStats(self.characterId);

    return {
      hpPct: self.maxHp > 0 ? self.hp / self.maxHp : 0,
      manaPct: self.maxMana > 0 ? self.mana / self.maxMana : 0,
      x: self.x / this.arenaSize,  // normalized to [-1, 1]
      z: self.z / this.arenaSize,
      rotY: self.rotY / Math.PI,   // normalized to [-1, 1]
      isStunned: self.stunned ? 1 : 0,
      isBlinded: self.blinded ? 1 : 0,
      inCombat: self.inCombat ? 1 : 0,
      cooldowns: self.cooldowns.getCooldownVector(stats.abilities),
      gcdPct: self.cooldowns.getGcdRemaining() / 0.75,

      oppHpPct: opp.maxHp > 0 ? opp.hp / opp.maxHp : 0,
      oppManaPct: opp.maxMana > 0 ? opp.mana / opp.maxMana : 0,
      oppRelX: (opp.x - self.x) / this.arenaSize,
      oppRelZ: (opp.z - self.z) / this.arenaSize,
      oppDistance: self.distanceTo(opp) / (this.arenaSize * 2),
      oppRotY: opp.rotY / Math.PI,
      oppIsStunned: opp.stunned ? 1 : 0,
      oppIsBlinded: opp.blinded ? 1 : 0,
      oppIsCasting: opp.castingAbilityName !== null ? 1 : 0,
    };
  }

  // ── Utilities ──────────────────────────────────────────────────────────

  get isDone(): boolean { return this.done; }
  get matchWinner(): number { return this.winner; }
  get matchTime(): number { return this.elapsed; }

  /** Flatten an observation into a float array for neural network input. */
  static flattenObservation(obs: EntityObservation): number[] {
    return [
      obs.hpPct, obs.manaPct, obs.x, obs.z, obs.rotY,
      obs.isStunned, obs.isBlinded, obs.inCombat,
      ...obs.cooldowns,
      obs.gcdPct,
      obs.oppHpPct, obs.oppManaPct, obs.oppRelX, obs.oppRelZ, obs.oppDistance,
      obs.oppRotY, obs.oppIsStunned, obs.oppIsBlinded, obs.oppIsCasting,
    ];
  }
}
