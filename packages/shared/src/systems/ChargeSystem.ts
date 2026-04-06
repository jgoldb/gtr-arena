import { yardsToUnits } from '../abilities.js';

// ── State interfaces ─────────────────────────────────────────────────────

export interface ActiveSweepCharge<T> {
  entity: T;
  elapsed: number;
  duration: number;
  dirX: number;
  dirZ: number;
  speed: number;
  hitTargets: Set<T>;
  maxDamage: number;
  savedAutoAttackTarget: T | null;
}

export interface ActiveTweakerSprintCharge<T> {
  entity: T;
  elapsed: number;
  duration: number;
  dirX: number;
  dirZ: number;
  speed: number;
  hitTargets: Set<T>;
  damage: number;
  savedAutoAttackTarget: T | null;
}

export interface ActiveKnockback<T> {
  target: T;
  dirX: number;
  dirZ: number;
  distance: number;
  duration: number;
  elapsed: number;
}

// ── Callbacks ────────────────────────────────────────────────────────────

export interface ChargeCallbacks<T> {
  /** Return XZ position of the entity. */
  getPosition(entity: T): { x: number; z: number };
  /** Move entity by (dx, dz). Platform handles collision resolution. */
  moveEntity(entity: T, dx: number, dz: number): void;
  /** Return all entities that are valid charge hit targets for the given entity. */
  getHostileEntities(entity: T): T[];
  /** True if the entity cannot be targeted (e.g. in dumpster). */
  isUntargetable(entity: T): boolean;
  /** True if the entity is dead. */
  isDead(entity: T): boolean;
  /** Return entity's melee range in world units. */
  getAutoAttackRange(entity: T): number;
  /** Apply sweep damage from source to target. */
  applySweepDamage(source: T, target: T, damage: number): void;
  /** Apply the Tweaker Sprint slow debuff to target. */
  applyTweakerSprintSlow(target: T): void;
  /** Enter combat for entity. */
  enterCombat(entity: T): void;
  /** Apply knockback landing stun. */
  applyKnockbackStun(target: T): void;
  /** Called when a sweep charge finishes. Platform handles animation, SFX, auto-attack re-engage. */
  onSweepChargeEnd(entity: T, savedAutoAttackTarget: T | null, hitCount: number): void;
  /** Called when a tweaker sprint charge finishes. Platform handles auto-attack re-engage. */
  onTweakerSprintChargeEnd(entity: T, savedAutoAttackTarget: T | null): void;
  /** Called when a knockback is created (e.g. server broadcasts knockback event). */
  onKnockbackCreated?(target: T, kb: ActiveKnockback<T>): void;
  /** Called when a knockback finishes (after stun is applied). Platform handles position reset, visual cleanup. */
  onKnockbackEnd?(target: T): void;
  /** Move entity along knockback direction. Separate from moveEntity so platform can handle Y arc, collision, etc. */
  moveKnockbackTarget(target: T, dirX: number, dirZ: number, speed: number, dt: number, t: number): void;
}

// ── Kaboom constants ─────────────────────────────────────────────────────

export const KABOOM_CONE_RANGE = yardsToUnits(8);
export const KABOOM_CONE_HALF_ANGLE = Math.PI / 6; // 60° total cone (30° each side)
export const KABOOM_KNOCKBACK_DISTANCE = yardsToUnits(8);
export const KABOOM_KNOCKBACK_DURATION = 0.5; // seconds

// ── ChargeSystem ─────────────────────────────────────────────────────────

export class ChargeSystem<T> {
  readonly sweepCharges = new Map<T, ActiveSweepCharge<T>>();
  readonly tweakerSprintCharges = new Map<T, ActiveTweakerSprintCharge<T>>();
  readonly activeKnockbacks: ActiveKnockback<T>[] = [];

  constructor(private readonly callbacks: ChargeCallbacks<T>) {}

  // ── Sweep charge ─────────────────────────────────────────────────────

  startSweepCharge(
    entity: T,
    dirX: number,
    dirZ: number,
    speed: number,
    duration: number,
    maxDamage: number,
    savedAutoAttackTarget: T | null,
  ): ActiveSweepCharge<T> {
    const charge: ActiveSweepCharge<T> = {
      entity,
      elapsed: 0,
      duration,
      dirX,
      dirZ,
      speed,
      hitTargets: new Set(),
      maxDamage,
      savedAutoAttackTarget,
    };
    this.sweepCharges.set(entity, charge);
    return charge;
  }

