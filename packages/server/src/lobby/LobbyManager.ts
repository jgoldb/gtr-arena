import type { WebSocket } from 'ws';
import type { ClientMessage, S2C_LobbyState, S2C_LobbyChat, ServerMessage, S2C_GameLobbyState, S2C_GameCancelled, S2C_AdminUsersList, S2C_AdminResult, S2C_UserProfile, S2C_Leaderboard, S2C_ChangePasswordResult, UserProfileData } from '@gtr/shared';
import type { LobbyUser, LobbyGameInfo } from '@gtr/shared';
import { GameLobby } from './GameLobby.js';
import { GameSession } from '../game/GameSession.js';
import type { RematchInfo } from '../game/GameSession.js';
import type { AuthManager } from '../auth/AuthManager.js';
import type { GtrDatabase } from '../db/Database.js';

interface ConnectedUser {
  userId: string;
  username: string;
  socket: WebSocket;
  status: 'online' | 'in-game';
  gameLobbyId: string | null;
  gameSessionId: string | null;
}

export class LobbyManager {
  private auth: AuthManager;
  private db: GtrDatabase;
  private users = new Map<string, ConnectedUser>();
  private gameLobbies = new Map<string, GameLobby>();
  private gameSessions = new Map<string, GameSession>();
  private pendingRejoins = new Map<string, string>(); // userId -> gameSessionId
  private nextGameId = 1;

  constructor(auth: AuthManager, db: GtrDatabase) {
    this.auth = auth;
    this.db = db;
  }

  /** Prefix a username with <GM> if the user is an admin. */
  private static gmTag(username: string, isAdmin: boolean): string {
    return isAdmin ? `<GM> ${username}` : username;
  }

  addUser(userId: string, username: string, socket: WebSocket): void {
    // Check for pending game rejoin
    const rejoinSessionId = this.pendingRejoins.get(userId);
    if (rejoinSessionId) {
      const session = this.gameSessions.get(rejoinSessionId);
      if (session && session.rejoinPlayer(userId, socket)) {
        this.pendingRejoins.delete(userId);
        this.users.set(userId, {
          userId,
          username,
          socket,
          status: 'in-game',
          gameLobbyId: null,
          gameSessionId: rejoinSessionId,
        });
        this.notifyAdminsUserListChanged();
        return;
      }
      // Session gone — fall through to normal lobby join
      this.pendingRejoins.delete(userId);
    }

    this.users.set(userId, {
      userId,
      username,
      socket,
      status: 'online',
      gameLobbyId: null,
      gameSessionId: null,
    });
    this.broadcastLobbyState();
    this.notifyAdminsUserListChanged();
  }

  /** Send updated user list to all online admins (for the admin panel). */
  private notifyAdminsUserListChanged(): void {
    for (const u of this.users.values()) {
      if (this.auth.getIsAdmin(u.userId) && !u.gameSessionId) {
        this.handleAdminGetUsers(u.userId);
      }
    }
  }

  removeUser(userId: string): void {
    const user = this.users.get(userId);
    if (!user) return;

    // Leave game lobby if in one
    if (user.gameLobbyId) {
      this.leaveGameLobby(userId);
    }

    // Handle active game session disconnect — grace period, not permanent removal
    if (user.gameSessionId) {
      const session = this.gameSessions.get(user.gameSessionId);
      if (session) {
        session.disconnectPlayer(userId);
        if (session.hasDisconnectedPlayer(userId)) {
          // Grace period started — track for rejoin
          this.pendingRejoins.set(userId, user.gameSessionId);
        }
        if (session.isEmpty()) {
          session.stop();
          this.gameSessions.delete(user.gameSessionId);
        }
      }
    }

    this.users.delete(userId);
    this.broadcastLobbyState();
  }

