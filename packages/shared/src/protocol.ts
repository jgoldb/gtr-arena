import type { CharacterId } from './characters.js';
import type { GameFormat, EntitySnapshot, EntityBuffSnapshot, GasCloudSnapshot, ChemicalPoolSnapshot, LobbyGameInfo, LobbyUser, GameLobbyPlayer } from './types.js';

// ── Client -> Server Messages ───────────────────────────────────────────

export interface C2S_Authenticate {
  type: 'authenticate';
  username: string;
  password: string;
  mode: 'login' | 'register';
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

export interface C2S_ClientReady {
  type: 'client_ready';
}

export interface C2S_SetResting {
  type: 'set_resting';
  resting: boolean;
}

export interface C2S_CancelBuff {
  type: 'cancel_buff';
  buffId: string;
}

export interface C2S_ReturnToLobby {
  type: 'return_to_lobby';
}

export interface C2S_RequestLobbyState {
  type: 'request_lobby_state';
}

export interface C2S_InspectUser {
  type: 'inspect_user';
  targetUserId: string;
}

export interface C2S_GetLeaderboard {
  type: 'get_leaderboard';
}

export interface C2S_RequestRematch {
  type: 'request_rematch';
  mapMode: 'random' | 'same' | 'new';
}

export interface C2S_AcceptRematch {
  type: 'accept_rematch';
}

export interface C2S_DeclineRematch {
  type: 'decline_rematch';
}

export interface C2S_ToggleGodMode {
  type: 'toggle_god_mode';
}

export interface C2S_SwapTeam {
  type: 'swap_team';
  draggedUserId: string;
  droppedOnUserId?: string;
  newTeam: number;
}

// ── Server -> Client Messages ───────────────────────────────────────────

export interface S2C_AuthResult {
  type: 'auth_result';
  success: boolean;
  userId: string;
  username?: string;
  isAdmin?: boolean;
  bannedUntil?: string;
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

export interface S2C_Flinch {
  type: 'flinch';
  entityId: string;
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
  /** Whether all original players are still connected (enables rematch option). */
  allPlayersPresent: boolean;
}

export interface S2C_RematchChallenge {
  type: 'rematch_challenge';
  challengerUsername: string;
  mapMode: 'random' | 'same' | 'new';
  totalPlayers: number;
  readyCount: number;
}

export interface S2C_RematchReadyUpdate {
  type: 'rematch_ready_update';
  readyCount: number;
  totalPlayers: number;
}

export interface S2C_RematchFailed {
  type: 'rematch_failed';
  reason: string;
}

export interface UserProfileData {
  username: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  createdAt: string;
  lastPlayed: string | null;
}

export interface S2C_UserProfile {
  type: 'user_profile';
  profile: UserProfileData;
}

export interface S2C_Leaderboard {
  type: 'leaderboard';
  entries: UserProfileData[];
}

export interface S2C_ErrorMessage {
  type: 'error';
  message: string;
}

export interface S2C_CountdownStart {
  type: 'countdown_start';
  countdown: number;
}

export interface S2C_GameCancelled {
  type: 'game_cancelled';
  reason: string;
}

export interface S2C_Kicked {
  type: 'kicked';
  reason: string;
}

export interface S2C_Pong {
  type: 'pong';
  timestamp: number;
}

export interface S2C_RejoinGame {
  type: 'rejoin_game';
  gameId: string;
  mapId: string;
  entities: EntitySnapshot[];
  localEntityId: string;
  buffs: EntityBuffSnapshot[];
  gasClouds: GasCloudSnapshot[];
  chemicalPools: ChemicalPoolSnapshot[];
  disconnectedEntityIds: string[];
  gameOver?: { winningTeam: number };
  /** Seconds remaining until arena doors open. Undefined/0 = already open. */
  arenaTimeRemaining?: number;
}

export interface S2C_PlayerDisconnected {
  type: 'player_disconnected';
  entityId: string;
  username: string;
}

export interface S2C_PlayerReconnected {
  type: 'player_reconnected';
  entityId: string;
  username: string;
}

export interface S2C_EntityRemoved {
  type: 'entity_removed';
  entityId: string;
  username?: string;
}

// ── Admin Messages ──────────────────────────────────────────────────────

export interface C2S_AdminGetUsers {
  type: 'admin_get_users';
}

export interface C2S_AdminDeleteUser {
  type: 'admin_delete_user';
  targetUserId: number; // DB id
}

export interface C2S_AdminBanUser {
  type: 'admin_ban_user';
  targetUserId: number; // DB id
  duration: string;     // e.g. '1h', '2h', '1d', '3d', '1w', '1mo', '1y', 'permanent'
}

export interface C2S_AdminUnbanUser {
  type: 'admin_unban_user';
  targetUserId: number;
}

export interface C2S_AdminResetPassword {
  type: 'admin_reset_password';
  targetUserId: number;
}

export interface C2S_AdminResetStats {
  type: 'admin_reset_stats';
  targetUserId: number;
}

export interface C2S_ChangePassword {
  type: 'change_password';
  currentPassword: string;
  newPassword: string;
}

export interface C2S_Ping {
  type: 'ping';
  timestamp: number;
}

export interface AdminUserRecord {
  id: number;
  username: string;
  createdAt: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  bannedUntil: string | null;
  lastPlayed: string | null;
}

export interface S2C_AdminUsersList {
  type: 'admin_users_list';
  users: AdminUserRecord[];
}

export interface S2C_AdminResult {
  type: 'admin_result';
  action: string;
  success: boolean;
  error?: string;
  /** For reset_password action, contains the generated password. */
  generatedPassword?: string;
}

export interface S2C_ChangePasswordResult {
  type: 'change_password_result';
  success: boolean;
  error?: string;
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
  disconnected?: boolean;
}

/**
 * High-frequency update (every tick).
 * - positions: always present (all entities)
 * - states: only entities whose combat/status state changed
 * - buffs: only entities whose buff list changed
 * - gasClouds/chemicalPools: only when non-empty
 */
/** Discrete event bundled into the tick update to reduce WebSocket frames. */
export type GameTickEvent =
  | S2C_CombatEvent
  | S2C_Flinch
  | S2C_AbilityEffect
  | S2C_CooldownUpdate
  | S2C_AutoAttackSwing
  | S2C_GasCloudSpawn
  | S2C_ChemPoolSpawn
  | S2C_EntityDied;

export interface S2C_GameStateUpdate {
  type: 'game_state_update';
  tick: number;
  timestamp: number;
  positions: EntityPositionData[];
  states?: EntityStateDelta[];
  buffs?: EntityBuffSnapshot[];
  gasClouds?: GasCloudSnapshot[];
  chemicalPools?: ChemicalPoolSnapshot[];
  /** Discrete events bundled into this tick (reduces separate WebSocket frames). */
  events?: GameTickEvent[];
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

export interface S2C_GodModeUpdate {
  type: 'god_mode_update';
  entityId: string;
  active: boolean;
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
  | C2S_ClientReady
  | C2S_PlayerState
  | C2S_UseAbility
  | C2S_SetTarget
  | C2S_AutoAttack
  | C2S_StopAutoAttack
  | C2S_CancelCast
  | C2S_CancelBuff
  | C2S_SetResting
  | C2S_ReturnToLobby
  | C2S_RequestLobbyState
  | C2S_InspectUser
  | C2S_GetLeaderboard
  | C2S_RequestRematch
  | C2S_AcceptRematch
  | C2S_DeclineRematch
  | C2S_ToggleGodMode
  | C2S_SwapTeam
  | C2S_AdminGetUsers
  | C2S_AdminDeleteUser
  | C2S_AdminBanUser
  | C2S_AdminUnbanUser
  | C2S_AdminResetPassword
  | C2S_AdminResetStats
  | C2S_ChangePassword
  | C2S_Ping;

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
  | S2C_Flinch
  | S2C_AbilityEffect
  | S2C_CooldownUpdate
  | S2C_AutoAttackSwing
  | S2C_GasCloudSpawn
  | S2C_ChemPoolSpawn
  | S2C_EntityDied
  | S2C_GameOver
  | S2C_ErrorMessage
  | S2C_CountdownStart
  | S2C_GameCancelled
  | S2C_Kicked
  | S2C_AdminUsersList
  | S2C_AdminResult
  | S2C_ChangePasswordResult
  | S2C_GodModeUpdate
  | S2C_RematchChallenge
  | S2C_RematchReadyUpdate
  | S2C_RematchFailed
  | S2C_UserProfile
  | S2C_Leaderboard
  | S2C_Pong
  | S2C_RejoinGame
  | S2C_PlayerDisconnected
  | S2C_PlayerReconnected
  | S2C_EntityRemoved;
