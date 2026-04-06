import type { S2C_GameStart, S2C_RejoinGame } from '@gtr/shared';
import { Vector3 as THREEVector3 } from 'three';
import { AuthScreen } from './screens/AuthScreen';
import { LobbyScreen } from './screens/LobbyScreen';
import { GameLobbyScreen } from './screens/GameLobbyScreen';
import { AdminScreen } from './screens/AdminScreen';
import { SinglePlayerScreen, type SinglePlayerConfig } from './screens/SinglePlayerScreen';
import { SpectatorScreen, type SpectatorConfig } from './screens/SpectatorScreen';
import { NetworkManager } from './network/NetworkManager';
import { ClientEngine } from './network/ClientEngine';
import { EscapeMenu, type EscapeMenuButton } from './ui/EscapeMenu';
import { AudioSettingsDialog } from './ui/AudioSettingsDialog';
import { audioSettings } from './ui/AudioSettings';
import { soundEffects } from './ui/SoundEffects';
import { KeybindMenu } from './ui/KeybindMenu';
import { ReconnectOverlay } from './ui/ReconnectOverlay';
import { renderPortraits } from './ui/PortraitRenderer';
import { MusicController } from './ui/MusicController';
import { GameOverOverlay } from './ui/GameOverOverlay';
import { showSinglePlayerGameOver } from './ui/SinglePlayerGameOver';
import * as mpUI from './ui/MultiplayerUI';
import { handleServerMessage, type MessageRouterDeps } from './MessageRouter';
import { getCharacterStats, CHARACTERS } from '@gtr/shared';
import type { Targetable } from './engine/types';

declare const __BUILD_VERSION__: string | undefined;

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
if (!canvas) throw new Error('Canvas element not found');

// Prevent browser context menu during gameplay
document.addEventListener('contextmenu', (e) => {
  if (currentState === 'playground' || currentState === 'multiplayer' || currentState === 'ui-setup' || currentState === 'single-player') {
    e.preventDefault();
  }
});

// Pre-render character face portraits
const portraits = renderPortraits();
const getPortrait = (modelName: string) => portraits.get(modelName);

// ── State ──────────────────────────────────────────────────────────────

type AppState = 'auth' | 'lobby' | 'game-lobby' | 'multiplayer' | 'playground' | 'ui-setup' | 'single-player';
let currentState: AppState = 'auth';
let network: NetworkManager | null = null;
let localUserId = '';
let isAdmin = false;
let localXp = 0;
let pendingLevelUpFrom: number | null = null; // old XP before a level-up that happened while lobby was not visible
let awaitingReconnectResult = false;
let updatePending = false;
let updateCheckPromise: Promise<void> | null = null;
let updateSnackbarEl: HTMLElement | null = null;
let authUpdateInterval: ReturnType<typeof setInterval> | null = null;

// Active screens / engines
let authScreen: AuthScreen | null = null;
let lobbyScreen: LobbyScreen | null = null;
let gameLobbyScreen: GameLobbyScreen | null = null;
let adminScreen: AdminScreen | null = null;
let singlePlayerScreen: SinglePlayerScreen | null = null;
let spectatorScreen: SpectatorScreen | null = null;
let clientEngine: ClientEngine | null = null;
const reconnectOverlay = new ReconnectOverlay();

// ── Music Controllers ─────────────────────────────────────────────────
const lobbyMusic = new MusicController('/audio/music/lobby.ogg');
const practiceMusic = new MusicController('/audio/music/practice.ogg');

// ── Game Over Overlay ─────────────────────────────────────────────────
const gameOverOverlay = new GameOverOverlay({
  sendMessage: (msg) => network?.send(msg as any),
  onExitToLobby: () => showLobby(),
});

// React to audio settings changes
audioSettings.onChange((s) => {
  if (!s.enableMusic) {
    lobbyMusic.fadeOut();
    practiceMusic.fadeOut();
  } else if (lobbyMusic.isPlaying) {
    lobbyMusic.applyVolume();
  } else if (currentState === 'lobby') {
    lobbyMusic.start();
  }
  if (s.enableMusic && practiceMusic.isPlaying) {
    practiceMusic.applyVolume();
  }
});


// Playground state
let pgSession: import('./engine/PlaygroundSession').PlaygroundSession | null = null;
let pgDebugPanel: import('./ui/DebugPanel').DebugPanel | null = null;

// Auth & Lobby escape menus
let authEscapeMenu: EscapeMenu | null = null;
let lobbyEscapeMenu: EscapeMenu | null = null;

// Shared keybind menu (persists across game modes)
const keybindMenu = new KeybindMenu();
document.body.appendChild(keybindMenu.element);

// ── Helpers ────────────────────────────────────────────────────────────

function hideGameUI(): void {
  const uiOverlay = document.getElementById('ui-overlay');
  const unitFrames = document.getElementById('unit-frames');
  const crosshair = document.getElementById('crosshair');
  if (uiOverlay) uiOverlay.style.display = 'none';
  if (unitFrames) unitFrames.style.display = 'none';
  if (crosshair) crosshair.style.display = 'none';
  canvas.style.display = 'none';
}

