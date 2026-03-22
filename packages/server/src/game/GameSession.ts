import type { WebSocket } from 'ws';
import type { CharacterId, GameFormat, ServerMessage, ClientMessage, S2C_GameStart, S2C_GameOver, S2C_EntityDied, S2C_CountdownStart, S2C_GodModeUpdate, S2C_RematchChallenge, S2C_RematchReadyUpdate, S2C_RematchFailed, MapInfo } from '@gtr/shared';
import { MAPS, MAP_LIST } from '@gtr/shared';
import { ServerEngine } from './ServerEngine.js';
import { ServerEntity } from './ServerEntity.js';
import type { AuthManager } from '../auth/AuthManager.js';
import type { GtrDatabase } from '../db/Database.js';

interface SessionPlayer {
  userId: string;
  username: string;
  team: number;
  characterId: CharacterId;
}

export interface RematchInfo {
  mapId: string;
  format: GameFormat;
  players: readonly SessionPlayer[];
  sockets: Map<string, WebSocket>;
}

export class GameSession {
  readonly gameId: string;
  readonly format: GameFormat;
  private readonly mapId: string;
  private readonly mapInfo: MapInfo | undefined;
  private engine: ServerEngine;
  private players: SessionPlayer[];
  private sockets: Map<string, WebSocket>;
  private entityIdByUserId = new Map<string, string>();
  private userIdByEntityId = new Map<string, string>();
  private auth: AuthManager;
  private db: GtrDatabase;
  private onGameOver: (gameId: string) => void;
  onRematch: ((gameId: string, info: RematchInfo) => void) | null = null;
  private stopped = false;
  private gameOver = false;
  private statsRecorded = false;
  private readyPlayers = new Set<string>();
  private readyTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private arenaOpenTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private arenaPreparationActive = false;
  private countdownStarted = false;
  private static readonly READY_TIMEOUT_MS = 10_000; // max wait for slow clients
  private static readonly COUNTDOWN_SECONDS = 3;

  // Rematch state
  private rematchRequester: string | null = null;
  private rematchMapMode: 'random' | 'same' | 'new' | null = null;
  private rematchAccepted = new Set<string>();

  constructor(
    gameId: string,
    mapId: string,
    format: GameFormat,
    players: readonly { userId: string; username: string; team: number; characterId: CharacterId | null }[],
    sockets: Map<string, WebSocket>,
    auth: AuthManager,
    db: GtrDatabase,
    onGameOver: (gameId: string) => void,
  ) {
    this.gameId = gameId;
    this.format = format;
    this.sockets = sockets;
    this.auth = auth;
    this.db = db;
    this.onGameOver = onGameOver;

    this.mapId = mapId;
    this.mapInfo = MAPS[mapId];
    const mapInfo = this.mapInfo;
    this.engine = new ServerEngine(mapInfo?.obstacles ?? []);

    this.players = players.map(p => ({
      userId: p.userId,
      username: p.username,
      team: p.team,
      characterId: p.characterId ?? 'janitor',
    }));

    // Create entities at spawn points
    for (const p of this.players) {
      const entityId = `entity_${p.userId}`;
      const entity = new ServerEntity(entityId, p.userId, p.characterId, p.username, p.team);

      // Place at team spawn point, facing toward map center (i.e. toward the enemy)
      const spawn = mapInfo?.spawnPoints[p.team];
      if (spawn) {
        entity.x = spawn.x;
        entity.y = spawn.y;
        entity.z = spawn.z;
        entity.rotationY = Math.atan2(-spawn.x, -spawn.z);
      }

      this.engine.addEntity(entity);
      this.entityIdByUserId.set(p.userId, entityId);
      this.userIdByEntityId.set(entityId, p.userId);
    }

    // Wire engine callbacks
    this.engine.onBroadcast = (msg) => this.broadcast(msg);
    this.engine.onSendToPlayer = (entityId, msg) => this.sendToEntity(entityId, msg);
    this.engine.onGameOver = (winningTeam) => this.handleGameOver(winningTeam);
  }

  start(): void {
    // Send game_start to each player with their local entity ID.
    // Clients load assets/scene, then send 'client_ready'. The countdown
    // begins once ALL clients report ready (or after a timeout fallback).
    const allEntities = this.engine.getAllEntities();
    const snapshots = allEntities.map(e => e.toSnapshot());

    for (const p of this.players) {
      const entityId = this.entityIdByUserId.get(p.userId)!;
      const msg: S2C_GameStart = {
        type: 'game_start',
        gameId: this.gameId,
        mapId: this.mapId,
        entities: snapshots,
        localEntityId: entityId,
        countdown: GameSession.COUNTDOWN_SECONDS,
      };
      this.sendToUser(p.userId, msg);
    }

    // Fallback: if not all clients report ready within the timeout, start anyway
    this.readyTimeoutId = setTimeout(() => {
      if (!this.stopped && !this.countdownStarted) {
        this.beginCountdown();
      }
    }, GameSession.READY_TIMEOUT_MS);
  }

