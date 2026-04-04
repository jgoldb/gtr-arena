/**
 * PlaygroundSession — shared UI wiring for all local (non-multiplayer) game modes.
 *
 * startSinglePlayer(), startPlayground(), and startUISetup() in main.ts used to
 * duplicate ~400 lines of identical setup code (unit frames, action bar, combat
 * callbacks, cast bar, ground targeting, update loop, etc.).  This module
 * extracts that shared logic into a single `createPlaygroundSession()` factory.
 */

import type { Engine } from './Engine';
import type { Vector3 } from 'three';
import { UnitFrame } from '../ui/UnitFrame';
import { TargetOfTargetFrame } from '../ui/TargetOfTargetFrame';
import { ActionBar } from '../ui/ActionBar';
import { ErrorText } from '../ui/ErrorText';
import { FloatingCombatText } from '../ui/FloatingCombatText';
import { Nameplates } from '../ui/Nameplates';
import { UnitTooltip } from '../ui/UnitTooltip';
import { EscapeMenu } from '../ui/EscapeMenu';
import { AudioSettingsDialog } from '../ui/AudioSettingsDialog';
import { DeathFrame } from '../ui/DeathFrame';
import { ArenaFrames } from '../ui/ArenaFrames';
import { PartyFrames } from '../ui/PartyFrames';
import { UnitFramePositioner } from '../ui/UnitFramePositioner';
import { DebugHUD } from '../ui/DebugHUD';
import { soundEffects } from '../ui/SoundEffects';
import { getCharacterStats, getCharacterSfx, getSharedSfx } from '@gtr/shared';
import {
  GLOBAL_COOLDOWN,
  FartBombDebuff,
  ChemicalSpillSpeedBuff,
  ChemicalSpillDot,
  CrotchRotDot,
  ParanoidDebuff,
  yardsToUnits,
  type Ability,
} from './combat/Ability';
import type { Targetable } from './types';
import type { KeybindMenu } from '../ui/KeybindMenu';

// ── Public API ────────────────────────────────────────────────────────

export interface PlaygroundSessionConfig {
  engine: Engine;
  canvas: HTMLCanvasElement;
  getPortrait: (modelName: string) => string | undefined;
  keybindMenu: KeybindMenu;
  onReturnToLobby: () => void;

  // Optional, mode-specific
  showRespawnButton?: boolean;
  showDebugHUD?: boolean;
  wireCharacterChange?: boolean;
  onGodModeToggle?: (active: boolean) => void;
  skipArenaPreparation?: boolean;
  /** Called once per frame at the end of the update loop (e.g. game-over check). */
  onFrameUpdate?: () => void;

  /** If provided, a PartyFrames widget is created for these allies. */
  partyFrameEntities?: Array<{ entityId: string; targetable: Targetable }>;
  /** If provided, an ArenaFrames widget is created for these enemies. */
  arenaFrameEntities?: Array<{ entityId: string; targetable: Targetable }>;
}

export interface PlaygroundSession {
  readonly engine: Engine;
  readonly actionBar: ActionBar;
  readonly errorText: ErrorText;
  dispose(): void;
}

// ── Factory ───────────────────────────────────────────────────────────

