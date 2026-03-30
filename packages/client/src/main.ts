import type { ServerMessage, S2C_GameStart, S2C_RejoinGame, PlayerMatchResult } from '@gtr/shared';
import { Vector3 as THREEVector3 } from 'three';
import { AuthScreen } from './screens/AuthScreen';
import { LobbyScreen } from './screens/LobbyScreen';
import { GameLobbyScreen } from './screens/GameLobbyScreen';
import { AdminScreen } from './screens/AdminScreen';
import { NetworkManager } from './network/NetworkManager';
import { ClientEngine } from './network/ClientEngine';
import { UnitFrame } from './ui/UnitFrame';
import { TargetOfTargetFrame } from './ui/TargetOfTargetFrame';
import { ActionBar, type AbilityUsabilityStatus } from './ui/ActionBar';
import { ErrorText } from './ui/ErrorText';
import { FloatingCombatText } from './ui/FloatingCombatText';
import { Nameplates } from './ui/Nameplates';
import { UnitTooltip } from './ui/UnitTooltip';
import { EscapeMenu, type EscapeMenuButton } from './ui/EscapeMenu';
import { AudioSettingsDialog } from './ui/AudioSettingsDialog';
import { audioSettings } from './ui/AudioSettings';
import { soundEffects } from './ui/SoundEffects';
import { KeybindMenu } from './ui/KeybindMenu';
import { DebugHUD } from './ui/DebugHUD';
import { ReconnectOverlay } from './ui/ReconnectOverlay';
import { ArenaFrames } from './ui/ArenaFrames';
import { PartyFrames } from './ui/PartyFrames';
import { UnitFramePositioner } from './ui/UnitFramePositioner';
import { DeathFrame } from './ui/DeathFrame';
import { ChatWindow } from './ui/ChatWindow';
import { renderPortraits } from './ui/PortraitRenderer';
import { getCharacterStats, getCharacterSfx, xpToLevel, CHARACTER_LIST, type CharacterId } from '@gtr/shared';
import { GLOBAL_COOLDOWN, type Ability } from './engine/combat/Ability';
import type { Targetable } from './engine/types';

declare const __BUILD_VERSION__: string | undefined;

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
if (!canvas) throw new Error('Canvas element not found');

// Prevent browser context menu during gameplay
document.addEventListener('contextmenu', (e) => {
  if (currentState === 'playground' || currentState === 'multiplayer' || currentState === 'ui-setup') {
    e.preventDefault();
  }
});

// Pre-render character face portraits
const portraits = renderPortraits();
const getPortrait = (modelName: string) => portraits.get(modelName);

// ── State ──────────────────────────────────────────────────────────────

type AppState = 'auth' | 'lobby' | 'game-lobby' | 'multiplayer' | 'playground' | 'ui-setup';
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

// Active screens / engines
let authScreen: AuthScreen | null = null;
let lobbyScreen: LobbyScreen | null = null;
let gameLobbyScreen: GameLobbyScreen | null = null;
let adminScreen: AdminScreen | null = null;
let clientEngine: ClientEngine | null = null;
const reconnectOverlay = new ReconnectOverlay();

// ── Lobby Music (persists across lobby/game transitions) ──────────────
const lobbyMusic = {
  audioCtx: null as AudioContext | null,
  gainNode: null as GainNode | null,
  sourceNode: null as AudioBufferSourceNode | null,
  fadingOut: false,
  _startId: 0,
  get volume(): number { return audioSettings.windowFocused ? audioSettings.masterVolume * audioSettings.musicVolume : 0; },

  onVisibilityChange(): void {
    if (this.fadingOut || !this.audioCtx || !this.gainNode) return;
    const ctx = this.audioCtx;
    const gain = this.gainNode;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    if (document.hidden) {
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
    } else {
      gain.gain.linearRampToValueAtTime(this.volume, ctx.currentTime + 0.5);
    }
  },

  resumeAudioCtx(): void {
    if (!this.audioCtx || this.fadingOut) return;
    this.audioCtx.resume().then(() => {
      const handler = this._onUserGesture;
      if (handler) for (const evt of ['pointerdown', 'keydown'] as const) {
        document.removeEventListener(evt, handler);
      }
      if (!this.fadingOut && this.gainNode && this.audioCtx && !document.hidden) {
        this.gainNode.gain.linearRampToValueAtTime(this.volume, this.audioCtx.currentTime + 2);
      }
    });
  },

  _onVisibilityChange: null as (() => void) | null,
  _onUserGesture: null as (() => void) | null,

  async start(): Promise<void> {
    if (!audioSettings.enableMusic) return;
    // Already playing — nothing to do
    if (this.audioCtx && !this.fadingOut) return;
    const id = ++this._startId;
    // Was fading out — wait for cleanup then restart
    if (this.fadingOut) {
      await new Promise<void>(r => setTimeout(r, 1700));
    }
    // If fadeOut() or another start() was called during the wait, abort
    if (id !== this._startId) return;
    this.fadingOut = false;
    try {
      const ctx = new AudioContext();
      this.audioCtx = ctx;
      const gain = ctx.createGain();
      this.gainNode = gain;
      gain.gain.value = 0;
      gain.connect(ctx.destination);

      const resp = await fetch('/audio/music/lobby.ogg');
      const buf = await resp.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(buf);

      if (this.fadingOut || id !== this._startId) {
        ctx.close();
        this.audioCtx = null;
        this.gainNode = null;
        return;
      }

      const source = ctx.createBufferSource();
      this.sourceNode = source;
      source.buffer = audioBuf;
      source.loop = true;
      source.connect(gain);
      source.start();

      this._onVisibilityChange = () => this.onVisibilityChange();
      this._onUserGesture = () => this.resumeAudioCtx();
      document.addEventListener('visibilitychange', this._onVisibilityChange);

      if (ctx.state === 'suspended') {
        for (const evt of ['pointerdown', 'keydown'] as const) {
          document.addEventListener(evt, this._onUserGesture, { once: false });
        }
      } else if (!document.hidden) {
        gain.gain.linearRampToValueAtTime(this.volume, ctx.currentTime + 2);
      }
    } catch {
      // Audio playback not available — silent fail
    }
  },

  fadeOut(): void {
    this._startId++;  // Cancel any in-progress start()
    this.fadingOut = true;
    if (this._onVisibilityChange) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }
    if (this._onUserGesture) {
      const handler = this._onUserGesture;
      for (const evt of ['pointerdown', 'keydown'] as const) {
        document.removeEventListener(evt, handler);
      }
    }
    if (!this.audioCtx || !this.gainNode) return;
    const ctx = this.audioCtx;
    const gain = this.gainNode;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.5);
    setTimeout(() => {
      this.sourceNode?.stop();
      ctx.close();
      this.audioCtx = null;
      this.gainNode = null;
      this.sourceNode = null;
    }, 1600);
  },

  applyVolume(): void {
    if (!this.audioCtx || !this.gainNode || this.fadingOut) return;
    const ctx = this.audioCtx;
    const gain = this.gainNode;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(this.volume, ctx.currentTime + 0.15);
  },
};

// React to audio settings changes
audioSettings.onChange((s) => {
  if (!s.enableMusic) {
    lobbyMusic.fadeOut();
  } else if (lobbyMusic.audioCtx && !lobbyMusic.fadingOut) {
    lobbyMusic.applyVolume();
  } else if (currentState === 'lobby') {
    lobbyMusic.start();
  }
});

// MP game UI elements
let mpActionBar: ActionBar | null = null;
let mpPlayerFrame: UnitFrame | null = null;
let mpTargetFrame: UnitFrame | null = null;
let mpToTFrame: TargetOfTargetFrame | null = null;
let mpErrorText: ErrorText | null = null;
let mpCombatText: FloatingCombatText | null = null;
let mpNameplates: Nameplates | null = null;
let mpUnitTooltip: UnitTooltip | null = null;
let mpCastBarContainer: HTMLDivElement | null = null;
let mpCastBarFill: HTMLDivElement | null = null;
let mpCastBarHeader: HTMLDivElement | null = null;
let mpGameOverScreen: HTMLDivElement | null = null;
let mpGameOver = false;
let mpEscapeMenu: EscapeMenu | null = null;
let mpDebugHUD: DebugHUD | null = null;
let mpArenaFrames: ArenaFrames | null = null;
let mpPartyFrames: PartyFrames | null = null;
let mpPositioner: UnitFramePositioner | null = null;
let mpDeathFrame: DeathFrame | null = null;
let mpChatWindow: ChatWindow | null = null;
let mpFrameLoopId: number | null = null;
let mpSelectedTargetId: string | null = null;

// Playground UI elements
let pgEngine: import('./engine/Engine').Engine | null = null;
let pgDebugPanel: import('./ui/DebugPanel').DebugPanel | null = null;
let pgActionBar: ActionBar | null = null;
let pgPlayerFrame: UnitFrame | null = null;
let pgTargetFrame: UnitFrame | null = null;
let pgToTFrame: TargetOfTargetFrame | null = null;
let pgErrorText: ErrorText | null = null;
let pgCombatText: FloatingCombatText | null = null;
let pgNameplates: Nameplates | null = null;
let pgUnitTooltip: UnitTooltip | null = null;
let pgDeathFrame: DeathFrame | null = null;
let pgCastBarContainer: HTMLDivElement | null = null;
let pgEscapeMenu: EscapeMenu | null = null;
let pgDebugHUD: DebugHUD | null = null;
let pgPositioner: UnitFramePositioner | null = null;
let pgArenaFrames: ArenaFrames | null = null;
let pgPartyFrames: PartyFrames | null = null;

// Auth & Lobby escape menus
let authEscapeMenu: EscapeMenu | null = null;
let lobbyEscapeMenu: EscapeMenu | null = null;

// Shared keybind menu (persists across game modes)
const keybindMenu = new KeybindMenu();
document.body.appendChild(keybindMenu.element);
let pgFrameLoopId: number | null = null;
let pgResizeHandler: (() => void) | null = null;

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
  cleanupMultiplayerUI();
  cleanupPlaygroundUI();
  toggleGodModeOverlay(false);
}

function cleanupMultiplayerUI(): void {
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('resize', onMpResize);
  clientEngine?.destroy();
  clientEngine = null;
  mpActionBar?.dispose();
  mpActionBar = null;
  mpPositioner?.dispose();
  mpPositioner = null;
  mpPlayerFrame = null;
  mpTargetFrame = null;
  mpToTFrame = null;
  mpErrorText?.element.remove();
  mpErrorText = null;
  mpCombatText?.element.remove();
  mpCombatText = null;
  mpNameplates?.element.remove();
  mpNameplates = null;
  mpUnitTooltip?.dispose();
  mpUnitTooltip = null;
  mpCastBarContainer?.remove();
  mpCastBarContainer = null;
  mpGameOverScreen?.remove();
  mpGameOverScreen = null;
  mpGameOver = false;
  gameOverBox = null;
  clearRematchOverlay();
  mpEscapeMenu?.dispose();
  mpEscapeMenu = null;
  mpDebugHUD?.dispose();
  mpDebugHUD = null;
  mpArenaFrames?.dispose();
  mpArenaFrames = null;
  mpPartyFrames?.dispose();
  mpPartyFrames = null;
  mpDeathFrame?.element.remove();
  mpDeathFrame = null;
  mpChatWindow?.dispose();
  mpChatWindow = null;
  if (mpFrameLoopId !== null) {
    cancelAnimationFrame(mpFrameLoopId);
    mpFrameLoopId = null;
  }
  mpSelectedTargetId = null;
}

