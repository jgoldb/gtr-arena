import type { WebSocket } from 'ws';
import type { ClientMessage, S2C_LobbyState, S2C_LobbyChat, ServerMessage, S2C_GameLobbyState, S2C_GameCancelled } from '@gtr/shared';
import type { LobbyUser, LobbyGameInfo } from '@gtr/shared';
import { GameLobby } from './GameLobby.js';
import { GameSession } from '../game/GameSession.js';

interface ConnectedUser {
  userId: string;
  username: string;
  socket: WebSocket;
  status: 'online' | 'in-game';
  gameLobbyId: string | null;
  gameSessionId: string | null;
}

export class LobbyManager {
  private users = new Map<string, ConnectedUser>();
  private gameLobbies = new Map<string, GameLobby>();
  private gameSessions = new Map<string, GameSession>();
  private nextGameId = 1;

  addUser(userId: string, username: string, socket: WebSocket): void {
    this.users.set(userId, {
      userId,
      username,
      socket,
      status: 'online',
      gameLobbyId: null,
      gameSessionId: null,
    });
    this.broadcastLobbyState();
  }

  removeUser(userId: string): void {
    const user = this.users.get(userId);
    if (!user) return;

    // Leave game lobby if in one
    if (user.gameLobbyId) {
      this.leaveGameLobby(userId);
    }

    // Handle active game session disconnect
    if (user.gameSessionId) {
      const session = this.gameSessions.get(user.gameSessionId);
      if (session) {
        session.removePlayer(userId);
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
      // In-game messages are routed to GameSession
      case 'player_state':
      case 'use_ability':
      case 'set_target':
      case 'auto_attack':
      case 'stop_auto_attack':
      case 'cancel_cast':
        if (user.gameSessionId) {
          const session = this.gameSessions.get(user.gameSessionId);
          session?.handleMessage(userId, msg);
        }
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
        }
        user.status = 'online';
        user.gameSessionId = null;
        this.broadcastLobbyState();
        break;
    }
  }

  private handleChat(userId: string, message: string): void {
    const user = this.users.get(userId);
    if (!user || !message.trim()) return;

    const chatMsg: S2C_LobbyChat = {
      type: 'lobby_chat',
      userId,
      username: user.username,
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
    const lobby = new GameLobby(gameId, format, mapId, userId, user.username);
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

    const result = lobby.addPlayer(userId, user.username);
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
  }

  private handleStartGame(userId: string): void {
    const user = this.users.get(userId);
    if (!user?.gameLobbyId) return;

    const lobby = this.gameLobbies.get(user.gameLobbyId);
    if (!lobby) return;

    if (lobby.hostUserId !== userId) {
      this.send(user.socket, { type: 'error', message: 'Only the host can start the game' });
      return;
    }

    const validation = lobby.canStart();
    if (!validation.success) {
      this.send(user.socket, { type: 'error', message: validation.error! });
      return;
    }

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

    const session = new GameSession(
      lobby.gameId,
      lobby.mapId,
      lobby.format,
      players,
      playerSockets,
      // onGameOver callback — just stop the session engine.
      // Players remain in 'in-game' status until they individually send 'return_to_lobby'.
      (gameId: string) => {
        this.gameSessions.delete(gameId);
      }
    );

    this.gameSessions.set(lobby.gameId, session);
    this.gameLobbies.delete(lobby.gameId);

    session.start();
    this.broadcastLobbyState();
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
        username: u.username,
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
        username: u.username,
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
