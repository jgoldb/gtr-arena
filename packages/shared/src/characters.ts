import type { Ability, BuffDefinition } from './abilities.js';
import {
  Sweep, BucketSplash, Mop, BigBoot, FartBomb, CrashOut, JimmyLegs, JanitorsHelper,
  BottleChuck, Discombobulate, Chudmax, ChemicalSpill, RetardStrength, FullRetard, CrotchRot, Kaboom,
  Shank, PocketSand,
  TweakingBuff,
} from './abilities.js';

export type CharacterId = 'janitor' | 'dr-retardo' | 'crackhead';

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
  abilities: readonly Ability[];
  startingBuffs?: readonly BuffDefinition[];
  playgroundOnly?: boolean;
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
    abilities: [Sweep, BucketSplash, Mop, BigBoot, FartBomb, CrashOut, JimmyLegs, JanitorsHelper],
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
    abilities: [BottleChuck, Discombobulate, Chudmax, ChemicalSpill, RetardStrength, FullRetard, CrotchRot, Kaboom],
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
    abilities: [Shank, PocketSand],
    startingBuffs: [TweakingBuff],
    playgroundOnly: false,
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

// ── Regen constants (shared by client RegenSystem & ServerRegenSystem) ──

export const REGEN_TICK_INTERVAL = 2.5;       // seconds between regen ticks
export const MANA_REGEN_DELAY = 5;             // seconds after last mana use before regen resumes
export const RESTING_MANA_MULTIPLIER = 5;      // mana regen multiplier while resting (5x)
