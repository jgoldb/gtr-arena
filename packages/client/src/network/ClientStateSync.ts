import type { EntitySnapshot, EntityBuffSnapshot } from '@gtr/shared';
import type { EntityStateDelta } from '@gtr/shared';
import type { PlayerController } from '../engine/player/PlayerController';
import type { ClientSoundManager } from './ClientSoundManager';
import type { Targetable } from '../engine/types';

// ── Entity view ──────────────────────────────────────────────────────

/** Mutable view of a remote entity, as needed by the state sync system. */
export interface StateSyncRemoteEntity {
  readonly id: string;
  readonly team: number;
  readonly model: {
    setAbilityBuffActive(id: string, active: boolean): void;
    setResting(resting: boolean): void;
  };
  readonly targetable: Targetable;
  hp: number; maxHp: number; mana: number; maxMana: number;
  dead: boolean; inCombat: boolean; stunned: boolean; charging: boolean;
  isMoving: boolean; isAutoAttacking: boolean;
  castingAbilityId: string | null;
  castingElapsed: number; castingTotalTime: number; castingIsChannel: boolean;
  targetEntityId: string | null;
  disconnected: boolean;
  buffs: EntityBuffSnapshot['buffs'];
  drTimers: EntityBuffSnapshot['drTimers'];
}

// ── Host interface ────────────────────────────────────────────────────

/** Host interface — ClientEngine implements this to provide mutable state access. */
export interface ClientStateSyncHost {
  readonly localEntityId: string;
  readonly playerController: PlayerController;
  readonly sound: ClientSoundManager;
  getRemoteEntity(id: string): StateSyncRemoteEntity | undefined;

  // Mutable local casting state
  localCastingAbilityId: string | null;
  localCastingElapsed: number;
  localCastingTotalTime: number;
  localCastingIsChannel: boolean;
  localTargetEntityId: string | null;

  // Mutable local buff state
  localBuffs: EntityBuffSnapshot['buffs'];
  localDRTimers: EntityBuffSnapshot['drTimers'];

  // Resting state
  resting: boolean;
  restingSentAt: number;

  // Target state
  selectedTargetId: string | null;

  // Prediction — check and clear when server confirms
  isPredictingCast(abilityId: string): boolean;
  clearPendingPrediction(): void;
  clearQueuedAbility(): void;
  cancelCastFromServer(): void;

  // Actions
  selectTarget(target: Targetable | null): void;
  activateBlind(canvas: HTMLCanvasElement): void;
  deactivateBlind(): void;
  isBlinded(): boolean;
  getRendererCanvas(): HTMLCanvasElement;
  getLocalTeam(): number;

  // Callbacks
  onEnterCombat?: (entityId: string) => void;
  onLeaveCombat?: (entityId: string) => void;
  onBuffApplied?: (entityId: string, buff: { name: string; type: 'buff' | 'debuff' }) => void;
  onBuffExpired?: (entityId: string, buff: { name: string; type: 'buff' | 'debuff' }) => void;
}

// ── ClientStateSync ─────────────────────────────────────────────────

export class ClientStateSync {
  private readonly host: ClientStateSyncHost;

  constructor(host: ClientStateSyncHost) {
    this.host = host;
  }

