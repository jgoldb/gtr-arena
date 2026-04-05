export type DifficultyLevel = 'easy' | 'medium' | 'hard' | 'expert' | 'master' | 'neural';

export interface DifficultyProfile {
  readonly name: string;

  /** How often the AI re-evaluates decisions (ms) */
  readonly thinkIntervalMs: number;

  /** Delay before responding to reactive events like trinket/interrupt (ms) */
  readonly reactionDelayMs: number;

  /** Random noise added to action scores (0 = perfect, 0.5 = sloppy) */
  readonly scoreFuzz: number;

  /** Probability of using an ability when one is available vs just auto-attacking */
  readonly abilityUsageRate: number;

  /** Chance to interrupt a channel/cast when able */
  readonly interruptChance: number;

  /** How well ranged NPCs maintain distance (0 = bad, 1 = perfect) */
  readonly kiteEfficiency: number;

  /** Probability of proactively avoiding hazards (gas clouds, pools) */
  readonly hazardAvoidance: number;

  /** How often they evaluate switching targets (0-1, higher = more frequent) */
  readonly targetSwitchFrequency: number;

  /** Movement speed multiplier (easy bots move slower) */
  readonly movementSpeedScale: number;

  /** How wasteful the AI is with abilities (0 = never wastes, 1 = very wasteful).
   *  Controls thresholds for skipping heals at high HP, defensive buffs with no pressure,
   *  AoE with no targets, etc. */
  readonly wastefulness: number;
}

export const DIFFICULTY_PRESETS: Record<DifficultyLevel, DifficultyProfile> = {
  easy: {
    name: 'Easy',
    thinkIntervalMs: 1200,
    reactionDelayMs: 1500,
    scoreFuzz: 0.5,
    abilityUsageRate: 0.4,
    interruptChance: 0.1,
    kiteEfficiency: 0.3,
    hazardAvoidance: 0.2,
    targetSwitchFrequency: 0.1,
    movementSpeedScale: 0.8,
    wastefulness: 0.7,
  },
  medium: {
    name: 'Medium',
    thinkIntervalMs: 600,
    reactionDelayMs: 800,
    scoreFuzz: 0.25,
    abilityUsageRate: 0.7,
    interruptChance: 0.4,
    kiteEfficiency: 0.5,
    hazardAvoidance: 0.5,
    targetSwitchFrequency: 0.3,
    movementSpeedScale: 0.9,
    wastefulness: 0.4,
  },
  hard: {
    name: 'Hard',
    thinkIntervalMs: 300,
    reactionDelayMs: 300,
    scoreFuzz: 0.1,
    abilityUsageRate: 0.9,
    interruptChance: 0.75,
    kiteEfficiency: 0.8,
    hazardAvoidance: 0.8,
    targetSwitchFrequency: 0.6,
    movementSpeedScale: 1.0,
    wastefulness: 0.15,
  },
  expert: {
    name: 'Expert',
    thinkIntervalMs: 200,
    reactionDelayMs: 100,
    scoreFuzz: 0.02,
    abilityUsageRate: 0.95,
    interruptChance: 0.9,
    kiteEfficiency: 0.95,
    hazardAvoidance: 0.95,
    targetSwitchFrequency: 0.8,
    movementSpeedScale: 1.0,
    wastefulness: 0.02,
  },
  master: {
    name: 'Master',
    thinkIntervalMs: 100,
    reactionDelayMs: 0,
    scoreFuzz: 0,
    abilityUsageRate: 1.0,
    interruptChance: 1.0,
    kiteEfficiency: 1.0,
    hazardAvoidance: 1.0,
    targetSwitchFrequency: 1.0,
    movementSpeedScale: 1.0,
    wastefulness: 0,
  },
  neural: {
    name: 'Neural',
    thinkIntervalMs: 100,
    reactionDelayMs: 0,
    scoreFuzz: 0,
    abilityUsageRate: 1.0,
    interruptChance: 1.0,
    kiteEfficiency: 1.0,
    hazardAvoidance: 1.0,
    targetSwitchFrequency: 1.0,
    movementSpeedScale: 1.0,
    wastefulness: 0,
  },
};