  /** Called when a client reports it has loaded and is ready. */
  markReady(userId: string): void {
    if (this.countdownStarted || this.stopped) return;
    this.readyPlayers.add(userId);

    // Check if all connected players are ready
    const allReady = this.players.every(p =>
      this.readyPlayers.has(p.userId) || !this.sockets.has(p.userId)
    );
    if (allReady) {
      this.beginCountdown();
    }
  }

  private beginCountdown(): void {
    if (this.countdownStarted) return;
    this.countdownStarted = true;

    if (this.readyTimeoutId) {
      clearTimeout(this.readyTimeoutId);
      this.readyTimeoutId = null;
    }

    // Tell all clients the countdown is starting NOW (synchronized)
    const countdownMsg: S2C_CountdownStart = {
      type: 'countdown_start',
      countdown: GameSession.COUNTDOWN_SECONDS,
    };
    this.broadcast(countdownMsg);

    // Start the engine tick loop immediately so game state (including buffs) is
    // broadcast to clients during the preparation period.
    this.arenaPreparationActive = true;
    this.engine.applyArenaPreparation();
    this.engine.start();

    // Remove the buff when the arena doors open (arenaOpenTime from map config).
    const arenaOpenTime = this.mapInfo?.arenaOpenTime ?? 30;
    this.arenaOpenTimeoutId = setTimeout(() => {
      this.arenaPreparationActive = false;
      this.arenaOpenTimeoutId = null;
      if (!this.stopped) {
        this.engine.removeArenaPreparation();
      }
    }, arenaOpenTime * 1000);
  }

  stop(): void {
    this.stopped = true;
    this.arenaPreparationActive = false;
    this.engine.stop();
    if (this.readyTimeoutId) {
      clearTimeout(this.readyTimeoutId);
      this.readyTimeoutId = null;
    }
    if (this.arenaOpenTimeoutId) {
      clearTimeout(this.arenaOpenTimeoutId);
      this.arenaOpenTimeoutId = null;
    }
  }

  handleMessage(userId: string, msg: ClientMessage): void {
    // Rematch messages are handled even after game over
    if (msg.type === 'request_rematch') {
      this.handleRematchRequest(userId, msg.mapMode);
      return;
    }
    if (msg.type === 'accept_rematch') {
      this.handleRematchAccept(userId);
      return;
    }
    if (msg.type === 'decline_rematch') {
      this.handleRematchDecline(userId);
      return;
    }

    if (msg.type === 'client_ready') {
      this.markReady(userId);
      return;
    }

    const entityId = this.entityIdByUserId.get(userId);
    if (!entityId) return;

    switch (msg.type) {
      case 'player_state':
        this.engine.updateEntityPosition(entityId, msg.x, msg.y, msg.z, msg.rotationY, msg.isMoving);
        break;
      case 'use_ability':
        this.engine.requestAbility(entityId, msg.abilityId, msg.targetEntityId ?? null);
        break;
      case 'set_target':
        this.engine.setTarget(entityId, msg.targetEntityId);
        break;
      case 'auto_attack':
        this.engine.requestAutoAttack(entityId, msg.targetEntityId);
        break;
      case 'stop_auto_attack':
        this.engine.stopAutoAttack(entityId);
        break;
      case 'cancel_cast':
        this.engine.cancelCastRequest(entityId);
        break;
      case 'cancel_buff':
        this.engine.cancelBuff(entityId, msg.buffId);
        break;
      case 'set_resting':
        this.engine.setResting(entityId, msg.resting);
        break;
      case 'toggle_god_mode':
        if (this.auth.getIsAdmin(userId)) {
          const active = this.engine.toggleGodMode(entityId);
          this.broadcast({
            type: 'god_mode_update',
            entityId,
            active,
          } as S2C_GodModeUpdate);
        }
        break;
    }
  }

  removePlayer(userId: string): void {
    this.sockets.delete(userId);

    // If someone leaves during a pending rematch, cancel it
    if (this.rematchRequester) {
      this.resetRematch();
      this.broadcast({
        type: 'rematch_failed',
        reason: 'A player left the game',
      } as S2C_RematchFailed);
    }

    if (this.stopped && !this.gameOver) return;
    if (this.gameOver) return;

    // Check if any team has 0 connected players — if so, the other team wins
    const connectedUserIds = new Set(this.sockets.keys());
    const teams = new Set(this.players.map(p => p.team));
    for (const team of teams) {
      const teamPlayers = this.players.filter(p => p.team === team);
      const hasConnected = teamPlayers.some(p => connectedUserIds.has(p.userId));
      if (!hasConnected) {
        // This team has no connected players — other team wins
        const winningTeam = [...teams].find(t => t !== team);
        if (winningTeam !== undefined) {
          this.handleGameOver(winningTeam);
        }
        return;
      }
    }
  }

  /** Whether all original players are still connected after game over. */
  get allPlayersPresent(): boolean {
    return this.players.every(p => this.sockets.has(p.userId));
  }

  isEmpty(): boolean {
    return this.sockets.size === 0;
  }

  getPlayerIds(): string[] {
    return this.players.map(p => p.userId);
  }

