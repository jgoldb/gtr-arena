import * as THREE from 'three';
import type { CharacterId } from '@gtr/shared';
import type { S2C_CooldownUpdate } from '@gtr/shared';
import { getCharacterStats, GLOBAL_COOLDOWN, abilityCooldown } from '@gtr/shared';
import type { ClientSoundManager } from './ClientSoundManager';

// ── Host interface ────────────────────────────────────────────────────

/** Host interface — ClientEngine provides mutable casting state and player access. */
export interface ClientAbilitySystemHost {
  readonly localEntityId: string;
  readonly sound: ClientSoundManager;

  // Player state
  getPlayerCharacterId(): CharacterId;
  getPlayerMana(): number;
  setPlayerMana(v: number): void;
  isPlayerMoving(): boolean;
  isPlayerGrounded(): boolean;
  isPlayerDead(): boolean;
  isPlayerStunned(): boolean;
  isPlayerCharging(): boolean;
  triggerAbilityAnimation(abilityId: string, targetPos?: THREE.Vector3): void;
  getEntityMeshPosition(entityId: string): THREE.Vector3 | undefined;

  // Mutable casting state (shared with stateSync)
  localCastingAbilityId: string | null;
  localCastingElapsed: number;
  localCastingTotalTime: number;
  localCastingIsChannel: boolean;

  // Local buff effects (for mana cost multiplier)
  getLocalBuffEffects(): ReadonlyArray<{ effects?: ReadonlyArray<{ type: string; value: number }> }>;

  // Callbacks
  onCooldownUpdate?: (abilityId: string, remaining: number, total: number) => void;
  onQueuedAbilityReady: ((abilityId: string) => void) | null;
  sendCancelCast(): void;
}

// ── ClientAbilitySystem ──────────────────────────────────────────────

export class ClientAbilitySystem {
  private readonly host: ClientAbilitySystemHost;

  // Cooldowns (local tracking from server updates)
  private cooldowns = new Map<string, { remaining: number; total: number }>();
  private gcd: { remaining: number; total: number } | null = null;

  // Ability queue — fires the queued ability the instant GCD/cast ends (like WoW's SpellQueueWindow)
  private static readonly QUEUE_WINDOW = 0.4; // 400ms
  private queuedAbility: { abilityId: string; targetEntityId: string | null; groundTarget?: { x: number; z: number } } | null = null;

  // Client-side ability prediction
  private static readonly PREDICTION_TIMEOUT = 0.5; // revert if no server response within 500ms
  private pendingPrediction: {
    abilityId: string;
    predictedAt: number;
    cooldownPredicted: boolean;
    castPredicted: boolean;
  } | null = null;

  constructor(host: ClientAbilitySystemHost) {
    this.host = host;
  }

  // ── Cooldown accessors ────────────────────────────────────────────

  getCooldownRemaining(abilityId: string): number {
    return this.cooldowns.get(abilityId)?.remaining ?? 0;
  }

  getCooldownTotal(abilityId: string): number {
    return this.cooldowns.get(abilityId)?.total ?? 0;
  }

  getGcdRemaining(): number {
    return this.gcd?.remaining ?? 0;
  }

  getGcdTotal(): number {
    return this.gcd?.total ?? 0;
  }

  // ── Server message handling ───────────────────────────────────────

  handleCooldownUpdate(msg: S2C_CooldownUpdate): void {
    if (msg.abilityId === '__gcd__') {
      this.gcd = { remaining: msg.remaining, total: msg.total };
      return;
    }
    this.cooldowns.set(msg.abilityId, { remaining: msg.remaining, total: msg.total });
    this.host.onCooldownUpdate?.(msg.abilityId, msg.remaining, msg.total);
  }

  // ── Ability queue ─────────────────────────────────────────────────

  /** Queue an ability to fire the instant GCD/cast ends. Replaces any existing queue. */
  queueAbility(abilityId: string, targetEntityId: string | null, groundTarget?: { x: number; z: number }): void {
    this.queuedAbility = { abilityId, targetEntityId, groundTarget };
  }