  private updateSweepCharge(entity: T, charge: ActiveSweepCharge<T>, dt: number): void {
    charge.elapsed += dt;

    // Move entity forward
    this.callbacks.moveEntity(entity, charge.dirX * charge.speed * dt, charge.dirZ * charge.speed * dt);

    // Hit detection
    const hitRadius = 1.0; // world units (~1.67 yards)
    const pos = this.callbacks.getPosition(entity);
    for (const other of this.callbacks.getHostileEntities(entity)) {
      if (this.callbacks.isDead(other) || charge.hitTargets.has(other) || this.callbacks.isUntargetable(other)) continue;
      const otherPos = this.callbacks.getPosition(other);
      const dx = pos.x - otherPos.x;
      const dz = pos.z - otherPos.z;
      if (Math.sqrt(dx * dx + dz * dz) <= hitRadius) {
        charge.hitTargets.add(other);
        // Damage scales linearly: 0% at t=0, 100% at t=duration
        const damagePercent = Math.min(1, charge.elapsed / charge.duration);
        const baseDamage = Math.round(charge.maxDamage * damagePercent);
        if (baseDamage > 0) {
          this.callbacks.applySweepDamage(entity, other, baseDamage);
        }
      }
    }

    // End charge
    if (charge.elapsed >= charge.duration) {
      // AoE burst at end: full damage to all hostiles in melee range
      const meleeRange = this.callbacks.getAutoAttackRange(entity);
      const endPos = this.callbacks.getPosition(entity);
      for (const other of this.callbacks.getHostileEntities(entity)) {
        if (this.callbacks.isDead(other) || this.callbacks.isUntargetable(other)) continue;
        const otherPos = this.callbacks.getPosition(other);
        const dx = endPos.x - otherPos.x;
        const dz = endPos.z - otherPos.z;
        if (Math.sqrt(dx * dx + dz * dz) <= meleeRange) {
          this.callbacks.applySweepDamage(entity, other, charge.maxDamage);
        }
      }

      this.callbacks.onSweepChargeEnd(entity, charge.savedAutoAttackTarget, charge.hitTargets.size);
      this.sweepCharges.delete(entity);
    }
  }

  // ── Tweaker Sprint charge ────────────────────────────────────────────

  startTweakerSprintCharge(
    entity: T,
    dirX: number,
    dirZ: number,
    speed: number,
    duration: number,
    damage: number,
    savedAutoAttackTarget: T | null,
  ): ActiveTweakerSprintCharge<T> {
    const charge: ActiveTweakerSprintCharge<T> = {
      entity,
      elapsed: 0,
      duration,
      dirX,
      dirZ,
      speed,
      hitTargets: new Set(),
      damage,
      savedAutoAttackTarget,
    };
    this.tweakerSprintCharges.set(entity, charge);
    return charge;
  }

  private updateTweakerSprintCharge(entity: T, charge: ActiveTweakerSprintCharge<T>, dt: number): void {
    charge.elapsed += dt;

    // Move entity toward target
    this.callbacks.moveEntity(entity, charge.dirX * charge.speed * dt, charge.dirZ * charge.speed * dt);

    // Hit detection: flat damage + slow debuff
    const hitRadius = 1.0;
    const pos = this.callbacks.getPosition(entity);
    for (const other of this.callbacks.getHostileEntities(entity)) {
      if (this.callbacks.isDead(other) || charge.hitTargets.has(other) || this.callbacks.isUntargetable(other)) continue;
      const otherPos = this.callbacks.getPosition(other);
      const dx = pos.x - otherPos.x;
      const dz = pos.z - otherPos.z;
      if (Math.sqrt(dx * dx + dz * dz) <= hitRadius) {
        charge.hitTargets.add(other);
        this.callbacks.applySweepDamage(entity, other, charge.damage);
        this.callbacks.applyTweakerSprintSlow(other);
      }
    }

    // End charge
    if (charge.elapsed >= charge.duration) {
      this.callbacks.onTweakerSprintChargeEnd(entity, charge.savedAutoAttackTarget);
      this.tweakerSprintCharges.delete(entity);
    }
  }

