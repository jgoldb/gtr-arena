import type { CharacterId } from '@gtr/shared';
import type { GameFormat, LobbyGameInfo, GameLobbyPlayer } from '@gtr/shared';
import type { S2C_GameLobbyState } from '@gtr/shared';
import { getMaxPlayers, MAPS } from '@gtr/shared';

interface LobbyPlayer {
  userId: string;
  username: string;
  team: number;
  characterId: CharacterId | null;
  lockedIn: boolean;
}

export class GameLobby {
  readonly gameId: string;
  readonly format: GameFormat;
  readonly mapId: string;
  readonly hostUserId: string;
  private players: LobbyPlayer[] = [];

  constructor(gameId: string, format: GameFormat, mapId: string, hostUserId: string, hostUsername: string) {
    this.gameId = gameId;
    this.format = format;
    this.mapId = mapId;
    this.hostUserId = hostUserId;

    this.players.push({
      userId: hostUserId,
      username: hostUsername,
      team: 0,
      characterId: null,
      lockedIn: false,
    });
  }

  addPlayer(userId: string, username: string): { success: boolean; error?: string } {
    const maxPlayers = getMaxPlayers(this.format);
    if (this.players.length >= maxPlayers) {
      return { success: false, error: 'Game is full' };
    }
    if (this.players.some(p => p.userId === userId)) {
      return { success: false, error: 'Already in this game' };
    }

    // Round-robin team assignment
    const team = this.players.length % 2 === 0 ? 0 : 1;

    this.players.push({
      userId,
      username,
      team,
      characterId: null,
      lockedIn: false,
    });

    return { success: true };
  }

  removePlayer(userId: string): void {
    this.players = this.players.filter(p => p.userId !== userId);
  }

  selectCharacter(userId: string, characterId: CharacterId): void {
    const player = this.players.find(p => p.userId === userId);
    if (player && !player.lockedIn) {
      player.characterId = characterId;
    }
  }

  lockIn(userId: string): { success: boolean; error?: string } {
    const player = this.players.find(p => p.userId === userId);
    if (!player) return { success: false, error: 'Not in this game' };
    if (!player.characterId) return { success: false, error: 'Select a character first' };
    player.lockedIn = true;
    return { success: true };
  }

  canStart(): { success: boolean; error?: string } {
    const maxPlayers = getMaxPlayers(this.format);
    if (this.players.length !== maxPlayers) {
      return { success: false, error: `Need ${maxPlayers} players to start (have ${this.players.length})` };
    }
    if (!this.players.every(p => p.lockedIn)) {
      return { success: false, error: 'All players must lock in their character' };
    }
    return { success: true };
  }

  isEmpty(): boolean {
    return this.players.length === 0;
  }

  getPlayers(): readonly LobbyPlayer[] {
    return this.players;
  }

  getState(): S2C_GameLobbyState {
    const mapInfo = MAPS[this.mapId];
    return {
      type: 'game_lobby_state',
      gameId: this.gameId,
      format: this.format,
      mapId: this.mapId,
      mapName: mapInfo?.name ?? this.mapId,
      hostUserId: this.hostUserId,
      players: this.players.map(p => ({
        userId: p.userId,
        username: p.username,
        team: p.team,
        characterId: p.characterId,
        lockedIn: p.lockedIn,
      })),
    };
  }

  getInfo(): LobbyGameInfo {
    const mapInfo = MAPS[this.mapId];
    return {
      gameId: this.gameId,
      format: this.format,
      mapId: this.mapId,
      mapName: mapInfo?.name ?? this.mapId,
      hostUsername: this.players[0]?.username ?? 'Unknown',
      playerCount: this.players.length,
      maxPlayers: getMaxPlayers(this.format),
    };
  }
}