  clearAbilityQueue(): void {
    this.queuedAbility = null;
  }

  getQueuedAbilityId(): string | null {
    return this.queuedAbility?.abilityId ?? null;
  }

  /** Returns true if the remaining time is within the queue window. */
  isWithinQueueWindow(remaining: number): boolean {
    return remaining > 0 && remaining <= ClientAbilitySystem.QUEUE_WINDOW;
  }

  /** Check if the queued ability can fire (GCD done, not casting, not incapacitated). */
  private processAbilityQueue(): void {
    if (!this.queuedAbility) return;

    // Clear queue if player can't act
    if (this.host.isPlayerDead() || this.host.isPlayerStunned() || this.host.isPlayerCharging()) {
      this.queuedAbility = null;
      return;
    }

    // Still on GCD
    if (this.gcd && this.gcd.remaining > 0) return;

    // Still casting (non-channel blocks queue; channel doesn't block action bar)
    if (this.host.localCastingAbilityId && !this.host.localCastingIsChannel) return;

    // Ready to fire — use callback so main.ts handles target resolution & validation
    const { abilityId } = this.queuedAbility;
    this.queuedAbility = null;
    this.host.onQueuedAbilityReady?.(abilityId);
  }

  // ── Client-side ability prediction ────────────────────────────────

  /**
   * Optimistically predict ability effects locally before server confirms.
   * Call immediately before sendAbility(). Applies GCD, cooldown, mana, animation/cast bar.
   * Server response reconciles via handleCooldownUpdate/handleAbilityEffect/state deltas.
   */
  predictAbility(abilityId: string, targetEntityId: string | null): void {
    const stats = getCharacterStats(this.host.getPlayerCharacterId());
    const ability = stats.abilities.find(a => a !== null && a.id === abilityId);
    if (!ability) return;

    // Predict GCD (CC-immune abilities bypass GCD)
    if (!ability.usableWhileCCd) {
      this.gcd = { remaining: GLOBAL_COOLDOWN, total: GLOBAL_COOLDOWN };
    }

    // Predict ability cooldown
    let cooldownPredicted = false;
    const cd = abilityCooldown(ability);
    if (cd > 0) {
      this.cooldowns.set(abilityId, { remaining: cd, total: cd });
      this.host.onCooldownUpdate?.(abilityId, cd, cd);
      cooldownPredicted = true;
    }

    // Predict mana deduction
    const effectiveCost = Math.round(ability.manaCost * this.getManaCostMultiplier());
    if (effectiveCost > 0) {
      this.host.setPlayerMana(Math.max(0, this.host.getPlayerMana() - effectiveCost));
    }

    // Predict cast bar for cast-time abilities (only if not moving/falling — server rejects casts while moving)
    let castPredicted = false;
    if (ability.castTime && !this.host.isPlayerMoving() && this.host.isPlayerGrounded()) {
      this.host.sound.updateBandageLoop(this.host.localEntityId, this.host.localCastingAbilityId, abilityId);
      this.host.sound.updateCastSpellLoop(this.host.localEntityId, this.host.localCastingAbilityId, abilityId);
      this.host.localCastingAbilityId = abilityId;
      this.host.localCastingElapsed = 0;
      this.host.localCastingTotalTime = ability.castTime;
      this.host.localCastingIsChannel = !!ability.isChannel;
      castPredicted = true;
    }

    // Predict animation for instant-cast abilities (cast animations are driven by casting state)
    if (!ability.castTime) {
      const targetPos = targetEntityId ? this.host.getEntityMeshPosition(targetEntityId) : undefined;
      this.host.triggerAbilityAnimation(abilityId, targetPos);
    }

    this.pendingPrediction = {
      abilityId,
      predictedAt: performance.now(),
      cooldownPredicted,
      castPredicted,
    };
  }

