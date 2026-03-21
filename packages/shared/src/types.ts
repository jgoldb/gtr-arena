// ── Shared entity interface (no Three.js dependency) ──────────────────────

export interface Positionable {
  readonly team: number;
  readonly name: string;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  inCombat: boolean;
  dead: boolean;
  readonly critChance: number;
  readonly dodgeChance: number;
  isHostileTo(other: Positionable): boolean;
  die(): void;
}

// ── Snapshot types for network sync ──────────────────────────────────────

export interface EntitySnapshot {
  id: string;
  characterId: string;
  team: number;
  name: string;
  x: number;
  y: number;
  z: number;
  rotationY: number;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  dead: boolean;
  inCombat: boolean;
  stunned: boolean;
  charging: boolean;
  isMoving: boolean;
  isAutoAttacking: boolean;
  castingAbilityId: string | null;
  castingElapsed: number;
  castingTotalTime: number;
  castingIsChannel: boolean;
  targetEntityId: string | null;
}

export interface EntityBuffSnapshot {
  entityId: string;
  buffs: { id: string; name: string; icon: string; type: 'buff' | 'debuff'; remaining: number; duration: number; description: string; shieldRemaining?: number; effects?: readonly { type: string; value: number }[] }[];
}

export interface GasCloudSnapshot {
  id: string;
  x: number;
  z: number;
  radius: number;
  elapsed: number;
  duration: number;
}

export interface ChemicalPoolSnapshot {
  id: string;
  x: number;
  z: number;
  radius: number;
  elapsed: number;
  duration: number;
  activationDelay: number;
  consumed: boolean;
}

export interface LobbyGameInfo {
  gameId: string;
  format: '1v1' | '2v2' | '3v3';
  mapId: string;
  mapName: string;
  hostUsername: string;
  playerCount: number;
  maxPlayers: number;
}

export interface LobbyUser {
  userId: string;
  username: string;
  status: 'online' | 'in-game';
}

export interface GameLobbyPlayer {
  userId: string;
  username: string;
  team: number;
  characterId: string | null;
  lockedIn: boolean;
}

export type GameFormat = '1v1' | '2v2' | '3v3';

export function getMaxPlayers(format: GameFormat): number {
  switch (format) {
    case '1v1': return 2;
    case '2v2': return 4;
    case '3v3': return 6;
  }
}