function cleanupPlaygroundUI(): void {
  if (pgResizeHandler) {
    window.removeEventListener('resize', pgResizeHandler);
    pgResizeHandler = null;
  }
  if (pgFrameLoopId !== null) {
    cancelAnimationFrame(pgFrameLoopId);
    pgFrameLoopId = null;
  }
  pgEngine?.dispose();
  pgEngine = null;
  pgDebugPanel?.dispose();
  pgDebugPanel = null;
  pgActionBar?.dispose();
  pgActionBar = null;
  pgPositioner?.dispose();
  pgPositioner = null;
  pgPlayerFrame = null;
  pgTargetFrame = null;
  pgToTFrame = null;
  pgErrorText?.element.remove();
  pgErrorText = null;
  pgCombatText?.element.remove();
  pgCombatText = null;
  pgNameplates?.element.remove();
  pgNameplates = null;
  pgUnitTooltip?.dispose();
  pgUnitTooltip = null;
  pgDeathFrame?.element.remove();
  pgDeathFrame = null;
  pgCastBarContainer?.remove();
  pgCastBarContainer = null;
  pgEscapeMenu?.dispose();
  pgEscapeMenu = null;
  pgDebugHUD?.dispose();
  pgDebugHUD = null;
  pgArenaFrames?.dispose();
  pgArenaFrames = null;
  pgPartyFrames?.dispose();
  pgPartyFrames = null;
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
  network.onMessage(handleServerMessage);
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
  if (isAdmin) {
    lobbyMenuButtons.push({
      label: 'Playground',
      onClick: () => lobbyScreen?.onPlayground?.(),
      color: 'rgba(90, 61, 138, 0.8)',
      hoverColor: 'rgba(112, 80, 168, 0.9)',
    });
  }
  if (isAdmin) {
    lobbyMenuButtons.push({
      label: 'Manage Users',
      onClick: () => lobbyScreen?.onAdmin?.(),
      color: 'rgba(138, 90, 32, 0.8)',
      hoverColor: 'rgba(168, 112, 48, 0.9)',
    });
  }
  lobbyMenuButtons.push({
    label: 'Practice',
    onClick: () => lobbyScreen?.onUISetup?.(),
    color: 'rgba(74, 58, 106, 0.8)',
    hoverColor: 'rgba(94, 74, 130, 0.9)',
  });
  lobbyMenuButtons.push({
    label: 'Change Password',
    onClick: () => lobbyScreen?.showChangePasswordDialog(),
    color: 'rgba(60, 60, 100, 0.8)',
    hoverColor: 'rgba(70, 70, 120, 0.9)',
  });
  lobbyMenuButtons.push({
    label: 'Logout',
    onClick: () => lobbyScreen?.onLogout?.(),
    color: 'rgba(160, 50, 50, 0.8)',
    hoverColor: 'rgba(180, 60, 60, 0.9)',
  });

  lobbyEscapeMenu = new EscapeMenu({
    onReturnToLobby: () => {},  // Not used in lobby mode
    customButtons: lobbyMenuButtons,
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

  gameLobbyScreen = new GameLobbyScreen(network!, localUserId);
  document.body.appendChild(gameLobbyScreen.element);
}

// ── Multiplayer Game ───────────────────────────────────────────────────

function onBeforeUnload(e: BeforeUnloadEvent): void {
  e.preventDefault();
}

function startMultiplayer(msg: S2C_GameStart): void {
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

  // Wire up server message handlers
  clientEngine.onError = (message) => mpErrorText?.show(message);
  clientEngine.onGodModeToggle = (active) => toggleGodModeOverlay(active);

  // Wire gate vote button
  const script = clientEngine.mapManager.getScript();
  if (script && 'onVoteOpenGates' in script) {
    (script as any).onVoteOpenGates = () => {
      network!.send({ type: 'vote_open_gates' });
    };
  }

  clientEngine.onCombatText = (sourceEntityId, targetEntityId, amount, type) => {
    // Skip 0-amount damage text (e.g. debuff-only abilities, hostile channel starts)
    if (amount === 0 && type !== 'miss' && type !== 'dodge' && type !== 'immune') return;
    const localId = clientEngine!.localId;
    const isLocalInvolved = sourceEntityId === localId || targetEntityId === localId;
    if (isLocalInvolved) {
      const mesh = clientEngine!.getEntityMesh(targetEntityId);
      if (mesh && mpCombatText) {
        const isIncoming = targetEntityId === localId;
        mpCombatText.spawn(mesh, amount, type as any, isIncoming);
      }
    }
    if (targetEntityId === localId) {
      mpPlayerFrame?.showCombatText(amount, type as any);
    } else if (targetEntityId === mpSelectedTargetId) {
      mpTargetFrame?.showCombatText(amount, type as any);
    }
    if (mpArenaFrames?.hasEntity(targetEntityId)) {
      mpArenaFrames.showCombatText(targetEntityId, amount, type as any);
    }
    if (mpPartyFrames?.hasEntity(targetEntityId)) {
      mpPartyFrames.showCombatText(targetEntityId, amount, type as any);
    }
  };

  clientEngine.onEnterCombat = (entityId) => {
    if (entityId === clientEngine!.localId) {
      const mesh = clientEngine!.getEntityMesh(entityId);
      if (mesh && mpCombatText) mpCombatText.spawnText(mesh, '+Combat', '#cc3333', true);
    }
  };
  clientEngine.onLeaveCombat = (entityId) => {
    if (entityId === clientEngine!.localId) {
      const mesh = clientEngine!.getEntityMesh(entityId);
      if (mesh && mpCombatText) mpCombatText.spawnText(mesh, '-Combat', '#33cc33', true);
    }
  };

  clientEngine.onBuffApplied = (entityId, buff) => {
    if (entityId === clientEngine!.localId) {
      const mesh = clientEngine!.getEntityMesh(entityId);
      if (mesh && mpCombatText) {
        const color = buff.type === 'buff' ? '#3388ff' : '#ff6644';
        mpCombatText.spawnText(mesh, `+${buff.name}`, color, true);
      }
    }
  };
  clientEngine.onBuffExpired = (entityId, buff) => {
    if (entityId === clientEngine!.localId) {
      const mesh = clientEngine!.getEntityMesh(entityId);
      if (mesh && mpCombatText) {
        mpCombatText.spawnText(mesh, `-${buff.name}`, '#888888', true);
      }
    }
  };
  clientEngine.onAbilitySuccess = (abilityId) => {
    if (abilityId === 'shank' || abilityId === 'pocket-sand' || abilityId === 'tweaker-sprint' || abilityId === 'gank') {
      const mesh = clientEngine!.getEntityMesh(clientEngine!.localId);
      if (mesh && mpCombatText) {
        mpCombatText.spawnText(mesh, '+15 Tweaking', '#3388ff', true);
      }
    }
    if (abilityId === 'crack-rock') {
      const mesh = clientEngine!.getEntityMesh(clientEngine!.localId);
      if (mesh && mpCombatText) {
        mpCombatText.spawnText(mesh, '+25 Tweaking', '#3388ff', true);
      }
    }
  };
  clientEngine.onManaDrained = (amount) => {
    const mesh = clientEngine!.getEntityMesh(clientEngine!.localId);
    if (mesh && mpCombatText) {
      mpCombatText.spawnText(mesh, `+${amount} Mana`, '#3388ff', true);
    }
  };
  clientEngine.onAbilityEffect = (entityId, abilityId) => {
    if (abilityId === 'pvp-trinket') {
      mpArenaFrames?.notifyTrinketUsed(entityId);
    }
  };

  // Create UI elements for MP game
  setupMultiplayerUI(msg);

  // Start rendering
  clientEngine.start();

  window.addEventListener('resize', onMpResize);
}

function startMultiplayerRejoin(msg: S2C_RejoinGame): void {
  lobbyMusic.fadeOut();
  cleanupCurrentState();
  currentState = 'multiplayer';
  showGameUI();

  window.addEventListener('beforeunload', onBeforeUnload);

  clientEngine = new ClientEngine(canvas, network!, msg.mapId, msg.localEntityId, msg.entities);
  clientEngine.isAdmin = isAdmin;

  network!.send({ type: 'client_ready' });

  // Wire callbacks (same as startMultiplayer)
  clientEngine.onError = (message) => mpErrorText?.show(message);
  clientEngine.onGodModeToggle = (active) => toggleGodModeOverlay(active);

  // Wire gate vote button
  const rejoinScript = clientEngine.mapManager.getScript();
  if (rejoinScript && 'onVoteOpenGates' in rejoinScript) {
    (rejoinScript as any).onVoteOpenGates = () => {
      network!.send({ type: 'vote_open_gates' });
    };
  }

  clientEngine.onCombatText = (sourceEntityId, targetEntityId, amount, type) => {
    // Skip 0-amount damage text (e.g. debuff-only abilities, hostile channel starts)
    if (amount === 0 && type !== 'miss' && type !== 'dodge' && type !== 'immune') return;
    const localId = clientEngine!.localId;
    const isLocalInvolved = sourceEntityId === localId || targetEntityId === localId;
    if (isLocalInvolved) {
      const mesh = clientEngine!.getEntityMesh(targetEntityId);
      if (mesh && mpCombatText) {
        const isIncoming = targetEntityId === localId;
        mpCombatText.spawn(mesh, amount, type as any, isIncoming);
      }
    }
    if (targetEntityId === localId) {
      mpPlayerFrame?.showCombatText(amount, type as any);
    } else if (targetEntityId === mpSelectedTargetId) {
      mpTargetFrame?.showCombatText(amount, type as any);
    }
    if (mpArenaFrames?.hasEntity(targetEntityId)) {
      mpArenaFrames.showCombatText(targetEntityId, amount, type as any);
    }
    if (mpPartyFrames?.hasEntity(targetEntityId)) {
      mpPartyFrames.showCombatText(targetEntityId, amount, type as any);
    }
  };

  clientEngine.onEnterCombat = (entityId) => {
    if (entityId === clientEngine!.localId) {
      const mesh = clientEngine!.getEntityMesh(entityId);
      if (mesh && mpCombatText) mpCombatText.spawnText(mesh, '+Combat', '#cc3333', true);
    }
  };
  clientEngine.onLeaveCombat = (entityId) => {
    if (entityId === clientEngine!.localId) {
      const mesh = clientEngine!.getEntityMesh(entityId);
      if (mesh && mpCombatText) mpCombatText.spawnText(mesh, '-Combat', '#33cc33', true);
    }
  };

  clientEngine.onBuffApplied = (entityId, buff) => {
    if (entityId === clientEngine!.localId) {
      const mesh = clientEngine!.getEntityMesh(entityId);
      if (mesh && mpCombatText) {
        const color = buff.type === 'buff' ? '#3388ff' : '#ff6644';
        mpCombatText.spawnText(mesh, `+${buff.name}`, color, true);
      }
    }
  };
  clientEngine.onBuffExpired = (entityId, buff) => {
    if (entityId === clientEngine!.localId) {
      const mesh = clientEngine!.getEntityMesh(entityId);
      if (mesh && mpCombatText) {
        mpCombatText.spawnText(mesh, `-${buff.name}`, '#888888', true);
      }
    }
  };
  clientEngine.onAbilitySuccess = (abilityId) => {
    if (abilityId === 'shank' || abilityId === 'pocket-sand' || abilityId === 'tweaker-sprint' || abilityId === 'gank') {
      const mesh = clientEngine!.getEntityMesh(clientEngine!.localId);
      if (mesh && mpCombatText) {
        mpCombatText.spawnText(mesh, '+15 Tweaking', '#3388ff', true);
      }
    }
    if (abilityId === 'crack-rock') {
      const mesh = clientEngine!.getEntityMesh(clientEngine!.localId);
      if (mesh && mpCombatText) {
        mpCombatText.spawnText(mesh, '+25 Tweaking', '#3388ff', true);
      }
    }
  };
  clientEngine.onManaDrained = (amount) => {
    const mesh = clientEngine!.getEntityMesh(clientEngine!.localId);
    if (mesh && mpCombatText) {
      mpCombatText.spawnText(mesh, `+${amount} Mana`, '#3388ff', true);
    }
  };
  clientEngine.onAbilityEffect = (entityId, abilityId) => {
    if (abilityId === 'pvp-trinket') {
      mpArenaFrames?.notifyTrinketUsed(entityId);
    }
  };

  setupMultiplayerUI(msg);

  // Apply full state from rejoin (buffs, world effects, disconnected entities)
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
      // Local player cooldowns → action bar
      clientEngine.handleCooldownUpdate({ type: 'cooldown_update', abilityId: cd.abilityId, remaining: cd.remaining, total: cd.total });
    }
    if (cd.abilityId === 'pvp-trinket') {
      // Enemy trinket cooldowns → arena frames
      mpArenaFrames?.notifyTrinketUsed(cd.entityId, cd.remaining, cd.total);
    }
  }

  for (const entityId of msg.disconnectedEntityIds) {
    clientEngine.handlePlayerDisconnected(entityId);
  }

  // Sync elapsed time from server — gameElapsed is authoritative and covers both
  // the arena countdown period and post-open time (needed for elevator sync, etc.)
  if (msg.gameElapsed !== undefined) {
    clientEngine.mapManager.setElapsed(msg.gameElapsed);
    // If doors should already be open, trigger the open immediately
    const script = clientEngine.mapManager.getScript();
    const openTime = (script && 'OPEN_TIME' in script) ? (script as any).OPEN_TIME as number : 30;
    if (msg.gameElapsed >= openTime && script && 'opened' in script && !(script as any).opened) {
      clientEngine.mapManager.forceOpenDoors();
    }
  } else if (msg.arenaTimeRemaining !== undefined && msg.arenaTimeRemaining > 0) {
    // Fallback: legacy path using arenaTimeRemaining
    const script = clientEngine.mapManager.getScript();
    const openTime = (script && 'OPEN_TIME' in script) ? (script as any).OPEN_TIME as number : 30;
    clientEngine.mapManager.setElapsed(openTime - msg.arenaTimeRemaining);
  } else {
    // Arena already open (or no arena countdown) — skip countdown entirely
    clientEngine.mapManager.forceOpenDoors();
  }

  clientEngine.start();
  window.addEventListener('resize', onMpResize);

  // If the game ended while we were disconnected, show game over immediately
  if (msg.gameOver) {
    showGameOver(msg.gameOver.winningTeam, false, msg.gameOver.playerResults);
  }
}

function onMpResize(): void {
  clientEngine?.resize(window.innerWidth, window.innerHeight);
}

