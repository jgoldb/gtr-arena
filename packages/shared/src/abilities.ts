// ── Distance conversion ─────────────────────────────────────────────────
// 1 yard = 0.6 world units.
// Melee range (5 yd) = 3 world units, matching existing auto-attack ranges.
export const YARDS_TO_UNITS = 0.6;

export function yardsToUnits(yards: number): number {
  return yards * YARDS_TO_UNITS;
}

// ── Buff/debuff system types ────────────────────────────────────────────

export interface BuffEffect {
  readonly type: 'autoAttackDamageTakenPercent' | 'autoAttackSpeedPercent' | 'movementSpeedPercent' | 'stun' | 'sleep' | 'discombobulate' | 'damageDealtPercent' | 'manaCostPercent';
  readonly value: number; // e.g. 50 = +50%, -20 = -20%
}

export interface BuffDefinition {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly duration: number; // seconds
  readonly type: 'buff' | 'debuff';
  readonly description: string;
  readonly effects: readonly BuffEffect[];
  readonly shieldAmount?: number;         // absorption shield HP
  readonly shieldReflectPercent?: number;  // % of incoming damage reflected to attacker
  readonly unremovable?: boolean;          // true = cannot be right-click cancelled by player
  readonly drCategory?: string;            // diminishing returns category (e.g. 'root', 'stun')
}

// ── Diminishing Returns ───────────────────────────────────────────────

export const DR_RESET_TIMER = 20; // seconds until DR resets
export const DR_MULTIPLIERS = [1, 0.5, 0.25, 0] as const; // 0 = immune

// ── Ability type ────────────────────────────────────────────────────────

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
  readonly requiresTarget?: boolean; // needs any target (hostile or friendly)
  readonly castTime?: number; // seconds; omit for instant-cast abilities
  readonly isChannel?: boolean; // true = channeled ability (bar drains, ticks periodically)
  readonly channelTicks?: number; // number of ticks during channel
  readonly healAmount?: number; // total healing over channel (for friendly targets)
  readonly description: string;
  readonly appliesDebuff?: BuffDefinition;
  readonly appliesSelfBuff?: BuffDefinition;
  readonly bonusDamagePercent?: number; // conditional % increase (e.g. 125 = +125%)
  readonly bonusDamageRequiresDebuff?: string; // debuff id required for bonus
  readonly chargeDuration?: number; // seconds — for charge abilities (e.g. Sweep)
  readonly chargeSpeed?: number; // world units/sec
  readonly chargeMaxDamage?: number; // max damage at full distance
  readonly groundTargeted?: boolean; // ability targets a ground location (click-to-place AoE)
  readonly aoeRadius?: number; // world units — radius of the AoE effect
}

// ── Buff definitions ────────────────────────────────────────────────────