function showGameUI(): void {
  const crosshair = document.getElementById('crosshair');
  if (crosshair) crosshair.style.display = 'none';
  canvas.style.display = 'block';
}

// ── God mode overlay ───────────────────────────────────────────────────
let godModeOverlay: HTMLDivElement | null = null;

function toggleGodModeOverlay(active: boolean): void {
  if (active && !godModeOverlay) {
    godModeOverlay = document.createElement('div');
    godModeOverlay.textContent = 'GOD MODE ACTIVATED';
    godModeOverlay.style.cssText = `
      position: fixed;
      top: 8%;
      left: 50%;
      transform: translateX(-50%);
      z-index: 300;
      pointer-events: none;
      color: #ffcc00;
      font-size: 24px;
      font-weight: bold;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      text-shadow: 0 0 10px rgba(255, 204, 0, 0.8), 2px 2px 4px rgba(0, 0, 0, 0.9);
      letter-spacing: 3px;
    `;
    document.body.appendChild(godModeOverlay);
  } else if (!active && godModeOverlay) {
    godModeOverlay.remove();
    godModeOverlay = null;
  }
}

function cleanupCurrentState(): void {
  if (authUpdateInterval) { clearInterval(authUpdateInterval); authUpdateInterval = null; }
  authScreen?.destroy();
  authScreen = null;
  authEscapeMenu?.dispose();
  authEscapeMenu = null;
  lobbyScreen?.destroy();
  lobbyScreen = null;
  lobbyEscapeMenu?.dispose();
  lobbyEscapeMenu = null;
  gameLobbyScreen?.destroy();
  gameLobbyScreen = null;
  adminScreen?.destroy();
  adminScreen = null;
  singlePlayerScreen?.destroy();
  singlePlayerScreen = null;
  spectatorScreen?.dispose();
  spectatorScreen = null;
  practiceMusic.fadeOut();
  soundEffects.fadeOutAll();
  cleanupMultiplayerUI();
  cleanupPlaygroundUI();
  toggleGodModeOverlay(false);
}

function cleanupMultiplayerUI(): void {
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('resize', onMpResize);
  clientEngine?.destroy();
  clientEngine = null;
  gameOverOverlay.cleanup();
  mpUI.cleanup();
}

function cleanupPlaygroundUI(): void {
  pgSession?.dispose();
  pgSession = null;
  pgDebugPanel?.dispose();
  pgDebugPanel = null;
  // Clear sidebar panel containers (CharacterSelector, MapSelector, NpcSpawner, debug buttons)
  const containers = ['map-selector-container', 'debug-panel-container', 'character-selector-container', 'npc-spawner-container'];
  for (const id of containers) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  }
}

// ── Update Detection (production only) ────────────────────────────────

function showUpdateSnackbar(message: string, autoDismissMs?: number): void {
  if (updateSnackbarEl) updateSnackbarEl.remove();
  updateSnackbarEl = document.createElement('div');
  updateSnackbarEl.style.cssText = `
    position: fixed; top: 24px; right: 24px; transform: translateY(-100%);
    background: rgba(20, 20, 20, 0.95); color: #4fc3f7; padding: 12px 24px;
    border-radius: 8px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    font-size: 14px; z-index: 10000; border: 1px solid rgba(79, 195, 247, 0.3);
    box-shadow: 0 4px 12px rgba(0,0,0,0.5); transition: transform 0.3s ease, opacity 0.3s ease;
    pointer-events: none;
  `;
  updateSnackbarEl.textContent = message;
  document.body.appendChild(updateSnackbarEl);
  requestAnimationFrame(() => {
    if (updateSnackbarEl) updateSnackbarEl.style.transform = 'translateY(0)';
  });
  if (autoDismissMs) {
    setTimeout(() => {
      if (updateSnackbarEl) {
        updateSnackbarEl.style.opacity = '0';
        setTimeout(() => { updateSnackbarEl?.remove(); updateSnackbarEl = null; }, 300);
      }
    }, autoDismissMs);
  }
}

async function checkForUpdate(): Promise<void> {
  if (typeof __BUILD_VERSION__ === 'undefined') return;
  try {
    const resp = await fetch(`/version.json?_=${Date.now()}`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.version && data.version !== __BUILD_VERSION__) {
      if (currentState === 'multiplayer') {
        updatePending = true;
      } else {
        sessionStorage.setItem('gtr_updated', '1');
        location.reload();
      }
    }
  } catch { /* network error — ignore */ }
}

// ── Connection & Auth ──────────────────────────────────────────────────

function connectWithCredentials(username: string, password: string, mode: 'login' | 'register'): void {
  network = new NetworkManager(username, password, mode);
  network.onMessage((msg) => handleServerMessage(msg, routerDeps));
  network.onConnectionStateChange((state) => {
    reconnectOverlay.update(state);
    if (state.status === 'reconnected') {
      updateCheckPromise = checkForUpdate();
    }
    if (state.status === 'failed') {
      if (currentState === 'multiplayer') {
        // Stay in the game world — show failure on the overlay instead of
        // tearing everything down. The player can see the arena behind it.
        reconnectOverlay.showMessage('Connection lost');
        // After a brief pause, transition to auth
        setTimeout(() => {
          reconnectOverlay.hide();
          network?.disconnect();
          network = null;
          showAuth();
          setTimeout(() => authScreen?.showError('Unable to connect to server. Please try again.'), 0);
        }, 3000);
      } else {
        reconnectOverlay.hide();
        network?.disconnect();
        network = null;
        showAuth();
        setTimeout(() => authScreen?.showError('Unable to connect to server. Please try again.'), 0);
      }
    }
  });
  network.connect();
}