function setupMultiplayerUI(msg: { entities: S2C_GameStart['entities']; localEntityId: string }): void {
  if (!clientEngine) return;

  const player = clientEngine.playerController;
  const localSnap = msg.entities.find(e => e.id === msg.localEntityId);
  const localCharStats = getCharacterStats((localSnap?.characterId ?? 'janitor') as any);

  // Error text
  mpErrorText = new ErrorText();
  document.body.appendChild(mpErrorText.element);

  // Floating combat text
  mpCombatText = new FloatingCombatText(clientEngine.camera);
  document.body.appendChild(mpCombatText.element);

  // Nameplates
  mpNameplates = new Nameplates(
    clientEngine.camera, clientEngine.scene,
    (target) => { clientEngine!.selectTarget(target); },
    (target) => { clientEngine!.targetingSystem.setNameplateHover(target); },
    (target) => { clientEngine!.rightClickTarget(target); },
  );
  document.body.appendChild(mpNameplates.element);

  // Unit tooltip (bottom-right, on hover)
  mpUnitTooltip = new UnitTooltip(player);
  document.body.appendChild(mpUnitTooltip.element);

  // Unit frames

  // Get a Targetable reference for any entity
  const makeTargetable = (entityId: string): Targetable | null => {
    if (entityId === clientEngine!.localId) {
      return player; // PlayerController implements Targetable
    }
    const e = clientEngine!.getRemoteEntity(entityId);
    return e?.targetable ?? null;
  };

  const mpSetTarget = (t: Targetable) => {
    clientEngine!.targetingSystem.currentTarget = t;
    const entityId = t === player ? clientEngine!.localId : (() => {
      for (const e of clientEngine!.getAllRemoteEntities()) {
        if (e.targetable === t) return e.id;
      }
      return null;
    })();
    mpSelectedTargetId = entityId;
    clientEngine!.selectedTargetId = entityId;
    clientEngine!.sendSetTarget(entityId);
  };
  mpPlayerFrame = new UnitFrame({
    getPortrait,
    onClick: mpSetTarget,
    hideCastBar: true,
    onBuffRightClick: (buffId) => {
      clientEngine?.sendCancelBuff(buffId);
    },
  });
  mpTargetFrame = new UnitFrame({ localPlayer: player, getPortrait, onClick: mpSetTarget });
  mpToTFrame = new TargetOfTargetFrame({ localPlayer: player, getPortrait, onClick: mpSetTarget });

  // Arena frames (Gladdy-style opponent frames on right side)
  mpArenaFrames = new ArenaFrames({ localPlayer: player, getPortrait, onClick: mpSetTarget });
  // Strip ArenaFrames' own fixed positioning (wrapper handles it)
  mpArenaFrames.element.style.position = '';
  mpArenaFrames.element.style.top = '';
  mpArenaFrames.element.style.right = '';
  mpArenaFrames.element.style.transform = '';
  mpArenaFrames.element.style.zIndex = '';

  // Party frames (friendly team members on left side, below player frame)
  mpPartyFrames = new PartyFrames({ localPlayer: player, getPortrait, onClick: mpSetTarget });

  // Register frames with positioner for drag-to-reposition
  mpPositioner = new UnitFramePositioner();
  document.body.appendChild(mpPositioner.register('player', mpPlayerFrame.element, { top: 12, left: 12 }));
  document.body.appendChild(mpPositioner.register('target', mpTargetFrame.element, { top: 12, left: 280 }));
  document.body.appendChild(mpPositioner.register('tot', mpToTFrame.element, { top: 51, left: 544 }));
  document.body.appendChild(mpPositioner.register('party', mpPartyFrames.element, { top: 150, left: 12 }, { stayBelow: { frameId: 'player', gap: 8 } }));
  const arenaDefaultLeft = window.innerWidth - 250;
  const arenaDefaultTop = Math.round(window.innerHeight / 2 - 100);
  document.body.appendChild(mpPositioner.register('arena', mpArenaFrames.element, { top: arenaDefaultTop, left: arenaDefaultLeft }));
  const allEntities = msg.entities
    .filter(e => e.id !== msg.localEntityId)
    .map(e => {
      const targetable = makeTargetable(e.id);
      return targetable ? { entityId: e.id, targetable } : null;
    })
    .filter((e): e is { entityId: string; targetable: Targetable } => e !== null);
  mpArenaFrames.setEntities(allEntities);
  mpPartyFrames.setEntities(allEntities);

  // Death frame
  mpDeathFrame = new DeathFrame();
  document.body.appendChild(mpDeathFrame.element);

  // Chat window
  mpChatWindow = new ChatWindow({
    onSend: (message) => {
      network?.send({ type: 'game_chat', message });
    },
    canOpen: () => !mpEscapeMenu?.isOpen && !keybindMenu.isOpen,
  });
  document.body.appendChild(mpChatWindow.element);

  // Action bar - abilities come from shared character data
  const abilities: readonly (Ability | null)[] = localCharStats.abilities;

  // Ground targeting state (MP)
  let mpPendingGroundAbility: Ability | null = null;

  function mpCancelGroundTargeting(): void {
    if (!mpPendingGroundAbility) return;
    mpPendingGroundAbility = null;
    clientEngine!.targetingSystem.cancelGroundTarget();
  }

  clientEngine.onGroundTargetConfirmed = () => {
    if (!mpPendingGroundAbility || !clientEngine) return;
    const ability = mpPendingGroundAbility;
    const groundPos = clientEngine.targetingSystem.getGroundTargetPosition();
    clientEngine.targetingSystem.cancelGroundTarget();
    mpPendingGroundAbility = null;
    clientEngine.predictGroundAbility(ability.id);
    clientEngine.sendAbility(ability.id, mpSelectedTargetId, { x: groundPos.x, y: groundPos.y, z: groundPos.z });
  };

  /** Fire an ability immediately (no GCD/cast checks). Used by both direct activation and queue callback. */
  function mpFireAbility(ability: Ability): void {
    if (clientEngine!.getCooldownRemaining(ability.id) > 0) return;
    if (ability.groundTargeted) {
      if (mpPendingGroundAbility?.id === ability.id) {
        mpCancelGroundTargeting();
      } else {
        mpCancelGroundTargeting();
        mpPendingGroundAbility = ability;
        clientEngine!.targetingSystem.startGroundTarget(ability.aoeRadius ?? 1, ability.range ?? 10);
      }
      return;
    }
    mpCancelGroundTargeting();
    // Only predict locally if the ability looks usable client-side (prevents false GCD flicker)
    if (mpGetAbilityStatus(ability) === 'usable') {
      clientEngine!.predictAbility(ability.id, mpSelectedTargetId);
    }
    clientEngine!.sendAbility(ability.id, mpSelectedTargetId);
  }

  // Ability queue callback — fires queued ability the instant GCD/cast ends
  clientEngine.onQueuedAbilityReady = (abilityId) => {
    const ability = abilities.find(a => a !== null && a.id === abilityId);
    if (!ability) return;
    mpFireAbility(ability);
  };

  function mpGetAbilityStatus(ability: Ability): AbilityUsabilityStatus {
    if (ability.id !== 'crack-rock' && clientEngine!.getLocalBuffs().some(b => b.id === 'dumpster-diving')) return 'locked';
    const effectiveManaCost = Math.round(ability.manaCost * clientEngine!.getManaCostMultiplier());
    if (player.mana < effectiveManaCost) return 'not-enough-resource';
    if (ability.requiresHostileTarget) {
      if (!mpSelectedTargetId) return 'no-target';
      const target = clientEngine!.getRemoteEntity(mpSelectedTargetId);
      if (!target || target.dead || target.team === player.team) return 'no-target';
      const pos = player.getPosition();
      const dx = pos.x - target.mesh.position.x;
      const dy = pos.y - target.mesh.position.y;
      const dz = pos.z - target.mesh.position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const effectiveRange = ability.isAutoAttack
        ? getCharacterStats(player.characterId as CharacterId).autoAttackRange
        : ability.range;
      if (effectiveRange && dist > effectiveRange) return 'out-of-range';
      if (ability.minRange && dist < ability.minRange) return 'out-of-range';
      // Line of sight check
      const collision = clientEngine!.mapManager.collision;
      if (!collision.hasLineOfSight(pos.x, pos.z, target.mesh.position.x, target.mesh.position.z, pos.y, target.mesh.position.y)) return 'not-in-los';
      // Facing check (120° cone, matches server)
      if (ability.requiresFacing !== false) {
        const hLen = Math.sqrt(dx * dx + dz * dz);
        if (hLen > 0.001) {
          const fwdX = Math.sin(player.mesh.rotation.y);
          const fwdZ = Math.cos(player.mesh.rotation.y);
          const dot = fwdX * ((target.mesh.position.x - pos.x) / hLen) + fwdZ * ((target.mesh.position.z - pos.z) / hLen);
          if (dot <= 0.5) return 'not-facing';
        }
      }
    }
    if (ability.requiresTarget && !ability.requiresHostileTarget) {
      // Friendly-or-self targeted abilities (e.g. Chudmax channel)
      // Auto self-cast if no target, but check range to non-self targets
      let targetId = mpSelectedTargetId;
      // Friendly-only abilities self-cast when targeting a hostile
      if (ability.requiresFriendlyTarget && targetId && targetId !== clientEngine!.localId) {
        const t = clientEngine!.getRemoteEntity(targetId);
        if (t && t.team !== player.team) targetId = null;
      }
      // Check blockedByTargetDebuff on resolved target
      if (ability.blockedByTargetDebuff) {
        if (!targetId || targetId === clientEngine!.localId) {
          if (clientEngine!.getLocalBuffs().some(b => b.id === ability.blockedByTargetDebuff)) return 'no-target';
        } else {
          const t = clientEngine!.getRemoteEntity(targetId);
          if (t && t.buffs.some(b => b.id === ability.blockedByTargetDebuff)) return 'no-target';
        }
      }
      if (targetId && targetId !== clientEngine!.localId) {
        const target = clientEngine!.getRemoteEntity(targetId);
        if (!target || target.dead) return 'no-target';
        if (ability.range) {
          const pos = player.getPosition();
          const dx = pos.x - target.mesh.position.x;
          const dy = pos.y - target.mesh.position.y;
          const dz = pos.z - target.mesh.position.z;
          if (Math.sqrt(dx * dx + dy * dy + dz * dz) > ability.range) return 'out-of-range';
        }
        // Line of sight check for friendly targets
        if (ability.range) {
          const pos = player.getPosition();
          const collision = clientEngine!.mapManager.collision;
          if (!collision.hasLineOfSight(pos.x, pos.z, target.mesh.position.x, target.mesh.position.z, pos.y, target.mesh.position.y)) return 'not-in-los';
        }
      }
    }
    return 'usable';
  }

  mpActionBar = new ActionBar({
    onActivate: (ability) => {
      // Attack toggle — bypass GCD/queue, just toggle auto-attack
      if (ability.isAutoAttack) {
        if (clientEngine!.playerController.isAutoAttacking) {
          clientEngine!.sendStopAutoAttack();
        } else if (mpSelectedTargetId) {
          if (clientEngine!.isResting()) clientEngine!.stopResting();
          clientEngine!.sendAutoAttack(mpSelectedTargetId);
        }
        return;
      }

      if (clientEngine!.isResting()) clientEngine!.stopResting();
      // Cancel current channel if starting new ability (same as playground)
      const castState = clientEngine!.getLocalCastingState();
      if (castState?.isChannel && clientEngine!.getCooldownRemaining(ability.id) <= 0) {
        clientEngine!.sendCancelCast();
      }

      // Determine if blocked by GCD or casting
      const gcdRemaining = clientEngine!.getGcdRemaining();
      const gcdBlocked = !ability.usableWhileCCd && gcdRemaining > 0;
      const castBlocked = castState !== null && !castState.isChannel;
      const castRemaining = castBlocked ? Math.max(0, castState!.totalTime - castState!.elapsed) : 0;

      if (gcdBlocked || castBlocked) {
        // Queue if within queue window (last 400ms of GCD/cast)
        const blockingRemaining = Math.max(
          gcdBlocked ? gcdRemaining : 0,
          castBlocked ? castRemaining : 0,
        );
        if (clientEngine!.isWithinQueueWindow(blockingRemaining)) {
          clientEngine!.queueAbility(ability.id, mpSelectedTargetId);
        }
        return;
      }

      // Not blocked — clear queue and fire immediately
      clientEngine!.clearAbilityQueue();
      mpFireAbility(ability);
    },
    getAbilityStatus: mpGetAbilityStatus,
    getCombatSystem: () => ({
      getCooldownRemaining: (id: string) => clientEngine!.getCooldownRemaining(id),
      getCooldownTotal: (id: string) => clientEngine!.getCooldownTotal(id),
    }) as any,
    getGcdRemaining: () => clientEngine!.getGcdRemaining(),
    getGcdTotal: () => clientEngine!.getGcdTotal(),
    isDisabled: () => {
      if (player.dead || player.stunned || player.charging) return true;
      const castState = clientEngine!.getLocalCastingState();
      if (castState && !castState.isChannel) {
        // Allow ability presses in the last 400ms of a cast for queuing
        const castRemaining = Math.max(0, castState.totalTime - castState.elapsed);
        return !clientEngine!.isWithinQueueWindow(castRemaining);
      }
      return false;
    },
    getQueuedAbilityId: () => clientEngine!.getQueuedAbilityId(),
    isAutoAttacking: () => clientEngine!.playerController.isAutoAttacking,
  });
  document.body.appendChild(mpActionBar.element);
  const charId = (localSnap?.characterId ?? 'janitor') as string;
  mpActionBar.loadAbilities(charId, abilities);

  // Cast bar
  mpCastBarContainer = document.createElement('div');
  mpCastBarContainer.style.cssText = `
    position: fixed; bottom: 84px; left: 50%; transform: translateX(-50%);
    width: 240px; z-index: 100; display: none;
  `;
  mpCastBarHeader = document.createElement('div');
  mpCastBarHeader.style.cssText = `
    display: flex; justify-content: space-between; color: #ddd;
    font-size: 11px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    margin-bottom: 2px; text-shadow: 1px 1px 2px rgba(0,0,0,0.9);
  `;
  const castBarBg = document.createElement('div');
  castBarBg.style.cssText = `
    height: 14px; background: rgba(0, 0, 0, 0.7);
    border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 3px; overflow: hidden;
  `;
  mpCastBarFill = document.createElement('div');
  mpCastBarFill.style.cssText = `height: 100%; background: linear-gradient(to right, #4488ff, #66aaff); width: 0%;`;
  castBarBg.appendChild(mpCastBarFill);
  mpCastBarContainer.appendChild(mpCastBarHeader);
  mpCastBarContainer.appendChild(castBarBg);
  document.body.appendChild(mpCastBarContainer);

  // Escape menu
  mpEscapeMenu = new EscapeMenu({
    onReturnToLobby: () => {
      showLobby();
      network?.send({ type: 'return_to_lobby' });
    },
    onEscapeWhilePlaying: () => {
      if (mpPendingGroundAbility) {
        mpCancelGroundTargeting();
        return true;
      }
      if (clientEngine?.getLocalCastingState()) {
        clientEngine.sendCancelCast();
        return true;
      }
      if (mpSelectedTargetId) {
        mpSelectedTargetId = null;
        if (clientEngine) {
          clientEngine.selectedTargetId = null;
          clientEngine.targetingSystem.currentTarget = null;
          clientEngine.sendSetTarget(null);
          clientEngine.sendStopAutoAttack();
          clientEngine.onTargetChanged?.(null);
        }
        return true;
      }
      return false;
    },
    isRematchEnabled: () => {
      if (!clientEngine) return false;
      // Enabled during Arena Preparation (before gates open) or after game over
      return mpGameOver || clientEngine.getLocalBuffs().some(b => b.id === 'arena-preparation');
    },
    onRematch: (mapMode) => {
      network?.send({ type: 'request_rematch', mapMode });
    },
    confirmExit: () => !mpGameOver,
    onKeybinds: () => {
      mpEscapeMenu?.close();
      keybindMenu.open(() => mpEscapeMenu?.open());
    },
    onAudio: () => {
      mpEscapeMenu?.close();
      new AudioSettingsDialog(() => mpEscapeMenu?.open()).open();
    },
  });
  document.body.appendChild(mpEscapeMenu.element);

  // Debug HUD (toggle with L key)
  mpDebugHUD = new DebugHUD(true);
  document.body.appendChild(mpDebugHUD.element);

  // Targeting and auto-attack are handled inside ClientEngine via InputManager
  // (same polling approach as playground mode — no DOM event handlers needed)
  clientEngine.onTargetChanged = (entityId) => {
    mpSelectedTargetId = entityId;
  };

  // Start UI update loop
  let lastMpFrameTime = performance.now();
  function mpUpdateFrames(): void {
    mpFrameLoopId = requestAnimationFrame(mpUpdateFrames);
    const now = performance.now();
    // Throttle to ~10 FPS when tab is visible but not focused
    const focused = document.hasFocus();
    if (!focused && now - lastMpFrameTime < 100) return;
    const dt = Math.min((now - lastMpFrameTime) / 1000, focused ? 0.1 : 0.2);
    lastMpFrameTime = now;

    if (!clientEngine) return;

    // Player frame — PlayerController implements Targetable directly
    if (mpPlayerFrame) {
      const pBuffs = clientEngine.getLocalBuffs();
      const pBuffList = pBuffs.filter(b => b.type === 'buff').map(b => ({
        definition: { id: b.id, name: b.name, icon: b.icon, duration: b.duration, type: b.type as 'buff', description: b.description, effects: [], unremovable: b.unremovable },
        remaining: b.remaining,
        shieldRemaining: b.shieldRemaining,
        appliedAt: Date.now(),
        stacks: b.stacks,
      }));
      const pDebuffList = pBuffs.filter(b => b.type === 'debuff').map(b => ({
        definition: { id: b.id, name: b.name, icon: b.icon, duration: b.duration, type: b.type as 'debuff', description: b.description, effects: [] },
        remaining: b.remaining,
        appliedAt: Date.now(),
        stacks: b.stacks,
      }));
      mpPlayerFrame.update(player, pBuffList, pDebuffList);
    }

    // Target frame
    if (mpSelectedTargetId && mpTargetFrame) {
      const targetTarget = makeTargetable(mpSelectedTargetId);
      if (targetTarget) {
        // Use local buffs when targeting self, remote entity buffs otherwise
        const isSelf = mpSelectedTargetId === clientEngine.localId;
        const rawBuffs = isSelf ? clientEngine.getLocalBuffs() : (clientEngine.getRemoteEntity(mpSelectedTargetId)?.buffs ?? []);
        const tBuffs = rawBuffs.filter(b => b.type === 'buff').map(b => ({
          definition: { id: b.id, name: b.name, icon: b.icon, duration: b.duration, type: b.type as 'buff', description: b.description, effects: [] },
          remaining: b.remaining,
          shieldRemaining: b.shieldRemaining,
          appliedAt: Date.now(),
          stacks: b.stacks,
        }));
        const tDebuffs = rawBuffs.filter(b => b.type === 'debuff').map(b => ({
          definition: { id: b.id, name: b.name, icon: b.icon, duration: b.duration, type: b.type as 'debuff', description: b.description, effects: [] },
          remaining: b.remaining,
          appliedAt: Date.now(),
          stacks: b.stacks,
        }));
        mpTargetFrame.update(targetTarget, tBuffs, tDebuffs);
      } else {
        mpTargetFrame.update(null);
      }
    } else if (mpTargetFrame) {
      mpTargetFrame.update(null);
    }

    // Target of Target frame (hidden when target is self — already shown in player frame)
    if (mpToTFrame) {
      let totTargetable: Targetable | null = null;
      if (mpSelectedTargetId && mpSelectedTargetId !== clientEngine.localId) {
        const totId = clientEngine.getRemoteEntity(mpSelectedTargetId)?.targetEntityId ?? null;
        // Don't expose invisible enemies via ToT
        if (totId && !clientEngine.isEntityInvisibleToLocal(totId)) totTargetable = makeTargetable(totId);
      }
      mpToTFrame.update(totTargetable);
    }

    // Arena frames (opponent frames on right side)
    if (mpArenaFrames) {
      const inPrep = clientEngine.getLocalBuffs().some(b => b.id === 'arena-preparation');
      mpArenaFrames.setVisible(true);
      mpArenaFrames.setDisabled(inPrep);
      mpArenaFrames.setSelectedTarget(mpSelectedTargetId);
      mpArenaFrames.update(dt, (entityId) => {
        const e = clientEngine!.getRemoteEntity(entityId);
        if (!e?.drTimers) return [];
        return e.drTimers.map(dr => ({
          icon: dr.icon,
          count: dr.count,
          remaining: dr.remaining,
          total: dr.total,
        }));
      }, (entityId) => clientEngine!.isEntityInvisibleToLocal(entityId));
    }

    // Party frames (friendly team members on left side)
    if (mpPartyFrames) {
      const inPrep = clientEngine.getLocalBuffs().some(b => b.id === 'arena-preparation');
      mpPartyFrames.setVisible(true);
      mpPartyFrames.setDisabled(inPrep);
      mpPartyFrames.setSelectedTarget(mpSelectedTargetId);
      mpPartyFrames.update(dt, (entityId) => {
        const e = clientEngine!.getRemoteEntity(entityId);
        if (!e?.buffs) return [];
        return e.buffs.filter(b => b.type === 'debuff').map(b => ({
          definition: { id: b.id, name: b.name, icon: b.icon, duration: b.duration, type: b.type as 'debuff', description: b.description, effects: [] },
          remaining: b.remaining,
          appliedAt: Date.now(),
          stacks: b.stacks,
        }));
      });
    }

    mpPlayerFrame?.updateCombatText(dt);
    mpTargetFrame?.updateCombatText(dt);
    mpActionBar?.update();
    mpCombatText?.update(dt);
    if (mpDebugHUD) {
      mpDebugHUD.update(dt);
      mpDebugHUD.pushLatency(clientEngine.latency);
    }

    // Nameplates: local player + remote entities
    if (mpNameplates) {
      const remotes = clientEngine.getAllRemoteEntities();
      const debuffMap = new Map<Targetable, { icon: string; remaining: number; duration: number }[]>();
      const npcsTargetable: Targetable[] = [];
      for (const e of remotes) {
        const t = e.targetable;
        if (t) {
          // Hide nameplates for hostile entities that are invisible (dumpster-diving)
          if (clientEngine.isEntityInvisibleToLocal(e.id)) continue;
          npcsTargetable.push(t);
          const debuffs = e.buffs.filter(b => b.type === 'debuff');
          if (debuffs.length > 0) {
            debuffMap.set(t, debuffs.map(b => ({ icon: b.icon, remaining: b.remaining, duration: b.duration })));
          }
        }
      }
      const isBlinded = clientEngine.getLocalBuffs().some(b => b.id === 'blinded');
      mpNameplates.update(player, npcsTargetable, (target) => debuffMap.get(target) ?? [], isBlinded);
    }

    // Unit tooltip (hover)
    if (mpUnitTooltip) {
      const hovered = clientEngine.targetingSystem.getHoveredTarget();
      mpUnitTooltip.update(hovered, (entity) => {
        // Resolve the hovered entity's target to a name
        let targetId: string | null = null;
        if (entity === (player as unknown as Targetable)) {
          targetId = clientEngine!.selectedTargetId;
        } else {
          for (const e of clientEngine!.getAllRemoteEntities()) {
            if (e.targetable === entity) { targetId = e.targetEntityId; break; }
          }
        }
        if (!targetId) return 'None';
        const targetEntity = clientEngine!.getEntity(targetId);
        return targetEntity ? targetEntity.name : 'None';
      }, dt);
    }

    // Cast bar
    const castState = clientEngine.getLocalCastingState();
    if (castState && mpCastBarContainer && mpCastBarFill && mpCastBarHeader) {
      mpCastBarContainer.style.display = 'block';
      let progress: number;
      if (castState.isChannel) {
        progress = Math.max(0, (castState.totalTime - castState.elapsed) / castState.totalTime);
        mpCastBarFill.style.background = 'linear-gradient(to right, #cc8833, #eebb55)';
      } else {
        progress = Math.min(1, castState.elapsed / castState.totalTime);
        mpCastBarFill.style.background = 'linear-gradient(to right, #4488ff, #66aaff)';
      }
      mpCastBarFill.style.width = `${progress * 100}%`;
      const remaining = Math.max(0, castState.totalTime - castState.elapsed);
      const ab = abilities.find(a => a !== null && a.id === castState.abilityId);
      mpCastBarHeader.innerHTML = `<span>${ab?.name ?? castState.abilityId}</span><span>${remaining.toFixed(1)}s</span>`;
    } else if (mpCastBarContainer) {
      mpCastBarContainer.style.display = 'none';
    }

    // Death frame
    if (mpDeathFrame) {
      if (player.dead && !mpDeathFrame.visible) mpDeathFrame.show();
      else if (!player.dead && mpDeathFrame.visible) mpDeathFrame.hide();
    }
  }
  mpUpdateFrames();
}