  /**
   * Predict GCD/cooldown/mana for a ground-targeted ability (skip animation — projectile
   * animations are complex and rely on server-provided ground position).
   */
  predictGroundAbility(abilityId: string): void {
    const stats = getCharacterStats(this.host.getPlayerCharacterId());
    const ability = stats.abilities.find(a => a !== null && a.id === abilityId);
    if (!ability) return;

    if (!ability.usableWhileCCd) {
      this.gcd = { remaining: GLOBAL_COOLDOWN, total: GLOBAL_COOLDOWN };
    }

    let cooldownPredicted = false;
    const cd = abilityCooldown(ability);
    if (cd > 0) {
      this.cooldowns.set(abilityId, { remaining: cd, total: cd });
      this.host.onCooldownUpdate?.(abilityId, cd, cd);
      cooldownPredicted = true;
    }

    const effectiveCost = Math.round(ability.manaCost * this.getManaCostMultiplier());
    if (effectiveCost > 0) {
      this.host.setPlayerMana(Math.max(0, this.host.getPlayerMana() - effectiveCost));
    }

    this.pendingPrediction = {
      abilityId,
      predictedAt: performance.now(),
      cooldownPredicted,
      castPredicted: false,
    };
  }

  /**
   * Revert a pending prediction (called when server sends an error or prediction times out).
   * Mana and cooldowns are corrected naturally by server deltas within 1-2 ticks.
   * GCD and casting state need explicit revert since no server update will clear them.
   */
  revertPrediction(): void {
    if (!this.pendingPrediction) return;
    const pred = this.pendingPrediction;
    this.pendingPrediction = null;

    // Revert predicted GCD — server didn't trigger one
    this.gcd = null;

    // Revert predicted cooldown — server didn't set one
    if (pred.cooldownPredicted) {
      this.cooldowns.delete(pred.abilityId);
    }

    // Revert predicted cast bar
    if (pred.castPredicted && this.host.localCastingAbilityId === pred.abilityId) {
      this.host.sound.updateBandageLoop(this.host.localEntityId, this.host.localCastingAbilityId, null);
      this.host.sound.updateCastSpellLoop(this.host.localEntityId, this.host.localCastingAbilityId, null);
      this.host.localCastingAbilityId = null;
      this.host.localCastingElapsed = 0;
      this.host.localCastingTotalTime = 0;
      this.host.localCastingIsChannel = false;
    }

    // Mana: let server's next state delta correct it (within 50-100ms)
  }

  getManaCostMultiplier(): number {
    let mult = 1;
    for (const buff of this.host.getLocalBuffEffects()) {
      if (buff.effects) {
        for (const effect of buff.effects) {
          if (effect.type === 'manaCostPercent') mult += effect.value / 100;
        }
      }
    }
    return Math.max(0, mult);
  }

  // ── Prediction state queries (used by stateSync) ─────────────────

  /** Returns true if we have a pending cast prediction for this ability. */
  isPredictingCast(abilityId: string): boolean {
    return !!(this.pendingPrediction?.castPredicted && this.pendingPrediction.abilityId === abilityId);
  }

  /** Clear the pending prediction (server confirmed it). */
  clearPendingPrediction(): void {
    this.pendingPrediction = null;
  }

  /** Check if we have any pending prediction (for ability_effect reconciliation). */
  getPendingPredictionAbilityId(): string | null {
    return this.pendingPrediction?.abilityId ?? null;
  }

  // ── Client-driven casting ─────────────────────────────────────────

  /** Instantly cancel the local cast/channel. Resets GCD + clears placeholder cooldown for casts (not channels). */
  cancelCastLocally(): void {
    const abilityId = this.host.localCastingAbilityId;
    if (!abilityId) return;
    const wasChannel = this.host.localCastingIsChannel;

    // Clear sound loops
    this.host.sound.updateBandageLoop(this.host.localEntityId, abilityId, null);
    this.host.sound.updateCastSpellLoop(this.host.localEntityId, abilityId, null);

    // Clear casting state
    this.host.localCastingAbilityId = null;
    this.host.localCastingElapsed = 0;
    this.host.localCastingTotalTime = 0;
    this.host.localCastingIsChannel = false;

    // For non-channel casts: reset GCD and clear placeholder cooldown (mirrors CastingSystem.cancel)
    if (!wasChannel) {
      this.gcd = null;
      this.cooldowns.delete(abilityId);
    }

    // Clear pending prediction if it matches
    if (this.pendingPrediction?.abilityId === abilityId) {
      this.pendingPrediction = null;
    }
  }

