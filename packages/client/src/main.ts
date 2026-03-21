import type { ServerMessage, S2C_GameStart } from '@gtr/shared';
import { AuthScreen } from './screens/AuthScreen';
import { LobbyScreen } from './screens/LobbyScreen';
import { GameLobbyScreen } from './screens/GameLobbyScreen';
import { NetworkManager } from './network/NetworkManager';
import { ClientEngine } from './network/ClientEngine';
import { UnitFrame } from './ui/UnitFrame';
import { ActionBar } from './ui/ActionBar';
import { ErrorText } from './ui/ErrorText';
import { FloatingCombatText } from './ui/FloatingCombatText';
import { Nameplates } from './ui/Nameplates';
import { renderPortraits } from './ui/PortraitRenderer';
import { getCharacterStats } from '@gtr/shared';
import type { Ability } from './engine/combat/Ability';
import type { Targetable } from './engine/types';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
if (!canvas) throw new Error('Canvas element not found');

// Pre-render character face portraits
const portraits = renderPortraits();
const getPortrait = (modelName: string) => portraits.get(modelName);

// ── State ──────────────────────────────────────────────────────────────

type AppState = 'auth' | 'lobby' | 'game-lobby' | 'multiplayer' | 'playground';
let currentState: AppState = 'auth';
let network: NetworkManager | null = null;
let localUserId = '';

// Active screens / engines
let authScreen: AuthScreen | null = null;
let lobbyScreen: LobbyScreen | null = null;
let gameLobbyScreen: GameLobbyScreen | null = null;
let clientEngine: ClientEngine | null = null;

// MP game UI elements
let mpActionBar: ActionBar | null = null;
let mpPlayerFrame: UnitFrame | null = null;
let mpTargetFrame: UnitFrame | null = null;
let mpErrorText: ErrorText | null = null;
let mpCombatText: FloatingCombatText | null = null;
let mpNameplates: Nameplates | null = null;
let mpCastBarContainer: HTMLDivElement | null = null;
let mpCastBarFill: HTMLDivElement | null = null;
let mpCastBarHeader: HTMLDivElement | null = null;
let mpGameOverScreen: HTMLDivElement | null = null;
let mpFrameLoopId: number | null = null;
let mpSelectedTargetId: string | null = null;

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

function cleanupCurrentState(): void {
  authScreen?.destroy();
  authScreen = null;
  lobbyScreen?.destroy();
  lobbyScreen = null;
  gameLobbyScreen?.destroy();
  gameLobbyScreen = null;
  cleanupMultiplayerUI();
}

function cleanupMultiplayerUI(): void {
  clientEngine?.destroy();
  clientEngine = null;
  mpActionBar?.element.remove();
  mpActionBar = null;
  mpPlayerFrame?.element.remove();
  mpPlayerFrame = null;
  mpTargetFrame?.element.remove();
  mpTargetFrame = null;
  mpErrorText?.element.remove();
  mpErrorText = null;
  mpCombatText?.element.remove();
  mpCombatText = null;
  mpNameplates?.element.remove();
  mpNameplates = null;
  mpCastBarContainer?.remove();
  mpCastBarContainer = null;
  mpGameOverScreen?.remove();
  mpGameOverScreen = null;
  if (mpFrameLoopId !== null) {
    cancelAnimationFrame(mpFrameLoopId);
    mpFrameLoopId = null;
  }
  mpSelectedTargetId = null;
}

// ── Auth Screen ────────────────────────────────────────────────────────

function showAuth(): void {
  cleanupCurrentState();
  currentState = 'auth';
  hideGameUI();

  authScreen = new AuthScreen((result) => {
    authScreen?.destroy();
    authScreen = null;
    network = new NetworkManager(result.token, result.username);
    network.onMessage(handleServerMessage);
    network.connect();
    // Will transition to lobby on auth_result
  });
  document.body.appendChild(authScreen.element);
}

