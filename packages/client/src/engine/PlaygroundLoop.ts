/**
 * PlaygroundLoop — owns the per-frame game loop for the Playground
 * (single-player) engine.
 *
 * Extracted from Engine.ts.  Handles input processing, buff/CC state sync,
 * casting animation, charge management, NPC state, and system tick ordering.
 */

import type * as THREE from 'three';
import { yardsToUnits } from './combat/Ability';
import type { Targetable } from './types';
import type { PlayerController } from './player/PlayerController';
import type { NpcController } from './npc/NpcController';
import type { InputManager } from './input/InputManager';
import type { TargetingSystem } from './targeting/TargetingSystem';
import type { BuffSystem } from './combat/BuffSystem';
import type { CombatSystem } from './combat/CombatSystem';
import type { CastingSystem } from './combat/CastingSystem';
import type { AutoAttackSystem } from './combat/AutoAttackSystem';
import type { RegenSystem } from './combat/RegenSystem';
import type { Renderer } from './renderer/Renderer';
import type { ThirdPersonCamera } from './camera/ThirdPersonCamera';
import type { MapManager } from './map/MapManager';
import type { PlaygroundEffects } from './effects/PlaygroundEffects';
import type { BlindEffect } from './effects/BlindEffect';
import type { PlaygroundNpcSystem } from './PlaygroundNpcSystem';
import type { GasCloudSystem, DotSystem, ChemicalPoolSystem, ChargeSystem, FullRetardAuraSystem } from '@gtr/shared';
import { keybindManager } from '../ui/KeybindManager';
import { soundEffects } from '../ui/SoundEffects';

// ── Host interface ──────────────────────────────────────────────────

/** The parent Engine implements this so the loop can read/write game state. */
export interface PlaygroundLoopHost {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly clock: THREE.Clock;
  readonly renderer: Renderer;
  readonly input: InputManager;
  readonly playerController: PlayerController;
  readonly targetingSystem: TargetingSystem;
  readonly mapManager: MapManager;
  readonly thirdPersonCamera: ThirdPersonCamera;
  readonly buffSystem: BuffSystem;
  readonly combatSystem: CombatSystem;
  readonly castingSystem: CastingSystem;
  readonly autoAttackSystem: AutoAttackSystem;
  readonly regenSystem: RegenSystem;
  readonly chargeSystem: ChargeSystem<Targetable>;
  readonly effects: PlaygroundEffects;
  readonly blindEffect: BlindEffect;
  readonly gasCloudSystem: GasCloudSystem<Targetable>;
  readonly chemPoolSystem: ChemicalPoolSystem<Targetable>;
  readonly dotSystem: DotSystem<Targetable>;
  readonly fullRetardAuraSystem: FullRetardAuraSystem<Targetable>;
  readonly npcSystem: PlaygroundNpcSystem;

  // Mutable Engine state
  godMode: boolean;
  isAdmin: boolean;
  resting: boolean;
  pendingNpcSpawn: { characterId: import('@gtr/shared').CharacterId; team?: number } | null;

  // Actions
  startAutoAttack(target: Targetable): void;
  stopAutoAttack(): void;
  startResting(): boolean;
  stopResting(): void;
  updateActiveDots(dt: number): void;
  updatePendingAoeImpacts(dt: number): void;
  removeNpc(npc: NpcController): void;
  sfxPan(sourcePos: THREE.Vector3): number;

  // Callbacks
  onGroundTargetConfirmed?: () => void;
  onGodModeToggle?: (active: boolean) => void;
}

// ── PlaygroundLoop ──────────────────────────────────────────────────

export class PlaygroundLoop {
  private readonly host: PlaygroundLoopHost;

  // Key edge-detection (previous frame state)
  private rKeyWasDown = false;
  private tabKeyWasDown = false;
  private fKeyWasDown = false;
  private gKeyWasDown = false;

  constructor(host: PlaygroundLoopHost) {
    this.host = host;
  }