  private handleGameOver(winningTeam: number): void {
    this.gameOver = true;
    const allPresent = this.allPlayersPresent;
    const msg: S2C_GameOver = { type: 'game_over', winningTeam, allPlayersPresent: allPresent };
    this.broadcast(msg);

    // Notify entity deaths
    for (const entity of this.engine.getAllEntities()) {
      if (entity.dead) {
        this.broadcast({
          type: 'entity_died',
          entityId: entity.id,
          killerEntityId: null,
        } as S2C_EntityDied);
      }
    }

    // Record stats for ALL players (including disconnected ones)
    this.recordStats(winningTeam);

    this.stop();
    this.onGameOver(this.gameId);
  }

  /** Record win/loss stats for every player in this game. Called once at game end. */
  private recordStats(winningTeam: number): void {
    if (this.statsRecorded) return;
    this.statsRecorded = true;

    for (const p of this.players) {
      const dbId = this.auth.getDbId(p.userId);
      if (dbId == null) continue;
      const won = p.team === winningTeam;
      this.db.recordGameResult(dbId, p.characterId, won);
    }
  }

  // ── Rematch ──────────────────────────────────────────────────────────

  private handleRematchRequest(userId: string, mapMode: 'random' | 'same' | 'new'): void {
    // Allow rematch during arena preparation (pre-game) or after game over
    if (!this.arenaPreparationActive && !this.gameOver) return;
    if (!this.allPlayersPresent) {
      this.sendToUser(userId, { type: 'rematch_failed', reason: 'Not all players are present' } as S2C_RematchFailed);
      return;
    }
    if (this.rematchRequester) {
      this.sendToUser(userId, { type: 'error', message: 'A rematch is already in progress' });
      return;
    }

    const requester = this.players.find(p => p.userId === userId);
    if (!requester) return;

    this.rematchRequester = userId;
    this.rematchMapMode = mapMode;
    this.rematchAccepted.clear();
    this.rematchAccepted.add(userId);

    const total = this.players.length;

    // If 1v1, the requester is the only one who needs to accept — check immediately
    if (total === this.rematchAccepted.size) {
      this.executeRematch();
      return;
    }

    // Notify all OTHER players about the challenge
    const challenge: S2C_RematchChallenge = {
      type: 'rematch_challenge',
      challengerUsername: requester.username,
      mapMode,
      totalPlayers: total,
      readyCount: 1,
    };
    for (const p of this.players) {
      if (p.userId !== userId) {
        this.sendToUser(p.userId, challenge);
      }
    }

    // Send ready update to the requester too so they see the ready check
    this.sendToUser(userId, {
      type: 'rematch_ready_update',
      readyCount: 1,
      totalPlayers: total,
    } as S2C_RematchReadyUpdate);
  }

  private handleRematchAccept(userId: string): void {
    if (!this.rematchRequester) return;
    if (this.rematchAccepted.has(userId)) return;

    this.rematchAccepted.add(userId);
    const total = this.players.length;

    // Broadcast updated ready count to all players
    const update: S2C_RematchReadyUpdate = {
      type: 'rematch_ready_update',
      readyCount: this.rematchAccepted.size,
      totalPlayers: total,
    };
    this.broadcast(update);

    if (this.rematchAccepted.size === total) {
      this.executeRematch();
    }
  }

  private handleRematchDecline(userId: string): void {
    if (!this.rematchRequester) return;

    const decliner = this.players.find(p => p.userId === userId);
    const name = decliner?.username ?? 'A player';
    this.resetRematch();
    this.broadcast({
      type: 'rematch_failed',
      reason: `${name} declined the rematch`,
    } as S2C_RematchFailed);
  }

  private executeRematch(): void {
    const mapMode = this.rematchMapMode!;
    let newMapId: string;

    if (mapMode === 'same') {
      newMapId = this.mapId;
    } else if (mapMode === 'random') {
      const mapIds = MAP_LIST.map(m => m.id);
      newMapId = mapIds[Math.floor(Math.random() * mapIds.length)];
    } else {
      // 'new' — iterate to the next map
      const mapIds = MAP_LIST.map(m => m.id);
      const currentIdx = mapIds.indexOf(this.mapId);
      newMapId = mapIds[(currentIdx + 1) % mapIds.length];
    }

    const info: RematchInfo = {
      mapId: newMapId,
      format: this.format,
      players: this.players,
      sockets: new Map(this.sockets),
    };

    this.resetRematch();
    this.onRematch?.(this.gameId, info);
  }

  private resetRematch(): void {
    this.rematchRequester = null;
    this.rematchMapMode = null;
    this.rematchAccepted.clear();
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const socket of this.sockets.values()) {
      if (socket.readyState === socket.OPEN) {
        socket.send(data);
      }
    }
  }

  private sendToEntity(entityId: string, msg: ServerMessage): void {
    const userId = this.userIdByEntityId.get(entityId);
    if (userId) {
      this.sendToUser(userId, msg);
    }
  }

  private sendToUser(userId: string, msg: ServerMessage): void {
    const socket = this.sockets.get(userId);
    if (socket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }
}
