import type { Ability, BuffDefinition } from './abilities.js';
import {
  Sweep, BucketSplash, Mop, BigBoot, FartBomb, CrashOut, JimmyLegs, JanitorsHelper,
  BottleChuck, Discombobulate, Chudmax, ChemicalSpill, RetardStrength, FullRetard, CrotchRot, Kaboom,
  Shank, PocketSand, StickyFingers, CrackRock, DumpsterDive, TweakerSprint, Gank, OD,
  Attack, PvPTrinket, Bandage,
  TweakingBuff,
  yardsToUnits,
} from './abilities.js';

export type CharacterId = 'janitor' | 'dr-retardo' | 'crackhead' | 'rabbi-zehnwirth' | 'brad-clemons' | 'gourd-of-war';

/** A sound effect entry: either a filename string (volume defaults to 1) or { file, volume }. */
export type SfxEntry = string | { file: string; volume?: number; loop?: boolean };

/** Resolved sound effect with full URL path and volume. */
export interface ResolvedSfx { url: string; volume: number; loop: boolean; }

export interface CharacterStats {
  id: CharacterId;
  displayName: string;
  baseMaxHp: number;
  baseMaxMana: number;
  autoAttackDamageMin: number;
  autoAttackDamageMax: number;
  autoAttackSpeed: number;  // seconds between swings
  autoAttackRange: number;  // world units
  critChance: number;
  dodgeChance: number;
  hpRegen: number;       // hp restored per regen tick
  manaRegen: number;     // mana restored per regen tick
  abilities: readonly (Ability | null)[];
  startingBuffs?: readonly BuffDefinition[];
  playgroundOnly?: boolean;
  soundEffects?: {
    autoAttackHit?: SfxEntry;
    autoAttackHit2?: SfxEntry;
    autoAttackCrit?: SfxEntry;
    struck?: SfxEntry;
    dodge?: SfxEntry;
    crashOut?: SfxEntry;
    bucketSplash?: SfxEntry;
    mop?: SfxEntry;
    bigBoot?: SfxEntry;
    fartBomb?: SfxEntry;
    bottleChuck?: SfxEntry;
    jimmyLegs?: SfxEntry;
    janitorsHelper?: SfxEntry;
    sweepStart?: SfxEntry;
    sweepSpin?: SfxEntry;
  };
}

export interface CharacterInfo {
  id: CharacterId;
  name: string;
  playgroundOnly?: boolean;
}

export const CHARACTERS: Record<CharacterId, CharacterStats> = {
  'janitor': {
    id: 'janitor',
    displayName: 'The Janitor',
    baseMaxHp: 3008,
    baseMaxMana: 1042,
    autoAttackDamageMin: 163,
    autoAttackDamageMax: 200,
    autoAttackSpeed: 2.5,
    autoAttackRange: 1.8,
    critChance: 0.25,
    dodgeChance: 0.17,
    hpRegen: 32,
    manaRegen: 12,
    abilities: [Attack, Sweep, BucketSplash, Mop, BigBoot, FartBomb, CrashOut, JimmyLegs, JanitorsHelper, PvPTrinket, Bandage],
    soundEffects: {
      autoAttackHit: 'auto-attack.ogg',
      autoAttackCrit: 'crit.ogg',
      struck: 'struck.ogg',
      dodge: 'dodge.ogg',
      crashOut: { file: 'crash-out.ogg', volume: 4 },
      bucketSplash: { file: 'bucket-splash.ogg', volume: 8 },
      mop: { file: 'mop.ogg', volume: 3 },
      bigBoot: { file: 'big-boot.ogg', volume: 3 },
      fartBomb: { file: 'fart-bomb.ogg', volume: 1.5 },
      jimmyLegs: { file: 'jimmy-legs.ogg', volume: 3 },
      janitorsHelper: { file: 'janitors-helper.ogg', volume: 3 },
      sweepStart: { file: 'sweep_1.ogg', volume: 3 },
      sweepSpin: { file: 'sweep_2.ogg', volume: 3 },
    },
  },
  'dr-retardo': {
    id: 'dr-retardo',
    displayName: 'Dr. Retardo',
    baseMaxHp: 2449,
    baseMaxMana: 4112,
    autoAttackDamageMin: 25,
    autoAttackDamageMax: 35,
    autoAttackSpeed: 1.5,
    autoAttackRange: 1.4,
    critChance: 0.07,
    dodgeChance: 0.05,
    hpRegen: 24,
    manaRegen: 48,
    abilities: [Attack, BottleChuck, Discombobulate, Chudmax, ChemicalSpill, RetardStrength, FullRetard, CrotchRot, Kaboom, PvPTrinket, Bandage],
    soundEffects: {
      autoAttackHit: { file: 'auto-attack1.ogg', volume: 3 },
      autoAttackHit2: { file: 'auto-attack2.ogg', volume: 3 },
      bottleChuck: { file: 'bottle-chuck.ogg', volume: 3 },
    },
  },
  'crackhead': {
    id: 'crackhead',
    displayName: 'Crackhead',
    baseMaxHp: 2188,
    baseMaxMana: 1232,
    autoAttackDamageMin: 130,
    autoAttackDamageMax: 170,
    autoAttackSpeed: 2.0,
    autoAttackRange: 1.8,
    critChance: 0.15,
    dodgeChance: 0.10,
    hpRegen: 28,
    manaRegen: 16,
    abilities: [Attack, Shank, PocketSand, StickyFingers, CrackRock, DumpsterDive, TweakerSprint, Gank, OD, PvPTrinket, Bandage],
    startingBuffs: [TweakingBuff],
  },
  'rabbi-zehnwirth': {
    id: 'rabbi-zehnwirth',
    displayName: 'Rabbi Zehnwirth',
    baseMaxHp: 2800,
    baseMaxMana: 1800,
    autoAttackDamageMin: 140,
    autoAttackDamageMax: 190,
    autoAttackSpeed: 2.5,
    autoAttackRange: 2.2,
    critChance: 0.12,
    dodgeChance: 0.15,
    hpRegen: 30,
    manaRegen: 20,
    abilities: [Attack, null, null, null, null, null, null, null, null, PvPTrinket, Bandage],
    playgroundOnly: true,
  },
  'brad-clemons': {
    id: 'brad-clemons',
    displayName: 'Brad Clemons',
    baseMaxHp: 3200,
    baseMaxMana: 1200,
    autoAttackDamageMin: 175,
    autoAttackDamageMax: 220,
    autoAttackSpeed: 2.4,
    autoAttackRange: yardsToUnits(20),
    critChance: 0.18,
    dodgeChance: 0.12,
    hpRegen: 35,
    manaRegen: 14,
    abilities: [Attack, null, null, null, null, null, null, null, null, PvPTrinket, Bandage],
    playgroundOnly: true,
  },
  'gourd-of-war': {
    id: 'gourd-of-war',
    displayName: 'Gourd of War',
    baseMaxHp: 3400,
    baseMaxMana: 1000,
    autoAttackDamageMin: 155,
    autoAttackDamageMax: 195,
    autoAttackSpeed: 2.3,
    autoAttackRange: 2.4,
    critChance: 0.15,
    dodgeChance: 0.10,
    hpRegen: 34,
    manaRegen: 12,
    abilities: [Attack, null, null, null, null, null, null, null, null, PvPTrinket, Bandage],
    playgroundOnly: true,
  },
};

