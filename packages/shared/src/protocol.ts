import type { CharacterId } from './characters';
import type { GameFormat, EntitySnapshot, EntityBuffSnapshot, GasCloudSnapshot, ChemicalPoolSnapshot, LobbyGameInfo, LobbyUser, GameLobbyPlayer } from './types';

// ── Client -> Server Messages ───────────────────────────────────────────

export interface C2S_Authenticate {
  type: 'authenticate';
  username: string;
  token: string;
}

export interface C2S_LobbyChat {
  type: 'lobby_chat';
  message: string;
}

export interface C2S_CreateGame {
  type: 'create_game';
  format: GameFormat;
  mapId: string;
}

export interface C2S_JoinGame {
  type: 'join_game';
  gameId: string;
}

export interface C2S_LeaveGame {
  type: 'leave_game';
}

export interface C2S_SelectCharacter {
  type: 'select_character';
  characterId: CharacterId;
}

export interface C2S_LockIn {
  type: 'lock_in';
}

export interface C2S_StartGame {
  type: 'start_game';
}

// ── In-Game Client -> Server ────────────────────────────────────────────

export interface C2S_PlayerState {
  type: 'player_state';
  x: number;
  y: number;
  z: number;
  rotationY: number;
  isMoving: boolean;
}

export interface C2S_UseAbility {
  type: 'use_ability';
  abilityId: string;
  targetEntityId: string | null;
}

export interface C2S_SetTarget {
  type: 'set_target';
  targetEntityId: string | null;
}

export interface C2S_AutoAttack {
  type: 'auto_attack';
  targetEntityId: string;
}

export interface C2S_StopAutoAttack {
  type: 'stop_auto_attack';
}

export interface C2S_CancelCast {
  type: 'cancel_cast';
}

// ── Server -> Client Messages ───────────────────────────────────────────

export interface S2C_AuthResult {
  type: 'auth_result';
  success: boolean;
  userId: string;
  error?: string;
}

export interface S2C_LobbyState {
  type: 'lobby_state';
  users: LobbyUser[];
  games: LobbyGameInfo[];
}

export interface S2C_LobbyChat {
  type: 'lobby_chat';
  userId: string;
  username: string;
  message: string;
  timestamp: number;
}

export interface S2C_GameLobbyState {
  type: 'game_lobby_state';
  gameId: string;
  format: GameFormat;
  mapId: string;
  mapName: string;
  hostUserId: string;
  players: GameLobbyPlayer[];
}

export interface S2C_GameStart {
  type: 'game_start';
  gameId: string;
  mapId: string;
  entities: EntitySnapshot[];
  localEntityId: string;
  countdown: number;
}

export interface S2C_GameState {
  type: 'game_state';
  tick: number;
  timestamp: number;
  entities: EntitySnapshot[];
  buffs: EntityBuffSnapshot[];
  gasClouds: GasCloudSnapshot[];
  chemicalPools: ChemicalPoolSnapshot[];
}

export interface S2C_CombatEvent {
  type: 'combat_event';
  sourceEntityId: string;
  targetEntityId: string;
  amount: number;
  combatType: 'damage' | 'heal' | 'crit' | 'miss' | 'dodge';
}

export interface S2C_AbilityEffect {
  type: 'ability_effect';
  entityId: string;
  abilityId: string;
}

export interface S2C_CooldownUpdate {
  type: 'cooldown_update';
  abilityId: string;
  remaining: number;
  total: number;
}

export interface S2C_GasCloudSpawn {
  type: 'gas_cloud_spawn';
  id: string;
  x: number;
  z: number;
  radius: number;
  duration: number;
}

export interface S2C_ChemPoolSpawn {
  type: 'chem_pool_spawn';
  id: string;
  x: number;
  z: number;
  radius: number;
  duration: number;
  activationDelay: number;
}

export interface S2C_AutoAttackSwing {
  type: 'auto_attack_swing';
  entityId: string;
  targetEntityId: string;
}

export interface S2C_EntityDied {
  type: 'entity_died';
  entityId: string;
  killerEntityId: string | null;
}

export interface S2C_GameOver {
  type: 'game_over';
  winningTeam: number;
}

export interface S2C_ErrorMessage {
  type: 'error';
  message: string;
}

export interface S2C_GameCancelled {
  type: 'game_cancelled';
  reason: string;
}

// ── Delta / Optimized State Messages ────────────────────────────────────

/** Lightweight position-only data sent every tick */
export interface EntityPositionData {
  id: string;
  x: number;
  y: number;
  z: number;
  rotationY: number;
  isMoving: boolean;
}

/** Partial entity state — only changed fields are present */
export interface EntityStateDelta {
  id: string;
  hp?: number;
  maxHp?: number;
  mana?: number;
  maxMana?: number;
  dead?: boolean;
  inCombat?: boolean;
  stunned?: boolean;
  charging?: boolean;
  isAutoAttacking?: boolean;
  castingAbilityId?: string | null;
  castingElapsed?: number;
  castingTotalTime?: number;
  castingIsChannel?: boolean;
  targetEntityId?: string | null;
}

/**
 * High-frequency update (every tick).
 * - positions: always present (all entities)
 * - states: only entities whose combat/status state changed
 * - buffs: only entities whose buff list changed
 * - gasClouds/chemicalPools: only when non-empty
 */
export interface S2C_GameStateUpdate {
  type: 'game_state_update';
  tick: number;
  timestamp: number;
  positions: EntityPositionData[];
  states?: EntityStateDelta[];
  buffs?: EntityBuffSnapshot[];
  gasClouds?: GasCloudSnapshot[];
  chemicalPools?: ChemicalPoolSnapshot[];
}

/**
 * Full keyframe snapshot — sent on game start and every KEYFRAME_INTERVAL ticks.
 * Clients reset their full state from this.
 */
export interface S2C_GameStateSnapshot {
  type: 'game_state_snapshot';
  tick: number;
  timestamp: number;
  entities: EntitySnapshot[];
  buffs: EntityBuffSnapshot[];
  gasClouds: GasCloudSnapshot[];
  chemicalPools: ChemicalPoolSnapshot[];
}

// ── Union types ─────────────────────────────────────────────────────────

export type ClientMessage =
  | C2S_Authenticate
  | C2S_LobbyChat
  | C2S_CreateGame
  | C2S_JoinGame
  | C2S_LeaveGame
  | C2S_SelectCharacter
  | C2S_LockIn
  | C2S_StartGame
  | C2S_PlayerState
  | C2S_UseAbility
  | C2S_SetTarget
  | C2S_AutoAttack
  | C2S_StopAutoAttack
  | C2S_CancelCast;

export type ServerMessage =
  | S2C_AuthResult
  | S2C_LobbyState
  | S2C_LobbyChat
  | S2C_GameLobbyState
  | S2C_GameStart
  | S2C_GameState
  | S2C_GameStateUpdate
  | S2C_GameStateSnapshot
  | S2C_CombatEvent
  | S2C_AbilityEffect
  | S2C_CooldownUpdate
  | S2C_AutoAttackSwing
  | S2C_GasCloudSpawn
  | S2C_ChemPoolSpawn
  | S2C_EntityDied
  | S2C_GameOver
  | S2C_ErrorMessage
  | S2C_GameCancelled;