// ── Server Message Handler ─────────────────────────────────────────────

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'auth_result':
      if (msg.success) {
        localUserId = msg.userId;
        isAdmin = msg.isAdmin ?? false;
        localXp = msg.xp ?? 0;
        // Update stored username to the original registered casing from the server
        if (msg.username) {
          sessionStorage.setItem('gtr_username', msg.username);
          localStorage.setItem('gtr_last_username', msg.username);
        }
        authScreen?.destroy();
        authScreen = null;
        if (currentState === 'multiplayer') {
          // Reconnecting mid-game — don't flash lobby, wait for server
          // to send rejoin_game (back to game) or lobby_state (to lobby)
          awaitingReconnectResult = true;
        } else {
          showLobby();
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
        network?.disconnect();
        network = null;
        sessionStorage.removeItem('gtr_password');
        if (authScreen) {
          // Already on the auth screen — just show the error without rebuilding
          authScreen.showError(errorMsg);
        } else {
          // Re-auth failed (auto-login or reconnect) — rebuild the auth screen
          showAuth();
          setTimeout(() => authScreen?.showError(errorMsg), 0);
        }
      }
      break;

    case 'lobby_state':
      if (awaitingReconnectResult) {
        // Server didn't send rejoin_game — no game to rejoin.
        // Always transition to lobby (update snackbar will show there if needed).
        awaitingReconnectResult = false;
        updateCheckPromise = null;
        showLobby();
      }
      lobbyScreen?.updateUsers(msg.users);
      lobbyScreen?.updateGames(msg.games);
      break;

    case 'lobby_chat':
      lobbyScreen?.addChatMessage(msg.username, msg.message, msg.isAnnouncement);
      break;

    case 'game_chat':
      mpChatWindow?.addMessage(msg.username, msg.message);
      break;

    case 'user_profile':
      if (msg.broadcast) {
        lobbyScreen?.updateOpenProfileDialog(msg.profile);
      } else {
        lobbyScreen?.showProfileDialog(msg.profile);
      }
      break;

    case 'leaderboard':
      lobbyScreen?.showLeaderboard(msg.entries);
      break;

    case 'xp_update': {
      const oldXp = localXp;
      localXp = msg.xp;
      if (msg.adminSet) {
        // Admin-set XP: just update display, no animation or congrats
        if (lobbyScreen) lobbyScreen.updateXp(msg.xp);
      } else if (lobbyScreen) {
        lobbyScreen.updateXp(msg.xp, oldXp);
      } else if (xpToLevel(msg.xp) > xpToLevel(oldXp)) {
        // Lobby not visible yet (e.g. game over screen) — remember for when it opens
        pendingLevelUpFrom = oldXp;
      }
      break;
    }

    case 'game_lobby_state':
      if (currentState !== 'game-lobby') showGameLobby();
      gameLobbyScreen?.update({
        format: msg.format,
        mapName: msg.mapName,
        hostUserId: msg.hostUserId,
        players: msg.players,
      });
      break;

    case 'game_start':
      startMultiplayer(msg);
      break;

    case 'game_state':
      clientEngine?.handleGameState(msg);
      break;

    case 'game_state_update':
      clientEngine?.handleGameStateUpdate(msg);
      break;

    case 'game_state_snapshot':
      clientEngine?.handleGameStateSnapshot(msg);
      break;

    case 'combat_event':
      clientEngine?.handleCombatEvent(msg);
      break;

    case 'flinch':
      clientEngine?.handleFlinch(msg);
      break;

    case 'ability_effect':
      clientEngine?.handleAbilityEffect(msg);
      break;

    case 'auto_attack_swing':
      clientEngine?.handleAutoAttackSwing(msg);
      break;

    case 'cooldown_update':
      clientEngine?.handleCooldownUpdate(msg);
      break;

    case 'gas_cloud_spawn':
      clientEngine?.handleGasCloudSpawn(msg);
      break;

    case 'chem_pool_spawn':
      clientEngine?.handleChemPoolSpawn(msg);
      break;

    case 'knockback':
      clientEngine?.handleKnockback(msg);
      break;

    case 'entity_died':
      clientEngine?.handleEntityDied(msg);
      break;

    case 'force_clear_target':
      clientEngine?.handleForceClearTarget();
      break;

    case 'position_correction':
      clientEngine?.handlePositionCorrection(msg);
      break;

    case 'position_relay':
      clientEngine?.handlePositionRelay(msg);
      break;

    case 'position_update':
      clientEngine?.handlePositionUpdate(msg);
      break;

    case 'countdown_start':
      // Server confirmed all clients are ready — reset the arena timer so
      // everyone's countdown is synchronized regardless of load time.
      if (clientEngine) {
        clientEngine.mapManager.resetTimer();
      }
      break;

    case 'gate_vote_update':
      if (clientEngine) {
        clientEngine.mapManager.updateGateVotes(msg.voteCount, msg.totalPlayers);
        if (msg.voteCount >= msg.totalPlayers) {
          clientEngine.mapManager.forceOpenDoors();
        }
      }
      break;

    case 'game_over':
      showGameOver(msg.winningTeam, msg.allPlayersPresent, msg.playerResults);
      clientEngine?.mapManager.onGameOver(msg.winningTeam);
      break;

    case 'rematch_challenge':
      showRematchChallenge(msg.challengerUsername, msg.mapMode, msg.totalPlayers, msg.readyCount);
      break;

    case 'rematch_ready_update':
      updateRematchReady(msg.readyCount, msg.totalPlayers);
      break;

    case 'rematch_failed':
      handleRematchFailed(msg.reason);
      break;

    case 'game_cancelled':
      showLobby();
      break;

    case 'admin_users_list':
      adminScreen?.updateUsers(msg.users);
      break;

    case 'admin_result':
      if (msg.action === 'reset_password' && msg.success && msg.generatedPassword) {
        adminScreen?.showResetPasswordResult(msg.generatedPassword);
      } else if (!msg.success) {
        console.warn('Admin action failed:', msg.error);
      }
      break;

    case 'change_password_result':
      lobbyScreen?.showChangePasswordResult(msg.success, msg.error);
      break;

    case 'god_mode_update':
      clientEngine?.handleGodModeUpdate(msg.entityId, msg.active);
      break;

    case 'kicked':
      network?.disconnect();
      network = null;
      localUserId = '';
      isAdmin = false;
      localXp = 0;
      sessionStorage.removeItem('gtr_username');
      sessionStorage.removeItem('gtr_password');
      showAuth();
      // Show the reason on the auth screen after it renders
      setTimeout(() => authScreen?.showError(msg.reason), 0);
      break;

    case 'error':
      if (currentState === 'multiplayer') {
        clientEngine?.revertPrediction();
        mpErrorText?.show(msg.message);
      } else {
        console.warn('Server error:', msg.message);
      }
      break;

    case 'rejoin_game':
      awaitingReconnectResult = false;
      updateCheckPromise = null;
      startMultiplayerRejoin(msg);
      break;

    case 'player_disconnected':
      clientEngine?.handlePlayerDisconnected(msg.entityId);
      mpErrorText?.show(`${msg.username} disconnected`, 3000);
      break;

    case 'player_reconnected':
      clientEngine?.handlePlayerReconnected(msg.entityId);
      mpErrorText?.show(`${msg.username} reconnected`, 3000);
      break;

    case 'entity_removed':
      clientEngine?.handleEntityRemoved(msg.entityId);
      mpArenaFrames?.removeEntity(msg.entityId);
      mpPartyFrames?.removeEntity(msg.entityId);
      if (msg.username) {
        mpErrorText?.show(`${msg.username} has left the game`, 3000);
      }
      break;
  }
}

// ── Rematch state ──────────────────────────────────────────────────────
let rematchOverlay: HTMLDivElement | null = null;
let rematchReadyText: HTMLDivElement | null = null;
let gameOverBox: HTMLDivElement | null = null;
let rematchMapMode: 'random' | 'same' | 'new' = 'random';

const btnStyle = `
  padding: 12px 32px; font-size: 15px; font-weight: bold;
  background: rgba(40, 80, 160, 0.8); color: #ddd;
  border: 1px solid rgba(100, 140, 255, 0.3); border-radius: 4px;
  cursor: pointer; outline: none;
`;

