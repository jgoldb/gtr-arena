import type { S2C_GameStart } from '@gtr/shared';
import { getCharacterStats, type CharacterId } from '@gtr/shared';
import type { ClientEngine } from '../network/ClientEngine';
import type { Targetable } from '../engine/types';
import { type Ability } from '../engine/combat/Ability';
import { UnitFrame } from './UnitFrame';
import { TargetOfTargetFrame } from './TargetOfTargetFrame';
import { ActionBar, type AbilityUsabilityStatus } from './ActionBar';
import { ErrorText } from './ErrorText';
import { FloatingCombatText } from './FloatingCombatText';
import { Nameplates } from './Nameplates';
import { UnitTooltip } from './UnitTooltip';
import { EscapeMenu } from './EscapeMenu';
import { AudioSettingsDialog } from './AudioSettingsDialog';
import { DebugHUD } from './DebugHUD';
import { ArenaFrames } from './ArenaFrames';
import { PartyFrames } from './PartyFrames';
import { UnitFramePositioner } from './UnitFramePositioner';
import { DeathFrame } from './DeathFrame';
import { ChatWindow } from './ChatWindow';
import type { KeybindMenu } from './KeybindMenu';
import type { GameOverOverlay } from './GameOverOverlay';

// ── Dependencies ──────────────────────────────────────────────────────

export interface MultiplayerUIDeps {
  clientEngine: ClientEngine;
  entities: S2C_GameStart['entities'];
  localEntityId: string;
  getPortrait: (modelName: string) => string | undefined;
  sendNetworkMessage: (msg: any) => void;
  keybindMenu: KeybindMenu;
  gameOverOverlay: GameOverOverlay;
  showLobby: () => void;
}

// ── Exported State ────────────────────────────────────────────────────

let _clientEngine: ClientEngine | null = null;

export let actionBar: ActionBar | null = null;
export let playerFrame: UnitFrame | null = null;
export let targetFrame: UnitFrame | null = null;
export let totFrame: TargetOfTargetFrame | null = null;
export let errorText: ErrorText | null = null;
export let combatText: FloatingCombatText | null = null;
export let nameplates: Nameplates | null = null;
export let unitTooltip: UnitTooltip | null = null;
export let castBarContainer: HTMLDivElement | null = null;
export let castBarFill: HTMLDivElement | null = null;
export let castBarHeader: HTMLDivElement | null = null;
export let escapeMenu: EscapeMenu | null = null;
export let debugHUD: DebugHUD | null = null;
export let arenaFrames: ArenaFrames | null = null;
export let partyFrames: PartyFrames | null = null;
export let positioner: UnitFramePositioner | null = null;
export let deathFrame: DeathFrame | null = null;
export let chatWindow: ChatWindow | null = null;
export let frameLoopId: number | null = null;
export let selectedTargetId: string | null = null;

// ── Setup ─────────────────────────────────────────────────────────────