  handleMessage(userId: string, msg: ClientMessage): void {
    const user = this.users.get(userId);
    if (!user) return;

    switch (msg.type) {
      case 'lobby_chat':
        this.handleChat(userId, msg.message);
        break;
      case 'create_game':
        this.handleCreateGame(userId, msg.format, msg.mapId);
        break;
      case 'join_game':
        this.handleJoinGame(userId, msg.gameId);
        break;
      case 'leave_game':
        this.leaveGameLobby(userId);
        break;
      case 'select_character':
        this.handleSelectCharacter(userId, msg.characterId);
        break;
      case 'lock_in':
        this.handleLockIn(userId);
        break;
      case 'start_game':
        this.handleStartGame(userId);
        break;
      case 'swap_team':
        this.handleSwapTeam(userId, msg.draggedUserId, msg.newTeam, msg.droppedOnUserId);
        break;
      // In-game messages are routed to GameSession
      case 'client_ready':
      case 'player_state':
      case 'use_ability':
      case 'set_target':
      case 'auto_attack':
      case 'stop_auto_attack':
      case 'cancel_cast':
      case 'cancel_buff':
      case 'set_resting':
      case 'toggle_god_mode':
      case 'request_rematch':
      case 'accept_rematch':
      case 'decline_rematch':
        if (user.gameSessionId) {
          const session = this.gameSessions.get(user.gameSessionId);
          session?.handleMessage(userId, msg);
        }
        break;
      case 'request_lobby_state':
        this.sendLobbyState(user);
        break;
      case 'return_to_lobby':
        if (user.gameSessionId) {
          const session = this.gameSessions.get(user.gameSessionId);
          if (session) {
            session.removePlayer(userId);
            if (session.isEmpty()) {
              session.stop();
              this.gameSessions.delete(user.gameSessionId);
            }
          }
          this.pendingRejoins.delete(userId);
        }
        user.status = 'online';
        user.gameSessionId = null;
        this.broadcastLobbyState();
        break;

      // Profile / Leaderboard
      case 'inspect_user':
        this.handleInspectUser(userId, msg.targetUserId);
        break;
      case 'get_leaderboard':
        this.handleGetLeaderboard(userId);
        break;

      // Admin messages
      case 'admin_get_users':
        this.handleAdminGetUsers(userId);
        break;
      case 'admin_delete_user':
        this.handleAdminDeleteUser(userId, msg.targetUserId);
        break;
      case 'admin_ban_user':
        this.handleAdminBanUser(userId, msg.targetUserId, msg.duration);
        break;
      case 'admin_unban_user':
        this.handleAdminUnbanUser(userId, msg.targetUserId);
        break;
      case 'admin_reset_password':
        this.handleAdminResetPassword(userId, msg.targetUserId);
        break;
      case 'admin_reset_stats':
        this.handleAdminResetStats(userId, msg.targetUserId);
        break;
      case 'change_password':
        this.handleChangePassword(userId, msg.currentPassword, msg.newPassword);
        break;
      case 'debug_add_xp':
        this.handleDebugAddXp(userId, msg.amount);
        break;
    }
  }

  private handleChat(userId: string, message: string): void {
    const user = this.users.get(userId);
    if (!user || !message.trim()) return;

    const chatMsg: S2C_LobbyChat = {
      type: 'lobby_chat',
      userId,
      username: LobbyManager.gmTag(user.username, this.auth.getIsAdmin(userId)),
      message: message.trim().substring(0, 500),
      timestamp: Date.now(),
    };

    // Send to all lobby users (not in-game)
    for (const u of this.users.values()) {
      if (u.status === 'online') {
        this.send(u.socket, chatMsg);
      }
    }
  }

  private handleCreateGame(userId: string, format: '1v1' | '2v2' | '3v3', mapId: string): void {
    const user = this.users.get(userId);
    if (!user) return;
    if (user.gameLobbyId || user.gameSessionId) {
      this.send(user.socket, { type: 'error', message: 'Already in a game' });
      return;
    }

    const gameId = `game_${this.nextGameId++}`;
    const lobby = new GameLobby(gameId, format, mapId, userId, LobbyManager.gmTag(user.username, this.auth.getIsAdmin(userId)));
    this.gameLobbies.set(gameId, lobby);

    user.gameLobbyId = gameId;
    this.broadcastGameLobbyState(lobby);
    this.broadcastLobbyState();
  }

  private handleJoinGame(userId: string, gameId: string): void {
    const user = this.users.get(userId);
    if (!user) return;
    if (user.gameLobbyId || user.gameSessionId) {
      this.send(user.socket, { type: 'error', message: 'Already in a game' });
      return;
    }

    const lobby = this.gameLobbies.get(gameId);
    if (!lobby) {
      this.send(user.socket, { type: 'error', message: 'Game not found' });
      return;
    }

    const result = lobby.addPlayer(userId, LobbyManager.gmTag(user.username, this.auth.getIsAdmin(userId)));
    if (!result.success) {
      this.send(user.socket, { type: 'error', message: result.error! });
      return;
    }

    user.gameLobbyId = gameId;
    this.broadcastGameLobbyState(lobby);
    this.broadcastLobbyState();
  }