function showGameOver(winningTeam: number, allPlayersPresent: boolean, playerResults: PlayerMatchResult[]): void {
  if (!clientEngine) return;
  mpGameOver = true;
  const won = clientEngine.playerController.team === winningTeam;

  mpGameOverScreen = document.createElement('div');
  mpGameOverScreen.style.cssText = `
    position: fixed; inset: 0; z-index: 900;
    display: flex; align-items: center; justify-content: center;
    pointer-events: none;
  `;

  gameOverBox = document.createElement('div');
  gameOverBox.style.cssText = `
    background: linear-gradient(to bottom, rgba(20, 20, 35, 0.95), rgba(10, 10, 20, 0.95));
    border: 1px solid ${won ? 'rgba(80, 200, 100, 0.5)' : 'rgba(200, 80, 80, 0.5)'};
    border-radius: 8px; padding: 30px 36px; text-align: center;
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    min-width: 560px; pointer-events: auto; position: relative;
  `;

  const dismissBtn = document.createElement('button');
  dismissBtn.textContent = '\u00d7';
  dismissBtn.style.cssText = `
    position: absolute; top: 8px; right: 12px; background: none; border: none;
    color: #888; font-size: 24px; cursor: pointer; outline: none; padding: 4px 8px;
    line-height: 1;
  `;
  dismissBtn.addEventListener('mouseenter', () => { dismissBtn.style.color = '#fff'; });
  dismissBtn.addEventListener('mouseleave', () => { dismissBtn.style.color = '#888'; });
  dismissBtn.addEventListener('click', () => {
    mpGameOverScreen?.remove();
    mpGameOverScreen = null;
    gameOverBox = null;
  });
  gameOverBox.appendChild(dismissBtn);

  const title = document.createElement('div');
  title.textContent = won ? 'Victory!' : 'Defeat';
  title.style.cssText = `color: ${won ? '#44cc44' : '#cc4444'}; font-size: 32px; font-weight: bold; margin-bottom: 20px;`;
  gameOverBox.appendChild(title);

  // ── Scoreboard table ──────────────────────────────────────────────
  const getCharName = (charId: string) => CHARACTER_LIST.find(c => c.id === charId)?.name ?? charId;
  const formatNum = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  // Sort: winning team first, then by damage within each team
  const winners = playerResults.filter(p => p.team === winningTeam).sort((a, b) => b.stats.damageDealt - a.stats.damageDealt);
  const losers = playerResults.filter(p => p.team !== winningTeam).sort((a, b) => b.stats.damageDealt - a.stats.damageDealt);

  const headerCellStyle = `
    padding: 6px 12px; font-size: 11px; font-weight: bold; text-transform: uppercase;
    color: #888; letter-spacing: 0.5px; border-bottom: 1px solid rgba(255,255,255,0.1);
    white-space: nowrap;
  `;
  const cellStyle = `padding: 7px 12px; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,0.05); white-space: nowrap;`;
  const numCellStyle = `${cellStyle} text-align: right; font-variant-numeric: tabular-nums;`;

  const table = document.createElement('table');
  table.style.cssText = 'width: 100%; border-collapse: collapse; margin-bottom: 20px;';

  // Header row
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th style="${headerCellStyle} text-align: left;">Player</th>
    <th style="${headerCellStyle} text-align: right;">Lvl</th>
    <th style="${headerCellStyle} text-align: right;">KB</th>
    <th style="${headerCellStyle} text-align: right;">Deaths</th>
    <th style="${headerCellStyle} text-align: right;">Damage</th>
    <th style="${headerCellStyle} text-align: right;">Healing</th>
    <th style="${headerCellStyle} text-align: right;">XP</th>
  </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  const renderTeamRows = (players: PlayerMatchResult[], isWinningTeam: boolean) => {
    if (players.length === 0) return;

    // Team divider
    const divider = document.createElement('tr');
    const divCell = document.createElement('td');
    divCell.colSpan = 7;
    divCell.style.cssText = `
      padding: 6px 12px 4px; font-size: 11px; font-weight: bold; text-transform: uppercase;
      color: ${isWinningTeam ? '#5a5' : '#a55'}; letter-spacing: 0.5px;
      border-bottom: 1px solid ${isWinningTeam ? 'rgba(80,200,100,0.2)' : 'rgba(200,80,80,0.2)'};
      text-align: left;
    `;
    divCell.textContent = isWinningTeam ? 'Winners' : 'Losers';
    divider.appendChild(divCell);
    tbody.appendChild(divider);

    for (const p of players) {
      const row = document.createElement('tr');
      const rowBg = isWinningTeam ? 'rgba(40, 80, 40, 0.15)' : 'rgba(80, 40, 40, 0.15)';
      row.style.cssText = `background: ${rowBg};`;

      // Player name + character
      const nameCell = document.createElement('td');
      nameCell.style.cssText = `${cellStyle} text-align: left;`;
      nameCell.innerHTML = `<span style="color: #eee; font-weight: bold;">${p.username}</span>` +
        `<span style="color: #777; font-size: 11px; margin-left: 6px;">${getCharName(p.characterId)}</span>`;
      row.appendChild(nameCell);

      // Level
      const lvlCell = document.createElement('td');
      lvlCell.style.cssText = numCellStyle;
      lvlCell.style.color = '#ccc';
      lvlCell.textContent = String(p.level);
      row.appendChild(lvlCell);

      // Killing Blows
      const kbCell = document.createElement('td');
      kbCell.style.cssText = numCellStyle;
      kbCell.style.color = p.stats.kills > 0 ? '#e8c35a' : '#666';
      kbCell.textContent = String(p.stats.kills);
      row.appendChild(kbCell);

      // Deaths
      const deathCell = document.createElement('td');
      deathCell.style.cssText = numCellStyle;
      deathCell.style.color = p.stats.deaths > 0 ? '#c44' : '#666';
      deathCell.textContent = String(p.stats.deaths);
      row.appendChild(deathCell);

      // Damage
      const dmgCell = document.createElement('td');
      dmgCell.style.cssText = numCellStyle;
      dmgCell.style.color = '#e07040';
      dmgCell.textContent = formatNum(p.stats.damageDealt);
      row.appendChild(dmgCell);

      // Healing
      const healCell = document.createElement('td');
      healCell.style.cssText = numCellStyle;
      healCell.style.color = p.stats.healingDone > 0 ? '#44cc44' : '#666';
      healCell.textContent = formatNum(p.stats.healingDone);
      row.appendChild(healCell);

      // XP Earned
      const xpCell = document.createElement('td');
      xpCell.style.cssText = numCellStyle;
      xpCell.style.color = '#b080e0';
      xpCell.textContent = `+${formatNum(p.xpGained)}`;
      row.appendChild(xpCell);

      tbody.appendChild(row);
    }
  };

  renderTeamRows(winners, true);
  renderTeamRows(losers, false);
  table.appendChild(tbody);
  gameOverBox.appendChild(table);

  // ── Buttons ───────────────────────────────────────────────────────

  // Rematch section (only if all players are still present)
  if (allPlayersPresent) {
    const rematchSection = document.createElement('div');
    rematchSection.style.cssText = 'margin-bottom: 12px;';

    // Map mode toggle
    const mapModeRow = document.createElement('div');
    mapModeRow.style.cssText = 'display: flex; gap: 8px; justify-content: center; margin-bottom: 10px;';

    const toggleBtnStyle = (active: boolean) => `
      padding: 8px 18px; font-size: 13px; font-weight: bold;
      background: ${active ? 'rgba(60, 120, 200, 0.9)' : 'rgba(40, 40, 60, 0.6)'};
      color: ${active ? '#fff' : '#888'};
      border: 1px solid ${active ? 'rgba(100, 160, 255, 0.5)' : 'rgba(80, 80, 100, 0.3)'};
      border-radius: 4px; cursor: pointer; outline: none; transition: all 0.15s;
    `;

    const randomBtn = document.createElement('button');
    randomBtn.textContent = 'Random Map';
    randomBtn.style.cssText = toggleBtnStyle(true);
    rematchMapMode = 'random';

    const sameBtn = document.createElement('button');
    sameBtn.textContent = 'Same Map';
    sameBtn.style.cssText = toggleBtnStyle(false);

    const newBtn = document.createElement('button');
    newBtn.textContent = 'New Map';
    newBtn.style.cssText = toggleBtnStyle(false);

    const updateToggle = (mode: 'random' | 'same' | 'new') => {
      rematchMapMode = mode;
      randomBtn.style.cssText = toggleBtnStyle(mode === 'random');
      sameBtn.style.cssText = toggleBtnStyle(mode === 'same');
      newBtn.style.cssText = toggleBtnStyle(mode === 'new');
    };

    randomBtn.addEventListener('click', () => updateToggle('random'));
    sameBtn.addEventListener('click', () => updateToggle('same'));
    newBtn.addEventListener('click', () => updateToggle('new'));

    mapModeRow.appendChild(randomBtn);
    mapModeRow.appendChild(sameBtn);
    mapModeRow.appendChild(newBtn);
    rematchSection.appendChild(mapModeRow);

    const rematchBtn = document.createElement('button');
    rematchBtn.textContent = 'Rematch';
    rematchBtn.style.cssText = `
      padding: 12px 32px; font-size: 15px; font-weight: bold;
      background: rgba(40, 160, 80, 0.8); color: #ddd;
      border: 1px solid rgba(80, 200, 120, 0.4); border-radius: 4px;
      cursor: pointer; outline: none; width: 100%;
    `;
    rematchBtn.addEventListener('click', () => {
      network?.send({ type: 'request_rematch', mapMode: rematchMapMode });
    });
    rematchSection.appendChild(rematchBtn);

    gameOverBox.appendChild(rematchSection);
  }

  // Exit to lobby button
  const lobbyBtn = document.createElement('button');
  lobbyBtn.textContent = 'Exit Game';
  lobbyBtn.style.cssText = btnStyle;
  lobbyBtn.addEventListener('click', () => {
    showLobby();
    network?.send({ type: 'return_to_lobby' });
  });
  gameOverBox.appendChild(lobbyBtn);

  mpGameOverScreen.appendChild(gameOverBox);
  document.body.appendChild(mpGameOverScreen);
}

function showRematchChallenge(challengerUsername: string, mapMode: 'random' | 'same' | 'new', totalPlayers: number, readyCount: number): void {
  clearRematchOverlay();

  rematchOverlay = document.createElement('div');
  rematchOverlay.style.cssText = `
    position: fixed; inset: 0; z-index: 950;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.5); pointer-events: auto;
  `;

  const box = document.createElement('div');
  box.style.cssText = `
    background: linear-gradient(to bottom, rgba(20, 20, 40, 0.97), rgba(10, 10, 25, 0.97));
    border: 1px solid rgba(100, 140, 220, 0.3);
    border-radius: 8px; padding: 32px 40px; text-align: center;
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    min-width: 300px;
  `;

  const heading = document.createElement('div');
  heading.textContent = 'Rematch Challenge';
  heading.style.cssText = 'color: #ccd; font-size: 22px; font-weight: bold; margin-bottom: 12px;';

  const desc = document.createElement('div');
  const modeLabel = mapMode === 'random' ? 'Random Map' : mapMode === 'same' ? 'Same Map' : 'New Map';
  desc.textContent = `${challengerUsername} wants a rematch (${modeLabel})`;
  desc.style.cssText = 'color: #99a; font-size: 14px; margin-bottom: 16px;';

  rematchReadyText = document.createElement('div');
  rematchReadyText.textContent = `${readyCount} / ${totalPlayers} ready`;
  rematchReadyText.style.cssText = 'color: #8cf; font-size: 16px; font-weight: bold; margin-bottom: 20px;';

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display: flex; gap: 12px; justify-content: center;';

  const acceptBtn = document.createElement('button');
  acceptBtn.textContent = 'Accept';
  acceptBtn.style.cssText = `
    padding: 10px 28px; font-size: 15px; font-weight: bold;
    background: rgba(40, 160, 80, 0.8); color: #ddd;
    border: 1px solid rgba(80, 200, 120, 0.4); border-radius: 4px;
    cursor: pointer; outline: none;
  `;
  acceptBtn.addEventListener('click', () => {
    network?.send({ type: 'accept_rematch' });
    acceptBtn.disabled = true;
    acceptBtn.style.opacity = '0.5';
    declineBtn.disabled = true;
    declineBtn.style.opacity = '0.5';
  });

  const declineBtn = document.createElement('button');
  declineBtn.textContent = 'Decline';
  declineBtn.style.cssText = `
    padding: 10px 28px; font-size: 15px; font-weight: bold;
    background: rgba(160, 50, 50, 0.8); color: #ddd;
    border: 1px solid rgba(200, 80, 80, 0.4); border-radius: 4px;
    cursor: pointer; outline: none;
  `;
  declineBtn.addEventListener('click', () => {
    network?.send({ type: 'decline_rematch' });
  });

  btnRow.appendChild(acceptBtn);
  btnRow.appendChild(declineBtn);

  box.appendChild(heading);
  box.appendChild(desc);
  box.appendChild(rematchReadyText);
  box.appendChild(btnRow);
  rematchOverlay.appendChild(box);
  document.body.appendChild(rematchOverlay);
}

function showRematchReadyCheck(readyCount: number, totalPlayers: number): void {
  clearRematchOverlay();

  rematchOverlay = document.createElement('div');
  rematchOverlay.style.cssText = `
    position: fixed; inset: 0; z-index: 950;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.5); pointer-events: auto;
  `;

  const box = document.createElement('div');
  box.style.cssText = `
    background: linear-gradient(to bottom, rgba(20, 20, 40, 0.97), rgba(10, 10, 25, 0.97));
    border: 1px solid rgba(100, 140, 220, 0.3);
    border-radius: 8px; padding: 32px 40px; text-align: center;
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    min-width: 280px;
  `;

  const heading = document.createElement('div');
  heading.textContent = 'Waiting for players...';
  heading.style.cssText = 'color: #ccd; font-size: 20px; font-weight: bold; margin-bottom: 16px;';

  rematchReadyText = document.createElement('div');
  rematchReadyText.textContent = `${readyCount} / ${totalPlayers} ready`;
  rematchReadyText.style.cssText = 'color: #8cf; font-size: 18px; font-weight: bold;';

  box.appendChild(heading);
  box.appendChild(rematchReadyText);
  rematchOverlay.appendChild(box);
  document.body.appendChild(rematchOverlay);
}

function updateRematchReady(readyCount: number, totalPlayers: number): void {
  // If we have the challenge overlay open (other player), update the text
  if (rematchReadyText) {
    rematchReadyText.textContent = `${readyCount} / ${totalPlayers} ready`;
    return;
  }
  // Otherwise we're the requester — show the ready check overlay
  showRematchReadyCheck(readyCount, totalPlayers);
}

