import type { ServerMessage, S2C_GameStart, S2C_RejoinGame } from '@gtr/shared';
import { xpToLevel } from '@gtr/shared';
import type { ClientEngine } from './network/ClientEngine';
import type { AuthScreen } from './screens/AuthScreen';
import type { LobbyScreen } from './screens/LobbyScreen';
import type { GameLobbyScreen } from './screens/GameLobbyScreen';
import type { AdminScreen } from './screens/AdminScreen';
import type { GameOverOverlay } from './ui/GameOverOverlay';
import * as mpUI from './ui/MultiplayerUI';

export interface MessageRouterDeps {
  getCurrentState: () => string;
  getClientEngine: () => ClientEngine | null;
  getAuthScreen: () => AuthScreen | null;
  getLobbyScreen: () => LobbyScreen | null;
  getGameLobbyScreen: () => GameLobbyScreen | null;
  getAdminScreen: () => AdminScreen | null;
  gameOverOverlay: GameOverOverlay;
  getLocalXp: () => number;
  isAwaitingReconnect: () => boolean;

  setLocalUserId: (id: string) => void;
  setIsAdmin: (admin: boolean) => void;
  setLocalXp: (xp: number) => void;
  setPendingLevelUpFrom: (xp: number | null) => void;
  setAwaitingReconnect: (val: boolean) => void;
  setUpdateCheckPromise: (val: Promise<void> | null) => void;
  destroyAuthScreen: () => void;
  disconnectNetwork: () => void;

  showLobby: () => void;
  showAuth: () => void;
  showGameLobby: () => void;
  startMultiplayer: (msg: S2C_GameStart | S2C_RejoinGame) => void;
}