  private leaveGameLobby(userId: string): void {
    const user = this.users.get(userId);
    if (!user || !user.gameLobbyId) return;

    const lobby = this.gameLobbies.get(user.gameLobbyId);
    if (!lobby) {
      user.gameLobbyId = null;
      return;
    }

    const isHost = lobby.hostUserId === userId;

    if (isHost) {
      // Host leaving cancels the entire lobby — notify and eject all other players
      for (const p of lobby.getPlayers()) {
        const u = this.users.get(p.userId);
        if (u) {
          u.gameLobbyId = null;
          this.send(u.socket, { type: 'game_cancelled', reason: isHost && p.userId !== userId
            ? 'The host left the game lobby'
            : 'You left the game lobby' } as S2C_GameCancelled);
        }
      }
      this.gameLobbies.delete(lobby.gameId);
    } else {
      lobby.removePlayer(userId);
      user.gameLobbyId = null;

      if (lobby.isEmpty()) {
        this.gameLobbies.delete(lobby.gameId);
      } else {
        this.broadcastGameLobbyState(lobby);
      }

      this.send(user.socket, { type: 'game_cancelled', reason: 'You left the game lobby' } as S2C_GameCancelled);
    }

    this.broadcastLobbyState();
  }

  private handleSelectCharacter(userId: string, characterId: string): void {
    const user = this.users.get(userId);
    if (!user?.gameLobbyId) return;

    const lobby = this.gameLobbies.get(user.gameLobbyId);
    if (!lobby) return;

    lobby.selectCharacter(userId, characterId as any);
    this.broadcastGameLobbyState(lobby);
  }

  private handleLockIn(userId: string): void {
    const user = this.users.get(userId);
    if (!user?.gameLobbyId) return;

    const lobby = this.gameLobbies.get(user.gameLobbyId);
    if (!lobby) return;

    const result = lobby.lockIn(userId);
    if (!result.success) {
      this.send(user.socket, { type: 'error', message: result.error! });
      return;
    }

    this.broadcastGameLobbyState(lobby);

    // Auto-start when all players are locked in
    if (lobby.canStart().success) {
      this.startGame(lobby);
    }
  }

  private handleSwapTeam(userId: string, draggedUserId: string, newTeam: number, droppedOnUserId?: string): void {
    const user = this.users.get(userId);
    if (!user?.gameLobbyId) return;

    const lobby = this.gameLobbies.get(user.gameLobbyId);
    if (!lobby) return;

    if (lobby.hostUserId !== userId) {
      this.send(user.socket, { type: 'error', message: 'Only the host can rearrange teams' });
      return;
    }

    const result = lobby.swapPlayerTeam(draggedUserId, newTeam, droppedOnUserId);
    if (!result.success) {
      this.send(user.socket, { type: 'error', message: result.error! });
      return;
    }

    this.broadcastGameLobbyState(lobby);
  }

  private handleStartGame(userId: string): void {
    const user = this.users.get(userId);
    if (!user?.gameLobbyId) return;

    const lobby = this.gameLobbies.get(user.gameLobbyId);
    if (!lobby) return;

    const validation = lobby.canStart();
    if (!validation.success) {
      this.send(user.socket, { type: 'error', message: validation.error! });
      return;
    }

    this.startGame(lobby);
  }

  private startGame(lobby: GameLobby): void {
    // Create game session
    const players = lobby.getPlayers();
    const playerSockets = new Map<string, WebSocket>();
    for (const p of players) {
      const u = this.users.get(p.userId);
      if (u) {
        u.status = 'in-game';
        u.gameSessionId = lobby.gameId;
        u.gameLobbyId = null;
        playerSockets.set(p.userId, u.socket);
      }
    }

    const session = this.createSession(lobby.gameId, lobby.mapId, lobby.format, players, playerSockets);

    this.gameSessions.set(lobby.gameId, session);
    this.gameLobbies.delete(lobby.gameId);

    session.start();
    this.broadcastLobbyState();
  }

  // ── Profile / Leaderboard ─────────────────────────────────────────────