function handleRematchFailed(reason: string): void {
  clearRematchOverlay();

  // Show a brief failure message in a temporary overlay
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 950;
    display: flex; align-items: center; justify-content: center;
    pointer-events: none;
  `;

  const box = document.createElement('div');
  box.style.cssText = `
    background: linear-gradient(to bottom, rgba(30, 15, 15, 0.95), rgba(15, 10, 10, 0.95));
    border: 1px solid rgba(200, 80, 80, 0.4);
    border-radius: 8px; padding: 24px 36px; text-align: center;
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  `;

  const text = document.createElement('div');
  text.textContent = reason;
  text.style.cssText = 'color: #e88; font-size: 16px; font-weight: bold;';

  box.appendChild(text);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  setTimeout(() => overlay.remove(), 3000);
}

function clearRematchOverlay(): void {
  rematchOverlay?.remove();
  rematchOverlay = null;
  rematchReadyText = null;
}

// ── Playground Mode ────────────────────────────────────────────────────

async function startPlayground(): Promise<void> {
  lobbyMusic.fadeOut();
  cleanupCurrentState();
  currentState = 'playground';

  // Show all game UI elements
  const uiOverlay = document.getElementById('ui-overlay');
  if (uiOverlay) uiOverlay.style.display = '';
  canvas.style.display = 'block';

  // Dynamically import the playground to avoid loading Engine in MP mode
  const { Engine } = await import('./engine/Engine');
  const { DebugPanel } = await import('./ui/DebugPanel');
  const { MapSelector } = await import('./ui/MapSelector');
  const { CharacterSelector } = await import('./ui/CharacterSelector');
  const { NpcSpawner } = await import('./ui/NpcSpawner');
  const { DebugStun, DiscombobulateDebuff, FartBombDebuff, ChemicalSpillSpeedBuff, ChemicalSpillDot, CrotchRotDot, ParanoidDebuff, yardsToUnits } = await import('./engine/combat/Ability');

  const engine = new Engine(canvas);
  engine.isAdmin = isAdmin;
  const savedUsername = sessionStorage.getItem('gtr_username');
  if (savedUsername) engine.playerController.name = savedUsername;
  pgEngine = engine;

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

  // Unit frames
  const setTarget = (t: Targetable) => { engine.targetingSystem.currentTarget = t; };
  const playerFrame = new UnitFrame({
    getPortrait,
    onClick: setTarget,
    hideCastBar: true,
    onBuffRightClick: (buffId) => {
      engine.buffSystem.remove(engine.playerController, buffId);
    },
  });
  pgPlayerFrame = playerFrame;
  const targetFrame = new UnitFrame({ localPlayer: engine.playerController, getPortrait, onClick: setTarget });
  pgTargetFrame = targetFrame;
  const totFrame = new TargetOfTargetFrame({ localPlayer: engine.playerController, getPortrait, onClick: setTarget });
  pgToTFrame = totFrame;

  // Register frames with positioner for drag-to-reposition
  pgPositioner = new UnitFramePositioner();
  document.body.appendChild(pgPositioner.register('player', playerFrame.element, { top: 12, left: 12 }));
  document.body.appendChild(pgPositioner.register('target', targetFrame.element, { top: 12, left: 280 }));
  document.body.appendChild(pgPositioner.register('tot', totFrame.element, { top: 51, left: 544 }));

  const errorText = new ErrorText();
  pgErrorText = errorText;
  document.body.appendChild(errorText.element);
  const combatText = new FloatingCombatText(engine.camera);
  pgCombatText = combatText;
  document.body.appendChild(combatText.element);
  const nameplates = new Nameplates(
    engine.camera, engine.scene,
    (target) => { engine.targetingSystem.currentTarget = target; },
    (target) => { engine.targetingSystem.setNameplateHover(target); },
    (target) => {
      engine.targetingSystem.currentTarget = target;
      if (target.isHostileTo(engine.playerController) && !target.dead) {
        engine.startAutoAttack(target);
      }
    },
  );
  pgNameplates = nameplates;
  document.body.appendChild(nameplates.element);

  // Unit tooltip (bottom-right, on hover)
  const unitTooltip = new UnitTooltip(engine.playerController);
  pgUnitTooltip = unitTooltip;
  document.body.appendChild(unitTooltip.element);

  engine.combatSystem.onCombatText = (target, amount, type) => {
    const isIncoming = target === engine.playerController;
    combatText.spawn(target.mesh, amount, type, isIncoming);
    if (isIncoming) playerFrame.showCombatText(amount, type);
    else if (target === engine.targetingSystem.currentTarget) targetFrame.showCombatText(amount, type);
  };

  engine.combatSystem.onEnterCombat = (entity) => {
    if (entity === engine.playerController) {
      combatText.spawnText(entity.mesh, '+Combat', '#cc3333', true);
    }
  };
  engine.combatSystem.onLeaveCombat = (entity) => {
    if (entity === engine.playerController) {
      combatText.spawnText(entity.mesh, '-Combat', '#33cc33', true);
    }
  };

  engine.buffSystem.onBuffApplied = (target, definition) => {
    if (target === engine.playerController) {
      const color = definition.type === 'buff' ? '#3388ff' : '#ff6644';
      combatText.spawnText(target.mesh, `+${definition.name}`, color, true);
      if (definition.id === 'dumpster-diving') engine.saveDumpsterDiveAutoTarget();
    }
  };
  engine.buffSystem.onBuffExpired = (target, definition) => {
    if (target === engine.playerController) {
      combatText.spawnText(target.mesh, `-${definition.name}`, '#888888', true);
    }
    engine.handleBuffExpired(target, definition);
  };
  engine.buffSystem.onStacksChanged = (target, buffId, oldStacks, newStacks) => {
    if (buffId === 'tweaking' && target === engine.playerController) {
      const delta = newStacks - oldStacks;
      const text = delta > 0 ? `+${delta} Tweaking` : `${delta} Tweaking`;
      const color = delta > 0 ? '#3388ff' : '#888888';
      combatText.spawnText(target.mesh, text, color, true);
    }
  };

  // Apply Arena Preparation now that SCT callbacks are wired
  engine.applyArenaPreparation();

  // Death frame
  pgDeathFrame = new DeathFrame();
  const respawnBtn = document.createElement('button');
  respawnBtn.textContent = 'Respawn';
  respawnBtn.style.cssText = 'margin-top: 12px; padding: 10px 32px; font-size: 15px; font-weight: bold; background: rgba(180,60,60,0.85); color: #eee; border: 1px solid #cc4444; border-radius: 4px; cursor: pointer; outline: none; pointer-events: auto;';
  respawnBtn.addEventListener('click', () => { engine.respawnPlayer(); pgDeathFrame?.hide(); });
  pgDeathFrame.element.querySelector('div')!.appendChild(respawnBtn);
  document.body.appendChild(pgDeathFrame.element);

  // Cast bar
  const castBarContainer = document.createElement('div');
  pgCastBarContainer = castBarContainer;
  castBarContainer.style.cssText = 'position: fixed; bottom: 84px; left: 50%; transform: translateX(-50%); width: 240px; z-index: 100; display: none;';
  const castBarHeader = document.createElement('div');
  castBarHeader.style.cssText = 'display: flex; justify-content: space-between; color: #ddd; font-size: 11px; font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif; margin-bottom: 2px; text-shadow: 1px 1px 2px rgba(0,0,0,0.9);';
  const castBarBg = document.createElement('div');
  castBarBg.style.cssText = 'height: 14px; background: rgba(0,0,0,0.7); border: 1px solid rgba(255,255,255,0.2); border-radius: 3px; overflow: hidden;';
  const castBarFill = document.createElement('div');
  castBarFill.style.cssText = 'height: 100%; background: linear-gradient(to right, #4488ff, #66aaff); width: 0%;';
  castBarBg.appendChild(castBarFill);
  castBarContainer.append(castBarHeader, castBarBg);
  document.body.appendChild(castBarContainer);

  // Helper: apply post-cast effects
  const MELEE_AUTO_ATTACK_ABILITIES = ['mop', 'big-boot', 'jimmy-legs', 'shank', 'gank'];

  // Ground targeting state
  let pendingGroundAbility: Ability | null = null;

  function cancelGroundTargeting(): void {
    if (!pendingGroundAbility && !engine.pendingNpcSpawn) return;
    pendingGroundAbility = null;
    engine.pendingNpcSpawn = null;
    engine.targetingSystem.cancelGroundTarget();
  }

  engine.onGroundTargetConfirmed = () => {
    // NPC spawn ground targeting
    if (engine.pendingNpcSpawn) {
      const { characterId, team } = engine.pendingNpcSpawn;
      const pos = engine.targetingSystem.getGroundTargetPosition();
      engine.targetingSystem.cancelGroundTarget();
      engine.pendingNpcSpawn = null;
      engine.spawnNpc(characterId, pos, team);
      return;
    }

    if (!pendingGroundAbility) return;
    const ability = pendingGroundAbility;
    const groundPos = engine.targetingSystem.getGroundTargetPosition();
    engine.targetingSystem.cancelGroundTarget();
    pendingGroundAbility = null;

    const result = engine.useGroundTargetAbility(ability, groundPos);
    if (result.success) {
      onAbilitySuccess(ability, groundPos);
    } else if (result.errorMessage) {
      errorText.show(result.errorMessage);
    }
  };

  function onAbilitySuccess(ability: Ability, groundPos?: import('three').Vector3): void {
    const targetPos = groundPos ?? engine.targetingSystem.currentTarget?.mesh.position.clone();
    engine.playerController.triggerAbilityAnimation(ability.id, targetPos);
    if (ability.id === 'crash-out') {
      const crashSfx = getCharacterSfx(engine.playerController.characterId)?.crashOut;
      if (crashSfx) soundEffects.play(crashSfx.url, undefined, undefined, crashSfx.volume);
    }
    if (ability.id === 'bucket-splash') {
      const splashSfx = getCharacterSfx(engine.playerController.characterId)?.bucketSplash;
      if (splashSfx) soundEffects.play(splashSfx.url, undefined, undefined, splashSfx.volume);
    }
    if (ability.id === 'fart-bomb') engine.spawnGasCloud(engine.playerController.mesh.position.clone(), yardsToUnits(5), 8, FartBombDebuff, 592, 2, engine.playerController);
    if (ability.id === 'sweep') engine.startSweepCharge();
    if (ability.id === 'kaboom') engine.executeKaboom();
    if (ability.id === 'chemical-spill') engine.spawnChemicalPool(engine.playerController.mesh.position.clone(), yardsToUnits(3), 30, ChemicalSpillSpeedBuff, ChemicalSpillDot, 297, 349, 600, 2, 6, engine.playerController, 2);
    if (ability.id === 'crotch-rot') {
      const target = engine.targetingSystem.currentTarget;
      if (target && !target.dead) {
        engine.spawnDot(target, CrotchRotDot, 12, 3, 720, engine.playerController);
      }
    }
    if (ability.id === 'shank' || ability.id === 'pocket-sand' || ability.id === 'sticky-fingers' || ability.id === 'dumpster-dive' || ability.id === 'tweaker-sprint' || ability.id === 'gank') {
      engine.buffSystem.addStacks(engine.playerController, 'tweaking', 15);
      if (engine.buffSystem.getStacks(engine.playerController, 'tweaking') >= 100 && !engine.buffSystem.hasDebuff(engine.playerController, 'paranoid')) {
        engine.buffSystem.apply(engine.playerController, ParanoidDebuff);
      }
    }
    if (ability.id === 'crack-rock') {
      engine.combatSystem.applyHeal(engine.playerController, 400);
      engine.buffSystem.addStacks(engine.playerController, 'tweaking', 25);
      if (engine.buffSystem.getStacks(engine.playerController, 'tweaking') >= 100 && !engine.buffSystem.hasDebuff(engine.playerController, 'paranoid')) {
        engine.buffSystem.apply(engine.playerController, ParanoidDebuff);
      }
    }
    if (ability.id === 'gank') {
      const target = engine.targetingSystem.currentTarget;
      if (target && (target.dead || target.hp / target.maxHp < 0.30)) {
        engine.combatSystem.clearCooldown('gank');
      }
    }
    if (ability.id === 'tweaker-sprint') {
      const target = engine.targetingSystem.currentTarget;
      if (target && !target.dead) {
        engine.startTweakerSprintCharge(target);
      }
    }
    if (ability.id === 'sticky-fingers') {
      const target = engine.targetingSystem.currentTarget;
      if (target) {
        const stealable = engine.buffSystem.getBuffs(target).filter(b => !b.definition.unremovable);
        if (stealable.length > 0) {
          const stolen = stealable[Math.floor(Math.random() * stealable.length)];
          const remainingTime = stolen.remaining;
          engine.buffSystem.remove(target, stolen.definition.id);
          engine.buffSystem.apply(engine.playerController, stolen.definition);
          engine.buffSystem.setRemaining(engine.playerController, stolen.definition.id, remainingTime);
        } else {
          const drain = Math.min(150, target.mana);
          target.mana -= drain;
          engine.playerController.mana = Math.min(engine.playerController.mana + 150, engine.playerController.maxMana);
          combatText.spawnText(engine.playerController.mesh, '+150 Mana', '#3388ff', true);
        }
      }
    }

    // Melee abilities automatically engage auto-attack on the target
    if (MELEE_AUTO_ATTACK_ABILITIES.includes(ability.id)) {
      const target = engine.targetingSystem.currentTarget;
      if (target && target.isHostileTo(engine.playerController) && !target.dead) {
        engine.startAutoAttack(target);
      }
    }
  }

  engine.onCastComplete = (ability) => onAbilitySuccess(ability);
  engine.onCastFailed = (message) => errorText.show(message);

  // Action bar
  const actionBar = new ActionBar({
    onActivate: (ability) => {
      // Attack toggle — bypass GCD/queue, just toggle auto-attack
      if (ability.isAutoAttack) {
        if (engine.isAutoAttackActive()) {
          engine.stopAutoAttack();
        } else {
          const target = engine.targetingSystem.currentTarget;
          if (target && target.isHostileTo(engine.playerController) && !target.dead) {
            if (engine.isResting()) engine.stopResting();
            engine.startAutoAttack(target);
          }
        }
        return;
      }

      if (engine.isResting()) engine.stopResting();
      if (engine.isChanneling() && engine.combatSystem.getCooldownRemaining(ability.id) <= 0) engine.cancelCasting();
      // Block during GCD (unless god mode or CC-immune ability)
      if (!engine.godMode && !ability.usableWhileCCd && engine.combatSystem.getGcdRemaining() > 0) return;
      // Ground-targeted abilities enter reticle mode instead of executing immediately
      if (ability.groundTargeted) {
        if (pendingGroundAbility?.id === ability.id) {
          cancelGroundTargeting();
        } else {
          // Don't enter ground targeting if on cooldown
          if (engine.combatSystem.getCooldownRemaining(ability.id) > 0) {
            errorText.show('Ability is not ready yet');
            return;
          }
          cancelGroundTargeting();
          pendingGroundAbility = ability;
          engine.targetingSystem.startGroundTarget(ability.aoeRadius ?? 1, ability.range ?? 10);
        }
        return;
      }
      cancelGroundTargeting();
      let target: Targetable | null = engine.targetingSystem.currentTarget;
      if (ability.requiresFriendlyTarget && target && target.isHostileTo(engine.playerController)) target = engine.playerController;
      if (!target && ability.requiresTarget && !ability.requiresHostileTarget) target = engine.playerController;
      if (ability.castTime) {
        const result = engine.startCasting(ability, engine.playerController.mesh.rotation.y, target);
        if (!result.success && result.errorMessage) errorText.show(result.errorMessage);
      } else {
        const result = engine.combatSystem.useAbility(ability, engine.playerController, engine.playerController.mesh.rotation.y, target);
        if (result.success) {
          onAbilitySuccess(ability);
          if (!engine.godMode && !ability.usableWhileCCd) engine.combatSystem.triggerGcd(GLOBAL_COOLDOWN);
          if (ability.id === 'pvp-trinket') engine.buffSystem.removeAllCCEffects(engine.playerController);
        }
        else if (result.errorMessage) errorText.show(result.errorMessage);
      }
    },
    getAbilityStatus: (ability) => {
      const player = engine.playerController;
      if (ability.id !== 'crack-rock' && engine.buffSystem.hasBuff(player, 'dumpster-diving')) return 'locked';
      const effectiveManaCost = Math.round(ability.manaCost * engine.buffSystem.getManaCostMultiplier(player));
      if (player.mana < effectiveManaCost) return 'not-enough-resource';
      if (ability.requiresHostileTarget) {
        const target = engine.targetingSystem.currentTarget;
        if (!target || !target.isHostileTo(player) || target.dead) return 'no-target';
        const dx = player.mesh.position.x - target.mesh.position.x;
        const dy = player.mesh.position.y - target.mesh.position.y;
        const dz = player.mesh.position.z - target.mesh.position.z;
        const hostileDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const effectiveRange = ability.isAutoAttack
          ? getCharacterStats(player.characterId).autoAttackRange
          : ability.range!;
        if (hostileDist > effectiveRange) return 'out-of-range';
        if (ability.minRange && hostileDist < ability.minRange) return 'out-of-range';
      }
      if (ability.requiresTarget && !ability.requiresHostileTarget) {
        let target: Targetable = engine.targetingSystem.currentTarget ?? player;
        if (ability.requiresFriendlyTarget && target !== player && target.isHostileTo(player)) target = player;
        if (target.dead) return 'no-target';
        if (ability.blockedByTargetDebuff && engine.buffSystem.hasDebuff(target, ability.blockedByTargetDebuff)) return 'no-target';
        if (ability.range && target !== player) {
          const dx = player.mesh.position.x - target.mesh.position.x;
          const dy = player.mesh.position.y - target.mesh.position.y;
          const dz = player.mesh.position.z - target.mesh.position.z;
          if (Math.sqrt(dx * dx + dy * dy + dz * dz) > ability.range) return 'out-of-range';
        }
      }
      return 'usable';
    },
    getCombatSystem: () => engine.combatSystem,
    getGcdRemaining: () => engine.combatSystem.getGcdRemaining(),
    getGcdTotal: () => engine.combatSystem.getGcdTotal(),
    isDisabled: () => engine.playerController.dead || engine.playerController.stunned || engine.playerController.charging || (engine.isCasting() && !engine.isChanneling()),
    isAutoAttacking: () => engine.isAutoAttackActive(),
  });
  pgActionBar = actionBar;
  document.body.appendChild(actionBar.element);
  actionBar.loadAbilities(engine.playerController.characterId, engine.playerController.abilities);
  engine.onCharacterChange = (abilities) => { cancelGroundTargeting(); actionBar.loadAbilities(engine.playerController.characterId, engine.playerController.abilities); };
  engine.onAutoAttackError = (message) => errorText.show(message);
  engine.onRestError = (message) => errorText.show(message);
  engine.onGodModeToggle = (active) => toggleGodModeOverlay(active);

  // Escape menu
  const escapeMenu = new EscapeMenu({
    onReturnToLobby: () => {
      showLobby();
      network?.send({ type: 'return_to_lobby' });
    },
    onEscapeWhilePlaying: () => {
      if (pendingGroundAbility || engine.pendingNpcSpawn) {
        cancelGroundTargeting();
        return true;
      }
      if (engine.isCasting()) {
        engine.cancelCasting();
        return true;
      }
      if (engine.targetingSystem.currentTarget) {
        engine.targetingSystem.currentTarget = null;
        engine.stopAutoAttack();
        return true;
      }
      return false;
    },
    onKeybinds: () => {
      escapeMenu.close();
      keybindMenu.open(() => escapeMenu.open());
    },
    onAudio: () => {
      escapeMenu.close();
      new AudioSettingsDialog(() => escapeMenu.open()).open();
    },
  });
  pgEscapeMenu = escapeMenu;
  document.body.appendChild(escapeMenu.element);

  // Debug HUD (toggle with L key)
  pgDebugHUD = new DebugHUD(false);
  document.body.appendChild(pgDebugHUD.element);

  const deathFrame = pgDeathFrame!;
  let lastFrameTime = performance.now();
  function updateFrames(): void {
    pgFrameLoopId = requestAnimationFrame(updateFrames);
    const now = performance.now();
    // Throttle to ~10 FPS when tab is visible but not focused
    const focused = document.hasFocus();
    if (!focused && now - lastFrameTime < 100) return;
    const dt = Math.min((now - lastFrameTime) / 1000, focused ? 0.1 : 0.2);
    lastFrameTime = now;

    const bs = engine.buffSystem;
    playerFrame.update(engine.playerController, bs.getBuffs(engine.playerController), bs.getDebuffs(engine.playerController));
    const ct = engine.targetingSystem.currentTarget;
    targetFrame.update(ct, ct ? bs.getBuffs(ct) : [], ct ? bs.getDebuffs(ct) : []);

    // Target of Target: NPC targets are tracked via autoAttackTarget
    const tot = ct && ct !== engine.playerController && 'autoAttackTarget' in ct
      ? (ct as any).autoAttackTarget as Targetable | null
      : null;
    totFrame.update(tot);

    playerFrame.updateCombatText(dt);
    targetFrame.updateCombatText(dt);
    actionBar.update();

    const castState = engine.getCastingState();
    if (castState) {
      castBarContainer.style.display = 'block';
      let progress: number;
      if (castState.isChannel) {
        progress = Math.max(0, (castState.totalTime - castState.elapsed) / castState.originalCastTime);
        castBarFill.style.background = 'linear-gradient(to right, #cc8833, #eebb55)';
      } else {
        progress = Math.min(1, castState.elapsed / castState.totalTime);
        castBarFill.style.background = 'linear-gradient(to right, #4488ff, #66aaff)';
      }
      castBarFill.style.width = `${progress * 100}%`;
      const remaining = Math.max(0, castState.totalTime - castState.elapsed);
      castBarHeader.innerHTML = `<span>${castState.abilityName}</span><span>${remaining.toFixed(1)}s</span>`;
    } else {
      castBarContainer.style.display = 'none';
    }

    combatText.update(dt);
    nameplates.update(engine.playerController, engine.getNpcs(), (target) => {
      return bs.getDebuffs(target).map(b => ({ icon: b.definition.icon, remaining: b.remaining, duration: b.definition.duration }));
    }, bs.isBlinded(engine.playerController));

    // Unit tooltip (hover)
    const hovered = engine.targetingSystem.getHoveredTarget();
    unitTooltip.update(hovered, (entity) => {
      if (entity === (engine.playerController as unknown as Targetable)) {
        return engine.targetingSystem.currentTarget?.name ?? 'None';
      }
      // NPC — check autoAttackTarget
      const npc = engine.getNpcs().find(n => n === entity);
      return npc?.autoAttackTarget?.name ?? 'None';
    }, dt);

    pgDebugHUD?.update(dt);

    if (engine.playerController.dead && !deathFrame.visible) deathFrame.show();
    else if (!engine.playerController.dead && deathFrame.visible) deathFrame.hide();
  }
  updateFrames();

  pgResizeHandler = () => engine.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', pgResizeHandler);
  engine.start();
}

// ── UI Setup (solo training room for UI customization) ────────────────

async function startUISetup(): Promise<void> {
  lobbyMusic.fadeOut();
  cleanupCurrentState();
  currentState = 'ui-setup';

  const uiOverlay = document.getElementById('ui-overlay');
  if (uiOverlay) uiOverlay.style.display = '';
  canvas.style.display = 'block';

  const { Engine } = await import('./engine/Engine');
  const { CharacterSelector } = await import('./ui/CharacterSelector');

  const engine = new Engine(canvas);
  const savedUsername = sessionStorage.getItem('gtr_username');
  if (savedUsername) engine.playerController.name = savedUsername;
  engine.loadMap('ui-setup');
  // Remove arena preparation — this is a free-roam UI setup room
  engine.buffSystem.remove(engine.playerController, 'arena-preparation');
  engine.arenaPreparationActive = false;
  pgEngine = engine;

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

  // Unit frames
  const setTarget = (t: Targetable) => { engine.targetingSystem.currentTarget = t; };
  const playerFrame = new UnitFrame({
    getPortrait,
    onClick: setTarget,
    hideCastBar: true,
    onBuffRightClick: (buffId) => {
      engine.buffSystem.remove(engine.playerController, buffId);
    },
  });
  pgPlayerFrame = playerFrame;
  const targetFrame = new UnitFrame({ localPlayer: engine.playerController, getPortrait, onClick: setTarget });
  pgTargetFrame = targetFrame;
  const totFrame = new TargetOfTargetFrame({ localPlayer: engine.playerController, getPortrait, onClick: setTarget });
  pgToTFrame = totFrame;

  pgPositioner = new UnitFramePositioner();
  document.body.appendChild(pgPositioner.register('player', playerFrame.element, { top: 12, left: 12 }));
  document.body.appendChild(pgPositioner.register('target', targetFrame.element, { top: 12, left: 280 }));
  document.body.appendChild(pgPositioner.register('tot', totFrame.element, { top: 51, left: 544 }));

  // ── Party & arena frames backed by real NPCs ────────────────────────
  const npcEntities = practiceNpcs.map((npc, i) => ({
    entityId: `practice_npc_${i}`,
    targetable: npc as unknown as Targetable,
  }));
  const npcByEntityId = new Map(npcEntities.map(e => [e.entityId, e.targetable]));

  const partyFrames = new PartyFrames({ localPlayer: engine.playerController, getPortrait, onClick: setTarget });
  pgPartyFrames = partyFrames;
  partyFrames.setEntities(npcEntities);

  const arenaFrames = new ArenaFrames({ localPlayer: engine.playerController, getPortrait, onClick: setTarget });
  pgArenaFrames = arenaFrames;
  arenaFrames.element.style.position = '';
  arenaFrames.element.style.top = '';
  arenaFrames.element.style.right = '';
  arenaFrames.element.style.transform = '';
  arenaFrames.element.style.zIndex = '';
  arenaFrames.setEntities(npcEntities);

  document.body.appendChild(pgPositioner.register('party', partyFrames.element, { top: 150, left: 12 }, { stayBelow: { frameId: 'player', gap: 8 } }));
  const arenaDefaultLeft = window.innerWidth - 250;
  const arenaDefaultTop = Math.round(window.innerHeight / 2 - 100);
  document.body.appendChild(pgPositioner.register('arena', arenaFrames.element, { top: arenaDefaultTop, left: arenaDefaultLeft }));

  const errorText = new ErrorText();
  pgErrorText = errorText;
  document.body.appendChild(errorText.element);
  const combatText = new FloatingCombatText(engine.camera);
  pgCombatText = combatText;
  document.body.appendChild(combatText.element);
  const nameplates = new Nameplates(
    engine.camera, engine.scene,
    (target) => { engine.targetingSystem.currentTarget = target; },
    (target) => { engine.targetingSystem.setNameplateHover(target); },
    (target) => {
      engine.targetingSystem.currentTarget = target;
      if (target.isHostileTo(engine.playerController) && !target.dead) {
        engine.startAutoAttack(target);
      }
    },
  );
  pgNameplates = nameplates;
  document.body.appendChild(nameplates.element);

  const unitTooltip = new UnitTooltip(engine.playerController);
  pgUnitTooltip = unitTooltip;
  document.body.appendChild(unitTooltip.element);

  engine.combatSystem.onCombatText = (target, amount, type) => {
    const isIncoming = target === engine.playerController;
    combatText.spawn(target.mesh, amount, type, isIncoming);
    if (isIncoming) playerFrame.showCombatText(amount, type);
    else if (target === engine.targetingSystem.currentTarget) targetFrame.showCombatText(amount, type);
  };

  engine.combatSystem.onEnterCombat = (entity) => {
    if (entity === engine.playerController) {
      combatText.spawnText(entity.mesh, '+Combat', '#cc3333', true);
    }
  };
  engine.combatSystem.onLeaveCombat = (entity) => {
    if (entity === engine.playerController) {
      combatText.spawnText(entity.mesh, '-Combat', '#33cc33', true);
    }
  };

  engine.buffSystem.onBuffApplied = (target, definition) => {
    if (target === engine.playerController) {
      const color = definition.type === 'buff' ? '#3388ff' : '#ff6644';
      combatText.spawnText(target.mesh, `+${definition.name}`, color, true);
      if (definition.id === 'dumpster-diving') engine.saveDumpsterDiveAutoTarget();
    }
  };
  engine.buffSystem.onBuffExpired = (target, definition) => {
    if (target === engine.playerController) {
      combatText.spawnText(target.mesh, `-${definition.name}`, '#888888', true);
    }
    engine.handleBuffExpired(target, definition);
  };
  engine.buffSystem.onStacksChanged = (target, buffId, oldStacks, newStacks) => {
    if (buffId === 'tweaking' && target === engine.playerController) {
      const delta = newStacks - oldStacks;
      const text = delta > 0 ? `+${delta} Tweaking` : `${delta} Tweaking`;
      const color = delta > 0 ? '#3388ff' : '#888888';
      combatText.spawnText(target.mesh, text, color, true);
    }
  };

  // No arena preparation in UI setup mode

  // Death frame
  pgDeathFrame = new DeathFrame();
  const respawnBtn = document.createElement('button');
  respawnBtn.textContent = 'Respawn';
  respawnBtn.style.cssText = 'margin-top: 12px; padding: 10px 32px; font-size: 15px; font-weight: bold; background: rgba(180,60,60,0.85); color: #eee; border: 1px solid #cc4444; border-radius: 4px; cursor: pointer; outline: none; pointer-events: auto;';
  respawnBtn.addEventListener('click', () => { engine.respawnPlayer(); pgDeathFrame?.hide(); });
  pgDeathFrame.element.querySelector('div')!.appendChild(respawnBtn);
  document.body.appendChild(pgDeathFrame.element);

  // Cast bar
  const castBarContainer = document.createElement('div');
  pgCastBarContainer = castBarContainer;
  castBarContainer.style.cssText = 'position: fixed; bottom: 84px; left: 50%; transform: translateX(-50%); width: 240px; z-index: 100; display: none;';
  const castBarHeader = document.createElement('div');
  castBarHeader.style.cssText = 'display: flex; justify-content: space-between; color: #ddd; font-size: 11px; font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif; margin-bottom: 2px; text-shadow: 1px 1px 2px rgba(0,0,0,0.9);';
  const castBarBg = document.createElement('div');
  castBarBg.style.cssText = 'height: 14px; background: rgba(0,0,0,0.7); border: 1px solid rgba(255,255,255,0.2); border-radius: 3px; overflow: hidden;';
  const castBarFill = document.createElement('div');
  castBarFill.style.cssText = 'height: 100%; background: linear-gradient(to right, #4488ff, #66aaff); width: 0%;';
  castBarBg.appendChild(castBarFill);
  castBarContainer.append(castBarHeader, castBarBg);
  document.body.appendChild(castBarContainer);

  // Ground targeting state
  let pendingGroundAbility: Ability | null = null;

  function cancelGroundTargeting(): void {
    if (!pendingGroundAbility) return;
    pendingGroundAbility = null;
    engine.targetingSystem.cancelGroundTarget();
  }

  engine.onGroundTargetConfirmed = () => {
    if (!pendingGroundAbility) return;
    const ability = pendingGroundAbility;
    const groundPos = engine.targetingSystem.getGroundTargetPosition();
    engine.targetingSystem.cancelGroundTarget();
    pendingGroundAbility = null;

    const result = engine.useGroundTargetAbility(ability, groundPos);
    if (result.success) {
      onAbilitySuccess(ability, groundPos);
    } else if (result.errorMessage) {
      errorText.show(result.errorMessage);
    }
  };

  const { yardsToUnits, FartBombDebuff, ChemicalSpillSpeedBuff, ChemicalSpillDot, CrotchRotDot, ParanoidDebuff } = await import('./engine/combat/Ability');
  const MELEE_AUTO_ATTACK_ABILITIES = ['mop', 'big-boot', 'jimmy-legs', 'shank', 'gank'];

  function onAbilitySuccess(ability: Ability, groundPos?: import('three').Vector3): void {
    const targetPos = groundPos ?? engine.targetingSystem.currentTarget?.mesh.position.clone();
    engine.playerController.triggerAbilityAnimation(ability.id, targetPos);
    if (ability.id === 'crash-out') {
      const crashSfx = getCharacterSfx(engine.playerController.characterId)?.crashOut;
      if (crashSfx) soundEffects.play(crashSfx.url, undefined, undefined, crashSfx.volume);
    }
    if (ability.id === 'bucket-splash') {
      const splashSfx = getCharacterSfx(engine.playerController.characterId)?.bucketSplash;
      if (splashSfx) soundEffects.play(splashSfx.url, undefined, undefined, splashSfx.volume);
    }
    if (ability.id === 'fart-bomb') engine.spawnGasCloud(engine.playerController.mesh.position.clone(), yardsToUnits(5), 8, FartBombDebuff, 592, 2, engine.playerController);
    if (ability.id === 'sweep') engine.startSweepCharge();
    if (ability.id === 'kaboom') engine.executeKaboom();
    if (ability.id === 'chemical-spill') engine.spawnChemicalPool(engine.playerController.mesh.position.clone(), yardsToUnits(3), 30, ChemicalSpillSpeedBuff, ChemicalSpillDot, 297, 349, 600, 2, 6, engine.playerController, 2);
    if (ability.id === 'crotch-rot') {
      const target = engine.targetingSystem.currentTarget;
      if (target && !target.dead) {
        engine.spawnDot(target, CrotchRotDot, 12, 3, 720, engine.playerController);
      }
    }
    if (ability.id === 'shank' || ability.id === 'pocket-sand' || ability.id === 'sticky-fingers' || ability.id === 'dumpster-dive' || ability.id === 'tweaker-sprint' || ability.id === 'gank') {
      engine.buffSystem.addStacks(engine.playerController, 'tweaking', 15);
      if (engine.buffSystem.getStacks(engine.playerController, 'tweaking') >= 100 && !engine.buffSystem.hasDebuff(engine.playerController, 'paranoid')) {
        engine.buffSystem.apply(engine.playerController, ParanoidDebuff);
      }
    }
    if (ability.id === 'crack-rock') {
      engine.combatSystem.applyHeal(engine.playerController, 400);
      engine.buffSystem.addStacks(engine.playerController, 'tweaking', 25);
      if (engine.buffSystem.getStacks(engine.playerController, 'tweaking') >= 100 && !engine.buffSystem.hasDebuff(engine.playerController, 'paranoid')) {
        engine.buffSystem.apply(engine.playerController, ParanoidDebuff);
      }
    }
    if (ability.id === 'gank') {
      const target = engine.targetingSystem.currentTarget;
      if (target && (target.dead || target.hp / target.maxHp < 0.30)) {
        engine.combatSystem.clearCooldown('gank');
      }
    }
    if (ability.id === 'tweaker-sprint') {
      const target = engine.targetingSystem.currentTarget;
      if (target && !target.dead) {
        engine.startTweakerSprintCharge(target);
      }
    }
    if (ability.id === 'sticky-fingers') {
      const target = engine.targetingSystem.currentTarget;
      if (target) {
        const stealable = engine.buffSystem.getBuffs(target).filter(b => !b.definition.unremovable);
        if (stealable.length > 0) {
          const stolen = stealable[Math.floor(Math.random() * stealable.length)];
          const remainingTime = stolen.remaining;
          engine.buffSystem.remove(target, stolen.definition.id);
          engine.buffSystem.apply(engine.playerController, stolen.definition);
          engine.buffSystem.setRemaining(engine.playerController, stolen.definition.id, remainingTime);
        } else {
          const drain = Math.min(150, target.mana);
          target.mana -= drain;
          engine.playerController.mana = Math.min(engine.playerController.mana + 150, engine.playerController.maxMana);
          combatText.spawnText(engine.playerController.mesh, '+150 Mana', '#3388ff', true);
        }
      }
    }
    if (MELEE_AUTO_ATTACK_ABILITIES.includes(ability.id)) {
      const target = engine.targetingSystem.currentTarget;
      if (target && target.isHostileTo(engine.playerController) && !target.dead) {
        engine.startAutoAttack(target);
      }
    }
  }

  engine.onCastComplete = (ability) => onAbilitySuccess(ability);
  engine.onCastFailed = (message) => errorText.show(message);

  // Action bar
  const actionBar = new ActionBar({
    onActivate: (ability) => {
      // Attack toggle — bypass GCD/queue, just toggle auto-attack
      if (ability.isAutoAttack) {
        if (engine.isAutoAttackActive()) {
          engine.stopAutoAttack();
        } else {
          const target = engine.targetingSystem.currentTarget;
          if (target && target.isHostileTo(engine.playerController) && !target.dead) {
            if (engine.isResting()) engine.stopResting();
            engine.startAutoAttack(target);
          }
        }
        return;
      }

      if (engine.isResting()) engine.stopResting();
      if (engine.isChanneling() && engine.combatSystem.getCooldownRemaining(ability.id) <= 0) engine.cancelCasting();
      if (!ability.usableWhileCCd && engine.combatSystem.getGcdRemaining() > 0) return;
      if (ability.groundTargeted) {
        if (pendingGroundAbility?.id === ability.id) {
          cancelGroundTargeting();
        } else {
          if (engine.combatSystem.getCooldownRemaining(ability.id) > 0) {
            errorText.show('Ability is not ready yet');
            return;
          }
          cancelGroundTargeting();
          pendingGroundAbility = ability;
          engine.targetingSystem.startGroundTarget(ability.aoeRadius ?? 1, ability.range ?? 10);
        }
        return;
      }
      cancelGroundTargeting();
      let target: Targetable | null = engine.targetingSystem.currentTarget;
      if (ability.requiresFriendlyTarget && target && target.isHostileTo(engine.playerController)) target = engine.playerController;
      if (!target && ability.requiresTarget && !ability.requiresHostileTarget) target = engine.playerController;
      if (ability.castTime) {
        const result = engine.startCasting(ability, engine.playerController.mesh.rotation.y, target);
        if (!result.success && result.errorMessage) errorText.show(result.errorMessage);
      } else {
        const result = engine.combatSystem.useAbility(ability, engine.playerController, engine.playerController.mesh.rotation.y, target);
        if (result.success) {
          onAbilitySuccess(ability);
          if (!ability.usableWhileCCd) engine.combatSystem.triggerGcd(GLOBAL_COOLDOWN);
          if (ability.id === 'pvp-trinket') engine.buffSystem.removeAllCCEffects(engine.playerController);
        }
        else if (result.errorMessage) errorText.show(result.errorMessage);
      }
    },
    getAbilityStatus: (ability) => {
      const player = engine.playerController;
      if (ability.id !== 'crack-rock' && engine.buffSystem.hasBuff(player, 'dumpster-diving')) return 'locked';
      const effectiveManaCost = Math.round(ability.manaCost * engine.buffSystem.getManaCostMultiplier(player));
      if (player.mana < effectiveManaCost) return 'not-enough-resource';
      if (ability.requiresHostileTarget) {
        const target = engine.targetingSystem.currentTarget;
        if (!target || !target.isHostileTo(player) || target.dead) return 'no-target';
        const dx = player.mesh.position.x - target.mesh.position.x;
        const dy = player.mesh.position.y - target.mesh.position.y;
        const dz = player.mesh.position.z - target.mesh.position.z;
        const hostileDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const effectiveRange = ability.isAutoAttack
          ? getCharacterStats(player.characterId).autoAttackRange
          : ability.range!;
        if (hostileDist > effectiveRange) return 'out-of-range';
        if (ability.minRange && hostileDist < ability.minRange) return 'out-of-range';
      }
      if (ability.requiresTarget && !ability.requiresHostileTarget) {
        let target: Targetable = engine.targetingSystem.currentTarget ?? player;
        if (ability.requiresFriendlyTarget && target !== player && target.isHostileTo(player)) target = player;
        if (target.dead) return 'no-target';
        if (ability.blockedByTargetDebuff && engine.buffSystem.hasDebuff(target, ability.blockedByTargetDebuff)) return 'no-target';
        if (ability.range && target !== player) {
          const dx = player.mesh.position.x - target.mesh.position.x;
          const dy = player.mesh.position.y - target.mesh.position.y;
          const dz = player.mesh.position.z - target.mesh.position.z;
          if (Math.sqrt(dx * dx + dy * dy + dz * dz) > ability.range) return 'out-of-range';
        }
      }
      return 'usable';
    },
    getCombatSystem: () => engine.combatSystem,
    getGcdRemaining: () => engine.combatSystem.getGcdRemaining(),
    getGcdTotal: () => engine.combatSystem.getGcdTotal(),
    isDisabled: () => engine.playerController.dead || engine.playerController.stunned || engine.playerController.charging || (engine.isCasting() && !engine.isChanneling()),
    isAutoAttacking: () => engine.isAutoAttackActive(),
  });
  pgActionBar = actionBar;
  document.body.appendChild(actionBar.element);
  actionBar.loadAbilities(engine.playerController.characterId, engine.playerController.abilities);
  engine.onCharacterChange = (abilities) => { cancelGroundTargeting(); actionBar.loadAbilities(engine.playerController.characterId, engine.playerController.abilities); };
  engine.onAutoAttackError = (message) => errorText.show(message);
  engine.onRestError = (message) => errorText.show(message);

  // Escape menu — return to lobby
  const escapeMenu = new EscapeMenu({
    onReturnToLobby: () => {
      showLobby();
      network?.send({ type: 'return_to_lobby' });
    },
    onEscapeWhilePlaying: () => {
      if (pendingGroundAbility) {
        cancelGroundTargeting();
        return true;
      }
      if (engine.isCasting()) {
        engine.cancelCasting();
        return true;
      }
      if (engine.targetingSystem.currentTarget) {
        engine.targetingSystem.currentTarget = null;
        engine.stopAutoAttack();
        return true;
      }
      return false;
    },
    onKeybinds: () => {
      escapeMenu.close();
      keybindMenu.open(() => escapeMenu.open());
    },
    onAudio: () => {
      escapeMenu.close();
      new AudioSettingsDialog(() => escapeMenu.open()).open();
    },
  });
  pgEscapeMenu = escapeMenu;
  document.body.appendChild(escapeMenu.element);

  // Debug HUD
  pgDebugHUD = new DebugHUD(false);
  document.body.appendChild(pgDebugHUD.element);

  const deathFrame = pgDeathFrame!;
  let lastFrameTime = performance.now();
  function updateFrames(): void {
    pgFrameLoopId = requestAnimationFrame(updateFrames);
    const now = performance.now();
    // Throttle to ~10 FPS when tab is visible but not focused
    const focused = document.hasFocus();
    if (!focused && now - lastFrameTime < 100) return;
    const dt = Math.min((now - lastFrameTime) / 1000, focused ? 0.1 : 0.2);
    lastFrameTime = now;

    const bs = engine.buffSystem;
    playerFrame.update(engine.playerController, bs.getBuffs(engine.playerController), bs.getDebuffs(engine.playerController));
    const ct = engine.targetingSystem.currentTarget;
    targetFrame.update(ct, ct ? bs.getBuffs(ct) : [], ct ? bs.getDebuffs(ct) : []);

    const tot = ct && ct !== engine.playerController && 'autoAttackTarget' in ct
      ? (ct as any).autoAttackTarget as Targetable | null
      : null;
    totFrame.update(tot);

    playerFrame.updateCombatText(dt);
    targetFrame.updateCombatText(dt);
    actionBar.update();

    const castState = engine.getCastingState();
    if (castState) {
      castBarContainer.style.display = 'block';
      let progress: number;
      if (castState.isChannel) {
        progress = Math.max(0, (castState.totalTime - castState.elapsed) / castState.originalCastTime);
        castBarFill.style.background = 'linear-gradient(to right, #cc8833, #eebb55)';
      } else {
        progress = Math.min(1, castState.elapsed / castState.totalTime);
        castBarFill.style.background = 'linear-gradient(to right, #4488ff, #66aaff)';
      }
      castBarFill.style.width = `${progress * 100}%`;
      const remaining = Math.max(0, castState.totalTime - castState.elapsed);
      castBarHeader.innerHTML = `<span>${castState.abilityName}</span><span>${remaining.toFixed(1)}s</span>`;
    } else {
      castBarContainer.style.display = 'none';
    }

    combatText.update(dt);
    nameplates.update(engine.playerController, engine.getNpcs(), (target) => {
      return bs.getDebuffs(target).map(b => ({ icon: b.definition.icon, remaining: b.remaining, duration: b.definition.duration }));
    }, bs.isBlinded(engine.playerController));

    const hovered = engine.targetingSystem.getHoveredTarget();
    unitTooltip.update(hovered, (entity) => {
      if (entity === (engine.playerController as unknown as Targetable)) {
        return engine.targetingSystem.currentTarget?.name ?? 'None';
      }
      const npc = engine.getNpcs().find(n => n === entity);
      return npc?.autoAttackTarget?.name ?? 'None';
    }, dt);

    partyFrames.setVisible(true);
    partyFrames.update(dt, (entityId) => {
      const t = npcByEntityId.get(entityId);
      if (!t) return [];
      return bs.getDebuffs(t);
    });
    arenaFrames.setVisible(true);
    arenaFrames.update(dt, (entityId) => {
      const t = npcByEntityId.get(entityId);
      if (!t) return [];
      return bs.getDRTimers(t);
    });

    pgDebugHUD?.update(dt);

    if (engine.playerController.dead && !deathFrame.visible) deathFrame.show();
    else if (!engine.playerController.dead && deathFrame.visible) deathFrame.hide();
  }
  updateFrames();

  pgResizeHandler = () => engine.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', pgResizeHandler);
  engine.start();
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