  /** Local cast completed — clear cast bar. Server sends ability_effect for actual effects and real cooldown. */
  completeCastLocally(): void {
    const abilityId = this.host.localCastingAbilityId;
    if (!abilityId) return;
    const wasChannel = this.host.localCastingIsChannel;

    // Clear sound loops
    this.host.sound.updateBandageLoop(this.host.localEntityId, abilityId, null);
    this.host.sound.updateCastSpellLoop(this.host.localEntityId, abilityId, null);

    // Clear casting state
    this.host.localCastingAbilityId = null;
    this.host.localCastingElapsed = 0;
    this.host.localCastingTotalTime = 0;
    this.host.localCastingIsChannel = false;

    // Clear placeholder cooldown for non-channels (server will send real cooldown via cooldown_update)
    if (!wasChannel) {
      this.cooldowns.delete(abilityId);
    }

    // Clear pending prediction if it matches
    if (this.pendingPrediction?.abilityId === abilityId) {
      this.pendingPrediction = null;
    }
  }

  // ── Per-frame update ──────────────────────────────────────────────

  /** Tick casting, cooldowns, process queue, check prediction timeout. */
  update(dt: number): void {
    // Tick local casting and check cancel/completion
    if (this.host.localCastingAbilityId) {
      this.host.localCastingElapsed += dt;

      // Auto-cancel if player can't cast (moving, dead, stunned, falling)
      if (this.host.isPlayerDead() || this.host.isPlayerStunned() ||
          this.host.isPlayerMoving() || !this.host.isPlayerGrounded()) {
        this.cancelCastLocally();
        this.host.sendCancelCast();
      }
      // Check completion
      else if (this.host.localCastingElapsed >= this.host.localCastingTotalTime) {
        this.completeCastLocally();
      }
    }

    // Tick cooldowns
    for (const [id, cd] of this.cooldowns) {
      cd.remaining = Math.max(0, cd.remaining - dt);
      if (cd.remaining <= 0) this.cooldowns.delete(id);
    }
    if (this.gcd) {
      this.gcd.remaining -= dt;
      if (this.gcd.remaining <= 0) this.gcd = null;
    }

    // Process ability queue — fire queued ability the instant GCD/cast ends
    this.processAbilityQueue();

    // Revert prediction if server hasn't responded within timeout.
    // Cast-time predictions skip this — they're confirmed by ability_effect on completion
    // or reverted by server error. The timeout only applies to instant abilities.
    if (this.pendingPrediction &&
        !this.pendingPrediction.castPredicted &&
        performance.now() - this.pendingPrediction.predictedAt > ClientAbilitySystem.PREDICTION_TIMEOUT * 1000) {
      this.revertPrediction();
    }
  }

  /** Fast-forward cooldowns and casting after tab was backgrounded. */
  fastForward(gap: number): void {
    // Fast-forward casting elapsed
    if (this.host.localCastingAbilityId) {
      this.host.localCastingElapsed += gap;
      if (this.host.localCastingElapsed >= this.host.localCastingTotalTime) {
        this.completeCastLocally();
      }
    }

    for (const [id, cd] of this.cooldowns) {
      cd.remaining = Math.max(0, cd.remaining - gap);
      if (cd.remaining <= 0) this.cooldowns.delete(id);
    }
    if (this.gcd) {
      this.gcd.remaining -= gap;
      if (this.gcd.remaining <= 0) this.gcd = null;
    }
  }
}
