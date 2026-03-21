import type { Ability } from './abilities';
import {
  Sweep, BucketSplash, Mop, BigBoot, FartBomb, CrashOut,
  BottleChuck, Discombobulate, Chudmax, ChemicalSpill, RetardStrength, FullRetard,
} from './abilities';

export type CharacterId = 'janitor' | 'dr-retardo';

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
  abilities: readonly Ability[];
}

export interface CharacterInfo {
  id: CharacterId;
  name: string;
}

export const CHARACTER_LIST: CharacterInfo[] = [
  { id: 'janitor', name: 'The Janitor' },
  { id: 'dr-retardo', name: 'Dr. Retardo' },
];

export const CHARACTERS: Record<CharacterId, CharacterStats> = {
  'janitor': {
    id: 'janitor',
    displayName: 'The Janitor',
    baseMaxHp: 475,
    baseMaxMana: 48,
    autoAttackDamageMin: 11,
    autoAttackDamageMax: 19,
    autoAttackSpeed: 2.5,
    autoAttackRange: 1.8,
    critChance: 0.22,
    dodgeChance: 0.17,
    abilities: [Sweep, BucketSplash, Mop, BigBoot, FartBomb, CrashOut],
  },
  'dr-retardo': {
    id: 'dr-retardo',
    displayName: 'Dr. Retardo',
    baseMaxHp: 369,
    baseMaxMana: 125,
    autoAttackDamageMin: 3,
    autoAttackDamageMax: 6,
    autoAttackSpeed: 1.2,
    autoAttackRange: 1.8,
    critChance: 0.07,
    dodgeChance: 0.05,
    abilities: [BottleChuck, Discombobulate, Chudmax, ChemicalSpill, RetardStrength, FullRetard],
  },
};

export function getCharacterStats(id: CharacterId): CharacterStats {
  return CHARACTERS[id];
}