  private handleInspectUser(userId: string, targetUserId: string): void {
    const user = this.users.get(userId);
    if (!user) return;

    // targetUserId is the socket-level ID like "user_123" — extract DB id
    const dbId = this.auth.getDbId(targetUserId);
    if (dbId == null) {
      this.send(user.socket, { type: 'error', message: 'User not found' });
      return;
    }

    const rows = this.db.getAllUsersWithStats();
    const row = rows.find(r => r.id === dbId);
    if (!row) {
      this.send(user.socket, { type: 'error', message: 'User not found' });
      return;
    }

    const charStats = this.db.getUserCharacterStats(dbId);
    const msg: S2C_UserProfile = {
      type: 'user_profile',
      profile: {
        username: LobbyManager.gmTag(row.username, row.is_admin === 1),
        xp: row.xp,
        gamesPlayed: row.games_played,
        wins: row.wins,
        losses: row.losses,
        createdAt: row.created_at,
        lastPlayed: row.last_played,
        characterStats: charStats.map(c => ({
          characterId: c.character_id,
          gamesPlayed: c.games_played,
          wins: c.wins,
          losses: c.losses,
        })),
      },
    };
    this.send(user.socket, msg);
  }

  private handleGetLeaderboard(userId: string): void {
    const user = this.users.get(userId);
    if (!user) return;

    const rows = this.db.getAllUsersWithStats();
    const entries: UserProfileData[] = rows.map(r => ({
      username: LobbyManager.gmTag(r.username, r.is_admin === 1),
      xp: r.xp,
      gamesPlayed: r.games_played,
      wins: r.wins,
      losses: r.losses,
      createdAt: r.created_at,
      lastPlayed: r.last_played,
    }));

    const msg: S2C_Leaderboard = { type: 'leaderboard', entries };
    this.send(user.socket, msg);
  }

  private handleDebugAddXp(userId: string, amount: number): void {
    const user = this.users.get(userId);
    if (!user) return;
    const dbId = this.auth.getDbId(userId);
    if (dbId == null) return;
    // Allow negative amounts (for reset-style usage) but clamp at 0 in DB
    const newXp = this.db.addXp(dbId, amount);
    this.send(user.socket, { type: 'xp_update', xp: newXp });
  }

  // ── Session creation ─────────────────────────────────────────────────

  private createSession(
    gameId: string,
    mapId: string,
    format: import('@gtr/shared').GameFormat,
    players: readonly { userId: string; username: string; team: number; characterId: import('@gtr/shared').CharacterId | null }[],
    sockets: Map<string, import('ws').WebSocket>,
  ): GameSession {
    const session = new GameSession(
      gameId,
      mapId,
      format,
      players,
      sockets,
      this.auth,
      this.db,
      // onGameOver — session stays alive for rematch; only cleaned up when empty
      (_gameId: string) => {},
    );

    session.onRematch = (oldGameId, info) => this.handleRematch(oldGameId, info);
    session.onGracePeriodExpired = (userId) => {
      this.pendingRejoins.delete(userId);
      if (session.isEmpty()) {
        session.stop();
        this.gameSessions.delete(gameId);
      }
    };
    return session;
  }

  private handleRematch(oldGameId: string, info: RematchInfo): void {
    // Clean up old session
    const oldSession = this.gameSessions.get(oldGameId);
    if (oldSession) {
      oldSession.stop();
      this.gameSessions.delete(oldGameId);
    }

    // Create new game session with same players
    const newGameId = `game_${this.nextGameId++}`;
    const newSession = this.createSession(newGameId, info.mapId, info.format, info.players, info.sockets);

    // Update user records to point to the new session
    for (const p of info.players) {
      const user = this.users.get(p.userId);
      if (user) {
        user.gameSessionId = newGameId;
        user.status = 'in-game';
      }
    }

    this.gameSessions.set(newGameId, newSession);
    newSession.start();
  }

  // ── Admin ────────────────────────────────────────────────────────────

  private handleAdminGetUsers(userId: string): void {
    const user = this.users.get(userId);
    if (!user || !this.auth.getIsAdmin(userId)) {
      if (user) this.send(user.socket, { type: 'error', message: 'Not authorized' });
      return;
    }

    const rows = this.db.getAllUsersWithStats();
    const msg: S2C_AdminUsersList = {
      type: 'admin_users_list',
      users: rows.map(r => ({
        id: r.id,
        username: LobbyManager.gmTag(r.username, r.is_admin === 1),
        xp: r.xp,
        createdAt: r.created_at,
        gamesPlayed: r.games_played,
        wins: r.wins,
        losses: r.losses,
        bannedUntil: r.banned_until,
        lastPlayed: r.last_played,
      })),
    };
    this.send(user.socket, msg);
  }