  /** Apply state deltas to local player and remote entities. */
  applyEntityStateDeltas(deltas: EntityStateDelta[]): void {
    const { host } = this;
    for (const delta of deltas) {
      if (delta.id === host.localEntityId) {
        const pc = host.playerController;
        if (delta.hp !== undefined) pc.hp = delta.hp;
        if (delta.maxHp !== undefined) pc.maxHp = delta.maxHp;
        if (delta.mana !== undefined) pc.mana = delta.mana;
        if (delta.maxMana !== undefined) pc.maxMana = delta.maxMana;
        if (delta.dead !== undefined) {
          if (delta.dead && !pc.dead) { pc.die(); host.clearQueuedAbility(); }
          else if (!delta.dead && pc.dead) pc.respawn();
          pc.dead = delta.dead;
        }
        if (delta.inCombat !== undefined) {
          if (delta.inCombat && !pc.inCombat) host.onEnterCombat?.(delta.id);
          else if (!delta.inCombat && pc.inCombat) host.onLeaveCombat?.(delta.id);
          pc.inCombat = delta.inCombat;
        }
        if (delta.stunned !== undefined) { pc.stunned = delta.stunned; pc.setStunned(delta.stunned); if (delta.stunned) host.clearQueuedAbility(); }
        if (delta.charging !== undefined) pc.charging = delta.charging;
        if (delta.isAutoAttacking !== undefined) pc.setAutoAttacking(delta.isAutoAttacking);
        if ('castingAbilityId' in delta) {
          const serverAbilityId = delta.castingAbilityId!;
          const clientAbilityId = host.localCastingAbilityId;

          if (serverAbilityId && serverAbilityId === clientAbilityId) {
            // Server confirms the cast we're driving locally — clear prediction, keep client state
            if (host.isPredictingCast(serverAbilityId)) {
              host.clearPendingPrediction();
            }
          } else if (!serverAbilityId && clientAbilityId) {
            // Server rejected or interrupted our cast — cancel locally
            host.cancelCastFromServer();
          } else if (serverAbilityId && serverAbilityId !== clientAbilityId) {
            // Different cast or client isn't casting — accept server authority
            host.sound.updateBandageLoop(delta.id, clientAbilityId, serverAbilityId);
            host.sound.updateCastSpellLoop(delta.id, clientAbilityId, serverAbilityId);
            host.localCastingAbilityId = serverAbilityId;
          }
          // Server says null, client says null — no-op
        }
        // Accept totalTime changes (handles pushback from server)
        if (delta.castingTotalTime !== undefined) host.localCastingTotalTime = delta.castingTotalTime;
        // Ignore server elapsed/isChannel when client is driving the same cast
        if (delta.castingElapsed !== undefined && !host.localCastingAbilityId) {
          host.localCastingElapsed = delta.castingElapsed;
        }
        if (delta.castingIsChannel !== undefined && !host.localCastingAbilityId) {
          host.localCastingIsChannel = delta.castingIsChannel;
        }
        if ('targetEntityId' in delta) host.localTargetEntityId = delta.targetEntityId!;
        continue;
      }

      const entity = host.getRemoteEntity(delta.id);
      if (!entity) continue;

      // Detect cast start for auto-targeting
      const wasCasting = entity.castingAbilityId;

      if (delta.hp !== undefined) entity.hp = delta.hp;
      if (delta.maxHp !== undefined) entity.maxHp = delta.maxHp;
      if (delta.mana !== undefined) entity.mana = delta.mana;
      if (delta.maxMana !== undefined) entity.maxMana = delta.maxMana;
      if (delta.dead !== undefined) entity.dead = delta.dead;
      if (delta.inCombat !== undefined) entity.inCombat = delta.inCombat;
      if (delta.stunned !== undefined) entity.stunned = delta.stunned;
      if (delta.charging !== undefined) entity.charging = delta.charging;
      if (delta.isAutoAttacking !== undefined) entity.isAutoAttacking = delta.isAutoAttacking;
      if ('castingAbilityId' in delta) {
        host.sound.updateBandageLoop(delta.id, entity.castingAbilityId, delta.castingAbilityId!);
        host.sound.updateCastSpellLoop(delta.id, entity.castingAbilityId, delta.castingAbilityId!);
        entity.castingAbilityId = delta.castingAbilityId!;
      }
      if (delta.castingElapsed !== undefined) entity.castingElapsed = delta.castingElapsed;
      if (delta.castingTotalTime !== undefined) entity.castingTotalTime = delta.castingTotalTime;
      if (delta.castingIsChannel !== undefined) entity.castingIsChannel = delta.castingIsChannel;
      if ('targetEntityId' in delta) entity.targetEntityId = delta.targetEntityId!;
      if (delta.disconnected !== undefined) entity.disconnected = delta.disconnected;

      // Auto-target hostile entity that begins casting on us (not while blinded)
      if (!wasCasting && entity.castingAbilityId && entity.targetEntityId === host.localEntityId
          && !host.selectedTargetId && entity.team !== host.getLocalTeam() && !host.isBlinded()) {
        host.selectTarget(entity.targetable);
      }
    }
  }

  /** Apply full state from a keyframe snapshot to the local player. */
  applyLocalEntityState(snap: EntitySnapshot): void {
    const { host } = this;
    const pc = host.playerController;
    pc.hp = snap.hp;
    pc.maxHp = snap.maxHp;
    pc.mana = snap.mana;
    pc.maxMana = snap.maxMana;
    if (snap.dead && !pc.dead) pc.die();
    else if (!snap.dead && pc.dead) pc.respawn();
    pc.dead = snap.dead;
    pc.inCombat = snap.inCombat;
    pc.stunned = snap.stunned;
    pc.charging = snap.charging;
    pc.setAutoAttacking(snap.isAutoAttacking);
    pc.setStunned(snap.stunned);
    // If client is actively casting, preserve client-driven casting state (only accept totalTime for pushback).
    // Otherwise accept the keyframe's casting state.
    if (host.localCastingAbilityId) {
      host.localCastingTotalTime = snap.castingTotalTime;
    } else {
      host.sound.updateBandageLoop(snap.id, host.localCastingAbilityId, snap.castingAbilityId);
      host.sound.updateCastSpellLoop(snap.id, host.localCastingAbilityId, snap.castingAbilityId);
      host.localCastingAbilityId = snap.castingAbilityId;
      host.localCastingElapsed = snap.castingElapsed;
      host.localCastingTotalTime = snap.castingTotalTime;
      host.localCastingIsChannel = snap.castingIsChannel;
    }
    host.localTargetEntityId = snap.targetEntityId;
  }

