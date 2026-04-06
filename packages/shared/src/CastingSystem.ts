import type { Positionable } from './types.js';
import type { Ability, BuffDefinition } from './abilities.js';
import { RecentlyBandagedDebuff, abilityCooldown } from './abilities.js';

// ── Types ─────────────────────────────────────────────────────────────────

export interface CastingState<T> {
  ability: Ability;
  target: T | null;
  elapsed: number;
  totalTime: number;
  originalCastTime: number;
  isChannel: boolean;
  tickInterval: number;
  ticksDelivered: number;
  damageMultiplier: number; // snapshotted at channel start for buff consistency
}

export const CAST_PUSHBACK_SECONDS = 0.5;
export const INTERRUPT_COOLDOWN_SECONDS = 1;

// ── Callbacks ─────────────────────────────────────────────────────────────

export interface CastingCallbacks<T extends Positionable> {
  // Queries
  isGodMode(entity: T): boolean;
  /** Return true if the entity should have its cast cancelled (dead, stunned, moving, falling, etc.) */
  shouldCancel(entity: T): boolean;
  getPosition(entity: T): { x: number; z: number };

  // Buff system
  getManaCostMultiplier(entity: T): number;
  getDamageDealtMultiplier(entity: T): number;
  applyBuff(target: T, def: BuffDefinition): boolean;
  removeBuff(target: T, buffId: string, silent?: boolean): void;
  setBuffRemaining(target: T, buffId: string, remaining: number): void;

  // Resources & cooldowns
  consumeMana(entity: T, amount: number): void;
  notifyManaUsed(entity: T): void;
  triggerGcd(entity: T): void;
  resetGcd(entity: T): void;
  setCooldown(entity: T, abilityId: string, duration: number): void;
  clearCooldown(entity: T, abilityId: string): void;

  // Combat
  rollMiss(): boolean;
  enterCombat(entity: T): void;
  applyHeal(healer: T, target: T, amount: number): void;
  applyChannelTickDamage(attacker: T, target: T, damage: number, multiplier: number): void;
  useAbility(entity: T, ability: Ability, target: T | null): { success: boolean; errorMessage?: string };

  // Events (optional)
  onHostileAction?(attacker: T, target: T): void;
  onChannelMiss?(attacker: T, target: T): void;
  onCastCompleted?(entity: T, ability: Ability, target: T | null, result: { success: boolean; errorMessage?: string }): void;
  /** Fires whenever a cast/channel ends (cancel, completion, or channel expiry). Use for SFX cleanup etc. */
  onCastEnded?(entity: T, ability: Ability, wasChannel: boolean): void;
}

// ── System ────────────────────────────────────────────────────────────────

export class CastingSystem<T extends Positionable> {
  private states = new Map<T, CastingState<T>>();
  /** Extra range tolerance added to channel range checks (e.g. for lag compensation on the server). */
  rangeTolerance = 0;

  constructor(private readonly cb: CastingCallbacks<T>) {}

  /**
   * Begin a cast or channel. The caller must validate the ability (range, facing, cooldown, etc.)
   * before calling this — `start` handles GCD, mana, channel aura, and state creation.
   *
   * @returns `{ started: true }` on success, or `{ started: false, errorMessage }` on failure.
   *          `missed` is true if a hostile channel roll missed (cast consumed resources but won't tick).
   */
  start(entity: T, ability: Ability, target: T | null): { started: boolean; errorMessage?: string; missed?: boolean } {
    if (this.states.has(entity)) {
      return { started: false, errorMessage: 'Already casting' };
    }
    if (this.cb.shouldCancel(entity)) {
      return { started: false, errorMessage: 'Cannot cast while moving' };
    }

    const godMode = this.cb.isGodMode(entity);

    // GCD at cast/channel start (skip for off-GCD abilities)
    if (!ability.offGcd) {
      this.cb.triggerGcd(entity);
    }

    const isChannel = ability.isChannel ?? false;

    // ── Channel-specific pre-cast ──
    if (isChannel) {
      if (!godMode) {
        const effectiveCost = Math.round(ability.manaCost * this.cb.getManaCostMultiplier(entity));
        this.cb.consumeMana(entity, effectiveCost);
        if (effectiveCost > 0) this.cb.notifyManaUsed(entity);
        this.cb.setCooldown(entity, ability.id, abilityCooldown(ability));
      }

      if (target && target.isHostileTo(entity)) {
        this.cb.onHostileAction?.(entity, target);
        this.cb.enterCombat(entity);
        this.cb.enterCombat(target);
        if (this.cb.rollMiss()) {
          this.cb.onChannelMiss?.(entity, target);
          return { started: true, missed: true };
        }
      }
    }

    // ── Non-channel: placeholder interrupt cooldown (real one set on completion) ──
    if (!isChannel && !godMode) {
      this.cb.setCooldown(entity, ability.id, INTERRUPT_COOLDOWN_SECONDS);
    }

    // ── Create state ──
    this.states.set(entity, {
      ability,
      target,
      elapsed: 0,
      totalTime: ability.castTime!,
      originalCastTime: ability.castTime!,
      isChannel,
      tickInterval: isChannel ? ability.castTime! / ability.channelTicks! : 0,
      ticksDelivered: 0,
      damageMultiplier: isChannel ? this.cb.getDamageDealtMultiplier(entity) : 1,
    });

    // ── Bandage: apply "Recently Bandaged" debuff ──
    if (isChannel && target && ability.id === 'bandage') {
      this.cb.applyBuff(target, RecentlyBandagedDebuff);
    }

    // ── Channel aura on target ──
    if (isChannel && target) {
      const isFriendly = !target.isHostileTo(entity);
      this.cb.applyBuff(target, {
        id: `channel-${ability.id}`,
        name: ability.name,
        icon: ability.icon,
        duration: ability.castTime!,
        type: isFriendly ? 'buff' : 'debuff',
        description: ability.description,
        effects: [],
        unremovable: true,
      });
    }

    return { started: true };
  }