function showAuth(): void {
  cleanupCurrentState();
  currentState = 'auth';
  hideGameUI();
  if (updatePending) {
    sessionStorage.setItem('gtr_updated', '1');
    location.reload();
    return;
  }
  checkForUpdate();
  authUpdateInterval = setInterval(() => checkForUpdate(), 30_000);

  authScreen = new AuthScreen((result) => {
    sessionStorage.setItem('gtr_username', result.username);
    sessionStorage.setItem('gtr_password', result.password);
    connectWithCredentials(result.username, result.password, result.mode);
  });
  authScreen.onMenu = () => authEscapeMenu?.open();
  document.body.appendChild(authScreen.element);
  authScreen.focus();

  // Auth escape menu
  authEscapeMenu = new EscapeMenu({
    onReturnToLobby: () => {},
    customButtons: [],
    onKeybinds: () => {
      authEscapeMenu?.close();
      keybindMenu.open(() => authEscapeMenu?.open());
    },
    onAudio: () => {
      authEscapeMenu?.close();
      new AudioSettingsDialog(() => authEscapeMenu?.open()).open();
    },
  });
  authEscapeMenu.element.style.zIndex = '1050';
  document.body.appendChild(authEscapeMenu.element);
}

// ── Lobby Screen ───────────────────────────────────────────────────────

function showLobby(): void {
  cleanupCurrentState();
  currentState = 'lobby';
  hideGameUI();
  if (updatePending) {
    sessionStorage.setItem('gtr_updated', '1');
    location.reload();
    return;
  }
  lobbyMusic.start();

  lobbyScreen = new LobbyScreen(network!, localUserId, isAdmin, localXp);
  lobbyScreen.onPlayground = () => startPlayground();
  lobbyScreen.onUISetup = () => startUISetup();
  lobbyScreen.onLogout = () => {
    lobbyMusic.fadeOut();
    network?.disconnect();
    network = null;
    localUserId = '';
    isAdmin = false;
    localXp = 0;
    const lastUser = sessionStorage.getItem('gtr_username');
    if (lastUser) localStorage.setItem('gtr_last_username', lastUser);
    sessionStorage.removeItem('gtr_username');
    sessionStorage.removeItem('gtr_password');
    showAuth();
  };
  lobbyScreen.onAdmin = () => showAdmin();
  lobbyScreen.onMenu = () => lobbyEscapeMenu?.open();
  document.body.appendChild(lobbyScreen.element);

  // Trigger pending level-up animation if one occurred while lobby was hidden
  if (pendingLevelUpFrom !== null) {
    lobbyScreen.updateXp(localXp, pendingLevelUpFrom);
    pendingLevelUpFrom = null;
  }

  // Lobby escape menu
  const lobbyMenuButtons: EscapeMenuButton[] = [];

  // Single Player — unique color (gold)
  lobbyMenuButtons.push({
    label: 'Single Player',
    onClick: () => showSinglePlayerScreen(),
    color: 'rgba(160, 100, 30, 0.8)',
    hoverColor: 'rgba(190, 120, 40, 0.9)',
  });

  // Settings group (default color matches Keybinds/Audio built-ins)
  lobbyMenuButtons.push({
    label: 'UI Setup',
    onClick: () => lobbyScreen?.onUISetup?.(),
  });
  lobbyMenuButtons.push({
    label: 'Keybinds',
    onClick: () => keybindMenu.open(() => lobbyEscapeMenu?.open()),
  });
  lobbyMenuButtons.push({
    label: 'Audio',
    onClick: () => new AudioSettingsDialog(() => lobbyEscapeMenu?.open()).open(),
  });
  lobbyMenuButtons.push({
    label: 'Change Password',
    onClick: () => lobbyScreen?.showChangePasswordDialog(),
  });

  // Logout — red
  lobbyMenuButtons.push({
    label: 'Logout',
    onClick: () => lobbyScreen?.onLogout?.(),
    color: 'rgba(160, 50, 50, 0.8)',
    hoverColor: 'rgba(180, 60, 60, 0.9)',
  });

  // Admin section — spaced, same color
  if (isAdmin) {
    lobbyMenuButtons.push({
      label: 'Playground',
      onClick: () => lobbyScreen?.onPlayground?.(),
      color: 'rgba(90, 61, 138, 0.8)',
      hoverColor: 'rgba(112, 80, 168, 0.9)',
      spaceBefore: true,
    });
    lobbyMenuButtons.push({
      label: 'Spectator',
      onClick: () => showSpectatorScreen(),
      color: 'rgba(90, 61, 138, 0.8)',
      hoverColor: 'rgba(112, 80, 168, 0.9)',
    });
    lobbyMenuButtons.push({
      label: 'Manage Users',
      onClick: () => lobbyScreen?.onAdmin?.(),
      color: 'rgba(90, 61, 138, 0.8)',
      hoverColor: 'rgba(112, 80, 168, 0.9)',
    });
  }

  lobbyEscapeMenu = new EscapeMenu({
    onReturnToLobby: () => {},  // Not used in lobby mode
    customButtons: lobbyMenuButtons,
  });
  lobbyEscapeMenu.element.style.zIndex = '1050';
  document.body.appendChild(lobbyEscapeMenu.element);

  // Request fresh lobby data (needed when returning from admin/game screens)
  network?.send({ type: 'request_lobby_state' });
}