// ── Lobby Screen ───────────────────────────────────────────────────────

function showLobby(): void {
  cleanupCurrentState();
  currentState = 'lobby';
  hideGameUI();

  lobbyScreen = new LobbyScreen(network!, localUserId);
  lobbyScreen.onPlayground = () => startPlayground();
  document.body.appendChild(lobbyScreen.element);
}

// ── Game Lobby Screen ──────────────────────────────────────────────────

function showGameLobby(): void {
  // Don't clean up lobby screen fully — just remove it from view
  lobbyScreen?.element.remove();
  gameLobbyScreen?.destroy();
  currentState = 'game-lobby';

  gameLobbyScreen = new GameLobbyScreen(network!, localUserId);
  document.body.appendChild(gameLobbyScreen.element);
}

// ── Multiplayer Game ───────────────────────────────────────────────────

function startMultiplayer(msg: S2C_GameStart): void {
  cleanupCurrentState();
  currentState = 'multiplayer';
  showGameUI();

  clientEngine = new ClientEngine(canvas, network!, msg.mapId, msg.localEntityId, msg.entities);

  // Wire up server message handlers
  clientEngine.onError = (message) => mpErrorText?.show(message);

  clientEngine.onCombatText = (sourceEntityId, targetEntityId, amount, type) => {
    const localId = clientEngine!.localId;
    const isLocalInvolved = sourceEntityId === localId || targetEntityId === localId;
    if (isLocalInvolved) {
      const mesh = clientEngine!.getEntityMesh(targetEntityId);
      if (mesh && mpCombatText) {
        mpCombatText.spawn(mesh, amount, type as any);
      }
    }
    if (targetEntityId === localId) {
      mpPlayerFrame?.showCombatText(amount, type as any);
    } else if (targetEntityId === mpSelectedTargetId) {
      mpTargetFrame?.showCombatText(amount, type as any);
    }
  };

  // Create UI elements for MP game
  setupMultiplayerUI(msg);

  // Start rendering
  clientEngine.start();

  window.addEventListener('resize', onMpResize);
}

function onMpResize(): void {
  clientEngine?.resize(window.innerWidth, window.innerHeight);
}

