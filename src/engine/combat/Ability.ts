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
  readonly range?: number; // world units (use yardsToUnits() to define from yards); omit for self-buffs
  readonly manaCost: number;
  readonly cooldown: number; // seconds
  readonly damage: number; // base damage (non-crit)
  readonly damageMin?: number; // if present with damageMax, roll random damage in range
  readonly damageMax?: number;
  readonly requiresHostileTarget: boolean;
  readonly description: string;
  readonly appliesDebuff?: BuffDefinition;
  readonly appliesSelfBuff?: BuffDefinition;
  readonly bonusDamagePercent?: number; // conditional % increase (e.g. 125 = +125%)
  readonly bonusDamageRequiresDebuff?: string; // debuff id required for bonus
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

export const Mop: Ability = {
  id: 'mop',
  name: 'Mop',
  icon: '🧹',
  range: yardsToUnits(3),
  manaCost: 12,
  cooldown: 5,
  damage: 0,
  damageMin: 10,
  damageMax: 20,
  requiresHostileTarget: true,
  description:
    'Strikes the target with a dirty mop, dealing 10-20 damage. Damage is increased by 125% if the target has Covered in Piss.',
  bonusDamagePercent: 125,
  bonusDamageRequiresDebuff: 'covered-in-piss',
};

export const DebugStun: BuffDefinition = {
  id: 'debug-stun',
  name: 'Stunned',
  icon: '⭐',
  duration: 99999,
  type: 'debuff',
  description: 'Stunned.',
  effects: [{ type: 'stun', value: 0 }],
};

export const BigBootStun: BuffDefinition = {
  id: 'big-boot',
  name: 'Big Boot',
  icon: '🥾',
  duration: 3,
  type: 'debuff',
  description: 'Stunned.',
  effects: [{ type: 'stun', value: 0 }],
};

export const BigBoot: Ability = {
  id: 'big-boot',
  name: 'Big Boot',
  icon: '🥾',
  range: yardsToUnits(5),
  manaCost: 10,
  cooldown: 18,
  damage: 0,
  requiresHostileTarget: true,
  description:
    'Kick the target right in the neck, stunning them for 3 seconds.',
  appliesDebuff: BigBootStun,
};

export const FartBombDebuff: BuffDefinition = {
  id: 'fart-bomb',
  name: 'Fart Bomb',
  icon: '💨',
  duration: 8,
  type: 'debuff',
  description: 'Slowed by 30%, taking damage over time.',
  effects: [{ type: 'movementSpeedPercent', value: -30 }],
};

export const FartBomb: Ability = {
  id: 'fart-bomb',
  name: 'Fart Bomb',
  icon: '💨',
  manaCost: 10,
  cooldown: 8,
  damage: 0,
  requiresHostileTarget: false,
  description:
    'Emit a cloud of toxic gas that poisons and slows enemies by 30%. Deals 96 damage over 8 seconds.',
};

export const CrashOutBuff: BuffDefinition = {
  id: 'crash-out',
  name: 'Crash Out',
  icon: '😡',
  duration: 10,
  type: 'buff',
  description: 'Enraged. Auto-attack speed increased by 300%. Movement speed reduced by 20%.',
  effects: [
    { type: 'autoAttackSpeedPercent', value: 300 },
    { type: 'movementSpeedPercent', value: -20 },
  ],
};

export const CrashOut: Ability = {
  id: 'crash-out',
  name: 'Crash Out',
  icon: '😡',
  manaCost: 18,
  cooldown: 60,
  damage: 0,
  requiresHostileTarget: false,
  description:
    'Enrages The Janitor into a fit of fury, increasing auto-attack speed by 300% but slowing movement speed by 20% for 10 sec.',
  appliesSelfBuff: CrashOutBuff,
};