  private handleAdminDeleteUser(userId: string, targetUserId: number): void {
    const user = this.users.get(userId);
    if (!user || !this.auth.getIsAdmin(userId)) {
      if (user) this.send(user.socket, { type: 'error', message: 'Not authorized' });
      return;
    }

    const success = this.db.deleteUser(targetUserId);
    const result: S2C_AdminResult = {
      type: 'admin_result',
      action: 'delete_user',
      success,
      error: success ? undefined : 'Cannot delete user (not found or is admin)',
    };
    this.send(user.socket, result);

    // If successful, kick the deleted user if they're online and refresh the list
    if (success) {
      const deletedUserId = `user_${targetUserId}`;
      const deletedUser = this.users.get(deletedUserId);
      if (deletedUser) {
        this.send(deletedUser.socket, { type: 'kicked', reason: 'Your account has been deleted by an admin' });
      }
      // Send updated user list to admin
      this.handleAdminGetUsers(userId);
    }
  }

  private static BAN_DURATIONS: Record<string, { ms: number; label: string } | 'permanent'> = {
    '1h':   { ms: 60 * 60 * 1000, label: '1 hour' },
    '2h':   { ms: 2 * 60 * 60 * 1000, label: '2 hours' },
    '1d':   { ms: 24 * 60 * 60 * 1000, label: '1 day' },
    '3d':   { ms: 3 * 24 * 60 * 60 * 1000, label: '3 days' },
    '1w':   { ms: 7 * 24 * 60 * 60 * 1000, label: '1 week' },
    '1mo':  { ms: 30 * 24 * 60 * 60 * 1000, label: '1 month' },
    '1y':   { ms: 365 * 24 * 60 * 60 * 1000, label: '1 year' },
    'permanent': 'permanent',
  };

  private handleAdminBanUser(userId: string, targetUserId: number, duration: string): void {
    const user = this.users.get(userId);
    if (!user || !this.auth.getIsAdmin(userId)) {
      if (user) this.send(user.socket, { type: 'error', message: 'Not authorized' });
      return;
    }

    const dur = LobbyManager.BAN_DURATIONS[duration];
    if (!dur) {
      this.send(user.socket, { type: 'admin_result', action: 'ban_user', success: false, error: 'Invalid ban duration' });
      return;
    }

    let bannedUntil: string;
    let kickReason: string;

    if (dur === 'permanent') {
      bannedUntil = 'permanent';
      kickReason = 'Your account has been permanently closed';
    } else {
      const banEnd = new Date(Date.now() + dur.ms);
      bannedUntil = banEnd.toISOString().replace('T', ' ').replace('Z', '');
      kickReason = `You have been banned for ${dur.label}`;
    }

    const success = this.db.banUser(targetUserId, bannedUntil);
    const result: S2C_AdminResult = {
      type: 'admin_result',
      action: 'ban_user',
      success,
      error: success ? undefined : 'Cannot ban user (not found or is admin)',
    };
    this.send(user.socket, result);

    if (success) {
      const bannedUserId = `user_${targetUserId}`;
      const bannedUser = this.users.get(bannedUserId);
      if (bannedUser) {
        this.send(bannedUser.socket, { type: 'kicked', reason: kickReason });
      }
      this.handleAdminGetUsers(userId);
    }
  }

  private handleAdminUnbanUser(userId: string, targetUserId: number): void {
    const user = this.users.get(userId);
    if (!user || !this.auth.getIsAdmin(userId)) {
      if (user) this.send(user.socket, { type: 'error', message: 'Not authorized' });
      return;
    }

    const success = this.db.unbanUser(targetUserId);
    const result: S2C_AdminResult = {
      type: 'admin_result',
      action: 'unban_user',
      success,
      error: success ? undefined : 'User not found',
    };
    this.send(user.socket, result);

    if (success) {
      this.handleAdminGetUsers(userId);
    }
  }

  private handleAdminResetPassword(userId: string, targetUserId: number): void {
    const user = this.users.get(userId);
    if (!user || !this.auth.getIsAdmin(userId)) {
      if (user) this.send(user.socket, { type: 'error', message: 'Not authorized' });
      return;
    }

    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
    let newPassword = '';
    for (let i = 0; i < 12; i++) {
      newPassword += chars[Math.floor(Math.random() * chars.length)];
    }

    const success = this.db.resetPassword(targetUserId, newPassword);
    const result: S2C_AdminResult = {
      type: 'admin_result',
      action: 'reset_password',
      success,
      error: success ? undefined : 'Cannot reset password (not found or is admin)',
      generatedPassword: success ? newPassword : undefined,
    };
    this.send(user.socket, result);
  }

