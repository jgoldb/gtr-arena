import type { CharacterId } from './characters';

// ── XP / Level utilities ──────────────────────────────────────────────────
//
// Formula:  xpForLevel(n) = 100 · (n − 1)^2.2
//
// Level 1→2 costs 100 XP.  Each successive gap grows super-linearly, so
// higher levels take progressively more effort with mild acceleration.
// No level cap; climbing simply becomes impractical at very high levels.

/** Cumulative XP required to reach a given level. Level 1 = 0 XP. */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.floor(100 * Math.pow(level - 1, 2.2));
}

/** Convert raw XP into a level number (minimum level 1). */
export function xpToLevel(xp: number): number {
  if (xp <= 0) return 1;
  // Analytical estimate, then adjust for floor() rounding
  let level = 1 + Math.floor(Math.pow(xp / 100, 1 / 2.2));
  while (xpForLevel(level + 1) <= xp) level++;
  return level;
}

/** XP progress within the current level: { current, needed } */
export function xpProgress(xp: number): { current: number; needed: number } {
  const level = xpToLevel(xp);
  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return { current: xp - base, needed: next - base };
}

/**
 * Calculate XP gained from a match.
 *
 * @param playerLevel  - The player's level
 * @param opponentLevel - The highest-level opponent in the match
 * @param won          - Whether the player won
 *
 * Baseline: lvl 1 vs lvl 1 → winner 240 XP, loser 80 XP.
 * Base XP grows with player level (60 + 20 * level).
 * Penalty when opponent is lower — accelerating with each level of gap.
 * Modest fixed bonus when opponent is higher (10 * playerLevel).
 * Winners earn 3x losers.
 */
export function calculateXpGain(playerLevel: number, opponentLevel: number, won: boolean): number {
  const base = 60 + 20 * playerLevel;

  if (!won) return base;

  // Win XP adjusted by opponent level difference
  const levelDiff = opponentLevel - playerLevel;
  let adjusted = base;
  if (levelDiff < 0) {
    // Opponent lower — triangular penalty: gap 1→5%, 2→15%, 3→30%, 4→50%, 5→75%…
    const gap = -levelDiff;
    const penalty = 0.05 * gap * (gap + 1) / 2;
    adjusted = base * Math.max(0.1, 1 - penalty);
  } else if (levelDiff > 0) {
    // Opponent higher — modest flat bonus based on player's own level
    adjusted = base + 10 * playerLevel;
  }

  return Math.round(adjusted * 5);
}

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
  characterId: CharacterId;
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
  disconnected?: boolean;
}

export interface EntityBuffSnapshot {
  entityId: string;
  buffs: { id: string; name: string; icon: string; type: 'buff' | 'debuff'; remaining: number; duration: number; description: string; shieldRemaining?: number; effects?: readonly { type: string; value: number }[]; unremovable?: boolean; stacks?: number; maxStacks?: number }[];
  drTimers?: { category: string; buffId: string; icon: string; count: number; remaining: number; total: number }[];
}

export interface GasCloudSnapshot {
  id: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  elapsed: number;
  duration: number;
}

export interface ChemicalPoolSnapshot {
  id: string;
  x: number;
  y: number;
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
  inProgress?: boolean;
}

export interface LobbyUser {
  userId: string;
  username: string;
  status: 'online' | 'in-game' | 'in-single-player';
}

export interface GameLobbyPlayer {
  userId: string;
  username: string;
  team: number;
  characterId: CharacterId | null;
  lockedIn: boolean;
}

export type GameFormat = '1v1' | '2v2' | '3v3';

/** Per-player stats accumulated during a match. */
export interface PlayerMatchStats {
  kills: number;
  deaths: number;
  damageDealt: number;
  healingDone: number;
}

export function getMaxPlayers(format: GameFormat): number {
  switch (format) {
    case '1v1': return 2;
    case '2v2': return 4;
    case '3v3': return 6;
  }
}