export function setup(deps: MultiplayerUIDeps): void {
  const { clientEngine, entities, localEntityId, getPortrait, sendNetworkMessage, keybindMenu, gameOverOverlay, showLobby } = deps;
  _clientEngine = clientEngine;

  const player = clientEngine.playerController;
  const localSnap = entities.find(e => e.id === localEntityId);
  const localCharStats = getCharacterStats((localSnap?.characterId ?? 'janitor') as any);

  // Error text
  errorText = new ErrorText();
  document.body.appendChild(errorText.element);

  // Floating combat text
  combatText = new FloatingCombatText(clientEngine.camera);
  document.body.appendChild(combatText.element);

  // Nameplates
  nameplates = new Nameplates(
    clientEngine.camera, clientEngine.scene,
    (target) => { clientEngine.selectTarget(target); },
    (target) => { clientEngine.targetingSystem.setNameplateHover(target); },
    (target) => { clientEngine.rightClickTarget(target); },
  );
  document.body.appendChild(nameplates.element);

  // Unit tooltip (bottom-right, on hover)
  unitTooltip = new UnitTooltip(player);
  document.body.appendChild(unitTooltip.element);

  // Unit frames

  // Get a Targetable reference for any entity
  const makeTargetable = (entityId: string): Targetable | null => {
    if (entityId === clientEngine.localId) {
      return player; // PlayerController implements Targetable
    }
    const e = clientEngine.getRemoteEntity(entityId);
    return e?.targetable ?? null;
  };

  const setTarget = (t: Targetable) => {
    clientEngine.targetingSystem.currentTarget = t;
    const entityId = t === player ? clientEngine.localId : (() => {
      for (const e of clientEngine.getAllRemoteEntities()) {
        if (e.targetable === t) return e.id;
      }
      return null;
    })();
    selectedTargetId = entityId;
    clientEngine.selectedTargetId = entityId;
    clientEngine.sendSetTarget(entityId);
  };
  playerFrame = new UnitFrame({
    getPortrait,
    onClick: setTarget,
    hideCastBar: true,
    onBuffRightClick: (buffId) => {
      clientEngine.sendCancelBuff(buffId);
    },
  });
  targetFrame = new UnitFrame({ localPlayer: player, getPortrait, onClick: setTarget });
  totFrame = new TargetOfTargetFrame({ localPlayer: player, getPortrait, onClick: setTarget });

  // Arena frames (Gladdy-style opponent frames on right side)
  arenaFrames = new ArenaFrames({ localPlayer: player, getPortrait, onClick: setTarget });
  // Strip ArenaFrames' own fixed positioning (wrapper handles it)
  arenaFrames.element.style.position = '';
  arenaFrames.element.style.top = '';
  arenaFrames.element.style.right = '';
  arenaFrames.element.style.transform = '';
  arenaFrames.element.style.zIndex = '';

  // Party frames (friendly team members on left side, below player frame)
  partyFrames = new PartyFrames({ localPlayer: player, getPortrait, onClick: setTarget });

  // Register frames with positioner for drag-to-reposition
  positioner = new UnitFramePositioner();
  document.body.appendChild(positioner.register('player', playerFrame.element, { top: 12, left: 12 }));
  document.body.appendChild(positioner.register('target', targetFrame.element, { top: 12, left: 280 }));
  document.body.appendChild(positioner.register('tot', totFrame.element, { top: 51, left: 544 }));
  document.body.appendChild(positioner.register('party', partyFrames.element, { top: 150, left: 12 }, { stayBelow: { frameId: 'player', gap: 8 } }));
  const arenaDefaultLeft = window.innerWidth - 250;
  const arenaDefaultTop = Math.round(window.innerHeight / 2 - 100);
  document.body.appendChild(positioner.register('arena', arenaFrames.element, { top: arenaDefaultTop, left: arenaDefaultLeft }));
  const allEntities = entities
    .filter(e => e.id !== localEntityId)
    .map(e => {
      const targetable = makeTargetable(e.id);
      return targetable ? { entityId: e.id, targetable } : null;
    })
    .filter((e): e is { entityId: string; targetable: Targetable } => e !== null);
  arenaFrames.setEntities(allEntities);
  partyFrames.setEntities(allEntities);

  // Death frame
  deathFrame = new DeathFrame();
  document.body.appendChild(deathFrame.element);

  // Chat window
  chatWindow = new ChatWindow({
    onSend: (message) => {
      sendNetworkMessage({ type: 'game_chat', message });
    },
    canOpen: () => !escapeMenu?.isOpen && !keybindMenu.isOpen,
  });
  document.body.appendChild(chatWindow.element);

  // Action bar - abilities come from shared character data
  const abilities: readonly (Ability | null)[] = localCharStats.abilities;

  // Ground targeting state
  let pendingGroundAbility: Ability | null = null;

  function cancelGroundTargeting(): void {
    if (!pendingGroundAbility) return;
    pendingGroundAbility = null;
    clientEngine.targetingSystem.cancelGroundTarget();
  }

  clientEngine.targetingSystem.onGroundTargetCancelled = () => {
    pendingGroundAbility = null;
  };

  clientEngine.onGroundTargetConfirmed = () => {
    if (!pendingGroundAbility || !_clientEngine) return;
    const ability = pendingGroundAbility;
    const groundPos = clientEngine.targetingSystem.getGroundTargetPosition();
    clientEngine.targetingSystem.cancelGroundTarget();
    pendingGroundAbility = null;
    clientEngine.predictGroundAbility(ability.id);
    clientEngine.sendAbility(ability.id, selectedTargetId, { x: groundPos.x, y: groundPos.y, z: groundPos.z });
  };

  /** Fire an ability immediately (no GCD/cast checks). Used by both direct activation and queue callback. */
  function fireAbility(ability: Ability): void {
    if (clientEngine.getCooldownRemaining(ability.id) > 0) return;
    if (ability.groundTargeted) {
      if (pendingGroundAbility?.id === ability.id) {
        cancelGroundTargeting();
      } else {
        cancelGroundTargeting();
        pendingGroundAbility = ability;
        clientEngine.targetingSystem.startGroundTarget(ability.aoeRadius ?? 1, ability.range ?? 10);
      }
      return;
    }
    cancelGroundTargeting();
    // Only predict locally if the ability looks usable client-side (prevents false GCD flicker)
    if (getAbilityStatus(ability) === 'usable') {
      clientEngine.predictAbility(ability.id, selectedTargetId);
    }
    clientEngine.sendAbility(ability.id, selectedTargetId);
  }

  // Ability queue callback -- fires queued ability the instant GCD/cast ends
  clientEngine.onQueuedAbilityReady = (abilityId) => {
    const ability = abilities.find(a => a !== null && a.id === abilityId);
    if (!ability) return;
    fireAbility(ability);
  };

  function getAbilityStatus(ability: Ability): AbilityUsabilityStatus {
    if (ability.id !== 'crack-rock' && clientEngine.getLocalBuffs().some(b => b.id === 'dumpster-diving')) return 'locked';
    const effectiveManaCost = Math.round(ability.manaCost * clientEngine.getManaCostMultiplier());
    if (player.mana < effectiveManaCost) return 'not-enough-resource';
    if (ability.requiresHostileTarget) {
      if (!selectedTargetId) return 'no-target';
      const target = clientEngine.getRemoteEntity(selectedTargetId);
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
      const collision = clientEngine.mapManager.collision;
      if (!collision.hasLineOfSight(pos.x, pos.z, target.mesh.position.x, target.mesh.position.z, pos.y, target.mesh.position.y)) return 'not-in-los';
      // Facing check (120 degree cone, matches server)
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
      let targetId = selectedTargetId;
      // Friendly-only abilities self-cast when targeting a hostile
      if (ability.requiresFriendlyTarget && targetId && targetId !== clientEngine.localId) {
        const t = clientEngine.getRemoteEntity(targetId);
        if (t && t.team !== player.team) targetId = null;
      }
      // Check blockedByTargetDebuff on resolved target
      if (ability.blockedByTargetDebuff) {
        if (!targetId || targetId === clientEngine.localId) {
          if (clientEngine.getLocalBuffs().some(b => b.id === ability.blockedByTargetDebuff)) return 'no-target';
        } else {
          const t = clientEngine.getRemoteEntity(targetId);
          if (t && t.buffs.some(b => b.id === ability.blockedByTargetDebuff)) return 'no-target';
        }
      }
      if (targetId && targetId !== clientEngine.localId) {
        const target = clientEngine.getRemoteEntity(targetId);
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
          const collision = clientEngine.mapManager.collision;
          if (!collision.hasLineOfSight(pos.x, pos.z, target.mesh.position.x, target.mesh.position.z, pos.y, target.mesh.position.y)) return 'not-in-los';
        }
      }
    }
    return 'usable';
  }

  actionBar = new ActionBar({
    onActivate: (ability) => {
      // Attack toggle -- bypass GCD/queue, just toggle auto-attack
      if (ability.isAutoAttack) {
        if (clientEngine.playerController.isAutoAttacking) {
          clientEngine.sendStopAutoAttack();
        } else if (selectedTargetId) {
          if (clientEngine.isResting()) clientEngine.stopResting();
          clientEngine.sendAutoAttack(selectedTargetId);
        }
        return;
      }

      if (clientEngine.isResting()) clientEngine.stopResting();
      // Cancel current channel if starting new ability (same as playground)
      const castState = clientEngine.getLocalCastingState();
      if (castState?.isChannel && clientEngine.getCooldownRemaining(ability.id) <= 0) {
        clientEngine.sendCancelCast();
      }

      // Determine if blocked by GCD or casting
      const gcdRemaining = clientEngine.getGcdRemaining();
      const gcdBlocked = !ability.usableWhileCCd && gcdRemaining > 0;
      const castBlocked = castState !== null && !castState.isChannel;
      const castRemaining = castBlocked ? Math.max(0, castState!.totalTime - castState!.elapsed) : 0;

      if (gcdBlocked || castBlocked) {
        // Queue if within queue window (last 400ms of GCD/cast)
        const blockingRemaining = Math.max(
          gcdBlocked ? gcdRemaining : 0,
          castBlocked ? castRemaining : 0,
        );
        if (clientEngine.isWithinQueueWindow(blockingRemaining)) {
          clientEngine.queueAbility(ability.id, selectedTargetId);
        }
        return;
      }

      // Not blocked -- clear queue and fire immediately
      clientEngine.clearAbilityQueue();
      fireAbility(ability);
    },
    getAbilityStatus,
    getCombatSystem: () => ({
      getCooldownRemaining: (id: string) => clientEngine.getCooldownRemaining(id),
      getCooldownTotal: (id: string) => clientEngine.getCooldownTotal(id),
    }) as any,
    getGcdRemaining: () => clientEngine.getGcdRemaining(),
    getGcdTotal: () => clientEngine.getGcdTotal(),
    isDisabled: () => {
      if (player.dead || player.stunned || player.charging) return true;
      const castState = clientEngine.getLocalCastingState();
      if (castState && !castState.isChannel) {
        // Allow ability presses in the last 400ms of a cast for queuing
        const castRemaining = Math.max(0, castState.totalTime - castState.elapsed);
        return !clientEngine.isWithinQueueWindow(castRemaining);
      }
      return false;
    },
    getQueuedAbilityId: () => clientEngine.getQueuedAbilityId(),
    isAutoAttacking: () => clientEngine.playerController.isAutoAttacking,
  });
  document.body.appendChild(actionBar.element);
  const charId = (localSnap?.characterId ?? 'janitor') as string;
  actionBar.loadAbilities(charId, abilities);

  // Cast bar
  castBarContainer = document.createElement('div');
  castBarContainer.style.cssText = `
    position: fixed; bottom: 84px; left: 50%; transform: translateX(-50%);
    width: 240px; z-index: 100; display: none;
  `;
  castBarHeader = document.createElement('div');
  castBarHeader.style.cssText = `
    display: flex; justify-content: space-between; color: #ddd;
    font-size: 11px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    margin-bottom: 2px; text-shadow: 1px 1px 2px rgba(0,0,0,0.9);
  `;
  const castBarBg = document.createElement('div');
  castBarBg.style.cssText = `
    height: 14px; background: rgba(0, 0, 0, 0.7);
    border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 3px; overflow: hidden;
  `;
  castBarFill = document.createElement('div');
  castBarFill.style.cssText = `height: 100%; background: linear-gradient(to right, #4488ff, #66aaff); width: 0%;`;
  castBarBg.appendChild(castBarFill);
  castBarContainer.appendChild(castBarHeader);
  castBarContainer.appendChild(castBarBg);
  document.body.appendChild(castBarContainer);

  // Escape menu
  escapeMenu = new EscapeMenu({
    onReturnToLobby: () => {
      showLobby();
      sendNetworkMessage({ type: 'return_to_lobby' });
    },
    onEscapeWhilePlaying: () => {
      if (pendingGroundAbility) {
        cancelGroundTargeting();
        return true;
      }
      if (clientEngine.getLocalCastingState()) {
        clientEngine.sendCancelCast();
        return true;
      }
      if (selectedTargetId) {
        selectedTargetId = null;
        clientEngine.selectedTargetId = null;
        clientEngine.targetingSystem.currentTarget = null;
        clientEngine.sendSetTarget(null);
        clientEngine.sendStopAutoAttack();
        clientEngine.onTargetChanged?.(null);
        return true;
      }
      return false;
    },
    isRematchEnabled: () => {
      if (!_clientEngine) return false;
      // Enabled during Arena Preparation (before gates open) or after game over
      return gameOverOverlay.isGameOver || clientEngine.getLocalBuffs().some(b => b.id === 'arena-preparation');
    },
    onRematch: (mapMode) => {
      sendNetworkMessage({ type: 'request_rematch', mapMode });
    },
    confirmExit: () => !gameOverOverlay.isGameOver,
    onKeybinds: () => {
      escapeMenu?.close();
      keybindMenu.open(() => escapeMenu?.open());
    },
    onAudio: () => {
      escapeMenu?.close();
      new AudioSettingsDialog(() => escapeMenu?.open()).open();
    },
  });
  document.body.appendChild(escapeMenu.element);

  // Debug HUD (toggle with L key)
  debugHUD = new DebugHUD(true);
  document.body.appendChild(debugHUD.element);

  // Targeting and auto-attack are handled inside ClientEngine via InputManager
  // (same polling approach as playground mode -- no DOM event handlers needed)
  clientEngine.onTargetChanged = (entityId) => {
    selectedTargetId = entityId;
  };

  // Start UI update loop
  let lastFrameTime = performance.now();
  function updateFrames(): void {
    frameLoopId = requestAnimationFrame(updateFrames);
    const now = performance.now();
    // Throttle to ~30 FPS when tab is visible but not focused
    const focused = document.hasFocus();
    if (!focused && now - lastFrameTime < 33) return;
    const dt = Math.min((now - lastFrameTime) / 1000, focused ? 0.1 : 0.2);
    lastFrameTime = now;

    if (!_clientEngine) return;

    // Player frame -- PlayerController implements Targetable directly
    if (playerFrame) {
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
      playerFrame.update(player, pBuffList, pDebuffList);
    }

    // Target frame
    if (selectedTargetId && targetFrame) {
      const targetTarget = makeTargetable(selectedTargetId);
      if (targetTarget) {
        // Use local buffs when targeting self, remote entity buffs otherwise
        const isSelf = selectedTargetId === clientEngine.localId;
        const rawBuffs = isSelf ? clientEngine.getLocalBuffs() : (clientEngine.getRemoteEntity(selectedTargetId)?.buffs ?? []);
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
        targetFrame.update(targetTarget, tBuffs, tDebuffs);
      } else {
        targetFrame.update(null);
      }
    } else if (targetFrame) {
      targetFrame.update(null);
    }

    // Target of Target frame (hidden when target is self -- already shown in player frame)
    if (totFrame) {
      let totTargetable: Targetable | null = null;
      if (selectedTargetId && selectedTargetId !== clientEngine.localId) {
        const totId = clientEngine.getRemoteEntity(selectedTargetId)?.targetEntityId ?? null;
        // Don't expose invisible enemies via ToT
        if (totId && !clientEngine.isEntityInvisibleToLocal(totId)) totTargetable = makeTargetable(totId);
      }
      totFrame.update(totTargetable);
    }

    // Arena frames (opponent frames on right side)
    if (arenaFrames) {
      const inPrep = clientEngine.getLocalBuffs().some(b => b.id === 'arena-preparation');
      arenaFrames.setVisible(true);
      arenaFrames.setDisabled(inPrep);
      arenaFrames.setSelectedTarget(selectedTargetId);
      arenaFrames.update(dt, (entityId) => {
        const e = clientEngine.getRemoteEntity(entityId);
        if (!e?.drTimers) return [];
        return e.drTimers.map(dr => ({
          icon: dr.icon,
          count: dr.count,
          remaining: dr.remaining,
          total: dr.total,
        }));
      }, (entityId) => clientEngine.isEntityInvisibleToLocal(entityId));
    }

    // Party frames (friendly team members on left side)
    if (partyFrames) {
      const inPrep = clientEngine.getLocalBuffs().some(b => b.id === 'arena-preparation');
      partyFrames.setVisible(true);
      partyFrames.setDisabled(inPrep);
      partyFrames.setSelectedTarget(selectedTargetId);
      partyFrames.update(dt, (entityId) => {
        const e = clientEngine.getRemoteEntity(entityId);
        if (!e?.buffs) return [];
        return e.buffs.filter(b => b.type === 'debuff').map(b => ({
          definition: { id: b.id, name: b.name, icon: b.icon, duration: b.duration, type: b.type as 'debuff', description: b.description, effects: [] },
          remaining: b.remaining,
          appliedAt: Date.now(),
          stacks: b.stacks,
        }));
      });
    }

    playerFrame?.updateCombatText(dt);
    targetFrame?.updateCombatText(dt);
    actionBar?.update();
    combatText?.update(dt);
    if (debugHUD) {
      debugHUD.update(dt);
      debugHUD.pushLatency(clientEngine.latency);
    }

    // Nameplates: local player + remote entities
    if (nameplates) {
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
      nameplates.update(player, npcsTargetable, (target) => debuffMap.get(target) ?? [], isBlinded);
    }

    // Unit tooltip (hover)
    if (unitTooltip) {
      const hovered = clientEngine.targetingSystem.getHoveredTarget();
      unitTooltip.update(hovered, (entity) => {
        // Resolve the hovered entity's target to a name
        let targetId: string | null = null;
        if (entity === (player as unknown as Targetable)) {
          targetId = clientEngine.selectedTargetId;
        } else {
          for (const e of clientEngine.getAllRemoteEntities()) {
            if (e.targetable === entity) { targetId = e.targetEntityId; break; }
          }
        }
        if (!targetId) return 'None';
        const targetEntity = clientEngine.getEntity(targetId);
        return targetEntity ? targetEntity.name : 'None';
      }, dt);
    }

    // Cast bar
    const castState = clientEngine.getLocalCastingState();
    if (castState && castBarContainer && castBarFill && castBarHeader) {
      castBarContainer.style.display = 'block';
      let progress: number;
      if (castState.isChannel) {
        progress = Math.max(0, (castState.totalTime - castState.elapsed) / castState.totalTime);
        castBarFill.style.background = 'linear-gradient(to right, #cc8833, #eebb55)';
      } else {
        progress = Math.min(1, castState.elapsed / castState.totalTime);
        castBarFill.style.background = 'linear-gradient(to right, #4488ff, #66aaff)';
      }
      castBarFill.style.width = `${progress * 100}%`;
      const remaining = Math.max(0, castState.totalTime - castState.elapsed);
      const ab = abilities.find(a => a !== null && a.id === castState.abilityId);
      castBarHeader.innerHTML = `<span>${ab?.name ?? castState.abilityId}</span><span>${remaining.toFixed(1)}s</span>`;
    } else if (castBarContainer) {
      castBarContainer.style.display = 'none';
    }

    // Death frame
    if (deathFrame) {
      if (player.dead && !deathFrame.visible) deathFrame.show();
      else if (!player.dead && deathFrame.visible) deathFrame.hide();
    }
  }
  updateFrames();
}