export const CoveredInPiss: BuffDefinition = {
  id: 'covered-in-piss',
  name: 'Covered in Piss',
  icon: '💦',
  duration: 6,
  type: 'debuff',
  description: 'Increases auto-attack damage taken by 50%.',
  effects: [{ type: 'autoAttackDamageTakenPercent', value: 50 }],
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

export const FartBombDebuff: BuffDefinition = {
  id: 'fart-bomb',
  name: 'Fart Bomb',
  icon: '💨',
  duration: Infinity,
  type: 'debuff',
  description: 'Slowed by 30%, taking damage over time.',
  effects: [{ type: 'movementSpeedPercent', value: -30 }],
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

export const DiscombobulateDebuff: BuffDefinition = {
  id: 'discombobulate',
  name: 'Discombobulate',
  icon: '🌀',
  duration: 5,
  type: 'debuff',
  description: 'Randomized character movement.',
  effects: [{ type: 'discombobulate', value: 0 }],
};

export const ChemicalSpillSpeedBuff: BuffDefinition = {
  id: 'chemical-spill-speed',
  name: 'Chemical Spill',
  icon: '🧪',
  duration: 4,
  type: 'buff',
  description: 'Movement speed increased by 40%.',
  effects: [{ type: 'movementSpeedPercent', value: 40 }],
};

export const ChemicalSpillDot: BuffDefinition = {
  id: 'chemical-spill-dot',
  name: 'Chemical Spill',
  icon: '🧪',
  duration: 6,
  type: 'debuff',
  description: 'Taking 200 damage every 2 seconds from mysterious chemicals.',
  effects: [],
};

export const RetardStrengthBuff: BuffDefinition = {
  id: 'retard-strength',
  name: 'Retard Strength',
  icon: '💪',
  duration: 5,
  type: 'buff',
  description: 'Damage and healing dealt increased by 50%. Absorbs up to 500 damage. Reflects 50% of damage taken.',
  effects: [{ type: 'damageDealtPercent', value: 50 }],
  shieldAmount: 500,
  shieldReflectPercent: 50,
};

export const FullRetardBuff: BuffDefinition = {
  id: 'full-retard',
  name: 'Full Retard',
  icon: '🤯',
  duration: 8,
  type: 'buff',
  description: 'Deals damage to all enemies and heals all friendlies in melee range.',
  effects: [],
};

export const RestingBuff: BuffDefinition = {
  id: 'resting',
  name: 'Resting',
  icon: '💤',
  duration: Infinity,
  type: 'buff',
  description: 'Recovering mana at an increased rate. Any movement or damage taken will cancel this effect.',
  effects: [],
};

export const CrotchRotDot: BuffDefinition = {
  id: 'crotch-rot',
  name: 'Crotch Rot',
  icon: '🦠',
  duration: 9,
  type: 'debuff',
  description: 'Taking 180 damage every 3 seconds. Stuns for 2 seconds when effect ends.',
  effects: [],
};

export const RottenCrotchStun: BuffDefinition = {
  id: 'rotten-crotch',
  name: 'Rotten Crotch',
  icon: '🤢',
  duration: 2,
  type: 'debuff',
  description: 'Stunned by a thoroughly rotten crotch.',
  effects: [{ type: 'stun', value: 0 }],
};

export const JimmyLegsDebuff: BuffDefinition = {
  id: 'jimmy-legs',
  name: 'Jimmy Legs',
  icon: '🦵',
  duration: 5,
  type: 'debuff',
  description: 'Movement speed slowed by 50%.',
  effects: [{ type: 'movementSpeedPercent', value: -50 }],
};

export const JimmyLegdDebuff: BuffDefinition = {
  id: 'jimmy-legd',
  name: "Jimmy Leg'd",
  icon: '🦵',
  duration: 2,
  type: 'debuff',
  description: 'Immobilized.',
  effects: [{ type: 'movementSpeedPercent', value: -100 }],
  drCategory: 'root',
};

export const KaboomStun: BuffDefinition = {
  id: 'kaboom-stun',
  name: 'Kaboom!',
  icon: '💥',
  duration: 1,
  type: 'debuff',
  description: 'Knocked down by an explosion. Stunned.',
  effects: [{ type: 'stun', value: 0 }],
};

export const ArenaPreparationBuff: BuffDefinition = {
  id: 'arena-preparation',
  name: 'Arena Preparation',
  icon: '⚔️',
  duration: Infinity,
  type: 'buff',
  description: 'Preparing for arena combat. Mana cost of all abilities reduced by 100%.',
  effects: [{ type: 'manaCostPercent', value: -100 }],
  unremovable: true,
};

export const JanitorsHelperDebuff: BuffDefinition = {
  id: 'janitors-helper',
  name: "Janitor's Helper",
  icon: '😴',
  duration: 10,
  type: 'debuff',
  description: 'Knocked out cold.',
  effects: [{ type: 'sleep', value: 0 }],
  drCategory: 'sleep',
};

// ── Ability definitions ─────────────────────────────────────────────────

export const Sweep: Ability = {
  id: 'sweep',
  name: 'Sweep',
  icon: '🌪️',
  manaCost: 130,
  cooldown: 10,
  damage: 409,
  requiresHostileTarget: false,
  chargeDuration: 0.714,
  chargeSpeed: yardsToUnits(28), // 28 yards/sec — covers 20 yards in ~0.714s
  chargeMaxDamage: 409,
  description:
    'Thrust forward with incredible ferocity, dealing damage to anyone in your way. Damage increases with distance. At the end, deals extra damage to targets within melee range.',
};

export const BucketSplash: Ability = {
  id: 'bucket-splash',
  name: 'Bucket Splash',
  icon: '🪣',
  range: yardsToUnits(10),
  manaCost: 65,
  cooldown: 6,
  damage: 0,
  damageMin: 25,
  damageMax: 35,
  requiresHostileTarget: true,
  description:
    'Splashes dirty mop water onto the target, dealing 25-35 damage. Applies Covered in Piss for 6 sec, increasing auto-attack damage taken by 50%.',
  appliesDebuff: CoveredInPiss,
};

export const Mop: Ability = {
  id: 'mop',
  name: 'Mop',
  icon: '🧹',
  range: yardsToUnits(3),
  manaCost: 30,
  cooldown: 4,
  damage: 0,
  damageMin: 100,
  damageMax: 116,
  requiresHostileTarget: true,
  description:
    'Strikes the target with a dirty mop, dealing 100-116 damage. Damage is increased by 125% if the target has Covered in Piss.',
  bonusDamagePercent: 125,
  bonusDamageRequiresDebuff: 'covered-in-piss',
};

export const BigBoot: Ability = {
  id: 'big-boot',
  name: 'Big Boot',
  icon: '🥾',
  range: yardsToUnits(5),
  manaCost: 180,
  cooldown: 18,
  damage: 50,
  requiresHostileTarget: true,
  description:
    'Kick the target right in the neck, dealing 50 damage and stunning for 3 seconds.',
  appliesDebuff: BigBootStun,
};

export const FartBomb: Ability = {
  id: 'fart-bomb',
  name: 'Fart Bomb',
  icon: '💨',
  manaCost: 140,
  cooldown: 8,
  damage: 0,
  requiresHostileTarget: false,
  description:
    'Emit a cloud of toxic gas that poisons and slows enemies by 30%. Deals 592 damage over 8 seconds.',
};

export const CrashOut: Ability = {
  id: 'crash-out',
  name: 'Crash Out',
  icon: '😡',
  manaCost: 280,
  cooldown: 60,
  damage: 0,
  requiresHostileTarget: false,
  description:
    'Enrages The Janitor into a fit of fury, increasing auto-attack speed by 300% but slowing movement speed by 20% for 10 sec.',
  appliesSelfBuff: CrashOutBuff,
};

export const BrokenGlassDebuff: BuffDefinition = {
  id: 'broken-glass',
  name: 'Broken Glass',
  icon: '🪟',
  duration: 2,
  type: 'debuff',
  description: 'Movement speed slowed by 70% for 2 seconds.',
  effects: [{ type: 'movementSpeedPercent', value: -70 }],
};

export const BottleChuck: Ability = {
  id: 'bottle-chuck',
  name: 'Bottle Chuck',
  icon: '⚗️',
  range: yardsToUnits(24),
  manaCost: 180,
  cooldown: 4,
  damage: 0,
  damageMin: 244,
  damageMax: 271,
  requiresHostileTarget: false,
  groundTargeted: true,
  aoeRadius: yardsToUnits(4),
  appliesDebuff: BrokenGlassDebuff,
  description:
    'Toss a bottle of volatile chemicals at a location, dealing 244-271 damage and slowing all enemies in the area by 70% for 2 sec.',
};

export const Discombobulate: Ability = {
  id: 'discombobulate',
  name: 'Discombobulate',
  icon: '🌀',
  range: yardsToUnits(20),
  manaCost: 245,
  cooldown: 10,
  castTime: 1.5,
  damage: 0,
  requiresHostileTarget: true,
  description:
    "Confuse the enemy target, causing them to lose control of their character's movement for 5 seconds.",
  appliesDebuff: DiscombobulateDebuff,
};

export const ChemicalSpill: Ability = {
  id: 'chemical-spill',
  name: 'Chemical Spill',
  icon: '🧪',
  manaCost: 175,
  cooldown: 8,
  damage: 0,
  requiresHostileTarget: false,
  description:
    'Spill a vial of mysterious chemicals onto the ground that other players can slip on. Activates after 2 seconds. Friendly players receive a 40% movement speed increase for 4 seconds. Hostile players take 297-349 damage and an additional 600 damage over 6 seconds.',
};

export const RetardStrength: Ability = {
  id: 'retard-strength',
  name: 'Retard Strength',
  icon: '💪',
  manaCost: 300,
  cooldown: 10,
  damage: 0,
  requiresHostileTarget: false,
  description:
    'You are much stronger than you appear. Increase damage and healing dealt by 50% and shields you, absorbing up to 100 damage and reflecting 50% of damage taken for 3 seconds.',
  appliesSelfBuff: RetardStrengthBuff,
};

export const Chudmax: Ability = {
  id: 'chudmax',
  name: 'Chudmax',
  icon: '🧬',
  range: yardsToUnits(15),
  manaCost: 275,
  cooldown: 1.5,
  castTime: 3,
  damage: 720,
  healAmount: 900,
  requiresHostileTarget: false,
  requiresTarget: true,
  isChannel: true,
  channelTicks: 3,
  description:
    'Channel the chud at your target for 3 seconds. Heals friendly targets for 900 or damages hostile targets for 720 over the duration.',
};

export const FullRetard: Ability = {
  id: 'full-retard',
  name: 'Full Retard',
  icon: '🤯',
  manaCost: 360,
  cooldown: 60,
  castTime: 1,
  damage: 0,
  requiresHostileTarget: false,
  description:
    'Never go full retard. But if you do...',
  appliesSelfBuff: FullRetardBuff,
};

export const CrotchRot: Ability = {
  id: 'crotch-rot',
  name: 'Crotch Rot',
  icon: '🦠',
  range: yardsToUnits(15),
  manaCost: 200,
  cooldown: 16,
  castTime: 0.5,
  damage: 0,
  requiresHostileTarget: true,
  description:
    'Deals 540 damage over 9 seconds. Stuns for 2 seconds when effect ends.',
  appliesDebuff: CrotchRotDot,
};

export const JimmyLegs: Ability = {
  id: 'jimmy-legs',
  name: 'Jimmy Legs',
  icon: '🦵',
  range: yardsToUnits(5),
  manaCost: 100,
  cooldown: 1.5,
  damage: 49,
  requiresHostileTarget: true,
  description:
    'Inflicts the target with the Jimmy Legs, reducing movement speed by 50% for 5 seconds. If used on a target with Jimmy Legs, the target will become immobilized for 2 seconds.',
  appliesDebuff: JimmyLegsDebuff,
};

export const JanitorsHelper: Ability = {
  id: 'janitors-helper',
  name: "Janitor's Helper",
  icon: '😴',
  range: yardsToUnits(5),
  manaCost: 175,
  cooldown: 30,
  castTime: 0.5,
  damage: 0,
  requiresHostileTarget: true,
  description:
    'Spray a cocktail of ammonia and bleach at your target, putting them to sleep for 10 seconds.',
  appliesDebuff: JanitorsHelperDebuff,
};

export const Kaboom: Ability = {
  id: 'kaboom',
  name: 'Kaboom',
  icon: '💥',
  manaCost: 235,
  cooldown: 3,
  damage: 0,
  requiresHostileTarget: false,
  description:
    'Mix up a potent batch of chemicals, causing an explosion, knocking back enemies in front of you.',
};