export function createPlaygroundSession(config: PlaygroundSessionConfig): PlaygroundSession {
  const {
    engine,
    canvas,
    getPortrait,
    keybindMenu,
    onReturnToLobby,
    showRespawnButton = false,
    showDebugHUD = false,
    wireCharacterChange = false,
    onGodModeToggle,
    skipArenaPreparation = false,
    onFrameUpdate,
    partyFrameEntities,
    arenaFrameEntities,
  } = config;

  // ── Unit frames ─────────────────────────────────────────────────────

  const setTarget = (t: Targetable) => { engine.targetingSystem.currentTarget = t; };

  const playerFrame = new UnitFrame({
    getPortrait,
    onClick: setTarget,
    hideCastBar: true,
    onBuffRightClick: (buffId) => {
      engine.buffSystem.remove(engine.playerController, buffId);
    },
  });

  const targetFrame = new UnitFrame({ localPlayer: engine.playerController, getPortrait, onClick: setTarget });
  const totFrame = new TargetOfTargetFrame({ localPlayer: engine.playerController, getPortrait, onClick: setTarget });

  const positioner = new UnitFramePositioner();
  document.body.appendChild(positioner.register('player', playerFrame.element, { top: 12, left: 12 }));
  document.body.appendChild(positioner.register('target', targetFrame.element, { top: 12, left: 280 }));
  document.body.appendChild(positioner.register('tot', totFrame.element, { top: 51, left: 544 }));

  // ── Party / Arena frames (ui-setup only) ────────────────────────────

  let partyFrames: PartyFrames | null = null;
  let arenaFrames: ArenaFrames | null = null;
  let npcByEntityId: Map<string, Targetable> | null = null;

  if (partyFrameEntities) {
    partyFrames = new PartyFrames({ localPlayer: engine.playerController, getPortrait, onClick: setTarget });
    partyFrames.setEntities(partyFrameEntities);
    document.body.appendChild(
      positioner.register('party', partyFrames.element, { top: 150, left: 12 }, { stayBelow: { frameId: 'player', gap: 8 } }),
    );
  }

  if (arenaFrameEntities) {
    arenaFrames = new ArenaFrames({ localPlayer: engine.playerController, getPortrait, onClick: setTarget });
    arenaFrames.element.style.position = '';
    arenaFrames.element.style.top = '';
    arenaFrames.element.style.right = '';
    arenaFrames.element.style.transform = '';
    arenaFrames.element.style.zIndex = '';
    arenaFrames.setEntities(arenaFrameEntities);
    const arenaDefaultLeft = window.innerWidth - 250;
    const arenaDefaultTop = Math.round(window.innerHeight / 2 - 100);
    document.body.appendChild(positioner.register('arena', arenaFrames.element, { top: arenaDefaultTop, left: arenaDefaultLeft }));
  }

  if (partyFrameEntities || arenaFrameEntities) {
    const all = [...(partyFrameEntities ?? []), ...(arenaFrameEntities ?? [])];
    npcByEntityId = new Map(all.map(e => [e.entityId, e.targetable]));
  }

  // ── Error / combat text / nameplates / tooltip ──────────────────────

  const errorText = new ErrorText();
  document.body.appendChild(errorText.element);

  const combatText = new FloatingCombatText(engine.camera);
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
  document.body.appendChild(nameplates.element);

  const unitTooltip = new UnitTooltip(engine.playerController);
  document.body.appendChild(unitTooltip.element);

  // ── Combat system callbacks ─────────────────────────────────────────

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

  // Apply arena preparation after callbacks are wired so SCT shows it
  if (!skipArenaPreparation) {
    engine.applyArenaPreparation();
  }

  // ── Death frame ─────────────────────────────────────────────────────

  const deathFrame = new DeathFrame();
  if (showRespawnButton) {
    const respawnBtn = document.createElement('button');
    respawnBtn.textContent = 'Respawn';
    respawnBtn.style.cssText = 'margin-top: 12px; padding: 10px 32px; font-size: 15px; font-weight: bold; background: rgba(180,60,60,0.85); color: #eee; border: 1px solid #cc4444; border-radius: 4px; cursor: pointer; outline: none; pointer-events: auto;';
    respawnBtn.addEventListener('click', () => { engine.respawnPlayer(); deathFrame.hide(); });
    deathFrame.element.querySelector('div')!.appendChild(respawnBtn);
  }
  document.body.appendChild(deathFrame.element);

  // ── Cast bar ────────────────────────────────────────────────────────

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

  // ── Ground targeting ────────────────────────────────────────────────

  const MELEE_AUTO_ATTACK_ABILITIES = ['mop', 'big-boot', 'jimmy-legs', 'shank', 'gank'];
  let pendingGroundAbility: Ability | null = null;

  function cancelGroundTargeting(): void {
    if (!pendingGroundAbility && !engine.pendingNpcSpawn) return;
    pendingGroundAbility = null;
    engine.pendingNpcSpawn = null;
    engine.targetingSystem.cancelGroundTarget();
  }

  engine.targetingSystem.onGroundTargetCancelled = () => {
    pendingGroundAbility = null;
    engine.pendingNpcSpawn = null;
  };

  engine.onGroundTargetConfirmed = () => {
    // NPC spawn ground targeting (playground only, harmless in other modes)
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

  // ── Ability success handler ─────────────────────────────────────────

  function onAbilitySuccess(ability: Ability, groundPos?: Vector3): void {
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
    if (ability.id === 'fart-bomb') {
      const fartSfx = getCharacterSfx(engine.playerController.characterId)?.fartBomb;
      if (fartSfx) soundEffects.play(fartSfx.url, undefined, undefined, fartSfx.volume);
      engine.spawnGasCloud(engine.playerController.mesh.position.clone(), yardsToUnits(5), 8, FartBombDebuff, 592, 2, engine.playerController);
    }
    if (ability.id === 'janitors-helper') {
      const jhSfx = getCharacterSfx(engine.playerController.characterId)?.janitorsHelper;
      if (jhSfx) soundEffects.play(jhSfx.url, undefined, undefined, jhSfx.volume);
    }
    if (ability.id === 'pocket-sand') {
      const psSfx = getCharacterSfx(engine.playerController.characterId)?.pocketSand;
      if (psSfx) soundEffects.play(psSfx.url, undefined, undefined, psSfx.volume);
    }
    if (ability.id === 'sweep') {
      const sweepStartSfx = getCharacterSfx(engine.playerController.characterId)?.sweepStart;
      if (sweepStartSfx) soundEffects.play(sweepStartSfx.url, undefined, undefined, sweepStartSfx.volume);
      engine.startSweepCharge();
    }
    if (ability.id === 'discombobulate') {
      const discSfx = getCharacterSfx(engine.playerController.characterId)?.discombobulate;
      if (discSfx) {
        const dist = targetPos ? engine.playerController.mesh.position.distanceTo(targetPos) : undefined;
        const pan = targetPos ? engine.sfxPan(targetPos) : undefined;
        soundEffects.play(discSfx.url, dist, pan, discSfx.volume);
      }
    }
    if (ability.id === 'kaboom') {
      const kaboomSfx = getCharacterSfx(engine.playerController.characterId)?.kaboom;
      if (kaboomSfx) soundEffects.play(kaboomSfx.url, undefined, undefined, kaboomSfx.volume);
      engine.executeKaboom();
    }
    if (ability.id === 'chemical-spill') {
      const csSfx = getCharacterSfx(engine.playerController.characterId)?.chemicalSpill;
      if (csSfx) soundEffects.play(csSfx.url, undefined, undefined, csSfx.volume);
      engine.spawnChemicalPool(engine.playerController.mesh.position.clone(), yardsToUnits(3), 30, ChemicalSpillSpeedBuff, ChemicalSpillDot, 297, 349, 600, 2, 6, engine.playerController, 2);
    }
    if (ability.id === 'retard-strength') {
      const rsSfx = getCharacterSfx(engine.playerController.characterId)?.retardStrength;
      if (rsSfx) soundEffects.play(rsSfx.url, undefined, undefined, rsSfx.volume);
    }
    if (ability.id === 'crotch-rot') {
      const crSfx = getCharacterSfx(engine.playerController.characterId)?.crotchRot;
      if (crSfx) soundEffects.play(crSfx.url, undefined, undefined, crSfx.volume);
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
      const crackRockSfx = getCharacterSfx(engine.playerController.characterId)?.crackRock;
      if (crackRockSfx) soundEffects.play(crackRockSfx.url, undefined, undefined, crackRockSfx.volume);
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
      const tsSfx = getCharacterSfx(engine.playerController.characterId)?.tweakerSprint;
      if (tsSfx) soundEffects.play(tsSfx.url, undefined, undefined, tsSfx.volume);
      const target = engine.targetingSystem.currentTarget;
      if (target && !target.dead) {
        engine.startTweakerSprintCharge(target);
      }
    }
    if (ability.id === 'sticky-fingers') {
      const sfSfx = getCharacterSfx(engine.playerController.characterId)?.stickyFingers;
      if (sfSfx) soundEffects.play(sfSfx.url, undefined, undefined, sfSfx.volume);
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

  // ── Engine callbacks ────────────────────────────────────────────────

  engine.onCastComplete = (ability) => onAbilitySuccess(ability);
  engine.onCastFailed = (message) => errorText.show(message);
  engine.onAutoAttackError = (message) => errorText.show(message);
  engine.onRestError = (message) => errorText.show(message);

  if (onGodModeToggle) {
    engine.onGodModeToggle = onGodModeToggle;
  }

  // ── Action bar ──────────────────────────────────────────────────────

  const actionBar = new ActionBar({
    onActivate: (ability) => {
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
      if (!engine.godMode && !ability.usableWhileCCd && engine.combatSystem.getGcdRemaining() > 0) return;

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
          if (!engine.godMode && !ability.usableWhileCCd) engine.combatSystem.triggerGcd(GLOBAL_COOLDOWN);
          if (ability.id === 'pvp-trinket') {
            engine.buffSystem.removeAllCCEffects(engine.playerController);
            const trinketSfx = getSharedSfx().pvpTrinket;
            if (trinketSfx) soundEffects.play(trinketSfx.url, undefined, undefined, trinketSfx.volume);
          }
        } else if (result.errorMessage) {
          errorText.show(result.errorMessage);
        }
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

  document.body.appendChild(actionBar.element);
  actionBar.loadAbilities(engine.playerController.characterId, engine.playerController.abilities);

  if (wireCharacterChange) {
    engine.onCharacterChange = () => {
      cancelGroundTargeting();
      actionBar.loadAbilities(engine.playerController.characterId, engine.playerController.abilities);
    };
  }

  // ── Escape menu ─────────────────────────────────────────────────────

  const escapeMenu = new EscapeMenu({
    onReturnToLobby,
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
  document.body.appendChild(escapeMenu.element);

  // ── Debug HUD ───────────────────────────────────────────────────────

  let debugHUD: DebugHUD | null = null;
  if (showDebugHUD) {
    debugHUD = new DebugHUD(false);
    document.body.appendChild(debugHUD.element);
  }

  // ── Frame update loop ───────────────────────────────────────────────

  let frameLoopId: number | null = null;
  let lastFrameTime = performance.now();

  function updateFrames(): void {
    frameLoopId = requestAnimationFrame(updateFrames);
    const now = performance.now();
    const focused = document.hasFocus();
    if (!focused && now - lastFrameTime < 33) return;
    const dt = Math.min((now - lastFrameTime) / 1000, focused ? 0.1 : 0.2);
    lastFrameTime = now;

    const bs = engine.buffSystem;

    // Player / target / ToT frames
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

    // Cast bar
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

    // Combat text / nameplates / tooltip
    combatText.update(dt);
    const visibleNpcs = engine.getNpcs().filter(n => !bs.isUntargetable(n));
    nameplates.update(engine.playerController, visibleNpcs, (target) => {
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

    // Party / arena frames (ui-setup)
    if (partyFrames && npcByEntityId) {
      partyFrames.setVisible(true);
      partyFrames.update(dt, (entityId) => {
        const t = npcByEntityId!.get(entityId);
        if (!t) return [];
        return bs.getDebuffs(t);
      });
    }
    if (arenaFrames && npcByEntityId) {
      arenaFrames.setVisible(true);
      arenaFrames.update(dt, (entityId) => {
        const t = npcByEntityId!.get(entityId);
        if (!t) return [];
        return bs.getDRTimers(t);
      });
    }

    debugHUD?.update(dt);

    // Death frame
    if (engine.playerController.dead && !deathFrame.visible) deathFrame.show();
    else if (!engine.playerController.dead && deathFrame.visible) deathFrame.hide();

    // Mode-specific per-frame callback
    onFrameUpdate?.();
  }

  updateFrames();

  // ── Resize + start ──────────────────────────────────────────────────

  let resizeHandler: (() => void) | null = () => engine.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', resizeHandler);
  engine.start();

  // ── Session object ──────────────────────────────────────────────────

  return {
    engine,
    actionBar,
    errorText,

    dispose(): void {
      if (frameLoopId !== null) {
        cancelAnimationFrame(frameLoopId);
        frameLoopId = null;
      }
      if (resizeHandler) {
        window.removeEventListener('resize', resizeHandler);
        resizeHandler = null;
      }
      engine.dispose();
      actionBar.dispose();
      positioner.dispose();
      errorText.element.remove();
      combatText.element.remove();
      nameplates.element.remove();
      unitTooltip.dispose();
      deathFrame.element.remove();
      castBarContainer.remove();
      escapeMenu.dispose();
      debugHUD?.dispose();
      arenaFrames?.dispose();
      partyFrames?.dispose();
    },
  };
}