// ── Callbacks ─────────────────────────────────────────────────────────

export function wireCallbacks(
  clientEngine: ClientEngine,
  sendNetworkMessage: (msg: any) => void,
  toggleGodModeOverlay: (active: boolean) => void,
): void {
  clientEngine.onError = (message) => errorText?.show(message);
  clientEngine.onGodModeToggle = (active) => toggleGodModeOverlay(active);

  const script = clientEngine.mapManager.getScript();
  if (script && 'onVoteOpenGates' in script) {
    (script as any).onVoteOpenGates = () => {
      sendNetworkMessage({ type: 'vote_open_gates' });
    };
  }

  clientEngine.onCombatText = (sourceEntityId, targetEntityId, amount, type) => {
    if (amount === 0 && type !== 'miss' && type !== 'dodge' && type !== 'immune') return;
    const localId = clientEngine.localId;
    const isLocalInvolved = sourceEntityId === localId || targetEntityId === localId;
    if (isLocalInvolved) {
      const mesh = clientEngine.getEntityMesh(targetEntityId);
      if (mesh && combatText) {
        const isIncoming = targetEntityId === localId;
        combatText.spawn(mesh, amount, type as any, isIncoming);
      }
    }
    if (targetEntityId === localId) {
      playerFrame?.showCombatText(amount, type as any);
    } else if (targetEntityId === selectedTargetId) {
      targetFrame?.showCombatText(amount, type as any);
    }
    if (arenaFrames?.hasEntity(targetEntityId)) {
      arenaFrames.showCombatText(targetEntityId, amount, type as any);
    }
    if (partyFrames?.hasEntity(targetEntityId)) {
      partyFrames.showCombatText(targetEntityId, amount, type as any);
    }
  };

  clientEngine.onEnterCombat = (entityId) => {
    if (entityId === clientEngine.localId) {
      const mesh = clientEngine.getEntityMesh(entityId);
      if (mesh && combatText) combatText.spawnText(mesh, '+Combat', '#cc3333', true);
    }
  };
  clientEngine.onLeaveCombat = (entityId) => {
    if (entityId === clientEngine.localId) {
      const mesh = clientEngine.getEntityMesh(entityId);
      if (mesh && combatText) combatText.spawnText(mesh, '-Combat', '#33cc33', true);
    }
  };

  clientEngine.onBuffApplied = (entityId, buff) => {
    if (entityId === clientEngine.localId) {
      const mesh = clientEngine.getEntityMesh(entityId);
      if (mesh && combatText) {
        const color = buff.type === 'buff' ? '#3388ff' : '#ff6644';
        combatText.spawnText(mesh, `+${buff.name}`, color, true);
      }
    }
  };
  clientEngine.onBuffExpired = (entityId, buff) => {
    if (entityId === clientEngine.localId) {
      const mesh = clientEngine.getEntityMesh(entityId);
      if (mesh && combatText) {
        combatText.spawnText(mesh, `-${buff.name}`, '#888888', true);
      }
    }
  };
  clientEngine.onAbilitySuccess = (abilityId) => {
    if (abilityId === 'shank' || abilityId === 'pocket-sand' || abilityId === 'tweaker-sprint' || abilityId === 'gank') {
      const mesh = clientEngine.getEntityMesh(clientEngine.localId);
      if (mesh && combatText) {
        combatText.spawnText(mesh, '+15 Tweaking', '#3388ff', true);
      }
    }
    if (abilityId === 'crack-rock') {
      const mesh = clientEngine.getEntityMesh(clientEngine.localId);
      if (mesh && combatText) {
        combatText.spawnText(mesh, '+25 Tweaking', '#3388ff', true);
      }
    }
  };
  clientEngine.onManaDrained = (amount) => {
    const mesh = clientEngine.getEntityMesh(clientEngine.localId);
    if (mesh && combatText) {
      combatText.spawnText(mesh, `+${amount} Mana`, '#3388ff', true);
    }
  };
  clientEngine.onAbilityEffect = (entityId, abilityId) => {
    if (abilityId === 'pvp-trinket') {
      arenaFrames?.notifyTrinketUsed(entityId);
    }
  };
}

// ── Cleanup ───────────────────────────────────────────────────────────

export function cleanup(): void {
  actionBar?.dispose();
  actionBar = null;
  positioner?.dispose();
  positioner = null;
  playerFrame = null;
  targetFrame = null;
  totFrame = null;
  errorText?.element.remove();
  errorText = null;
  combatText?.element.remove();
  combatText = null;
  nameplates?.element.remove();
  nameplates = null;
  unitTooltip?.dispose();
  unitTooltip = null;
  castBarContainer?.remove();
  castBarContainer = null;
  castBarFill = null;
  castBarHeader = null;
  escapeMenu?.dispose();
  escapeMenu = null;
  debugHUD?.dispose();
  debugHUD = null;
  arenaFrames?.dispose();
  arenaFrames = null;
  partyFrames?.dispose();
  partyFrames = null;
  deathFrame?.element.remove();
  deathFrame = null;
  chatWindow?.dispose();
  chatWindow = null;
  if (frameLoopId !== null) {
    cancelAnimationFrame(frameLoopId);
    frameLoopId = null;
  }
  selectedTargetId = null;
  _clientEngine = null;
}