function showAdmin(): void {
  lobbyScreen?.element.remove();
  lobbyEscapeMenu?.dispose();
  lobbyEscapeMenu = null;
  adminScreen?.destroy();

  const localDbId = parseInt(localUserId.replace('user_', ''), 10);
  adminScreen = new AdminScreen(network!, localDbId);
  adminScreen.onBack = () => {
    adminScreen?.destroy();
    adminScreen = null;
    showLobby();
  };
  document.body.appendChild(adminScreen.element);

  // Lobby escape menu for admin screen
  const adminMenuButtons: EscapeMenuButton[] = [
    {
      label: 'Back to Lobby',
      onClick: () => adminScreen?.onBack?.(),
      color: 'rgba(60, 60, 100, 0.8)',
      hoverColor: 'rgba(70, 70, 120, 0.9)',
    },
    {
      label: 'Logout',
      onClick: () => {
        adminScreen?.destroy();
        adminScreen = null;
        lobbyScreen?.onLogout?.();
      },
      color: 'rgba(160, 50, 50, 0.8)',
      hoverColor: 'rgba(180, 60, 60, 0.9)',
    },
  ];
  lobbyEscapeMenu = new EscapeMenu({
    onReturnToLobby: () => {},
    customButtons: adminMenuButtons,
    onKeybinds: () => {
      lobbyEscapeMenu?.close();
      keybindMenu.open(() => lobbyEscapeMenu?.open());
    },
    onAudio: () => {
      lobbyEscapeMenu?.close();
      new AudioSettingsDialog(() => lobbyEscapeMenu?.open()).open();
    },
  });
  lobbyEscapeMenu.element.style.zIndex = '1050';
  document.body.appendChild(lobbyEscapeMenu.element);

  // Request user list from server
  network!.send({ type: 'admin_get_users' });
}

// ── Game Lobby Screen ──────────────────────────────────────────────────

function showGameLobby(): void {
  // Don't clean up lobby screen fully — just remove it from view
  lobbyScreen?.element.remove();
  lobbyEscapeMenu?.dispose();
  lobbyEscapeMenu = null;
  gameLobbyScreen?.destroy();
  currentState = 'game-lobby';

  gameLobbyScreen = new GameLobbyScreen(network!, localUserId, getPortrait);
  document.body.appendChild(gameLobbyScreen.element);

  // Lobby escape menu for game lobby screen
  const gameLobbyMenuButtons: EscapeMenuButton[] = [
    {
      label: 'Leave Game',
      onClick: () => network?.send({ type: 'leave_game' }),
      color: 'rgba(160, 50, 50, 0.8)',
      hoverColor: 'rgba(180, 60, 60, 0.9)',
    },
  ];
  lobbyEscapeMenu = new EscapeMenu({
    onReturnToLobby: () => {},
    customButtons: gameLobbyMenuButtons,
    onKeybinds: () => {
      lobbyEscapeMenu?.close();
      keybindMenu.open(() => lobbyEscapeMenu?.open());
    },
    onAudio: () => {
      lobbyEscapeMenu?.close();
      new AudioSettingsDialog(() => lobbyEscapeMenu?.open()).open();
    },
  });
  lobbyEscapeMenu.element.style.zIndex = '1050';
  document.body.appendChild(lobbyEscapeMenu.element);
}

// ── Multiplayer Game ───────────────────────────────────────────────────

function onBeforeUnload(e: BeforeUnloadEvent): void {
  e.preventDefault();
}