  /** Run one frame of game logic. Called from Engine.loop after deltaTime is computed. */
  update(deltaTime: number): void {
    const { host } = this;
    const { input, playerController, targetingSystem, buffSystem, autoAttackSystem } = host;

    // ── Input processing ──────────────────────────────────────────

    const click = input.getLeftClick();
    if (click) {
      if (targetingSystem.groundTargetActive) {
        if (!targetingSystem.groundTargetBlocked) {
          host.onGroundTargetConfirmed?.();
        }
      } else if (!input.isMouseButtonDown('right')) {
        targetingSystem.processClick(click.x, click.y);
      }
    }

    // Process right-click for auto-attack
    const rightClick = input.getRightClick();
    if (rightClick) {
      const target = targetingSystem.processRightClick(rightClick.x, rightClick.y);
      if (target && target.isHostileTo(playerController) && !target.dead) {
        host.startAutoAttack(target);
      }
    }

    // Update cursor for hover detection (only when pointer is unlocked)
    targetingSystem.updateHoverCursor(input.getMouseScreenPos(), input.isMouseButtonDown('right'));

    // Stop auto-attack if player deselected target
    if (autoAttackSystem.isAttacking(playerController)
        && targetingSystem.currentTarget !== autoAttackSystem.getTarget(playerController)) {
      host.stopAutoAttack();
    }

    // ── Auto-attack updates ───────────────────────────────────────

    autoAttackSystem.update(playerController, deltaTime);
    for (const npc of host.npcSystem.getNpcs()) {
      if (npc.inCombat && npc.autoAttackTarget && !npc.dead && !npc.stunned && !npc.blinded) {
        autoAttackSystem.start(npc, npc.autoAttackTarget);
      } else if (autoAttackSystem.isAttacking(npc)) {
        autoAttackSystem.stop(npc);
      }
      autoAttackSystem.update(npc, deltaTime);
    }
    autoAttackSystem.updateProjectiles(deltaTime);

    // ── Buff-driven modifiers ─────────────────────────────────────

    playerController.movementSpeedModifier = buffSystem.getMovementSpeedMultiplier(playerController)
      * (host.godMode ? 4 : 1);
    playerController.setAbilityBuffActive('crash-out', buffSystem.hasBuff(playerController, 'crash-out'));
    playerController.setAbilityBuffActive('retard-strength', buffSystem.hasBuff(playerController, 'retard-strength'));
    playerController.setAbilityBuffActive('full-retard', buffSystem.hasBuff(playerController, 'full-retard'));
    playerController.setAbilityBuffActive('dumpster-diving', buffSystem.hasBuff(playerController, 'dumpster-diving'));
    playerController.setAbilityBuffActive('overdosing', buffSystem.hasBuff(playerController, 'overdosing'));

    // ── Input-driven state toggles ────────────────────────────────

    const rKeyDown = input.isBindDown(keybindManager.getCode('rest'));
    if (rKeyDown && !this.rKeyWasDown) {
      if (host.resting) { host.stopResting(); } else { host.startResting(); }
    }
    this.rKeyWasDown = rKeyDown;

    // Drop target if it became untargetable (e.g. NPC dumpster-diving)
    const ct = targetingSystem.currentTarget;
    if (ct && ct !== (playerController as Targetable) && buffSystem.isUntargetable(ct)) {
      targetingSystem.currentTarget = null;
    }

    // Tab targeting — nearest hostile in front within 30 yards (blocked while blinded)
    const tabDown = input.isBindDown(keybindManager.getCode('target_nearest_enemy'));
    if (tabDown && !this.tabKeyWasDown && !buffSystem.isBlinded(playerController)) {
      const visibleNpcs = host.npcSystem.getNpcs().filter(n => !buffSystem.isUntargetable(n));
      targetingSystem.selectNearestHostileInFront(visibleNpcs, yardsToUnits(30));
    }
    this.tabKeyWasDown = tabDown;

    // Target of target key
    const fDown = input.isBindDown(keybindManager.getCode('target_of_target'));
    if (fDown && !this.fKeyWasDown) {
      const ct2 = targetingSystem.currentTarget;
      if (ct2 && 'autoAttackTarget' in ct2) {
        const tot = (ct2 as any).autoAttackTarget as Targetable | null;
        if (tot && tot !== ct2) {
          targetingSystem.currentTarget = tot;
        }
      }
    }
    this.fKeyWasDown = fDown;

    // God mode toggle — "G" key (admin only)
    const gKeyDown = input.isKeyDown('KeyG');
    if (gKeyDown && !this.gKeyWasDown && host.isAdmin) {
      host.godMode = !host.godMode;
      host.combatSystem.setGodMode(playerController, host.godMode);
      playerController.godMode = host.godMode;
      if (host.godMode) {
        playerController.hp = playerController.maxHp;
        playerController.mana = playerController.maxMana;
      }
      host.onGodModeToggle?.(host.godMode);
    }
    this.gKeyWasDown = gKeyDown;

    // Cancel resting on movement
    if (host.resting) {
      const wDown = input.isBindDown(keybindManager.getCode('move_forward'));
      const sDown = input.isBindDown(keybindManager.getCode('move_backward'));
      const aDown = input.isBindDown(keybindManager.getCode('move_left'));
      const dDown = input.isBindDown(keybindManager.getCode('move_right'));
      const bothMouse = input.isMouseButtonDown('left') && input.isMouseButtonDown('right');
      const jumping = input.isBindDown(keybindManager.getCode('jump'));
      if (wDown || sDown || aDown || dDown || bothMouse || jumping) {
        host.stopResting();
      }
    }

    // Cancel resting on entering combat
    if (host.resting && playerController.inCombat) {
      host.stopResting();
    }

    // ── Stun / CC / blind state ───────────────────────────────────

    const playerStunned = buffSystem.isStunned(playerController) || buffSystem.isSleeping(playerController);
    playerController.setStunned(playerStunned);
    if (playerStunned && autoAttackSystem.isAttacking(playerController)) {
      host.stopAutoAttack();
    }
    // Cancel ground targeting on stun or death
    if ((playerStunned || playerController.dead) && targetingSystem.groundTargetActive) {
      host.pendingNpcSpawn = null;
      targetingSystem.cancelGroundTarget();
    }
    if (playerStunned && host.resting) {
      host.stopResting();
    }

    // Discombobulate state — player
    playerController.setDiscombobulated(buffSystem.isDiscombobulated(playerController));

    // Blind state — player
    const playerBlinded = buffSystem.isBlinded(playerController);
    if (playerBlinded) {
      if (!host.blindEffect.isActive()) {
        host.blindEffect.activate(host.renderer.getCanvas());
      }
      host.blindEffect.update(deltaTime);
    } else if (host.blindEffect.isActive()) {
      host.blindEffect.deactivate();
    }

    // ── NPC state sync ────────────────────────────────────────────

    for (const npc of host.npcSystem.getNpcs()) {
      npc.setStunned(buffSystem.isStunned(npc) || buffSystem.isSleeping(npc));
      npc.blinded = buffSystem.isBlinded(npc);
      npc.model.setAbilityBuffActive('crash-out', buffSystem.hasBuff(npc, 'crash-out'));
      npc.model.setAbilityBuffActive('retard-strength', buffSystem.hasBuff(npc, 'retard-strength'));
      npc.model.setAbilityBuffActive('full-retard', buffSystem.hasBuff(npc, 'full-retard'));
      const npcDumpsterDiving = buffSystem.hasBuff(npc, 'dumpster-diving');
      if ('dumpsterDiveHostile' in npc.model) {
        (npc.model as any).dumpsterDiveHostile = npcDumpsterDiving;
      }
      npc.model.setAbilityBuffActive('dumpster-diving', npcDumpsterDiving);
      npc.model.setAbilityBuffActive('overdosing', buffSystem.hasBuff(npc, 'overdosing'));
    }

    // ── Casting / channeling ──────────────────────────────────────

    host.castingSystem.update(playerController, deltaTime);

    const castState = host.castingSystem.getState(playerController);
    if (castState) {
      const progress = Math.min(1, castState.elapsed / castState.totalTime);
      if (castState.isChannel) {
        playerController.setChannelAnimation(castState.ability.id, progress);
        playerController.setCastAnimation(null, 0);
      } else {
        playerController.setCastAnimation(castState.ability.id, progress);
        playerController.setChannelAnimation(null, 0);
      }
    } else {
      playerController.setCastAnimation(null, 0);
      playerController.setChannelAnimation(null, 0);
    }

    // Sync casting state to PlayerController so the target frame cast bar works
    if (castState) {
      playerController.castingAbilityName = castState.ability.name;
      playerController.castingElapsed = castState.elapsed;
      playerController.castingTotalTime = castState.totalTime;
      playerController.castingIsChannel = castState.isChannel;
    } else {
      playerController.castingAbilityName = null;
      playerController.castingElapsed = 0;
      playerController.castingTotalTime = 0;
      playerController.castingIsChannel = false;
    }

    // ── Charges ───────────────────────────────────────────────────

    for (const npc of host.npcSystem.getNpcs()) {
      if ((npc.dead || buffSystem.isStunned(npc)) && host.chargeSystem.isCharging(npc)) {
        host.chargeSystem.cancelCharges(npc);
      }
    }
    if (playerStunned && host.chargeSystem.isCharging(playerController)) {
      playerController.charging = false;
      playerController.chargeAnimSpeed = 1;
      host.chargeSystem.cancelCharges(playerController);
    }
    host.chargeSystem.update(deltaTime);

    // ── System updates ────────────────────────────────────────────

    host.mapManager.update(deltaTime);

    const snapY = host.mapManager.getMovingPlatformSnapY(
      playerController.mesh.position.x,
      playerController.mesh.position.z,
    );
    if (snapY !== undefined) {
      playerController.mesh.position.y = snapY;
      playerController.velocityY = 0;
    }

    playerController.update(deltaTime);
    for (const npc of host.npcSystem.getNpcs()) npc.update(deltaTime);

    // Despawn dead NPCs after their timer expires
    const npcsMut = host.npcSystem.getNpcsMut();
    for (let i = npcsMut.length - 1; i >= 0; i--) {
      if (npcsMut[i].shouldDespawn) {
        host.removeNpc(npcsMut[i]);
      }
    }

    host.gasCloudSystem.update(deltaTime);
    host.chemPoolSystem.update(deltaTime);
    host.updateActiveDots(deltaTime);
    host.updatePendingAoeImpacts(deltaTime);
    host.fullRetardAuraSystem.update(deltaTime);
    host.effects.update(deltaTime);
    host.combatSystem.update(deltaTime);
    buffSystem.update(deltaTime);
    // Re-run casting update after buff tick so channel aura remaining overrides the buff system's decrement
    host.castingSystem.update(playerController, 0);
    host.regenSystem.update(deltaTime);
    targetingSystem.update(deltaTime);

    // Update spatial audio positions so sounds track entity movement
    soundEffects.updateSpatialPositions((key) => {
      for (const npc of host.npcSystem.getNpcs()) {
        if (npc.mesh.uuid === key) {
          return {
            distance: playerController.mesh.position.distanceTo(npc.mesh.position),
            pan: host.sfxPan(npc.mesh.position),
          };
        }
      }
      return null;
    });

    host.thirdPersonCamera.update(deltaTime);
    playerController.setOpacity(host.thirdPersonCamera.getPlayerModelOpacity());
    host.renderer.render(host.scene, host.camera);
    input.resetDeltas();
  }
}