export const CHARACTER_LIST: CharacterInfo[] = (Object.values(CHARACTERS) as CharacterStats[]).map(c => ({
  id: c.id,
  name: c.displayName,
  playgroundOnly: c.playgroundOnly,
}));

export function getCharacterStats(id: CharacterId): CharacterStats {
  return CHARACTERS[id];
}

export type ResolvedCharacterSfx = { [K in keyof NonNullable<CharacterStats['soundEffects']>]?: ResolvedSfx };

function resolveSfxEntry(base: string, entry: SfxEntry): ResolvedSfx {
  if (typeof entry === 'string') return { url: base + entry, volume: 1, loop: false };
  return { url: base + entry.file, volume: entry.volume ?? 1, loop: entry.loop ?? false };
}

/** Resolve short SFX filenames to full `/audio/sfx/abilities/{id}/` paths with volume. */
export function getCharacterSfx(id: CharacterId): ResolvedCharacterSfx | undefined {
  const sfx = CHARACTERS[id].soundEffects;
  if (!sfx) return undefined;
  const base = `/audio/sfx/abilities/${id}/`;
  const result: ResolvedCharacterSfx = {};
  for (const key of Object.keys(sfx) as (keyof typeof sfx)[]) {
    const entry = sfx[key];
    if (entry) result[key] = resolveSfxEntry(base, entry);
  }
  return result;
}

// ── Shared SFX (abilities used by all characters) ──

const SHARED_SFX_BASE = '/audio/sfx/abilities/shared/';

const SHARED_SFX_DEFS: Record<string, SfxEntry> = {
  pvpTrinket: { file: 'pvp-trinket.ogg', volume: 3 },
  bandage: { file: 'bandage.ogg', volume: 5, loop: true },
};

export type ResolvedSharedSfx = { [K in keyof typeof SHARED_SFX_DEFS]?: ResolvedSfx };

let _sharedSfxCache: ResolvedSharedSfx | undefined;

/** Resolve shared ability SFX (abilities common to all characters) from `/audio/sfx/abilities/shared/`. */
export function getSharedSfx(): ResolvedSharedSfx {
  if (_sharedSfxCache) return _sharedSfxCache;
  const result: ResolvedSharedSfx = {};
  for (const key of Object.keys(SHARED_SFX_DEFS)) {
    result[key] = resolveSfxEntry(SHARED_SFX_BASE, SHARED_SFX_DEFS[key]);
  }
  _sharedSfxCache = result;
  return result;
}

// ── Ranged auto-attack constants ──
/** Auto-attack ranges above this threshold are treated as ranged (projectile + travel time). */
export const MELEE_RANGE_THRESHOLD = yardsToUnits(5);
export const BULLET_SPEED = yardsToUnits(50);   // world units/sec (~0.4s at 20 yd)

export function isRangedAutoAttack(stats: CharacterStats): boolean {
  return stats.autoAttackRange > MELEE_RANGE_THRESHOLD;
}

// ── Regen constants (shared by client RegenSystem & ServerRegenSystem) ──

export const REGEN_TICK_INTERVAL = 2.5;       // seconds between regen ticks
export const MANA_REGEN_DELAY = 5;             // seconds after last mana use before regen resumes
export const RESTING_MANA_MULTIPLIER = 5;      // mana regen multiplier while resting (5x)
