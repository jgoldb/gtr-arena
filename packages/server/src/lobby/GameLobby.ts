import type { CharacterId } from '@gtr/shared';
import type { GameFormat, LobbyGameInfo, GameLobbyPlayer } from '@gtr/shared';
import type { S2C_GameLobbyState } from '@gtr/shared';
import { getMaxPlayers, MAPS, CHARACTERS } from '@gtr/shared';

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
  hostUserId: string;
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

    // Assign to the team with fewer players (prefer team 0 if tied)
    const team0Count = this.players.filter(p => p.team === 0).length;
    const team1Count = this.players.filter(p => p.team === 1).length;
    const team = team0Count <= team1Count ? 0 : 1;

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

  /** Transfer host to the next player in the list (longest-tenured). Returns the new host userId, or null if empty. */
  transferHost(): string | null {
    if (this.players.length === 0) return null;
    this.hostUserId = this.players[0].userId;
    return this.hostUserId;
  }

  selectCharacter(userId: string, characterId: CharacterId): void {
    const player = this.players.find(p => p.userId === userId);
    if (player && !player.lockedIn) {
      const stats = CHARACTERS[characterId];
      if (stats?.playgroundOnly) return;
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

  swapPlayerTeam(draggedUserId: string, newTeam: number, droppedOnUserId?: string): { success: boolean; error?: string } {
    if (newTeam !== 0 && newTeam !== 1) return { success: false, error: 'Invalid team' };

    const dragged = this.players.find(p => p.userId === draggedUserId);
    if (!dragged) return { success: false, error: 'Player not found' };
    if (dragged.team === newTeam) return { success: true };

    const maxPerTeam = getMaxPlayers(this.format) / 2;
    const targetTeamCount = this.players.filter(p => p.team === newTeam).length;

    if (droppedOnUserId) {
      // Swap two players between teams
      const target = this.players.find(p => p.userId === droppedOnUserId);
      if (!target) return { success: false, error: 'Target player not found' };
      if (target.team === dragged.team) return { success: false, error: 'Players are on the same team' };
      const tmpTeam = dragged.team;
      dragged.team = target.team;
      target.team = tmpTeam;
      return { success: true };
    }

    // No swap target — move only if team has room
    if (targetTeamCount >= maxPerTeam) {
      return { success: false, error: 'Team is full — drop on a player to swap' };
    }
    dragged.team = newTeam;
    return { success: true };
  }

  canStart(): { success: boolean; error?: string } {
    const maxPlayers = getMaxPlayers(this.format);
    if (this.players.length !== maxPlayers) {
      return { success: false, error: `Need ${maxPlayers} players to start (have ${this.players.length})` };
    }
    const perTeam = maxPlayers / 2;
    const team0Count = this.players.filter(p => p.team === 0).length;
    const team1Count = this.players.filter(p => p.team === 1).length;
    if (team0Count !== perTeam || team1Count !== perTeam) {
      return { success: false, error: `Teams must be balanced (${perTeam} per team)` };
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
      hostUsername: this.players.find(p => p.userId === this.hostUserId)?.username ?? 'Unknown',
      playerCount: this.players.length,
      maxPlayers: getMaxPlayers(this.format),
    };
  }
}
