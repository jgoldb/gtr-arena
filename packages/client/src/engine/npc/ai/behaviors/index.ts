import type { CharacterId } from '@gtr/shared';
import { getCharacterStats } from '@gtr/shared';
import type { CharacterBehavior } from './BaseBehavior';
import { BaseBehavior } from './BaseBehavior';
import { JanitorBehavior } from './JanitorBehavior';
import { CrackheadBehavior } from './CrackheadBehavior';
import { DrRetardoBehavior } from './DrRetardoBehavior';

export function createCharacterBehavior(characterId: CharacterId): CharacterBehavior {
  switch (characterId) {
    case 'janitor':
      return new JanitorBehavior();
    case 'crackhead':
      return new CrackheadBehavior();
    case 'dr-retardo':
      return new DrRetardoBehavior();
    default: {
      const stats = getCharacterStats(characterId);
      return new BaseBehavior(characterId, stats.autoAttackRange);
    }
  }
}

export type { CharacterBehavior, ScoredAction } from './BaseBehavior';