export function handleServerMessage(msg: ServerMessage, deps: MessageRouterDeps): void {
  switch (msg.type) {
    case 'auth_result':
      if (msg.success) {
        deps.setLocalUserId(msg.userId);
        deps.setIsAdmin(msg.isAdmin ?? false);
        deps.setLocalXp(msg.xp ?? 0);
        // Update stored username to the original registered casing from the server
        if (msg.username) {
          sessionStorage.setItem('gtr_username', msg.username);
          localStorage.setItem('gtr_last_username', msg.username);
        }
        deps.destroyAuthScreen();
        if (deps.getCurrentState() === 'multiplayer') {
          // Reconnecting mid-game — don't flash lobby, wait for server
          // to send rejoin_game (back to game) or lobby_state (to lobby)
          deps.setAwaitingReconnect(true);
        } else {
          deps.showLobby();
        }
      } else {
        // Auth failed — always transition to auth screen (handles reconnect case
        // where authScreen is null, e.g. when re-auth fails during gameplay)
        let errorMsg = msg.error ?? 'Authentication failed';
        if (msg.bannedUntil && msg.bannedUntil !== 'permanent') {
          const banEnd = new Date(msg.bannedUntil + 'Z');
          errorMsg = `You are banned until ${banEnd.toLocaleString()}`;
        }
        if (msg.banReason) {
          errorMsg += `\nReason: ${msg.banReason}`;
        }
        deps.disconnectNetwork();
        sessionStorage.removeItem('gtr_password');
        if (deps.getAuthScreen()) {
          // Already on the auth screen — just show the error without rebuilding
          deps.getAuthScreen()!.showError(errorMsg);
        } else {
          // Re-auth failed (auto-login or reconnect) — rebuild the auth screen
          deps.showAuth();
          setTimeout(() => deps.getAuthScreen()?.showError(errorMsg), 0);
        }
      }
      break;

    case 'lobby_state':
      if (deps.isAwaitingReconnect()) {
        // Server didn't send rejoin_game — no game to rejoin.
        // Always transition to lobby (update snackbar will show there if needed).
        deps.setAwaitingReconnect(false);
        deps.setUpdateCheckPromise(null);
        deps.showLobby();
      }
      deps.getLobbyScreen()?.updateUsers(msg.users);
      deps.getLobbyScreen()?.updateGames(msg.games);
      break;

    case 'lobby_chat':
      deps.getLobbyScreen()?.addChatMessage(msg.username, msg.message, msg.isAnnouncement);
      break;

    case 'game_chat':
      mpUI.chatWindow?.addMessage(msg.username, msg.message);
      break;

    case 'user_profile':
      if (msg.broadcast) {
        deps.getLobbyScreen()?.updateOpenProfileDialog(msg.profile);
      } else {
        deps.getLobbyScreen()?.showProfileDialog(msg.profile);
      }
      break;

    case 'leaderboard':
      deps.getLobbyScreen()?.showLeaderboard(msg.entries);
      break;

    case 'xp_update': {
      const oldXp = deps.getLocalXp();
      deps.setLocalXp(msg.xp);
      const lobbyScreen = deps.getLobbyScreen();
      if (msg.adminSet) {
        // Admin-set XP: just update display, no animation or congrats
        if (lobbyScreen) lobbyScreen.updateXp(msg.xp);
      } else if (lobbyScreen) {
        lobbyScreen.updateXp(msg.xp, oldXp);
      } else if (xpToLevel(msg.xp) > xpToLevel(oldXp)) {
        // Lobby not visible yet (e.g. game over screen) — remember for when it opens
        deps.setPendingLevelUpFrom(oldXp);
      }
      break;
    }

    case 'game_lobby_state':
      if (deps.getCurrentState() !== 'game-lobby') deps.showGameLobby();
      deps.getGameLobbyScreen()?.update({
        format: msg.format,
        mapId: msg.mapId,
        mapName: msg.mapName,
        hostUserId: msg.hostUserId,
        players: msg.players,
      });
      break;

    case 'game_start':
      deps.startMultiplayer(msg);
      break;

    case 'game_state':
      deps.getClientEngine()?.handleGameState(msg);
      break;

    case 'game_state_update':
      deps.getClientEngine()?.handleGameStateUpdate(msg);
      break;

    case 'game_state_snapshot':
      deps.getClientEngine()?.handleGameStateSnapshot(msg);
      break;

    case 'combat_event':
      deps.getClientEngine()?.handleCombatEvent(msg);
      break;

    case 'flinch':
      deps.getClientEngine()?.handleFlinch(msg);
      break;

    case 'ability_effect':
      deps.getClientEngine()?.handleAbilityEffect(msg);
      break;

    case 'auto_attack_swing':
      deps.getClientEngine()?.handleAutoAttackSwing(msg);
      break;

    case 'cooldown_update':
      deps.getClientEngine()?.handleCooldownUpdate(msg);
      break;

    case 'gas_cloud_spawn':
      deps.getClientEngine()?.handleGasCloudSpawn(msg);
      break;

    case 'chem_pool_spawn':
      deps.getClientEngine()?.handleChemPoolSpawn(msg);
      break;

    case 'knockback':
      deps.getClientEngine()?.handleKnockback(msg);
      break;

    case 'entity_died':
      deps.getClientEngine()?.handleEntityDied(msg);
      break;

    case 'force_clear_target':
      deps.getClientEngine()?.handleForceClearTarget();
      break;

    case 'position_correction':
      deps.getClientEngine()?.handlePositionCorrection(msg);
      break;

    case 'position_relay':
      deps.getClientEngine()?.handlePositionRelay(msg);
      break;

    case 'position_update':
      deps.getClientEngine()?.handlePositionUpdate(msg);
      break;

    case 'countdown_start':
      // Server confirmed all clients are ready — reset the arena timer so
      // everyone's countdown is synchronized regardless of load time.
      deps.getClientEngine()?.mapManager.resetTimer();
      break;

    case 'gate_vote_update': {
      const ce = deps.getClientEngine();
      if (ce) {
        ce.mapManager.updateGateVotes(msg.voteCount, msg.totalPlayers);
        if (msg.voteCount >= msg.totalPlayers) {
          ce.mapManager.forceOpenDoors();
        }
      }
      break;
    }

    case 'game_over': {
      const ce = deps.getClientEngine();
      if (ce) {
        deps.gameOverOverlay.show(msg.winningTeam, ce.playerController.team, msg.allPlayersPresent, msg.playerResults);
      }
      ce?.mapManager.onGameOver(msg.winningTeam);
      break;
    }

    case 'rematch_challenge':
      deps.gameOverOverlay.showRematchChallenge(msg.challengerUsername, msg.mapMode, msg.totalPlayers, msg.readyCount);
      break;

    case 'rematch_ready_update':
      deps.gameOverOverlay.updateRematchReady(msg.readyCount, msg.totalPlayers);
      break;

    case 'rematch_failed':
      deps.gameOverOverlay.handleRematchFailed(msg.reason);
      break;

    case 'game_cancelled':
      deps.showLobby();
      break;

    case 'admin_users_list':
      deps.getAdminScreen()?.updateUsers(msg.users);
      break;

    case 'admin_result':
      if (msg.action === 'reset_password' && msg.success && msg.generatedPassword) {
        deps.getAdminScreen()?.showResetPasswordResult(msg.generatedPassword);
      } else if (!msg.success) {
        console.warn('Admin action failed:', msg.error);
      }
      break;

    case 'change_password_result':
      deps.getLobbyScreen()?.showChangePasswordResult(msg.success, msg.error);
      break;

    case 'god_mode_update':
      deps.getClientEngine()?.handleGodModeUpdate(msg.entityId, msg.active);
      break;

    case 'kicked':
      deps.disconnectNetwork();
      deps.setLocalUserId('');
      deps.setIsAdmin(false);
      deps.setLocalXp(0);
      {
        const lastUser = sessionStorage.getItem('gtr_username');
        if (lastUser) localStorage.setItem('gtr_last_username', lastUser);
      }
      sessionStorage.removeItem('gtr_username');
      sessionStorage.removeItem('gtr_password');
      deps.showAuth();
      // Show the reason on the auth screen after it renders
      setTimeout(() => deps.getAuthScreen()?.showError(msg.reason), 0);
      break;

    case 'error':
      if (deps.getCurrentState() === 'multiplayer') {
        deps.getClientEngine()?.revertPrediction();
        mpUI.errorText?.show(msg.message);
      } else {
        console.warn('Server error:', msg.message);
      }
      break;

    case 'rejoin_game':
      deps.setAwaitingReconnect(false);
      deps.setUpdateCheckPromise(null);
      deps.startMultiplayer(msg);
      break;

    case 'player_disconnected':
      deps.getClientEngine()?.handlePlayerDisconnected(msg.entityId);
      mpUI.errorText?.show(`${msg.username} disconnected`, 3000);
      break;

    case 'player_reconnected':
      deps.getClientEngine()?.handlePlayerReconnected(msg.entityId);
      mpUI.errorText?.show(`${msg.username} reconnected`, 3000);
      break;

    case 'entity_removed':
      deps.getClientEngine()?.handleEntityRemoved(msg.entityId);
      mpUI.arenaFrames?.removeEntity(msg.entityId);
      mpUI.partyFrames?.removeEntity(msg.entityId);
      if (msg.username) {
        mpUI.errorText?.show(`${msg.username} has left the game`, 3000);
      }
      break;
  }
}