function setupMultiplayerUI(msg: S2C_GameStart): void {
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
  mpNameplates = new Nameplates(clientEngine.camera, clientEngine.scene);
  document.body.appendChild(mpNameplates.element);

  // Unit frames
  const unitFrameContainer = document.getElementById('unit-frames');
  if (unitFrameContainer) unitFrameContainer.style.display = 'flex';
  const playerFrameContainer = document.getElementById('player-frame-container')!;
  const targetFrameContainer = document.getElementById('target-frame-container')!;
  playerFrameContainer.innerHTML = '';
  targetFrameContainer.innerHTML = '';

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
  mpPlayerFrame = new UnitFrame({ getPortrait, onClick: mpSetTarget });
  playerFrameContainer.appendChild(mpPlayerFrame.element);

  mpTargetFrame = new UnitFrame({ localPlayer: player, getPortrait, onClick: mpSetTarget });
  targetFrameContainer.appendChild(mpTargetFrame.element);

  // Action bar - abilities come from shared character data
  const abilities: readonly Ability[] = localCharStats.abilities;

  mpActionBar = new ActionBar({
    onActivate: (ability) => {
      // Cancel current channel if starting new ability (same as playground)
      const castState = clientEngine!.getLocalCastingState();
      if (castState?.isChannel && clientEngine!.getCooldownRemaining(ability.id) <= 0) {
        clientEngine!.sendCancelCast();
      }
      clientEngine!.sendAbility(ability.id, mpSelectedTargetId);
    },
    getAbilityStatus: (ability) => {
      if (player.mana < ability.manaCost) return 'not-enough-resource';
      if (ability.requiresHostileTarget) {
        if (!mpSelectedTargetId) return 'no-target';
        const target = clientEngine!.getRemoteEntity(mpSelectedTargetId);
        if (!target || target.dead || target.team === player.team) return 'no-target';
        const pos = player.getPosition();
        const dx = pos.x - target.mesh.position.x;
        const dz = pos.z - target.mesh.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (ability.range && dist > ability.range) return 'out-of-range';
      }
      if (ability.requiresTarget && !ability.requiresHostileTarget) {
        // Friendly-or-self targeted abilities (e.g. Chudmax channel)
        // Auto self-cast if no target, but check range to non-self targets
        const targetId = mpSelectedTargetId;
        if (targetId && targetId !== clientEngine!.localId) {
          const target = clientEngine!.getRemoteEntity(targetId);
          if (!target || target.dead) return 'no-target';
          if (ability.range) {
            const pos = player.getPosition();
            const dx = pos.x - target.mesh.position.x;
            const dz = pos.z - target.mesh.position.z;
            if (Math.sqrt(dx * dx + dz * dz) > ability.range) return 'out-of-range';
          }
        }
      }
      return 'usable';
    },
    getCombatSystem: () => ({
      getCooldownRemaining: (id: string) => clientEngine!.getCooldownRemaining(id),
      getCooldownTotal: (id: string) => clientEngine!.getCooldownTotal(id),
    }) as any,
    isDisabled: () => {
      const castState = clientEngine!.getLocalCastingState();
      const isCasting = castState !== null && !castState.isChannel;
      return player.dead || player.stunned || player.charging || isCasting;
    },
  });
  document.body.appendChild(mpActionBar.element);
  mpActionBar.clearAllSlots();
  abilities.forEach((ab, i) => mpActionBar!.setSlotAbility(i, ab));

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
    const dt = Math.min((now - lastMpFrameTime) / 1000, 0.1);
    lastMpFrameTime = now;

    if (!clientEngine) return;

    // Player frame — PlayerController implements Targetable directly
    if (mpPlayerFrame) {
      const pBuffs = clientEngine.getLocalBuffs();
      const pBuffList = pBuffs.filter(b => b.type === 'buff').map(b => ({
        definition: { id: b.id, name: b.name, icon: b.icon, duration: b.duration, type: b.type as 'buff', description: b.description, effects: [] },
        remaining: b.remaining,
        shieldRemaining: b.shieldRemaining,
      }));
      const pDebuffList = pBuffs.filter(b => b.type === 'debuff').map(b => ({
        definition: { id: b.id, name: b.name, icon: b.icon, duration: b.duration, type: b.type as 'debuff', description: b.description, effects: [] },
        remaining: b.remaining,
      }));
      mpPlayerFrame.update(player, pBuffList, pDebuffList);
    }

    // Target frame
    if (mpSelectedTargetId && mpTargetFrame) {
      const targetTarget = makeTargetable(mpSelectedTargetId);
      if (targetTarget) {
        const targetE = clientEngine.getRemoteEntity(mpSelectedTargetId);
        const tBuffs = (targetE?.buffs ?? []).filter(b => b.type === 'buff').map(b => ({
          definition: { id: b.id, name: b.name, icon: b.icon, duration: b.duration, type: b.type as 'buff', description: b.description, effects: [] },
          remaining: b.remaining,
          shieldRemaining: b.shieldRemaining,
        }));
        const tDebuffs = (targetE?.buffs ?? []).filter(b => b.type === 'debuff').map(b => ({
          definition: { id: b.id, name: b.name, icon: b.icon, duration: b.duration, type: b.type as 'debuff', description: b.description, effects: [] },
          remaining: b.remaining,
        }));
        mpTargetFrame.update(targetTarget, tBuffs, tDebuffs);
      } else {
        mpTargetFrame.update(null);
      }
    } else if (mpTargetFrame) {
      mpTargetFrame.update(null);
    }

    mpPlayerFrame?.updateCombatText(dt);
    mpTargetFrame?.updateCombatText(dt);
    mpActionBar?.update();
    mpCombatText?.update(dt);

    // Nameplates: local player + remote entities
    if (mpNameplates) {
      const remotes = clientEngine.getAllRemoteEntities();
      const npcsTargetable = remotes
        .map(e => makeTargetable(e.id))
        .filter((t): t is Targetable => t !== null);
      mpNameplates.update(player, npcsTargetable);
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
      const ab = abilities.find(a => a.id === castState.abilityId);
      mpCastBarHeader.innerHTML = `<span>${ab?.name ?? castState.abilityId}</span><span>${remaining.toFixed(1)}s</span>`;
    } else if (mpCastBarContainer) {
      mpCastBarContainer.style.display = 'none';
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
        showLobby();
      } else {
        alert('Auth failed: ' + (msg.error ?? 'Unknown error'));
      }
      break;

    case 'lobby_state':
      lobbyScreen?.updateUsers(msg.users);
      lobbyScreen?.updateGames(msg.games);
      break;

    case 'lobby_chat':
      lobbyScreen?.addChatMessage(msg.username, msg.message);
      break;

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

    case 'game_over':
      showGameOver(msg.winningTeam);
      break;

    case 'game_cancelled':
      showLobby();
      break;

    case 'error':
      if (currentState === 'multiplayer') {
        mpErrorText?.show(msg.message);
      } else {
        console.warn('Server error:', msg.message);
      }
      break;
  }
}

