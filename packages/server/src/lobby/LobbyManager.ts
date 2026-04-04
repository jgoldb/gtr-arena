import type { WebSocket } from 'ws';
import type { DataChannel } from 'node-datachannel';
import type { ClientMessage, S2C_LobbyState, S2C_LobbyChat, ServerMessage, S2C_GameCancelled, S2C_UserProfile, S2C_Leaderboard, S2C_ChangePasswordResult, UserProfileData } from '@gtr/shared';
import type { LobbyUser, LobbyGameInfo } from '@gtr/shared';
import { encodeMessage } from '@gtr/shared';
import { GameLobby } from './GameLobby.js';
import { GameSession } from '../game/GameSession.js';
import type { RematchInfo } from '../game/GameSession.js';
import type { AuthManager } from '../auth/AuthManager.js';
import type { GtrDatabase } from '../db/Database.js';
import { AdminHandler } from './AdminHandler.js';

interface ConnectedUser {
  userId: string;
  username: string;
  socket: WebSocket;
  status: 'online' | 'in-game' | 'in-single-player';
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
  /** Reference to the global DataChannel map for unreliable game traffic. */
  private dataChannelMap: Map<string, DataChannel> | null = null;
  /** In-memory ring buffer of recent lobby chat messages (session-level, clears on restart). */
  private static readonly CHAT_HISTORY_SIZE = 100;
  private chatHistory: S2C_LobbyChat[] = [];
  private adminHandler: AdminHandler;

  constructor(auth: AuthManager, db: GtrDatabase) {
    this.auth = auth;
    this.db = db;
    this.adminHandler = new AdminHandler(auth, db, {
      getUser: (userId) => this.users.get(userId),
      allUsers: () => this.users.values(),
      send: (socket, msg) => this.send(socket, msg),
      gmTag: (username, isAdmin) => LobbyManager.gmTag(username, isAdmin),
    });
    this.restoreActiveSessions();
  }

  /** Set the global DataChannel map for unreliable game traffic (called once at startup). */
  setDataChannelMap(map: Map<string, DataChannel>): void {
    this.dataChannelMap = map;
    // Wire DataChannel lookup into any sessions restored before this was set
    for (const session of this.gameSessions.values()) {
      if (!session.getDataChannel) {
        session.getDataChannel = (userId) => map.get(userId);
      }
    }
  }

  /** Restore active game sessions from the database on server startup (crash recovery). */
  private restoreActiveSessions(): void {
    const saved = this.db.loadActiveSessions();
    if (saved.length === 0) return;

    console.log(`[CrashRecovery] Restoring ${saved.length} active game session(s)...`);

    for (const data of saved) {
      const session = GameSession.restore(
        data,
        this.auth,
        this.db,
        (_gameId: string) => {},
      );

      if (!session) {
        console.warn(`[CrashRecovery] Failed to restore session ${data.gameId}, deleting`);
        this.db.deleteActiveSession(data.gameId);
        continue;
      }

      // Wire session callbacks
      if (this.dataChannelMap) {
        const dcMap = this.dataChannelMap;
        session.getDataChannel = (userId) => dcMap.get(userId);
      }
      session.onRematch = (oldGameId, info) => this.handleRematch(oldGameId, info);
      session.onGracePeriodExpired = (userId) => {
        this.pendingRejoins.delete(userId);
        if (session.isEmpty()) {
          session.stop();
          this.gameSessions.delete(data.gameId);
          this.broadcastLobbyState();
        }
      };

      this.gameSessions.set(data.gameId, session);

      // Parse the gameId to keep nextGameId above any restored IDs
      const idNum = parseInt(data.gameId.replace('game_', ''), 10);
      if (!isNaN(idNum) && idNum >= this.nextGameId) {
        this.nextGameId = idNum + 1;
      }

      // Add surviving players to pendingRejoins and start grace periods
      // (skip players who were already removed before the crash)
      const players: { userId: string; username: string; team: number; characterId: string }[] = JSON.parse(data.players);
      const removedBeforeEnd: string[] = JSON.parse(data.removedBeforeEnd);
      const removedSet = new Set(removedBeforeEnd);
      for (const p of players) {
        if (removedSet.has(p.userId)) continue;
        this.pendingRejoins.set(p.userId, data.gameId);
        session.startGracePeriod(p.userId);
      }

      console.log(`[CrashRecovery] Restored session ${data.gameId} (${data.mapId}, ${data.format}) with ${players.length} players`);
    }
  }

  /** Prefix a username with <GM> if the user is an admin. */
  private static gmTag(username: string, isAdmin: boolean): string {
    return isAdmin ? `<GM> ${username}` : username;
  }

  addUser(userId: string, username: string, socket: WebSocket): void {
    // If the user already has an active entry (duplicate login), clean up old state first.
    // This handles leaving game lobbies and starting disconnect grace periods for game sessions
    // so that the rejoin logic below can seamlessly reconnect the new socket.
    if (this.users.has(userId)) {
      this.removeUser(userId);
    }

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
    this.sendChatHistory(socket);
    this.broadcastLobbyState();
    this.notifyAdminsUserListChanged();
  }