function startMultiplayer(msg: S2C_GameStart | S2C_RejoinGame): void {
  lobbyMusic.fadeOut();
  cleanupCurrentState();
  currentState = 'multiplayer';
  showGameUI();

  // Warn before closing the window while in-game
  window.addEventListener('beforeunload', onBeforeUnload);

  clientEngine = new ClientEngine(canvas, network!, msg.mapId, msg.localEntityId, msg.entities);
  clientEngine.isAdmin = isAdmin;

  // Tell the server we're loaded and ready
  network!.send({ type: 'client_ready' });

  mpUI.wireCallbacks(clientEngine!, (m) => network?.send(m), toggleGodModeOverlay);

  // Create UI elements for MP game
  mpUI.setup({
    clientEngine: clientEngine!,
    entities: msg.entities,
    localEntityId: msg.localEntityId,
    getPortrait,
    sendNetworkMessage: (m) => network?.send(m),
    keybindMenu,
    gameOverOverlay,
    showLobby,
  });

  // Rejoin-specific: sync full state from server
  if (msg.type === 'rejoin_game') {
    clientEngine.handleGameStateSnapshot({
      type: 'game_state_snapshot',
      tick: 0,
      timestamp: Date.now(),
      entities: msg.entities,
      buffs: msg.buffs,
      gasClouds: msg.gasClouds,
      chemicalPools: msg.chemicalPools,
    });

    // Sync cooldown state from server
    for (const cd of msg.cooldowns) {
      if (cd.entityId === msg.localEntityId) {
        clientEngine.handleCooldownUpdate({ type: 'cooldown_update', abilityId: cd.abilityId, remaining: cd.remaining, total: cd.total });
      }
      if (cd.abilityId === 'pvp-trinket') {
        mpUI.arenaFrames?.notifyTrinketUsed(cd.entityId, cd.remaining, cd.total);
      }
    }

    for (const entityId of msg.disconnectedEntityIds) {
      clientEngine.handlePlayerDisconnected(entityId);
    }

    // Sync elapsed time from server — gameElapsed is authoritative and covers both
    // the arena countdown period and post-open time (needed for elevator sync, etc.)
    if (msg.gameElapsed !== undefined) {
      clientEngine.mapManager.setElapsed(msg.gameElapsed);
      const script = clientEngine.mapManager.getScript();
      const openTime = (script && 'OPEN_TIME' in script) ? (script as any).OPEN_TIME as number : 30;
      if (msg.gameElapsed >= openTime && script && 'opened' in script && !(script as any).opened) {
        clientEngine.mapManager.forceOpenDoors();
      }
    } else if (msg.arenaTimeRemaining !== undefined && msg.arenaTimeRemaining > 0) {
      const script = clientEngine.mapManager.getScript();
      const openTime = (script && 'OPEN_TIME' in script) ? (script as any).OPEN_TIME as number : 30;
      clientEngine.mapManager.setElapsed(openTime - msg.arenaTimeRemaining);
    } else {
      clientEngine.mapManager.forceOpenDoors();
    }
  }

  // Start rendering
  clientEngine.start();

  window.addEventListener('resize', onMpResize);

  // If rejoining a finished game, show game over immediately
  if (msg.type === 'rejoin_game' && msg.gameOver) {
    gameOverOverlay.show(msg.gameOver.winningTeam, clientEngine!.playerController.team, false, msg.gameOver.playerResults);
  }
}

function onMpResize(): void {
  clientEngine?.resize(window.innerWidth, window.innerHeight);
}

// ── Message Router Deps ───────────────────────────────────────────────

const routerDeps: MessageRouterDeps = {
  getCurrentState: () => currentState,
  getClientEngine: () => clientEngine,
  getAuthScreen: () => authScreen,
  getLobbyScreen: () => lobbyScreen,
  getGameLobbyScreen: () => gameLobbyScreen,
  getAdminScreen: () => adminScreen,
  gameOverOverlay,
  getLocalXp: () => localXp,
  isAwaitingReconnect: () => awaitingReconnectResult,
  setLocalUserId: (id) => { localUserId = id; },
  setIsAdmin: (admin) => { isAdmin = admin; },
  setLocalXp: (xp) => { localXp = xp; },
  setPendingLevelUpFrom: (val) => { pendingLevelUpFrom = val; },
  setAwaitingReconnect: (val) => { awaitingReconnectResult = val; },
  setUpdateCheckPromise: (val) => { updateCheckPromise = val; },
  destroyAuthScreen: () => { authScreen?.destroy(); authScreen = null; },
  disconnectNetwork: () => { network?.disconnect(); network = null; },
  showLobby,
  showAuth,
  showGameLobby,
  startMultiplayer,
};

// ── Single Player Mode ─────────────────────────────────────────────────

function showSinglePlayerScreen(): void {
  cleanupCurrentState();
  currentState = 'single-player';
  hideGameUI();
  network?.send({ type: 'enter_single_player' });

  singlePlayerScreen = new SinglePlayerScreen();
  singlePlayerScreen.onFight = (config) => startSinglePlayer(config);
  singlePlayerScreen.onBack = () => {
    showLobby();
    network?.send({ type: 'return_to_lobby' });
  };
  singlePlayerScreen.onMenu = () => lobbyEscapeMenu?.open();
  document.body.appendChild(singlePlayerScreen.element);

  // Escape menu for single player screen
  const spMenuButtons: EscapeMenuButton[] = [
    {
      label: 'Back to Lobby',
      onClick: () => {
        singlePlayerScreen?.onBack?.();
      },
      color: 'rgba(160, 50, 50, 0.8)',
      hoverColor: 'rgba(180, 60, 60, 0.9)',
    },
  ];
  lobbyEscapeMenu = new EscapeMenu({
    onReturnToLobby: () => {},
    customButtons: spMenuButtons,
    onKeybinds: () => {
      lobbyEscapeMenu?.close();
      keybindMenu.open(() => lobbyEscapeMenu?.open());
    },
    onAudio: () => {
      lobbyEscapeMenu?.close();
      new AudioSettingsDialog(() => lobbyEscapeMenu?.open()).open();
    },
  });
  lobbyEscapeMenu.element.style.zIndex = '1050';
  document.body.appendChild(lobbyEscapeMenu.element);
}

