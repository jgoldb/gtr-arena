export type { AnimationInput } from './CharacterModel';
export { CharacterModel } from './CharacterModel';
export { TheJanitor } from './TheJanitor';
export { DrRetardo } from './DrRetardo';

import { TheJanitor } from './TheJanitor';
import { DrRetardo } from './DrRetardo';
import type { CharacterModel } from './CharacterModel';
import type { CharacterId } from '@gtr/shared';

// Re-export from shared
export type { CharacterId };
export { CHARACTER_LIST } from '@gtr/shared';
export type { CharacterInfo } from '@gtr/shared';

export function createCharacter(id: CharacterId): CharacterModel {
  switch (id) {
    case 'janitor':
      return new TheJanitor();
    case 'dr-retardo':
      return new DrRetardo();
    default:
      return new TheJanitor();
  }
}