function showGameOver(winningTeam: number): void {
  if (!clientEngine) return;
  const won = clientEngine.playerController.team === winningTeam;

  mpGameOverScreen = document.createElement('div');
  mpGameOverScreen.style.cssText = `
    position: fixed; inset: 0; z-index: 900;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.6); pointer-events: auto;
  `;

  const box = document.createElement('div');
  box.style.cssText = `
    background: linear-gradient(to bottom, rgba(20, 20, 35, 0.95), rgba(10, 10, 20, 0.95));
    border: 1px solid ${won ? 'rgba(80, 200, 100, 0.5)' : 'rgba(200, 80, 80, 0.5)'};
    border-radius: 8px; padding: 40px 50px; text-align: center;
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  `;

  const title = document.createElement('div');
  title.textContent = won ? 'Victory!' : 'Defeat';
  title.style.cssText = `color: ${won ? '#44cc44' : '#cc4444'}; font-size: 36px; font-weight: bold; margin-bottom: 16px;`;

  const btn = document.createElement('button');
  btn.textContent = 'Return to Lobby';
  btn.style.cssText = `
    padding: 12px 32px; font-size: 15px; font-weight: bold;
    background: rgba(40, 80, 160, 0.8); color: #ddd;
    border: 1px solid rgba(100, 140, 255, 0.3); border-radius: 4px;
    cursor: pointer; outline: none;
  `;
  btn.addEventListener('click', () => {
    window.removeEventListener('resize', onMpResize);
    showLobby();
    network?.send({ type: 'return_to_lobby' });
  });

  box.appendChild(title);
  box.appendChild(btn);
  mpGameOverScreen.appendChild(box);
  document.body.appendChild(mpGameOverScreen);
}

// ── Playground Mode ────────────────────────────────────────────────────

