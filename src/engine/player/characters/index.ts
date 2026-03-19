export type { AnimationInput } from './CharacterModel';
export { CharacterModel } from './CharacterModel';
export { TheJanitor } from './TheJanitor';
export { DrRetardo } from './DrRetardo';

import { TheJanitor } from './TheJanitor';
import { DrRetardo } from './DrRetardo';
import type { CharacterModel } from './CharacterModel';

export type CharacterId = 'janitor' | 'dr-retardo';

export interface CharacterInfo {
  id: CharacterId;
  name: string;
}

export const CHARACTER_LIST: CharacterInfo[] = [
  { id: 'janitor', name: 'The Janitor' },
  { id: 'dr-retardo', name: 'Dr. Retardo' },
];

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