  /** Send updated user list to all online admins (for the admin panel). */
  private notifyAdminsUserListChanged(): void {
    for (const u of this.users.values()) {
      if (this.auth.getIsAdmin(u.userId) && !u.gameSessionId) {
        this.adminHandler.handleAdminGetUsers(u.userId);
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
      case 'change_format':
        this.handleChangeFormat(userId, msg.format);
        break;
      case 'change_map':
        this.handleChangeMap(userId, msg.mapId);
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
      case 'vote_open_gates':
      case 'game_chat':
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
        this.sendChatHistory(user.socket);
        this.broadcastLobbyState();
        break;

      case 'enter_single_player':
        user.status = 'in-single-player';
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
        this.adminHandler.handleAdminGetUsers(userId);
        break;
      case 'admin_delete_user':
        this.adminHandler.handleAdminDeleteUser(userId, msg.targetUserId);
        break;
      case 'admin_ban_user':
        this.adminHandler.handleAdminBanUser(userId, msg.targetUserId, msg.duration, msg.reason);
        break;
      case 'admin_unban_user':
        this.adminHandler.handleAdminUnbanUser(userId, msg.targetUserId);
        break;
      case 'admin_reset_password':
        this.adminHandler.handleAdminResetPassword(userId, msg.targetUserId);
        break;
      case 'admin_reset_stats':
        this.adminHandler.handleAdminResetStats(userId, msg.targetUserId);
        break;
      case 'admin_nuke_stats':
        this.adminHandler.handleAdminNukeStats(userId);
        break;
      case 'admin_set_xp':
        this.adminHandler.handleAdminSetXp(userId, msg.targetUserId, msg.xp);
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

    const trimmed = message.trim();
    const isAdmin = this.auth.getIsAdmin(userId);
    const isAnnouncement = isAdmin && trimmed.startsWith('/a ');
    const finalMessage = isAnnouncement ? trimmed.slice(3).trim() : trimmed;
    if (!finalMessage) return;

    const chatMsg: S2C_LobbyChat = {
      type: 'lobby_chat',
      userId,
      username: LobbyManager.gmTag(user.username, isAdmin),
      message: finalMessage.substring(0, 500),
      timestamp: Date.now(),
      ...(isAnnouncement && { isAnnouncement: true }),
    };

    // Store in history buffer
    this.chatHistory.push(chatMsg);
    if (this.chatHistory.length > LobbyManager.CHAT_HISTORY_SIZE) {
      this.chatHistory.shift();
    }

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

    lobby.removePlayer(userId);
    user.gameLobbyId = null;
    this.send(user.socket, { type: 'game_cancelled', reason: 'You left the game lobby' } as S2C_GameCancelled);

    if (lobby.isEmpty()) {
      this.gameLobbies.delete(lobby.gameId);
    } else {
      // If the host left, pass host to the longest-tenured remaining player
      if (lobby.hostUserId === userId) {
        lobby.transferHost();
      }
      this.broadcastGameLobbyState(lobby);
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

  private handleChangeFormat(userId: string, format: '1v1' | '2v2' | '3v3'): void {
    const user = this.users.get(userId);
    if (!user?.gameLobbyId) return;

    const lobby = this.gameLobbies.get(user.gameLobbyId);
    if (!lobby) return;

    if (lobby.hostUserId !== userId) {
      this.send(user.socket, { type: 'error', message: 'Only the host can change the format' });
      return;
    }

    const result = lobby.setFormat(format);
    if (!result.success) {
      this.send(user.socket, { type: 'error', message: result.error! });
      return;
    }

    this.broadcastGameLobbyState(lobby);
    this.broadcastLobbyState();
  }

  private handleChangeMap(userId: string, mapId: string): void {
    const user = this.users.get(userId);
    if (!user?.gameLobbyId) return;

    const lobby = this.gameLobbies.get(user.gameLobbyId);
    if (!lobby) return;

    if (lobby.hostUserId !== userId) {
      this.send(user.socket, { type: 'error', message: 'Only the host can change the map' });
      return;
    }

    const result = lobby.setMapId(mapId);
    if (!result.success) {
      this.send(user.socket, { type: 'error', message: result.error! });
      return;
    }

    this.broadcastGameLobbyState(lobby);
    this.broadcastLobbyState();
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

    // Wire unreliable DataChannel lookup for position broadcasts
    if (this.dataChannelMap) {
      const dcMap = this.dataChannelMap;
      session.getDataChannel = (userId) => dcMap.get(userId);
    }
    session.onRematch = (oldGameId, info) => this.handleRematch(oldGameId, info);
    session.onGracePeriodExpired = (userId) => {
      this.pendingRejoins.delete(userId);
      if (session.isEmpty()) {
        session.stop();
        this.gameSessions.delete(gameId);
        this.broadcastLobbyState();
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
    this.broadcastLobbyState();
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
        status: u.gameSessionId ? 'in-game' : u.status,
      });
    }

    const games: LobbyGameInfo[] = [];
    for (const lobby of this.gameLobbies.values()) {
      games.push(lobby.getInfo());
    }
    for (const session of this.gameSessions.values()) {
      games.push(session.getLobbyInfo());
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
        status: u.gameSessionId ? 'in-game' : u.status,
      });
    }

    const games: LobbyGameInfo[] = [];
    for (const lobby of this.gameLobbies.values()) {
      games.push(lobby.getInfo());
    }
    for (const session of this.gameSessions.values()) {
      games.push(session.getLobbyInfo());
    }

    this.send(user.socket, { type: 'lobby_state', users, games });
  }

  /** Send recent lobby chat history to a single socket (on join / return from game). */
  private sendChatHistory(socket: WebSocket): void {
    if (socket.readyState !== socket.OPEN) return;
    for (const msg of this.chatHistory) {
      socket.send(encodeMessage(msg));
    }
  }

  private send(socket: WebSocket, msg: ServerMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(encodeMessage(msg));
    }
  }
}
