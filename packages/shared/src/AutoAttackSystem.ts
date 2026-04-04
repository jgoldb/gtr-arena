import type { Positionable } from './types.js';
import { GLOBAL_COOLDOWN } from './abilities.js';
import { BULLET_SPEED } from './characters.js';
import { isFacingCheck } from './CombatLogic.js';

// ── Types ─────────────────────────────────────────────────────────────────

export interface AutoAttackState<T> {
  target: T;
  rangedResumeDelay: number;
  wasMoving: boolean;
}

export interface PendingProjectile<T> {
  attacker: T;
  target: T;
  damage: number;
  remainingTime: number;
}

// ── Callbacks ─────────────────────────────────────────────────────────────

export interface AutoAttackCallbacks<T extends Positionable> {
  // Position & orientation
  getPosition(entity: T): { x: number; y: number; z: number };
  getRotationY(entity: T): number;

  // State queries
  isMoving(entity: T): boolean;
  isCasting(entity: T): boolean;
  isUntargetable(entity: T): boolean;
  isRanged(entity: T): boolean;
  getAutoAttackSpeed(entity: T): number;
  /** Return the combined speed multiplier (buff + god-mode factor). */
  getAttackSpeedMultiplier(entity: T): number;
  rollDamage(entity: T): number;

  // Range & LoS
  hasLineOfSight(attacker: T, target: T): boolean;

  // Combat resolution
  /** Melee hit: apply damage immediately, return true if critical. */
  applyMeleeDamage(attacker: T, target: T, damage: number): boolean;
  /** Ranged projectile landed: apply damage (no dodge). */
  applyProjectileDamage(attacker: T, target: T, damage: number): void;

  // Events (optional)
  onSwing?(attacker: T, target: T, isRanged: boolean, isCrit: boolean): void;
  onAutoAttackError?(attacker: T, message: string): void;
  onStopped?(entity: T): void;
}

// ── System ────────────────────────────────────────────────────────────────

export class AutoAttackSystem<T extends Positionable> {
  private readonly attacks = new Map<T, AutoAttackState<T>>();
  private readonly swingTimers = new Map<T, number>();
  private readonly projectiles: PendingProjectile<T>[] = [];

  /** Extra range added to range checks (0 for client, yardsToUnits(1) for server). */
  rangeTolerance = 0;

  constructor(private readonly cb: AutoAttackCallbacks<T>) {}

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Begin auto-attacking a target. Does not reset the swing timer.
   * No-op if already attacking this target.
   */
  start(entity: T, target: T): void {
    const existing = this.attacks.get(entity);
    if (existing && existing.target === target) return;

    // Cap persisted timer to attack speed (prevents instant swing after long idle)
    const persisted = this.swingTimers.get(entity) ?? Infinity;
    const atkSpeed = this.cb.getAutoAttackSpeed(entity);
    this.swingTimers.set(entity, Math.min(persisted, atkSpeed));

    this.attacks.set(entity, {
      target,
      rangedResumeDelay: this.cb.isRanged(entity) ? GLOBAL_COOLDOWN : 0,
      wasMoving: this.cb.isMoving(entity),
    });
  }

  /** Stop auto-attacking. Preserves swing timer for next start(). */
  stop(entity: T): void {
    if (!this.attacks.has(entity)) return;
    this.attacks.delete(entity);
    this.cb.onStopped?.(entity);
  }

  /** Reset the swing timer to 0 (e.g. after ability use). */
  resetSwingTimer(entity: T): void {
    this.swingTimers.set(entity, 0);
  }

  /** Whether this entity is currently auto-attacking. */
  isAttacking(entity: T): boolean {
    return this.attacks.has(entity);
  }

  /** The current auto-attack target, or null. */
  getTarget(entity: T): T | null {
    return this.attacks.get(entity)?.target ?? null;
  }

  // ── Per-entity tick ─────────────────────────────────────────────────────