async function startPlayground(): Promise<void> {
  cleanupCurrentState();
  currentState = 'playground';

  // Show all game UI elements
  const uiOverlay = document.getElementById('ui-overlay');
  const unitFrames = document.getElementById('unit-frames');
  if (uiOverlay) uiOverlay.style.display = '';
  if (unitFrames) unitFrames.style.display = 'flex';
  canvas.style.display = 'block';

  // Dynamically import the playground to avoid loading Engine in MP mode
  const { Engine } = await import('./engine/Engine');
  const { DebugPanel } = await import('./ui/DebugPanel');
  const { MapSelector } = await import('./ui/MapSelector');
  const { CharacterSelector } = await import('./ui/CharacterSelector');
  const { NpcSpawner } = await import('./ui/NpcSpawner');
  const { DebugStun, DiscombobulateDebuff, FartBombDebuff, ChemicalSpillSpeedBuff, ChemicalSpillDot, yardsToUnits } = await import('./engine/combat/Ability');

  const engine = new Engine(canvas);

  const mapContainer = document.getElementById('map-selector-container')!;
  const debugContainer = document.getElementById('debug-panel-container')!;
  const charContainer = document.getElementById('character-selector-container')!;
  const npcContainer = document.getElementById('npc-spawner-container')!;

  new CharacterSelector(engine, charContainer);
  new MapSelector(engine, mapContainer);
  new NpcSpawner(engine, npcContainer);
  new DebugPanel(engine, debugContainer);

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
  const playerFrame = new UnitFrame({ getPortrait, onClick: setTarget });
  document.getElementById('player-frame-container')!.appendChild(playerFrame.element);
  const targetFrame = new UnitFrame({ localPlayer: engine.playerController, getPortrait, onClick: setTarget });
  document.getElementById('target-frame-container')!.appendChild(targetFrame.element);

  const errorText = new ErrorText();
  document.body.appendChild(errorText.element);
  const combatText = new FloatingCombatText(engine.camera);
  document.body.appendChild(combatText.element);
  const nameplates = new Nameplates(engine.camera, engine.scene);
  document.body.appendChild(nameplates.element);

  engine.combatSystem.onCombatText = (target, amount, type) => {
    combatText.spawn(target.mesh, amount, type);
    if (target === engine.playerController) playerFrame.showCombatText(amount, type);
    else if (target === engine.targetingSystem.currentTarget) targetFrame.showCombatText(amount, type);
  };

  // Death screen
  const deathScreen = document.createElement('div');
  deathScreen.style.cssText = 'position: fixed; top: 35%; left: 50%; transform: translate(-50%, -50%); display: none; z-index: 500; pointer-events: none;';
  const deathDialog = document.createElement('div');
  deathDialog.style.cssText = 'pointer-events: auto; background: linear-gradient(to bottom, rgba(30,10,10,0.95), rgba(10,5,5,0.95)); border: 1px solid #aa3333; border-radius: 8px; padding: 30px 40px; text-align: center; font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;';
  const deathTitle = document.createElement('div');
  deathTitle.textContent = 'You Died';
  deathTitle.style.cssText = 'color: #cc2222; font-size: 32px; font-weight: bold; margin-bottom: 12px;';
  const deathSub = document.createElement('div');
  deathSub.textContent = 'Your character has been slain.';
  deathSub.style.cssText = 'color: #888; font-size: 14px; margin-bottom: 24px;';
  const respawnBtn = document.createElement('button');
  respawnBtn.textContent = 'Respawn';
  respawnBtn.style.cssText = 'padding: 10px 32px; font-size: 15px; font-weight: bold; background: rgba(180,60,60,0.85); color: #eee; border: 1px solid #cc4444; border-radius: 4px; cursor: pointer; outline: none;';
  respawnBtn.addEventListener('click', () => { engine.playerController.respawn(); deathScreen.style.display = 'none'; });
  deathDialog.append(deathTitle, deathSub, respawnBtn);
  deathScreen.appendChild(deathDialog);
  document.body.appendChild(deathScreen);

  // Cast bar
  const castBarContainer = document.createElement('div');
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
  function onAbilitySuccess(ability: Ability): void {
    engine.playerController.triggerAbilityAnimation(ability.id, engine.targetingSystem.currentTarget?.mesh.position.clone());
    if (ability.id === 'fart-bomb') engine.spawnGasCloud(engine.playerController.mesh.position.clone(), yardsToUnits(5), 8, FartBombDebuff, 96, 2, engine.playerController);
    if (ability.id === 'sweep') engine.startSweepCharge();
    if (ability.id === 'chemical-spill') engine.spawnChemicalPool(engine.playerController.mesh.position.clone(), yardsToUnits(3), 30, ChemicalSpillSpeedBuff, ChemicalSpillDot, 40, 60, 2, 6, engine.playerController, 2);
  }

  engine.onCastComplete = (ability) => onAbilitySuccess(ability);
  engine.onCastFailed = (message) => errorText.show(message);

  // Action bar
  const actionBar = new ActionBar({
    onActivate: (ability) => {
      if (engine.isChanneling() && engine.combatSystem.getCooldownRemaining(ability.id) <= 0) engine.cancelCasting();
      let target: Targetable | null = engine.targetingSystem.currentTarget;
      if (!target && ability.requiresTarget && !ability.requiresHostileTarget) target = engine.playerController;
      if (ability.castTime) {
        const result = engine.startCasting(ability, engine.playerController.mesh.rotation.y, target);
        if (!result.success && result.errorMessage) errorText.show(result.errorMessage);
      } else {
        const result = engine.combatSystem.useAbility(ability, engine.playerController, engine.playerController.mesh.rotation.y, target);
        if (result.success) onAbilitySuccess(ability);
        else if (result.errorMessage) errorText.show(result.errorMessage);
      }
    },
    getAbilityStatus: (ability) => {
      const player = engine.playerController;
      if (player.mana < ability.manaCost) return 'not-enough-resource';
      if (ability.requiresHostileTarget) {
        const target = engine.targetingSystem.currentTarget;
        if (!target || !target.isHostileTo(player) || target.dead) return 'no-target';
        const dx = player.mesh.position.x - target.mesh.position.x;
        const dz = player.mesh.position.z - target.mesh.position.z;
        if (Math.sqrt(dx * dx + dz * dz) > ability.range!) return 'out-of-range';
      }
      if (ability.requiresTarget && !ability.requiresHostileTarget) {
        const target = engine.targetingSystem.currentTarget ?? player;
        if (target.dead) return 'no-target';
        if (ability.range && target !== player) {
          const dx = player.mesh.position.x - target.mesh.position.x;
          const dz = player.mesh.position.z - target.mesh.position.z;
          if (Math.sqrt(dx * dx + dz * dz) > ability.range) return 'out-of-range';
        }
      }
      return 'usable';
    },
    getCombatSystem: () => engine.combatSystem,
    isDisabled: () => engine.playerController.dead || engine.playerController.stunned || engine.playerController.charging || (engine.isCasting() && !engine.isChanneling()),
  });
  document.body.appendChild(actionBar.element);
  const loadAbilities = (abilities: readonly Ability[]) => { actionBar.clearAllSlots(); abilities.forEach((ab, i) => actionBar.setSlotAbility(i, ab)); };
  loadAbilities(engine.playerController.abilities);
  engine.onCharacterChange = (abilities) => loadAbilities(abilities);
  engine.onAutoAttackError = (message) => errorText.show(message);

  let deathScreenShown = false;
  let lastFrameTime = performance.now();
  function updateFrames(): void {
    requestAnimationFrame(updateFrames);
    const now = performance.now();
    const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
    lastFrameTime = now;

    const bs = engine.buffSystem;
    playerFrame.update(engine.playerController, bs.getBuffs(engine.playerController), bs.getDebuffs(engine.playerController));
    const ct = engine.targetingSystem.currentTarget;
    targetFrame.update(ct, ct ? bs.getBuffs(ct) : [], ct ? bs.getDebuffs(ct) : []);
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
    nameplates.update(engine.playerController, engine.getNpcs());

    if (engine.playerController.dead && !deathScreenShown) { deathScreenShown = true; deathScreen.style.display = 'block'; }
    else if (!engine.playerController.dead && deathScreenShown) { deathScreenShown = false; }
  }
  updateFrames();

  window.addEventListener('resize', () => engine.resize(window.innerWidth, window.innerHeight));
  engine.start();
}

// ── Boot ───────────────────────────────────────────────────────────────

showAuth();