  // ── Kaboom cone AoE ──────────────────────────────────────────────────

  /**
   * Execute a kaboom cone AoE from the entity, knocking back all hostiles
   * within the cone. Returns the knockbacks created.
   */
  executeKaboom(entity: T, rotationY: number): ActiveKnockback<T>[] {
    const forwardX = Math.sin(rotationY);
    const forwardZ = Math.cos(rotationY);
    const range = KABOOM_CONE_RANGE;
    const cosHalf = Math.cos(KABOOM_CONE_HALF_ANGLE);
    const pos = this.callbacks.getPosition(entity);
    const created: ActiveKnockback<T>[] = [];

    for (const other of this.callbacks.getHostileEntities(entity)) {
      if (this.callbacks.isDead(other) || this.callbacks.isUntargetable(other)) continue;
      const otherPos = this.callbacks.getPosition(other);
      const dx = otherPos.x - pos.x;
      const dz = otherPos.z - pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > range || dist < 0.01) continue;

      // Cone angle check
      const toTargetX = dx / dist;
      const toTargetZ = dz / dist;
      const dot = forwardX * toTargetX + forwardZ * toTargetZ;
      if (dot < cosHalf) continue;

      // Target is in cone — knock them back
      this.callbacks.enterCombat(entity);
      this.callbacks.enterCombat(other);

      const kb: ActiveKnockback<T> = {
        target: other,
        dirX: toTargetX,
        dirZ: toTargetZ,
        distance: KABOOM_KNOCKBACK_DISTANCE,
        duration: KABOOM_KNOCKBACK_DURATION,
        elapsed: 0,
      };
      this.activeKnockbacks.push(kb);
      created.push(kb);
      this.callbacks.onKnockbackCreated?.(other, kb);
    }

    return created;
  }

  // ── Knockback update ─────────────────────────────────────────────────

  private updateKnockbacks(dt: number): void {
    for (let i = this.activeKnockbacks.length - 1; i >= 0; i--) {
      const kb = this.activeKnockbacks[i];
      kb.elapsed += dt;
      const t = Math.min(1, kb.elapsed / kb.duration);

      // Move target along knockback direction
      const speed = kb.distance / kb.duration;
      this.callbacks.moveKnockbackTarget(kb.target, kb.dirX, kb.dirZ, speed, dt, t);

      if (t >= 1) {
        this.callbacks.applyKnockbackStun(kb.target);
        this.callbacks.onKnockbackEnd?.(kb.target);
        this.activeKnockbacks.splice(i, 1);
      }
    }
  }

  // ── Charge cancellation ──────────────────────────────────────────────

  /** Cancel all charges for the given entity (e.g. on stun or disconnect). */
  cancelCharges(entity: T): boolean {
    let had = false;
    if (this.sweepCharges.has(entity)) {
      this.sweepCharges.delete(entity);
      had = true;
    }
    if (this.tweakerSprintCharges.has(entity)) {
      this.tweakerSprintCharges.delete(entity);
      had = true;
    }
    return had;
  }

  /** Check if the entity currently has an active charge. */
  isCharging(entity: T): boolean {
    return this.sweepCharges.has(entity) || this.tweakerSprintCharges.has(entity);
  }

  /** Remove all state related to an entity (charges + knockbacks targeting them). */
  removeEntity(entity: T): void {
    this.sweepCharges.delete(entity);
    this.tweakerSprintCharges.delete(entity);
    // Remove knockbacks targeting this entity
    for (let i = this.activeKnockbacks.length - 1; i >= 0; i--) {
      if (this.activeKnockbacks[i].target === entity) {
        this.activeKnockbacks.splice(i, 1);
      }
    }
  }

  // ── Main update ──────────────────────────────────────────────────────

  update(dt: number): void {
    for (const [entity, charge] of this.sweepCharges) {
      this.updateSweepCharge(entity, charge, dt);
    }
    for (const [entity, charge] of this.tweakerSprintCharges) {
      this.updateTweakerSprintCharge(entity, charge, dt);
    }
    this.updateKnockbacks(dt);
  }
}