async function startSinglePlayer(config: SinglePlayerConfig): Promise<void> {
  lobbyMusic.fadeOut();
  cleanupCurrentState();
  currentState = 'single-player';

  const uiOverlay = document.getElementById('ui-overlay');
  if (uiOverlay) uiOverlay.style.display = '';
  canvas.style.display = 'block';

  const { Engine } = await import('./engine/Engine');
  const { createPlaygroundSession } = await import('./engine/PlaygroundSession');

  const engine = new Engine(canvas);
  engine.isAdmin = isAdmin;
  const savedUsername = sessionStorage.getItem('gtr_username');
  if (savedUsername) engine.playerController.name = savedUsername;

  // Set character and load map
  engine.setCharacter(config.playerCharId);
  engine.loadMap(config.mapId);

  // Spawn AI opponent on the opposing spawn point
  const mapConfig = engine.mapManager.getCurrentConfig();
  const opponentSpawn = mapConfig?.spawnPoints?.[1] ?? { x: 0, y: 0, z: -10 };
  const opponentName = CHARACTERS[config.opponentCharId].displayName;
  const aiNpc = engine.spawnAiNpc(
    config.opponentCharId,
    new THREEVector3(opponentSpawn.x, opponentSpawn.y, opponentSpawn.z),
    1,       // team 1 (opponent)
    opponentName,
    config.difficulty
  );
  aiNpc.mesh.rotation.y = Math.atan2(-opponentSpawn.x, -opponentSpawn.z);

  // Apply starting buffs to NPC
  const npcStats = getCharacterStats(config.opponentCharId);
  if (npcStats.startingBuffs) {
    for (const buff of npcStats.startingBuffs) {
      engine.buffSystem.apply(aiNpc, buff);
    }
  }

  // ── Game-over detection ──
  let spGameOver = false;
  let spGameOverCleanup: (() => void) | null = null;

  function checkGameOver(): void {
    if (spGameOver) return;
    const playerDead = engine.playerController.dead;
    const npcDead = aiNpc.dead;
    if (!playerDead && !npcDead) return;

    spGameOver = true;
    const won = npcDead && !playerDead;

    setTimeout(() => {
      spGameOverCleanup = showSinglePlayerGameOver({
        won,
        opponentName,
        onRematch: () => {
          spGameOverCleanup = null;
          cleanupPlaygroundUI();
          startSinglePlayer(config);
        },
        onExit: () => {
          spGameOverCleanup = null;
          showLobby();
          network?.send({ type: 'return_to_lobby' });
        },
      });
    }, 1500);
  }

  // Shared session handles all UI wiring, action bar, combat callbacks, update loop
  pgSession = createPlaygroundSession({
    engine,
    canvas,
    getPortrait,
    keybindMenu,
    onReturnToLobby: () => {
      spGameOverCleanup?.();
      showLobby();
      network?.send({ type: 'return_to_lobby' });
    },
    onFrameUpdate: checkGameOver,
  });
}

// ── Spectator Mode ────────────────────────────────────────────────────

function showSpectatorScreen(): void {
  cleanupCurrentState();
  currentState = 'single-player'; // reuse state (no new AppState needed)
  hideGameUI();

  spectatorScreen = new SpectatorScreen();
  spectatorScreen.onWatch = (config) => startSpectatorMode(config);
  spectatorScreen.onBack = () => {
    showLobby();
    network?.send({ type: 'return_to_lobby' });
  };
  document.body.appendChild(spectatorScreen.element);

  // Escape menu
  const specMenuButtons: EscapeMenuButton[] = [
    {
      label: 'Back to Lobby',
      onClick: () => spectatorScreen?.onBack?.(),
      color: 'rgba(160, 50, 50, 0.8)',
      hoverColor: 'rgba(180, 60, 60, 0.9)',
    },
  ];
  lobbyEscapeMenu = new EscapeMenu({
    onReturnToLobby: () => {},
    customButtons: specMenuButtons,
    onKeybinds: () => {
      lobbyEscapeMenu?.close();
      keybindMenu.open(() => lobbyEscapeMenu?.open());
    },
    onAudio: () => {
      lobbyEscapeMenu?.close();
      new AudioSettingsDialog(() => lobbyEscapeMenu?.open()).open();
    },
  });
  lobbyEscapeMenu.element.style.zIndex = '1050';
  document.body.appendChild(lobbyEscapeMenu.element);
}

