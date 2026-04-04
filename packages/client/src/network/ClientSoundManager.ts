import type { CharacterId } from '@gtr/shared';
import type { S2C_CombatEvent, S2C_AbilityEffect, S2C_Flinch } from '@gtr/shared';
import { getCharacterSfx, getSharedSfx } from '@gtr/shared';
import { soundEffects, type LoopHandle } from '../ui/SoundEffects';

// ── Host interface ────────────────────────────────────────────────────

/** Read-only view of an entity, as needed by the sound system. */
export interface SoundEntityView {
  readonly id: string;
  readonly characterId: string;
}

/** Host interface — ClientEngine provides spatial audio + entity lookups. */
export interface ClientSoundHost {
  readonly localEntityId: string;
  getLocalCharacterId(): CharacterId;
  getEntityCharacterId(entityId: string): CharacterId | undefined;
  distToEntity(entityId: string): number;
  panToEntity(entityId: string): number;
}

// ── ClientSoundManager ───────────────────────────────────────────────

export class ClientSoundManager {
  private readonly host: ClientSoundHost;

  // Per-entity toggle for alternating auto-attack SFX (e.g. Dr. Retardo flask/test tube)
  private aaSfxToggle = new Map<string, boolean>();

  // Bandage loop SFX (keyed by entity ID)
  private bandageLoops = new Map<string, LoopHandle>();

  // Dr. Retardo cast-spell loop SFX (keyed by entity ID)
  private castSpellLoops = new Map<string, LoopHandle>();

  constructor(host: ClientSoundHost) {
    this.host = host;
    soundEffects.init();
  }

  // ── Combat event SFX ──────────────────────────────────────────────

  playCombatEventSfx(msg: S2C_CombatEvent): void {
    // Auto-attack hit sounds
    if (msg.isAutoAttack && msg.amount > 0 && (msg.combatType === 'damage' || msg.combatType === 'crit')) {
      const charId = this.resolveCharacterId(msg.sourceEntityId);
      if (charId) {
        const sfx = getCharacterSfx(charId);
        let aaSfx = (msg.combatType === 'crit' && sfx?.autoAttackCrit) || sfx?.autoAttackHit;
        // Alternate between two auto-attack sounds when available
        if (msg.combatType !== 'crit' && sfx?.autoAttackHit2) {
          const toggle = this.aaSfxToggle.get(msg.sourceEntityId) ?? false;
          aaSfx = toggle ? sfx.autoAttackHit2 : sfx.autoAttackHit;
          this.aaSfxToggle.set(msg.sourceEntityId, !toggle);
        }
        if (aaSfx) this.playSpatial(aaSfx, msg.sourceEntityId);
      }
    }

    // Ability damage sounds
    const abilityHitMap: Record<string, (sfx: ReturnType<typeof getCharacterSfx>) => { url: string; volume: number } | undefined> = {
      'mop': (sfx) => sfx?.mop,
      'big-boot': (sfx) => sfx?.bigBoot,
      'jimmy-legs': (sfx) => sfx?.jimmyLegs,
    };
    if (msg.abilityId && msg.amount > 0 && (msg.combatType === 'damage' || msg.combatType === 'crit')) {
      const getter = abilityHitMap[msg.abilityId];
      if (getter) {
        const charId = this.resolveCharacterId(msg.sourceEntityId);
        if (charId) {
          const entry = getter(getCharacterSfx(charId));
          if (entry) this.playSpatial(entry, msg.sourceEntityId);
        }
      }
      // Bottle-chuck plays at target position, not source
      if (msg.abilityId === 'bottle-chuck') {
        const charId = this.resolveCharacterId(msg.sourceEntityId);
        if (charId) {
          const bcSfx = getCharacterSfx(charId)?.bottleChuck;
          if (bcSfx) this.playSpatial(bcSfx, msg.targetEntityId);
        }
      }
    }

    // Dodge SFX
    if (msg.combatType === 'dodge') {
      if (msg.targetEntityId === this.host.localEntityId) {
        const localDodgeSfx = getCharacterSfx(this.host.getLocalCharacterId())?.dodge;
        if (localDodgeSfx) soundEffects.play(localDodgeSfx.url, undefined, undefined, localDodgeSfx.volume);
      } else {
        const charId = this.host.getEntityCharacterId(msg.targetEntityId);
        if (charId) {
          const dodgeSfx = getCharacterSfx(charId)?.dodge;
          if (dodgeSfx) this.playSpatial(dodgeSfx, msg.targetEntityId);
        }
      }
    }
  }

  // ── Ability effect SFX ────────────────────────────────────────────

  playAbilityEffectSfx(msg: S2C_AbilityEffect): void {
    const charId = this.resolveCharacterId(msg.entityId);
    if (charId) {
      const sfx = getCharacterSfx(charId);
      // Map of ability ID → SFX entry getter
      const sfxMap: Record<string, { url: string; volume: number } | undefined> = {
        'crash-out': sfx?.crashOut,
        'bucket-splash': sfx?.bucketSplash,
        'fart-bomb': sfx?.fartBomb,
        'janitors-helper': sfx?.janitorsHelper,
        'sweep': sfx?.sweepStart,
        'sweep-finish': sfx?.sweepSpin,
        'chemical-spill': sfx?.chemicalSpill,
        'retard-strength': sfx?.retardStrength,
        'kaboom': sfx?.kaboom,
        'shank': sfx?.shank,
        'gank': sfx?.gank,
        'pocket-sand': sfx?.pocketSand,
        'sticky-fingers': sfx?.stickyFingers,
        'tweaker-sprint': sfx?.tweakerSprint,
        'crack-rock': sfx?.crackRock,
      };
      const entry = sfxMap[msg.abilityId];
      if (entry) this.playSpatial(entry, msg.entityId);

      // Discombobulate and crotch-rot play at target position
      if (msg.abilityId === 'discombobulate' && sfx?.discombobulate) {
        const spatialId = msg.targetId ?? msg.entityId;
        this.playSpatial(sfx.discombobulate, spatialId);
      }
      if (msg.abilityId === 'crotch-rot' && sfx?.crotchRot) {
        const spatialId = msg.targetId ?? msg.entityId;
        this.playSpatial(sfx.crotchRot, spatialId);
      }
    }

    // Shared SFX (all characters)
    if (msg.abilityId === 'pvp-trinket') {
      const trinketSfx = getSharedSfx().pvpTrinket;
      if (trinketSfx) this.playSpatial(trinketSfx, msg.entityId);
    }
  }