  /** Apply full state from a keyframe snapshot to a remote entity. */
  applyRemoteEntityState(entity: StateSyncRemoteEntity, snap: EntitySnapshot): void {
    const { host } = this;
    entity.hp = snap.hp;
    entity.maxHp = snap.maxHp;
    entity.mana = snap.mana;
    entity.maxMana = snap.maxMana;
    entity.dead = snap.dead;
    entity.inCombat = snap.inCombat;
    entity.stunned = snap.stunned;
    entity.charging = snap.charging;
    entity.isMoving = snap.isMoving;
    entity.isAutoAttacking = snap.isAutoAttacking;
    host.sound.updateBandageLoop(snap.id, entity.castingAbilityId, snap.castingAbilityId);
    host.sound.updateCastSpellLoop(snap.id, entity.castingAbilityId, snap.castingAbilityId);
    entity.castingAbilityId = snap.castingAbilityId;
    entity.castingElapsed = snap.castingElapsed;
    entity.castingTotalTime = snap.castingTotalTime;
    entity.castingIsChannel = snap.castingIsChannel;
    entity.targetEntityId = snap.targetEntityId;
    entity.disconnected = snap.disconnected ?? false;
  }

  /** Apply buff updates to local player and remote entity visuals. */
  applyBuffUpdates(buffSnapshots: EntityBuffSnapshot[]): void {
    const { host } = this;
    for (const buffSnap of buffSnapshots) {
      if (buffSnap.entityId === host.localEntityId) {
        // Detect buff transitions for combat text
        const oldIds = new Set(host.localBuffs.map(b => b.id));
        const newIds = new Set(buffSnap.buffs.map(b => b.id));
        for (const b of buffSnap.buffs) {
          if (!oldIds.has(b.id)) {
            host.onBuffApplied?.(buffSnap.entityId, b);
            host.sound.playBuffAppliedSfx(buffSnap.entityId, b.id);
          }
        }
        for (const b of host.localBuffs) {
          if (!newIds.has(b.id)) host.onBuffExpired?.(buffSnap.entityId, b);
        }

        host.localBuffs = buffSnap.buffs;
        host.localDRTimers = buffSnap.drTimers;
        // Sync resting state from server — but ignore stale updates that arrive
        // before the server has processed our resting request (grace period 500ms)
        const restingGraceExpired = performance.now() - host.restingSentAt > 500;
        if (host.resting && restingGraceExpired && !host.localBuffs.some(b => b.id === 'resting')) {
          host.resting = false;
          host.playerController.setResting(false);
        }
        const hasBuff = (id: string) => host.localBuffs.some(b => b.id === id);
        host.playerController.setAbilityBuffActive('crash-out', hasBuff('crash-out'));
        host.playerController.setAbilityBuffActive('retard-strength', hasBuff('retard-strength'));
        host.playerController.setAbilityBuffActive('full-retard', hasBuff('full-retard'));
        host.playerController.setAbilityBuffActive('dumpster-diving', hasBuff('dumpster-diving'));
        host.playerController.setAbilityBuffActive('overdosing', hasBuff('overdosing'));
        host.playerController.setDiscombobulated(host.localBuffs.some(b => b.id === 'discombobulate'));

        // Blind: activate/deactivate effect, clear target on first application
        const isNowBlinded = host.localBuffs.some(b => b.id === 'blinded');
        if (isNowBlinded && !host.isBlinded()) {
          host.activateBlind(host.getRendererCanvas());
          host.selectTarget(null);
        } else if (!isNowBlinded && host.isBlinded()) {
          host.deactivateBlind();
        }
        continue;
      }
      const entity = host.getRemoteEntity(buffSnap.entityId);
      if (entity) {
        // Detect rotten-crotch / od-stun application for struck SFX
        if (
          (buffSnap.buffs.some(b => b.id === 'rotten-crotch') && !entity.buffs.some(b => b.id === 'rotten-crotch')) ||
          (buffSnap.buffs.some(b => b.id === 'od-stun') && !entity.buffs.some(b => b.id === 'od-stun'))
        ) {
          host.sound.playBuffAppliedSfx(entity.id, 'rotten-crotch');
        }
        entity.buffs = buffSnap.buffs;
        entity.drTimers = buffSnap.drTimers;
        const hasBuff = (id: string) => buffSnap.buffs.some(b => b.id === id);
        entity.model.setAbilityBuffActive('crash-out', hasBuff('crash-out'));
        entity.model.setAbilityBuffActive('retard-strength', hasBuff('retard-strength'));
        entity.model.setAbilityBuffActive('full-retard', hasBuff('full-retard'));
        const dumpsterDiving = hasBuff('dumpster-diving');
        if ('dumpsterDiveHostile' in entity.model) {
          (entity.model as any).dumpsterDiveHostile = dumpsterDiving && entity.team !== host.getLocalTeam();
        }
        entity.model.setAbilityBuffActive('dumpster-diving', dumpsterDiving);
        entity.model.setAbilityBuffActive('overdosing', hasBuff('overdosing'));
        entity.model.setResting(hasBuff('resting'));
      }
    }
  }
}
