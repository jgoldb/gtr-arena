import type { WebSocket } from 'ws';
import type { DataChannel } from 'node-datachannel';
import type { CharacterId, GameFormat, ServerMessage, ClientMessage, EntitySnapshot, S2C_GameStart, S2C_GameOver, S2C_EntityDied, S2C_CountdownStart, S2C_GodModeUpdate, S2C_GateVoteUpdate, S2C_GameChat, S2C_RematchChallenge, S2C_RematchReadyUpdate, S2C_RematchFailed, S2C_RejoinGame, S2C_PlayerDisconnected, S2C_PlayerReconnected, S2C_EntityRemoved, MapInfo, PlayerMatchStats, PlayerMatchResult, LobbyGameInfo } from '@gtr/shared';
import { MAPS, MAP_LIST, xpToLevel, calculateXpGain, getMaxPlayers, encodeMessage } from '@gtr/shared';
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
  private arenaCountdownStartedAt = 0;
  private gateVotes = new Set<string>();
  private static readonly READY_TIMEOUT_MS = 10_000; // max wait for slow clients
  private static readonly COUNTDOWN_SECONDS = 3;

  // Disconnect grace period
  private disconnectedPlayers = new Map<string, { timer: ReturnType<typeof setTimeout> }>();
  onGracePeriodExpired: ((userId: string) => void) | null = null;
  private static readonly DISCONNECT_GRACE_PERIOD_MS = 120_000; // 2 minutes

  // Per-player match stats (survives entity removal)
  private matchStats = new Map<string, PlayerMatchStats>();

  // Players who left/disconnected before the game ended — they get a loss but no XP
  private removedBeforeEnd = new Set<string>();

  /** Callback to look up active DataChannels by userId — injected by LobbyManager/index. */
  getDataChannel: ((userId: string) => DataChannel | undefined) | null = null;

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
    this.engine = new ServerEngine(mapInfo?.obstacles ?? [], mapId);

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

    // Initialize match stats for every player (persists through disconnects)
    for (const p of this.players) {
      this.matchStats.set(p.userId, { kills: 0, deaths: 0, damageDealt: 0, healingDone: 0 });
    }

    this.wireEngineCallbacks();
  }

  /** Wire all engine callbacks — shared by constructor and restore(). */
  private wireEngineCallbacks(): void {
    // Inject arenaTimeRemaining + gameElapsed into keyframe snapshots, and persist state
    this.engine.onBroadcast = (msg) => {
      if (msg.type === 'game_state_snapshot') {
        const snapshot = msg as import('@gtr/shared').S2C_GameStateSnapshot;
        if (this.arenaPreparationActive && this.arenaCountdownStartedAt > 0) {
          const arenaOpenTime = this.mapInfo?.arenaOpenTime ?? 30;
          const elapsedMs = Date.now() - this.arenaCountdownStartedAt;
          const remainingSec = arenaOpenTime - elapsedMs / 1000;
          if (remainingSec > 0) {
            snapshot.arenaTimeRemaining = remainingSec;
          }
        }
        snapshot.gameElapsed = this.engine.getGameElapsed();
        // Persist to DB on each keyframe for crash recovery
        if (!this.gameOver) {
          this.persistState();
        }
      }
      this.broadcast(msg);
    };
    this.engine.onSendToPlayer = (entityId, msg) => this.sendToEntity(entityId, msg);
    this.engine.onPositionRelay = (senderEntityId, msg) => this.broadcastExcept(senderEntityId, msg);
    this.engine.onBroadcastUnreliable = (msg) => this.broadcastUnreliable(msg);
    this.engine.onPositionRelayUnreliable = (senderEntityId, msg) => this.broadcastUnreliableExcept(senderEntityId, msg);
    this.engine.onGameOver = (winningTeam) => this.handleGameOver(winningTeam);

    // Wire match stat tracking (ignore stats during arena preparation)
    this.engine.onStatDamage = (sourceEntityId, _targetEntityId, amount) => {
      if (this.arenaPreparationActive) return;
      const userId = this.userIdByEntityId.get(sourceEntityId);
      if (userId) {
        const stats = this.matchStats.get(userId);
        if (stats) stats.damageDealt += amount;
      }
    };
    this.engine.onStatHeal = (sourceEntityId, _targetEntityId, amount) => {
      if (this.arenaPreparationActive) return;
      const userId = this.userIdByEntityId.get(sourceEntityId);
      if (userId) {
        const stats = this.matchStats.get(userId);
        if (stats) stats.healingDone += amount;
      }
    };
    this.engine.onStatKill = (killerEntityId, victimEntityId) => {
      if (this.arenaPreparationActive) return;
      const killerUserId = this.userIdByEntityId.get(killerEntityId);
      if (killerUserId) {
        const stats = this.matchStats.get(killerUserId);
        if (stats) stats.kills += 1;
      }
      const victimUserId = this.userIdByEntityId.get(victimEntityId);
      if (victimUserId) {
        const stats = this.matchStats.get(victimUserId);
        if (stats) stats.deaths += 1;
      }
    };
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
    this.arenaCountdownStartedAt = Date.now();
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

  private handleGateVote(userId: string): void {
    if (!this.arenaPreparationActive || this.stopped) return;
    this.gateVotes.add(userId);

    const totalPlayers = this.players.length;
    const voteCount = this.gateVotes.size;

    // Broadcast updated vote count
    this.broadcast({
      type: 'gate_vote_update',
      voteCount,
      totalPlayers,
    } as S2C_GateVoteUpdate);

    // If all players voted, immediately open gates
    if (voteCount >= totalPlayers) {
      this.arenaPreparationActive = false;
      if (this.arenaOpenTimeoutId) {
        clearTimeout(this.arenaOpenTimeoutId);
        this.arenaOpenTimeoutId = null;
      }
      if (!this.stopped) {
        this.engine.removeArenaPreparation();
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.arenaPreparationActive = false;
    this.engine.stop();
    this.deletePersistedState();
    if (this.readyTimeoutId) {
      clearTimeout(this.readyTimeoutId);
      this.readyTimeoutId = null;
    }
    if (this.arenaOpenTimeoutId) {
      clearTimeout(this.arenaOpenTimeoutId);
      this.arenaOpenTimeoutId = null;
    }
    for (const dc of this.disconnectedPlayers.values()) {
      clearTimeout(dc.timer);
    }
    this.disconnectedPlayers.clear();
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

    if (msg.type === 'vote_open_gates') {
      this.handleGateVote(userId);
      return;
    }

    const entityId = this.entityIdByUserId.get(userId);
    if (!entityId) return;

    switch (msg.type) {
      case 'player_state':
        // Ignore position updates from clients that haven't yet signalled ready for
        // this session.  During a rematch the old ClientEngine can still fire off
        // player_state messages before the new game_start is processed, which would
        // overwrite the fresh spawn position.
        if (!this.readyPlayers.has(userId) && !this.countdownStarted) break;
        this.engine.updateEntityPosition(entityId, msg.x, msg.y, msg.z, msg.rotationY, msg.isMoving, msg.vx, msg.vz, msg.moveFlags, msg.moveSpeed, msg.vy, msg.turnSpeed);
        break;
      case 'use_ability':
        this.engine.requestAbility(
          entityId, msg.abilityId, msg.targetEntityId ?? null,
          msg.groundTargetX !== undefined && msg.groundTargetZ !== undefined
            ? { x: msg.groundTargetX, y: msg.groundTargetY ?? 0, z: msg.groundTargetZ } : undefined,
          msg.serverTimestamp
        );
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
      case 'game_chat': {
        const trimmed = msg.message.trim().substring(0, 500);
        if (!trimmed) break;
        const player = this.players.find(p => p.userId === userId);
        if (!player) break;
        this.broadcast({ type: 'game_chat', username: player.username, message: trimmed } as S2C_GameChat);
        break;
      }
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

  /** Explicit leave (return to lobby). Immediately removes the player's entity. */
  removePlayer(userId: string): void {
    // Clear any grace period
    const dc = this.disconnectedPlayers.get(userId);
    if (dc) {
      clearTimeout(dc.timer);
      this.disconnectedPlayers.delete(userId);
    }

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

    // Immediately remove the entity from the game world
    const entityId = this.entityIdByUserId.get(userId);
    const player = this.players.find(p => p.userId === userId);
    if (entityId) {
      this.engine.removeEntity(entityId);
      this.broadcast({ type: 'entity_removed', entityId, username: player?.username } as S2C_EntityRemoved);
    }

    // Track that this player left before the game ended (loss, no XP)
    if (!this.gameOver) {
      this.removedBeforeEnd.add(userId);
      this.checkTeamForfeit();
    }
  }

  /** WebSocket closed — start grace period for reconnection. */
  disconnectPlayer(userId: string): void {
    this.sockets.delete(userId);

    if (this.rematchRequester) {
      this.resetRematch();
      this.broadcast({
        type: 'rematch_failed',
        reason: 'A player disconnected',
      } as S2C_RematchFailed);
    }

    if (this.stopped && !this.gameOver) return;

    const entityId = this.entityIdByUserId.get(userId);
    if (!entityId) return;
    const player = this.players.find(p => p.userId === userId);
    if (!player) return;

    // Freeze alive entities during active game (dead/post-game entities stay as-is)
    const entity = this.engine.getEntity(entityId);
    if (!this.gameOver && entity && !entity.dead) {
      this.engine.freezeEntity(entityId);
    }

    // All disconnects get a grace period — dead players and post-game players
    // can still reconnect to see results and rematch
    const timer = setTimeout(() => {
      this.disconnectedPlayers.delete(userId);
      this.engine.removeEntity(entityId);
      this.broadcast({ type: 'entity_removed', entityId, username: player?.username } as S2C_EntityRemoved);
      this.onGracePeriodExpired?.(userId);
      if (!this.gameOver) {
        this.removedBeforeEnd.add(userId);
        this.checkTeamForfeit();
      }
    }, GameSession.DISCONNECT_GRACE_PERIOD_MS);
    this.disconnectedPlayers.set(userId, { timer });

    this.broadcast({
      type: 'player_disconnected',
      entityId,
      username: player.username,
    } as S2C_PlayerDisconnected);
  }

  /** Reconnect a player to the active game. Returns true if successful. */
  rejoinPlayer(userId: string, socket: WebSocket): boolean {
    const player = this.players.find(p => p.userId === userId);
    if (!player) return false;
    const entityId = this.entityIdByUserId.get(userId);
    if (!entityId) return false;

    // Clear grace period
    const dc = this.disconnectedPlayers.get(userId);
    if (dc) {
      clearTimeout(dc.timer);
      this.disconnectedPlayers.delete(userId);
    }

    this.sockets.set(userId, socket);
    this.engine.unfreezeEntity(entityId);

    // Snap entity to elevator if within its footprint (prevents mid-air spawn on rejoin)
    this.engine.snapEntityToElevator(entityId);

    // Build rejoin message with full current state
    const allEntities = this.engine.getAllEntities();
    const snapshots = allEntities.map(e => e.toSnapshot());
    const fullState = this.engine.getFullState();

    const disconnectedEntityIds: string[] = [];
    for (const [dcUserId] of this.disconnectedPlayers) {
      const dcEntityId = this.entityIdByUserId.get(dcUserId);
      if (dcEntityId) disconnectedEntityIds.push(dcEntityId);
    }

    // Calculate remaining arena prep time
    let arenaTimeRemaining: number | undefined;
    if (this.arenaPreparationActive && this.arenaCountdownStartedAt > 0) {
      const arenaOpenTime = this.mapInfo?.arenaOpenTime ?? 30;
      const elapsedMs = Date.now() - this.arenaCountdownStartedAt;
      const remainingSec = arenaOpenTime - elapsedMs / 1000;
      arenaTimeRemaining = remainingSec > 0 ? remainingSec : 0;
    }

    const rejoinMsg: S2C_RejoinGame = {
      type: 'rejoin_game',
      gameId: this.gameId,
      mapId: this.mapId,
      entities: snapshots,
      localEntityId: entityId,
      buffs: fullState.buffs,
      gasClouds: fullState.gasClouds,
      chemicalPools: fullState.chemicalPools,
      cooldowns: fullState.cooldowns,
      disconnectedEntityIds,
      ...(this.gameOver ? { gameOver: { winningTeam: this.getWinningTeam(), playerResults: this.buildPlayerResults(this.getWinningTeam()) } } : {}),
      ...(arenaTimeRemaining !== undefined ? { arenaTimeRemaining } : {}),
      gameElapsed: this.engine.getGameElapsed(),
    };
    this.sendToUser(userId, rejoinMsg);

    // Notify others
    this.broadcast({
      type: 'player_reconnected',
      entityId,
      username: player.username,
    } as S2C_PlayerReconnected);

    return true;
  }

  /** Check if any team has 0 connected players. Returns true if forfeit triggered. */
  private checkTeamForfeit(): boolean {
    const connectedUserIds = new Set(this.sockets.keys());
    const teams = new Set(this.players.map(p => p.team));
    for (const team of teams) {
      const teamPlayers = this.players.filter(p => p.team === team);
      const hasConnected = teamPlayers.some(p => connectedUserIds.has(p.userId));
      if (!hasConnected) {
        const winningTeam = [...teams].find(t => t !== team);
        if (winningTeam !== undefined) {
          this.handleGameOver(winningTeam);
        }
        return true;
      }
    }
    return false;
  }

  /** Whether all original players are still connected after game over. */
  get allPlayersPresent(): boolean {
    return this.players.every(p => this.sockets.has(p.userId));
  }

  /** Whether the session has no connected players AND no pending grace periods. */
  isEmpty(): boolean {
    return this.sockets.size === 0 && this.disconnectedPlayers.size === 0;
  }

  hasDisconnectedPlayer(userId: string): boolean {
    return this.disconnectedPlayers.has(userId);
  }

  getPlayerIds(): string[] {
    return this.players.map(p => p.userId);
  }

  getLobbyInfo(): LobbyGameInfo {
    return {
      gameId: this.gameId,
      format: this.format,
      mapId: this.mapId,
      mapName: this.mapInfo?.name ?? this.mapId,
      hostUsername: this.players[0]?.username ?? 'Unknown',
      playerCount: this.players.length,
      maxPlayers: getMaxPlayers(this.format),
      inProgress: true,
    };
  }

  private winningTeamResult = -1;

  private getWinningTeam(): number {
    return this.winningTeamResult;
  }

  /** Build results array for all original players (including disconnected), with pre-computed XP. */
  private buildPlayerResults(winningTeam: number): PlayerMatchResult[] {
    // Compute levels and XP gains before building results
    const playerInfos = new Map<string, { level: number; xpGained: number }>();
    const infos: { userId: string; dbId: number; team: number; level: number }[] = [];
    for (const p of this.players) {
      const dbId = this.auth.getDbId(p.userId);
      if (dbId == null) continue;
      const xp = this.db.getUserXp(dbId);
      infos.push({ userId: p.userId, dbId, team: p.team, level: xpToLevel(xp) });
    }
    for (const info of infos) {
      const won = info.team === winningTeam;
      // Players removed before game end or with no damage/healing contribution get no XP
      const removed = this.removedBeforeEnd.has(info.userId);
      const pStats = this.matchStats.get(info.userId);
      const contributed = pStats != null && (pStats.damageDealt > 0 || pStats.healingDone > 0);
      const highestOpponentLevel = infos
        .filter(o => o.team !== info.team)
        .reduce((max, o) => Math.max(max, o.level), 1);
      const xpGained = (removed || !contributed) ? 0 : calculateXpGain(info.level, highestOpponentLevel, won);
      playerInfos.set(info.userId, { level: info.level, xpGained });
    }

    return this.players.map(p => {
      const info = playerInfos.get(p.userId);
      return {
        userId: p.userId,
        username: p.username,
        team: p.team,
        characterId: p.characterId,
        stats: this.matchStats.get(p.userId) ?? { kills: 0, deaths: 0, damageDealt: 0, healingDone: 0 },
        level: info?.level ?? 1,
        xpGained: info?.xpGained ?? 0,
      };
    });
  }

  private handleGameOver(winningTeam: number): void {
    this.gameOver = true;
    this.winningTeamResult = winningTeam;

    // Clear all grace period timers — game is over
    for (const dc of this.disconnectedPlayers.values()) {
      clearTimeout(dc.timer);
    }
    this.disconnectedPlayers.clear();

    const allPresent = this.allPlayersPresent;
    const playerResults = this.buildPlayerResults(winningTeam);
    const msg: S2C_GameOver = { type: 'game_over', winningTeam, allPlayersPresent: allPresent, playerResults };
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

    // Record stats and award XP for ALL players (including disconnected ones)
    this.recordStats(winningTeam);

    // Game is over — no need to persist for crash recovery
    this.deletePersistedState();
  }

  /** Record win/loss stats and award XP for every player in this game. Called once at game end. */
  private recordStats(winningTeam: number): void {
    if (this.statsRecorded) return;
    this.statsRecorded = true;

    // Build a map of dbId → level for all players so we can look up opponent levels
    const playerInfos: { userId: string; dbId: number; team: number; characterId: string; level: number }[] = [];
    for (const p of this.players) {
      const dbId = this.auth.getDbId(p.userId);
      if (dbId == null) continue;
      const xp = this.db.getUserXp(dbId);
      playerInfos.push({ userId: p.userId, dbId, team: p.team, characterId: p.characterId, level: xpToLevel(xp) });
    }

    for (const info of playerInfos) {
      const removed = this.removedBeforeEnd.has(info.userId);
      // Players removed before game end always get a loss
      const won = removed ? false : info.team === winningTeam;
      this.db.recordGameResult(info.dbId, info.characterId, won);

      // Players removed before game end or with no damage/healing contribution get no XP
      const pStats = this.matchStats.get(info.userId);
      const contributed = pStats != null && (pStats.damageDealt > 0 || pStats.healingDone > 0);
      if (!removed && contributed) {
        const highestOpponentLevel = playerInfos
          .filter(o => o.team !== info.team)
          .reduce((max, o) => Math.max(max, o.level), 1);

        const xpGain = calculateXpGain(info.level, highestOpponentLevel, won);
        const newXp = this.db.addXp(info.dbId, xpGain);
        this.sendToUser(info.userId, { type: 'xp_update', xp: newXp });
      }
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

  // ── Crash recovery persistence ──────────────────────────────────────

  /** Serialize and persist current session state to the database (called every keyframe). */
  private persistState(): void {
    const entities = this.engine.getAllEntities().map(e => e.toSnapshot());
    const cooldowns = this.engine.getFullState().cooldowns;

    const matchStatsObj: Record<string, PlayerMatchStats> = {};
    for (const [userId, stats] of this.matchStats) {
      matchStatsObj[userId] = stats;
    }

    this.db.saveActiveSession({
      gameId: this.gameId,
      mapId: this.mapId,
      format: this.format,
      players: JSON.stringify(this.players),
      gameStartedAt: Date.now() - this.engine.getGameElapsed() * 1000,
      gameElapsed: this.engine.getGameElapsed(),
      arenaCountdownStartedAt: this.arenaCountdownStartedAt,
      countdownStarted: this.countdownStarted,
      arenaPreparationActive: this.arenaPreparationActive,
      matchStats: JSON.stringify(matchStatsObj),
      removedBeforeEnd: JSON.stringify([...this.removedBeforeEnd]),
      gameState: JSON.stringify({ entities, cooldowns }),
    });
  }

  /** Delete persisted state (game over or session cleanup). */
  deletePersistedState(): void {
    this.db.deleteActiveSession(this.gameId);
  }

  /** Restore a GameSession from persisted database state (called on server startup). */
  static restore(
    data: {
      gameId: string;
      mapId: string;
      format: string;
      players: string;
      gameStartedAt: number;
      gameElapsed: number;
      arenaCountdownStartedAt: number;
      countdownStarted: boolean;
      arenaPreparationActive: boolean;
      matchStats: string;
      removedBeforeEnd: string;
      gameState: string;
    },
    auth: AuthManager,
    db: GtrDatabase,
    onGameOver: (gameId: string) => void,
  ): GameSession | null {
    const players: SessionPlayer[] = JSON.parse(data.players);
    const gameState: { entities: EntitySnapshot[]; cooldowns: { entityId: string; abilityId: string; remaining: number; total: number }[] } = JSON.parse(data.gameState);
    const matchStatsObj: Record<string, PlayerMatchStats> = JSON.parse(data.matchStats);
    const removedBeforeEnd: string[] = JSON.parse(data.removedBeforeEnd);

    const mapInfo = MAPS[data.mapId];
    const format = data.format as GameFormat;

    // Create session with empty sockets (all players disconnected on restart)
    const session = new GameSession(
      data.gameId,
      data.mapId,
      format,
      players,
      new Map(), // no sockets — all players are disconnected
      auth,
      db,
      onGameOver,
    );

    // Restore entity positions/state from saved snapshots
    const restoredEntityIds = new Set<string>();
    for (const snap of gameState.entities) {
      const entity = session.engine.getEntity(snap.id);
      if (entity) {
        entity.applySnapshot(snap);
        restoredEntityIds.add(snap.id);
      }
    }

    // Remove entities for players who were removed before the crash
    // (the constructor creates all entities, but some may have been removed mid-game)
    for (const userId of removedBeforeEnd) {
      const entityId = session.entityIdByUserId.get(userId);
      if (entityId && !restoredEntityIds.has(entityId)) {
        session.engine.removeEntity(entityId);
      }
    }

    // Restore game elapsed time so getGameElapsed() returns the correct value
    session.engine.setElapsedOffset(data.gameElapsed);

    // Restore session-level state
    session.countdownStarted = data.countdownStarted;
    session.arenaCountdownStartedAt = data.arenaCountdownStartedAt;

    // Handle arena preparation — check if prep time has elapsed since the crash
    if (data.arenaPreparationActive && data.arenaCountdownStartedAt > 0) {
      const arenaOpenTime = mapInfo?.arenaOpenTime ?? 30;
      const elapsedSinceCountdown = (Date.now() - data.arenaCountdownStartedAt) / 1000;
      if (elapsedSinceCountdown < arenaOpenTime) {
        // Still in arena prep — reapply buff and schedule removal
        session.arenaPreparationActive = true;
        session.engine.applyArenaPreparation();
        const remainingMs = (arenaOpenTime - elapsedSinceCountdown) * 1000;
        session.arenaOpenTimeoutId = setTimeout(() => {
          session.arenaPreparationActive = false;
          session.arenaOpenTimeoutId = null;
          if (!session.stopped) {
            session.engine.removeArenaPreparation();
          }
        }, remainingMs);
      } else {
        // Prep time already elapsed — skip it
        session.arenaPreparationActive = false;
      }
    } else {
      session.arenaPreparationActive = false;
    }

    // Restore match stats
    for (const [userId, stats] of Object.entries(matchStatsObj)) {
      session.matchStats.set(userId, stats);
    }

    // Restore removed-before-end set
    for (const userId of removedBeforeEnd) {
      session.removedBeforeEnd.add(userId);
    }

    // Start the engine tick loop (entities will be frozen once we disconnect all players)
    session.engine.start();

    // Freeze all entities and mark all players as disconnected
    for (const p of players) {
      const entityId = session.entityIdByUserId.get(p.userId);
      if (entityId) {
        const entity = session.engine.getEntity(entityId);
        if (entity && !entity.dead) {
          session.engine.freezeEntity(entityId);
        }
      }
    }

    return session;
  }

  /** Start grace period for a player without requiring them to have been connected.
   *  Used during session restore when all players start disconnected. */
  startGracePeriod(userId: string): void {
    if (this.disconnectedPlayers.has(userId)) return;
    const entityId = this.entityIdByUserId.get(userId);
    if (!entityId) return;
    const player = this.players.find(p => p.userId === userId);
    if (!player) return;

    const timer = setTimeout(() => {
      this.disconnectedPlayers.delete(userId);
      this.engine.removeEntity(entityId);
      this.broadcast({ type: 'entity_removed', entityId, username: player?.username } as S2C_EntityRemoved);
      this.onGracePeriodExpired?.(userId);
      if (!this.gameOver) {
        this.removedBeforeEnd.add(userId);
        this.checkTeamForfeit();
      }
    }, GameSession.DISCONNECT_GRACE_PERIOD_MS);
    this.disconnectedPlayers.set(userId, { timer });
  }

  private broadcast(msg: ServerMessage): void {
    const data = encodeMessage(msg);
    for (const socket of this.sockets.values()) {
      if (socket.readyState === socket.OPEN) {
        socket.send(data);
      }
    }
  }

  /** Broadcast to all clients except the entity's owner (used for position relay). */
  private broadcastExcept(entityId: string, msg: ServerMessage): void {
    const senderUserId = this.userIdByEntityId.get(entityId);
    const data = encodeMessage(msg);
    for (const [userId, socket] of this.sockets) {
      if (userId !== senderUserId && socket.readyState === socket.OPEN) {
        socket.send(data);
      }
    }
  }

  /** Broadcast via unreliable DataChannel. Users without a DC get the data via the
   *  reliable game_state_update fallback (positions included when DC is unavailable). */
  private broadcastUnreliable(msg: ServerMessage): void {
    const data = encodeMessage(msg);
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    for (const userId of this.sockets.keys()) {
      const dc = this.getDataChannel?.(userId);
      if (dc && dc.isOpen()) {
        try { dc.sendMessageBinary(buf); } catch { /* DC closed mid-send */ }
      }
    }
  }

  /** Broadcast unreliable to all except the entity's owner. */
  private broadcastUnreliableExcept(entityId: string, msg: ServerMessage): void {
    const senderUserId = this.userIdByEntityId.get(entityId);
    const data = encodeMessage(msg);
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    for (const userId of this.sockets.keys()) {
      if (userId === senderUserId) continue;
      const dc = this.getDataChannel?.(userId);
      if (dc && dc.isOpen()) {
        try { dc.sendMessageBinary(buf); } catch { /* DC closed mid-send */ }
      } else {
        // Fallback: send position relay via reliable WebSocket
        const socket = this.sockets.get(userId);
        if (socket && socket.readyState === socket.OPEN) {
          socket.send(data);
        }
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
      socket.send(encodeMessage(msg));
    }
  }
}