  // ── Flinch SFX ────────────────────────────────────────────────────

  playFlinchSfx(msg: S2C_Flinch): void {
    if (msg.entityId === this.host.localEntityId) {
      const localStruckSfx = getCharacterSfx(this.host.getLocalCharacterId())?.struck;
      if (localStruckSfx) soundEffects.play(localStruckSfx.url, undefined, undefined, localStruckSfx.volume);
    } else {
      const charId = this.host.getEntityCharacterId(msg.entityId);
      if (charId) {
        const struckSfx = getCharacterSfx(charId)?.struck;
        if (struckSfx) this.playSpatial(struckSfx, msg.entityId);
      }
    }
  }

  // ── Buff transition SFX ───────────────────────────────────────────

  /** Play struck SFX when rotten-crotch or od-stun is applied. */
  playBuffAppliedSfx(entityId: string, buffId: string): void {
    if (buffId === 'rotten-crotch' || buffId === 'od-stun') {
      const charId = this.resolveCharacterId(entityId);
      if (charId) {
        const struckSfx = getCharacterSfx(charId)?.struck;
        if (struckSfx) {
          if (entityId === this.host.localEntityId) {
            soundEffects.play(struckSfx.url, undefined, undefined, struckSfx.volume);
          } else {
            this.playSpatial(struckSfx, entityId);
          }
        }
      }
    }
  }

  // ── Cast loop management ──────────────────────────────────────────

  /** Start or stop the bandage loop SFX when an entity's castingAbilityId changes. */
  updateBandageLoop(entityId: string, prev: string | null, next: string | null): void {
    if (prev === next) return;
    if (prev === 'bandage') {
      const handle = this.bandageLoops.get(entityId);
      if (handle) { handle.stop(); this.bandageLoops.delete(entityId); }
    }
    if (next === 'bandage') {
      const sfx = getSharedSfx().bandage;
      if (sfx) {
        const dist = entityId === this.host.localEntityId ? undefined : this.host.distToEntity(entityId);
        const pan = entityId === this.host.localEntityId ? undefined : this.host.panToEntity(entityId);
        const handle = soundEffects.playLoop(sfx.url, dist, pan, sfx.volume, entityId);
        if (handle) this.bandageLoops.set(entityId, handle);
      }
    }
  }

  /** Start or stop Dr. Retardo's cast-spell loop SFX when casting state changes. */
  updateCastSpellLoop(entityId: string, prev: string | null, next: string | null): void {
    if (prev === next) return;
    const charId = this.resolveCharacterId(entityId);
    if (charId !== 'dr-retardo') return;
    if (prev && prev !== 'bandage') {
      const handle = this.castSpellLoops.get(entityId);
      if (handle) { handle.stop(); this.castSpellLoops.delete(entityId); }
    }
    if (next && next !== 'bandage') {
      const sfx = getSharedSfx().castSpell;
      if (sfx) {
        const dist = entityId === this.host.localEntityId ? undefined : this.host.distToEntity(entityId);
        const pan = entityId === this.host.localEntityId ? undefined : this.host.panToEntity(entityId);
        const handle = soundEffects.playLoop(sfx.url, dist, pan, sfx.volume, entityId);
        if (handle) this.castSpellLoops.set(entityId, handle);
      }
    }
  }

  // ── Spatial audio update ──────────────────────────────────────────

  /** Update spatial audio positions so sounds track entity movement. */
  updateSpatialPositions(): void {
    soundEffects.updateSpatialPositions((key) => {
      if (key === this.host.localEntityId) return null;
      return { distance: this.host.distToEntity(key), pan: this.host.panToEntity(key) };
    });
  }

  // ── Dumpster Dive emerge SFX ───────────────────────────────────────

  playDumpsterEmerge(entityId: string, characterId: CharacterId, phase: 1 | 2): void {
    const sfx = getCharacterSfx(characterId);
    const entry = phase === 1 ? sfx?.dumpsterDive1 : sfx?.dumpsterDive2;
    if (entry) this.playSpatial(entry, entityId);
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  destroy(): void {
    for (const handle of this.bandageLoops.values()) handle.stop();
    this.bandageLoops.clear();
    for (const handle of this.castSpellLoops.values()) handle.stop();
    this.castSpellLoops.clear();
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private resolveCharacterId(entityId: string): CharacterId | undefined {
    if (entityId === this.host.localEntityId) return this.host.getLocalCharacterId();
    return this.host.getEntityCharacterId(entityId);
  }

  private playSpatial(entry: { url: string; volume: number }, entityId: string): void {
    if (entityId === this.host.localEntityId) {
      soundEffects.play(entry.url, undefined, undefined, entry.volume);
    } else {
      soundEffects.play(entry.url, this.host.distToEntity(entityId), this.host.panToEntity(entityId), entry.volume, entityId);
    }
  }
}