  /** Cancel an active cast/channel. Removes channel aura and clears state. */
  cancel(entity: T): void {
    const casting = this.states.get(entity);
    if (!casting) return;
    this.removeChannelAura(casting);
    // Reset GCD when a cast-time ability is canceled (not channels — they already consumed resources)
    if (!casting.isChannel) {
      this.cb.resetGcd(entity);
      this.cb.clearCooldown(entity, casting.ability.id);
    }
    this.states.delete(entity);
    this.cb.onCastEnded?.(entity, casting.ability, casting.isChannel);
  }

  /** Advance the casting state for one entity. Handles cancellation, tick delivery, and completion. */
  update(entity: T, dt: number): void {
    const casting = this.states.get(entity);
    if (!casting) return;

    casting.elapsed += dt;

    // Cancel if dead, stunned, moving, falling, etc.
    if (this.cb.shouldCancel(entity)) {
      this.cancel(entity);
      return;
    }

    // Validate target mid-cast/channel
    if (casting.ability.requiresHostileTarget || casting.ability.requiresTarget) {
      const ct = casting.target;
      if (!ct || ct.dead) {
        this.cancel(entity);
        return;
      }
      // Channels cancel on out-of-range; regular casts check at completion
      if (casting.isChannel && casting.ability.range) {
        const ePos = this.cb.getPosition(entity);
        const tPos = this.cb.getPosition(ct);
        const dx = ePos.x - tPos.x;
        const dz = ePos.z - tPos.z;
        if (Math.sqrt(dx * dx + dz * dz) > casting.ability.range + this.rangeTolerance) {
          this.cancel(entity);
          return;
        }
      }
    }

    // ── Channel tick delivery & completion ──
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
        this.cb.setBuffRemaining(casting.target, `channel-${casting.ability.id}`, remaining);
      }

      // Channel ends when elapsed reaches totalTime
      if (casting.elapsed >= casting.totalTime) {
        this.removeChannelAura(casting);
        const { ability } = casting;
        this.states.delete(entity);
        this.cb.onCastEnded?.(entity, ability, true);
      }
      return;
    }

    // ── Regular cast completion ──
    if (casting.elapsed >= casting.totalTime) {
      const { ability, target } = casting;
      this.states.delete(entity);
      this.cb.clearCooldown(entity, ability.id);
      const result = this.cb.useAbility(entity, ability, target);
      this.cb.onCastEnded?.(entity, ability, false);
      this.cb.onCastCompleted?.(entity, ability, target, result);
    }
  }

  /** Apply pushback from direct damage. Channels lose 35% of full duration; casts gain 0.5s (capped at 2x). */
  applyPushback(entity: T): void {
    const casting = this.states.get(entity);
    if (!casting) return;
    if (casting.isChannel) {
      // Channel pushback: lose 35% of full channel duration per hit (WoW-style)
      casting.totalTime = Math.max(casting.elapsed, casting.totalTime - casting.originalCastTime * 0.35);
    } else {
      // Cast pushback: increase cast time (capped at 2x original)
      const maxTime = casting.originalCastTime * 2;
      casting.totalTime = Math.min(casting.totalTime + CAST_PUSHBACK_SECONDS, maxTime);
    }
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  isCasting(entity: T): boolean {
    return this.states.has(entity);
  }

  isChanneling(entity: T): boolean {
    const state = this.states.get(entity);
    return state !== undefined && state.isChannel;
  }

  getState(entity: T): CastingState<T> | null {
    return this.states.get(entity) ?? null;
  }

  /** Remove all casting states. */
  clear(): void {
    this.states.clear();
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private removeChannelAura(casting: CastingState<T>): void {
    if (!casting.isChannel || !casting.target) return;
    this.cb.removeBuff(casting.target, `channel-${casting.ability.id}`, true);
  }

  private deliverChannelTick(entity: T, casting: CastingState<T>): void {
    if (!casting.target || casting.target.dead) return;
    const { ability, target } = casting;
    const isFriendly = !target.isHostileTo(entity);

    if (isFriendly && ability.healAmount) {
      const healPerTick = Math.round(ability.healAmount / ability.channelTicks! * casting.damageMultiplier);
      this.cb.applyHeal(entity, target, healPerTick);
      // Healing someone in combat puts the healer in combat (but not self-heals)
      if (target !== entity && target.inCombat) {
        this.cb.enterCombat(entity);
      }
    } else if (!isFriendly && ability.damage > 0) {
      const damagePerTick = Math.round(ability.damage / ability.channelTicks!);
      this.cb.applyChannelTickDamage(entity, target, damagePerTick, casting.damageMultiplier);
    }
  }
}
