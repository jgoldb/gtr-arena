import type { BuffDefinition } from './BuffSystem';

// Distance conversion: 1 yard = 0.6 world units.
// Melee range (5 yd) = 3 world units, matching existing auto-attack ranges.
export const YARDS_TO_UNITS = 0.6;

export function yardsToUnits(yards: number): number {
  return yards * YARDS_TO_UNITS;
}

export interface Ability {
  readonly id: string;
  readonly name: string;
  readonly icon: string; // emoji or short label for the slot
  readonly range: number; // world units (use yardsToUnits() to define from yards)
  readonly manaCost: number;
  readonly cooldown: number; // seconds
  readonly damage: number; // base damage (non-crit)
  readonly requiresHostileTarget: boolean;
  readonly description: string;
  readonly appliesDebuff?: BuffDefinition;
}

export const CoveredInPiss: BuffDefinition = {
  id: 'covered-in-piss',
  name: 'Covered in Piss',
  icon: '💦',
  duration: 6,
  type: 'debuff',
  description: 'Increases auto-attack damage taken by 50%.',
  effects: [{ type: 'autoAttackDamageTakenPercent', value: 50 }],
};

export const BucketSplash: Ability = {
  id: 'bucket-splash',
  name: 'Bucket Splash',
  icon: '🪣',
  range: yardsToUnits(10),
  manaCost: 8,
  cooldown: 12,
  damage: 5,
  requiresHostileTarget: true,
  description:
    'Splashes dirty mop water onto the target, dealing 5 damage. Applies Covered in Piss for 6 sec, increasing auto-attack damage taken by 50%.',
  appliesDebuff: CoveredInPiss,
};