async function startSpectatorMode(config: SpectatorConfig): Promise<void> {
  lobbyMusic.fadeOut();
  cleanupCurrentState();
  currentState = 'single-player';

  const uiOverlay = document.getElementById('ui-overlay');
  if (uiOverlay) uiOverlay.style.display = '';
  canvas.style.display = 'block';

  const { Engine } = await import('./engine/Engine');
  const { createPlaygroundSession } = await import('./engine/PlaygroundSession');

  const engine = new Engine(canvas);
  engine.isAdmin = isAdmin;
  engine.loadMap(config.mapId);

  // Enable spectator mode - hides player, overrides camera
  engine.enableSpectatorMode();

  // Spawn both NPC fighters
  const mapConfig = engine.mapManager.getCurrentConfig();
  const spawn1 = mapConfig?.spawnPoints?.[0] ?? { x: 0, y: 0, z: 5 };
  const spawn2 = mapConfig?.spawnPoints?.[1] ?? { x: 0, y: 0, z: -5 };

  const name1 = CHARACTERS[config.char1].displayName;
  const name2 = CHARACTERS[config.char2].displayName;

  const npc1 = engine.spawnAiNpc(
    config.char1,
    new THREEVector3(spawn1.x, spawn1.y, spawn1.z),
    0, name1, config.diff1, config.mode1,
  );
  npc1.mesh.rotation.y = Math.atan2(spawn2.x - spawn1.x, spawn2.z - spawn1.z);

  const npc2 = engine.spawnAiNpc(
    config.char2,
    new THREEVector3(spawn2.x, spawn2.y, spawn2.z),
    1, name2, config.diff2, config.mode2,
  );
  npc2.mesh.rotation.y = Math.atan2(spawn1.x - spawn2.x, spawn1.z - spawn2.z);

  // Apply starting buffs
  for (const [npc, charId] of [[npc1, config.char1], [npc2, config.char2]] as const) {
    const stats = getCharacterStats(charId);
    if (stats.startingBuffs) {
      for (const buff of stats.startingBuffs) {
        engine.buffSystem.apply(npc, buff);
      }
    }
  }

  // Camera follows first NPC initially
  engine.setSpectatorTarget(npc1);

  // ── Game-over detection ──
  let specGameOver = false;
  let specGameOverCleanup: (() => void) | null = null;

  function checkGameOver(): void {
    if (specGameOver) return;
    const dead1 = npc1.dead;
    const dead2 = npc2.dead;
    if (!dead1 && !dead2) return;

    specGameOver = true;
    const winnerName = dead2 && !dead1 ? name1 : dead1 && !dead2 ? name2 : null;

    setTimeout(() => {
      specGameOverCleanup = showSinglePlayerGameOver({
        won: !!winnerName,
        opponentName: '',
        title: winnerName ? `${winnerName} wins!` : 'DRAW',
        subtitle: winnerName
          ? `${dead1 ? name1 : name2} has been defeated.`
          : 'Both fighters went down!',
        onRematch: () => {
          specGameOverCleanup = null;
          cleanupPlaygroundUI();
          startSpectatorMode(config);
        },
        onExit: () => {
          specGameOverCleanup = null;
          showLobby();
          network?.send({ type: 'return_to_lobby' });
        },
      });
    }, 1500);
  }

  // Wire up arena frames for both fighters
  const arenaEntities = [
    { entityId: 'spec_npc_0', targetable: npc1 as unknown as Targetable },
    { entityId: 'spec_npc_1', targetable: npc2 as unknown as Targetable },
  ];

  pgSession = createPlaygroundSession({
    engine,
    canvas,
    getPortrait,
    keybindMenu,
    onReturnToLobby: () => {
      specGameOverCleanup?.();
      showLobby();
      network?.send({ type: 'return_to_lobby' });
    },
    onFrameUpdate: checkGameOver,
    skipArenaPreparation: true,
    arenaFrameEntities: arenaEntities,
  });
}

// ── Playground Mode ────────────────────────────────────────────────────

async function startPlayground(): Promise<void> {
  lobbyMusic.fadeOut();
  cleanupCurrentState();
  currentState = 'playground';

  const uiOverlay = document.getElementById('ui-overlay');
  if (uiOverlay) uiOverlay.style.display = '';
  canvas.style.display = 'block';

  const { Engine } = await import('./engine/Engine');
  const { createPlaygroundSession } = await import('./engine/PlaygroundSession');
  const { DebugPanel } = await import('./ui/DebugPanel');
  const { MapSelector } = await import('./ui/MapSelector');
  const { CharacterSelector } = await import('./ui/CharacterSelector');
  const { NpcSpawner } = await import('./ui/NpcSpawner');
  const { DebugStun, DiscombobulateDebuff } = await import('./engine/combat/Ability');

  const engine = new Engine(canvas);
  engine.isAdmin = isAdmin;
  const savedUsername = sessionStorage.getItem('gtr_username');
  if (savedUsername) engine.playerController.name = savedUsername;

  // Playground-specific: debug panels, selectors, NPC spawner
  const mapContainer = document.getElementById('map-selector-container')!;
  const debugContainer = document.getElementById('debug-panel-container')!;
  const charContainer = document.getElementById('character-selector-container')!;
  const npcContainer = document.getElementById('npc-spawner-container')!;

  new CharacterSelector(engine, charContainer);
  new MapSelector(engine, mapContainer);
  new NpcSpawner(engine, npcContainer);
  pgDebugPanel = new DebugPanel(engine, debugContainer);

  // Debug buttons
  const makeBtn = (text: string, bg: string, onClick: () => void) => {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `padding: 6px 10px; font-size: 13px; background: ${bg}; color: #ddd; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; cursor: pointer; outline: none; width: 100%; margin-top: 4px;`;
    btn.addEventListener('click', onClick);
    npcContainer.appendChild(btn);
    return btn;
  };

  makeBtn('Kill Target', 'rgba(160, 40, 40, 0.85)', () => {
    const t = engine.targetingSystem.currentTarget;
    if (t && !t.dead) t.die();
  });

  makeBtn('Open Gates', 'rgba(40, 100, 160, 0.85)', () => {
    const script = engine.mapManager.getScript();
    if (script && 'forceOpenDoors' in script) (script as any).forceOpenDoors();
  });

  const stunBtn = makeBtn('Stun Target', 'rgba(160, 130, 40, 0.85)', () => {
    const t = engine.targetingSystem.currentTarget;
    if (!t || t.dead) return;
    if (engine.buffSystem.isStunned(t)) {
      engine.buffSystem.remove(t, 'debug-stun');
      stunBtn.textContent = 'Stun Target';
      stunBtn.style.background = 'rgba(160, 130, 40, 0.85)';
    } else {
      engine.buffSystem.apply(t, DebugStun);
      stunBtn.textContent = 'Unstun Target';
      stunBtn.style.background = 'rgba(40, 130, 160, 0.85)';
    }
  });

  makeBtn('Discombobulate', 'rgba(100, 60, 160, 0.85)', () => {
    const t = engine.targetingSystem.currentTarget;
    if (t && !t.dead) engine.buffSystem.apply(t, DiscombobulateDebuff);
  });

  // Shared session handles all UI wiring, action bar, combat callbacks, update loop
  pgSession = createPlaygroundSession({
    engine,
    canvas,
    getPortrait,
    keybindMenu,
    onReturnToLobby: () => {
      showLobby();
      network?.send({ type: 'return_to_lobby' });
    },
    showRespawnButton: true,
    showDebugHUD: true,
    wireCharacterChange: true,
    onGodModeToggle: (active) => toggleGodModeOverlay(active),
  });
}

