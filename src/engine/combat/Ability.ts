export interface Ability {
  readonly id: string;
  readonly name: string;
  readonly icon: string; // emoji or short label for the slot
  readonly range: number; // max distance in world units
  readonly manaCost: number;
  readonly cooldown: number; // seconds
  readonly damage: number; // base damage (non-crit)
  readonly requiresHostileTarget: boolean;
  readonly description: string;
}

export const BasicAttack: Ability = {
  id: 'basic-attack',
  name: 'Basic Attack',
  icon: '⚔',
  range: 3,
  manaCost: 10,
  cooldown: 1.5,
  damage: 10,
  requiresHostileTarget: true,
  description: 'A swift melee strike against the target.',
};
