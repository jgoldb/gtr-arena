import type { WebSocket } from 'ws';
import type { CharacterId, GameFormat, ServerMessage, ClientMessage, S2C_GameStart, S2C_GameOver, S2C_EntityDied } from '@gtr/shared';
import { MAPS } from '@gtr/shared';
import { ServerEngine } from './ServerEngine.js';
import { ServerEntity } from './ServerEntity.js';

interface SessionPlayer {
  userId: string;
  username: string;
  team: number;
  characterId: CharacterId;
}

export class GameSession {
  readonly gameId: string;
  private readonly mapId: string;
  private engine: ServerEngine;
  private players: SessionPlayer[];
  private sockets: Map<string, WebSocket>;
  private entityIdByUserId = new Map<string, string>();
  private onGameOver: (gameId: string) => void;
  private stopped = false;

  constructor(
    gameId: string,
    mapId: string,
    _format: GameFormat,
    players: readonly { userId: string; username: string; team: number; characterId: CharacterId | null }[],
    sockets: Map<string, WebSocket>,
    onGameOver: (gameId: string) => void,
  ) {
    this.gameId = gameId;
    this.sockets = sockets;
    this.onGameOver = onGameOver;

    this.mapId = mapId;
    const mapInfo = MAPS[mapId];
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
    }

    // Wire engine callbacks
    this.engine.onBroadcast = (msg) => this.broadcast(msg);
    this.engine.onSendToPlayer = (entityId, msg) => this.sendToEntity(entityId, msg);
    this.engine.onGameOver = (winningTeam) => this.handleGameOver(winningTeam);
  }

  start(): void {
    // Send game_start to each player with their local entity ID
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
        countdown: 3,
      };
      this.sendToUser(p.userId, msg);
    }

    // Start the engine after a countdown delay
    setTimeout(() => {
      if (!this.stopped) this.engine.start();
    }, 3000);
  }

  stop(): void {
    this.stopped = true;
    this.engine.stop();
  }

  handleMessage(userId: string, msg: ClientMessage): void {
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
    }
  }

  removePlayer(userId: string): void {
    this.sockets.delete(userId);
    if (this.stopped) return;

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

  isEmpty(): boolean {
    return this.sockets.size === 0;
  }

  getPlayerIds(): string[] {
    return this.players.map(p => p.userId);
  }

  private handleGameOver(winningTeam: number): void {
    const msg: S2C_GameOver = { type: 'game_over', winningTeam };
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

    this.stop();
    this.onGameOver(this.gameId);
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
    // Find userId for this entity
    for (const [userId, eid] of this.entityIdByUserId) {
      if (eid === entityId) {
        this.sendToUser(userId, msg);
        return;
      }
    }
  }

  private sendToUser(userId: string, msg: ServerMessage): void {
    const socket = this.sockets.get(userId);
    if (socket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }
}