// ── UI Setup (solo training room for UI customization) ────────────────

async function startUISetup(): Promise<void> {
  lobbyMusic.fadeOut();
  cleanupCurrentState();
  currentState = 'ui-setup';
  practiceMusic.start();

  const uiOverlay = document.getElementById('ui-overlay');
  if (uiOverlay) uiOverlay.style.display = '';
  canvas.style.display = 'block';

  const { Engine } = await import('./engine/Engine');
  const { createPlaygroundSession } = await import('./engine/PlaygroundSession');
  const { CharacterSelector } = await import('./ui/CharacterSelector');

  const engine = new Engine(canvas);
  const savedUsername = sessionStorage.getItem('gtr_username');
  if (savedUsername) engine.playerController.name = savedUsername;
  engine.loadMap('ui-setup');
  // Remove arena preparation — this is a free-roam UI setup room
  engine.buffSystem.remove(engine.playerController, 'arena-preparation');
  engine.arenaPreparationActive = false;

  // Spawn 3 ally and 3 enemy NPCs (massive HP so they don't die)
  const practiceNpcs = [
    engine.spawnNpc('janitor',    new THREEVector3(-6, 0, -6), 0, 'Party 1'),
    engine.spawnNpc('dr-retardo', new THREEVector3(-8, 0, -3), 0, 'Party 2'),
    engine.spawnNpc('crackhead',  new THREEVector3(-5, 0, 0),  0, 'Party 3'),
    engine.spawnNpc('janitor',    new THREEVector3(6, 0, -6),  1, 'Arena 1'),
    engine.spawnNpc('dr-retardo', new THREEVector3(8, 0, -3),  1, 'Arena 2'),
    engine.spawnNpc('crackhead',  new THREEVector3(5, 0, 0),   1, 'Arena 3'),
  ];
  for (const npc of practiceNpcs) {
    npc.maxHp = 9999999;
    npc.hp = 9999999;
  }

  // Character selector (floating top-left panel, no debug sidebar)
  const charContainer = document.getElementById('character-selector-container')!;
  new CharacterSelector(engine, charContainer, { excludePlaygroundOnly: true });

  // Build entity arrays for party/arena frames
  const npcEntities = practiceNpcs.map((npc, i) => ({
    entityId: `practice_npc_${i}`,
    targetable: npc as unknown as Targetable,
  }));
  const allyEntities = npcEntities.filter((_, i) => i < 3);
  const enemyEntities = npcEntities.filter((_, i) => i >= 3);

  // Shared session handles all UI wiring, action bar, combat callbacks, update loop
  pgSession = createPlaygroundSession({
    engine,
    canvas,
    getPortrait,
    keybindMenu,
    onReturnToLobby: () => {
      showLobby();
      network?.send({ type: 'return_to_lobby' });
    },
    showRespawnButton: true,
    showDebugHUD: true,
    wireCharacterChange: true,
    skipArenaPreparation: true,
    partyFrameEntities: allyEntities,
    arenaFrameEntities: enemyEntities,
  });
}

// ── Boot ───────────────────────────────────────────────────────────────

if (sessionStorage.getItem('gtr_updated')) {
  sessionStorage.removeItem('gtr_updated');
  // Show after a brief delay so the DOM is ready
  setTimeout(() => showUpdateSnackbar('Game has been updated!', 5000), 500);
}

// Auto-login if credentials exist from a previous session (e.g., page refresh)
const savedUsername = sessionStorage.getItem('gtr_username');
const savedPassword = sessionStorage.getItem('gtr_password');
if (savedUsername && savedPassword) {
  currentState = 'auth';
  connectWithCredentials(savedUsername, savedPassword, 'login');
} else {
  showAuth();
}