  /**
   * Update auto-attack for a single entity. Call once per tick per entity.
   * Always ticks the persistent swing timer, then processes swing logic if active.
   */
  update(entity: T, dt: number): void {
    // Always tick persistent swing timer (even when not attacking)
    const prevTimer = this.swingTimers.get(entity) ?? Infinity;
    this.swingTimers.set(entity, prevTimer + dt);

    const state = this.attacks.get(entity);
    if (!state) return;

    const { target } = state;

    // Stop conditions
    if (entity.dead || target.dead || !target.isHostileTo(entity)
        || this.cb.isUntargetable(target) || this.cb.isUntargetable(entity)) {
      this.stop(entity);
      return;
    }

    // Ranged: detect movement→stop transition and add GCD delay
    const isRanged = this.cb.isRanged(entity);
    const isMoving = this.cb.isMoving(entity);
    if (isRanged && state.wasMoving && !isMoving) {
      state.rangedResumeDelay = GLOBAL_COOLDOWN;
    }
    state.wasMoving = isMoving;
    if (state.rangedResumeDelay > 0) {
      state.rangedResumeDelay = Math.max(0, state.rangedResumeDelay - dt);
    }

    const timer = this.swingTimers.get(entity)!;
    const atkSpeedMult = this.cb.getAttackSpeedMultiplier(entity);
    const atkSpeed = this.cb.getAutoAttackSpeed(entity);

    if (timer < atkSpeed / atkSpeedMult) return;

    // Ranged: blocked while moving or during resume delay
    if (isRanged && (isMoving || state.rangedResumeDelay > 0)) return;

    // Don't swing while casting
    if (this.cb.isCasting(entity)) return;

    // Range check (3D distance)
    const ePos = this.cb.getPosition(entity);
    const tPos = this.cb.getPosition(target);
    const dx = ePos.x - tPos.x;
    const dy = ePos.y - tPos.y;
    const dz = ePos.z - tPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > entity.autoAttackRange + this.rangeTolerance) {
      this.swingTimers.set(entity, atkSpeed);
      return;
    }

    // LoS check
    if (!this.cb.hasLineOfSight(entity, target)) {
      this.swingTimers.set(entity, atkSpeed);
      this.cb.onAutoAttackError?.(entity, 'Not in line of sight');
      return;
    }

    // Facing check (120° cone)
    const toX = tPos.x - ePos.x;
    const toZ = tPos.z - ePos.z;
    const rotY = this.cb.getRotationY(entity);
    const fwdX = Math.sin(rotY);
    const fwdZ = Math.cos(rotY);
    if (!isFacingCheck(fwdX, fwdZ, toX, toZ)) {
      this.swingTimers.set(entity, 0);
      this.cb.onAutoAttackError?.(entity, 'Not facing target');
      return;
    }

    // Swing!
    this.swingTimers.set(entity, 0);
    const damage = this.cb.rollDamage(entity);

    if (isRanged) {
      const travelTime = dist / BULLET_SPEED;
      this.projectiles.push({ attacker: entity, target, damage, remainingTime: travelTime });
      this.cb.onSwing?.(entity, target, true, false);
    } else {
      const isCrit = this.cb.applyMeleeDamage(entity, target, damage);
      this.cb.onSwing?.(entity, target, false, isCrit);
    }
  }

  // ── Projectile tick ─────────────────────────────────────────────────────

  /** Tick all pending ranged projectiles. Call once per frame/tick. */
  updateProjectiles(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.remainingTime -= dt;
      if (p.remainingTime <= 0) {
        this.projectiles.splice(i, 1);
        if (!p.target.dead && !this.cb.isUntargetable(p.target)) {
          this.cb.applyProjectileDamage(p.attacker, p.target, p.damage);
        }
      }
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  /** Remove all state for an entity (on removal/death cleanup). */
  removeEntity(entity: T): void {
    this.attacks.delete(entity);
    this.swingTimers.delete(entity);
    // Remove attacks targeting this entity
    for (const [e, state] of this.attacks) {
      if (state.target === entity) {
        this.attacks.delete(e);
        this.cb.onStopped?.(e);
      }
    }
    // Remove projectiles involving this entity
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      if (p.attacker === entity || p.target === entity) {
        this.projectiles.splice(i, 1);
      }
    }
  }

  /** Remove all state. */
  clear(): void {
    this.attacks.clear();
    this.swingTimers.clear();
    this.projectiles.length = 0;
  }

  /** Read-only access to pending projectiles. */
  get pendingProjectiles(): readonly PendingProjectile<T>[] {
    return this.projectiles;
  }
}