  private handleAdminResetStats(userId: string, targetUserId: number): void {
    const user = this.users.get(userId);
    if (!user || !this.auth.getIsAdmin(userId)) {
      if (user) this.send(user.socket, { type: 'error', message: 'Not authorized' });
      return;
    }

    const success = this.db.resetStats(targetUserId);
    const result: S2C_AdminResult = {
      type: 'admin_result',
      action: 'reset_stats',
      success,
      error: success ? undefined : 'User not found',
    };
    this.send(user.socket, result);

    if (success) {
      // Notify the target user if they're online so their lobby XP/level updates in real time
      const targetSocketId = this.auth.getUserIdByDbId(targetUserId);
      if (targetSocketId) {
        const targetUser = this.users.get(targetSocketId);
        if (targetUser) {
          this.send(targetUser.socket, { type: 'xp_update', xp: 0 });
        }
      }

      // Broadcast updated profile to all lobby users so open inspect dialogs refresh
      const rows = this.db.getAllUsersWithStats();
      const row = rows.find(r => r.id === targetUserId);
      if (row) {
        const broadcastCharStats = this.db.getUserCharacterStats(targetUserId);
        const profileMsg: S2C_UserProfile = {
          type: 'user_profile',
          broadcast: true,
          profile: {
            username: LobbyManager.gmTag(row.username, row.is_admin === 1),
            xp: row.xp,
            gamesPlayed: row.games_played,
            wins: row.wins,
            losses: row.losses,
            createdAt: row.created_at,
            lastPlayed: row.last_played,
            characterStats: broadcastCharStats.map(c => ({
              characterId: c.character_id,
              gamesPlayed: c.games_played,
              wins: c.wins,
              losses: c.losses,
            })),
          },
        };
        for (const u of this.users.values()) {
          if (!u.gameSessionId) {
            this.send(u.socket, profileMsg);
          }
        }
      }

      this.handleAdminGetUsers(userId);
    }
  }

  private handleChangePassword(userId: string, currentPassword: string, newPassword: string): void {
    const user = this.users.get(userId);
    if (!user) return;

    const dbId = this.auth.getDbId(userId);
    if (dbId == null) {
      this.send(user.socket, { type: 'change_password_result', success: false, error: 'User not found' } as S2C_ChangePasswordResult);
      return;
    }

    if (!newPassword || newPassword.length < 3) {
      this.send(user.socket, { type: 'change_password_result', success: false, error: 'New password must be at least 3 characters' } as S2C_ChangePasswordResult);
      return;
    }

    const result = this.db.changePassword(dbId, currentPassword, newPassword);
    this.send(user.socket, { type: 'change_password_result', success: result.success, error: result.error } as S2C_ChangePasswordResult);
  }

  private broadcastGameLobbyState(lobby: GameLobby): void {
    const state = lobby.getState();
    for (const p of lobby.getPlayers()) {
      const user = this.users.get(p.userId);
      if (user) {
        this.send(user.socket, state);
      }
    }
  }

  private broadcastLobbyState(): void {
    const users: LobbyUser[] = [];
    for (const u of this.users.values()) {
      users.push({
        userId: u.userId,
        username: LobbyManager.gmTag(u.username, this.auth.getIsAdmin(u.userId)),
        status: u.gameSessionId ? 'in-game' : 'online',
      });
    }

    const games: LobbyGameInfo[] = [];
    for (const lobby of this.gameLobbies.values()) {
      games.push(lobby.getInfo());
    }

    const msg: S2C_LobbyState = { type: 'lobby_state', users, games };

    // Send to all connected users who are in the lobby (not in a game lobby or game session)
    for (const u of this.users.values()) {
      if (!u.gameLobbyId && !u.gameSessionId) {
        this.send(u.socket, msg);
      }
    }
  }

  private sendLobbyState(user: ConnectedUser): void {
    const users: LobbyUser[] = [];
    for (const u of this.users.values()) {
      users.push({
        userId: u.userId,
        username: LobbyManager.gmTag(u.username, this.auth.getIsAdmin(u.userId)),
        status: u.gameSessionId ? 'in-game' : 'online',
      });
    }

    const games: LobbyGameInfo[] = [];
    for (const lobby of this.gameLobbies.values()) {
      games.push(lobby.getInfo());
    }

    this.send(user.socket, { type: 'lobby_state', users, games });
  }

  private send(socket: WebSocket, msg: ServerMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }
}
