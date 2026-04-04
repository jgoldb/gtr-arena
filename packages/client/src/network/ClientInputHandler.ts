import type { InputManager } from '../engine/input/InputManager';
import type { TargetingSystem } from '../engine/targeting/TargetingSystem';
import type { Targetable } from '../engine/types';
import { yardsToUnits } from '@gtr/shared';
import { keybindManager } from '../ui/KeybindManager';

// ── Host interface ────────────────────────────────────────────────────

/** Host interface — ClientEngine implements this to provide state and actions. */
export interface ClientInputHandlerHost {
  readonly input: InputManager;
  readonly targetingSystem: TargetingSystem;

  // Local player state queries
  isPlayerDead(): boolean;
  isPlayerStunned(): boolean;
  isPlayerInCombat(): boolean;
  isPlayerGrounded(): boolean;

  // Engine state queries
  getSelectedTargetId(): string | null;
  getLocalEntityId(): string;
  isResting(): boolean;
  isAdmin(): boolean;
  isCasting(): boolean;
  isBlinded(): boolean;

  // Actions
  startResting(): boolean;
  stopResting(): void;
  /** Full select-target path: updates targeting system, selectedTargetId, sends to server, fires onTargetChanged. */
  selectTarget(target: Targetable | null): void;
  sendCancelCast(): void;
  sendGodModeToggle(): void;
  /** Right-click attack: stop resting if needed, then send auto-attack. */
  rightClickAttack(targetEntityId: string): void;

  // Entity lookups
  getVisibleHostileTargetables(): Targetable[];
  findEntityIdByTargetable(target: Targetable | null): string | null;
  isEntityInvisibleToLocal(entityId: string): boolean;
  isHostileToLocal(target: Targetable): boolean;
  getRemoteEntityTargetId(entityId: string): string | null;
  getTargetableById(entityId: string): Targetable | null;

  // Callbacks
  onGroundTargetConfirmed?: () => void;
}

// ── ClientInputHandler ───────────────────────────────────────────────

export class ClientInputHandler {
  private readonly host: ClientInputHandlerHost;

  // Key press edge-detection (previous frame state)
  private rKeyWasDown = false;
  private gKeyWasDown = false;
  private tabKeyWasDown = false;
  private fKeyWasDown = false;

  constructor(host: ClientInputHandlerHost) {
    this.host = host;
  }

  // ── Per-frame update ──────────────────────────────────────────────

  /** Process action keys: resting, god mode, cast cancellation. */
  updateActions(): void {
    const { host } = this;
    const input = host.input;

    // Resting toggle
    const rKeyDown = input.isBindDown(keybindManager.getCode('rest'));
    if (rKeyDown && !this.rKeyWasDown) {
      if (host.isResting()) {
        host.stopResting();
      } else {
        host.startResting();
      }
    }
    this.rKeyWasDown = rKeyDown;

    // God mode toggle — "G" key (admin only, sends to server)
    const gKeyDown = input.isKeyDown('KeyG');
    if (gKeyDown && !this.gKeyWasDown && host.isAdmin()) {
      host.sendGodModeToggle();
    }
    this.gKeyWasDown = gKeyDown;

    // Cancel casting on jump or falling
    if (host.isCasting() && (input.isBindDown(keybindManager.getCode('jump')) || !host.isPlayerGrounded())) {
      host.sendCancelCast();
    }

    // Cancel resting on movement or jump
    if (host.isResting()) {
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
    if (host.isResting() && host.isPlayerInCombat()) {
      host.stopResting();
    }

    // Cancel resting on stun or death
    if (host.isResting() && (host.isPlayerStunned() || host.isPlayerDead())) {
      host.stopResting();
    }
  }

  /** Process targeting keys and mouse clicks. */
  updateTargeting(): void {
    const { host } = this;
    const input = host.input;

    // Tab targeting — nearest hostile in front within 30 yards (blocked while blinded)
    const tabDown = input.isBindDown(keybindManager.getCode('target_nearest_enemy'));
    if (tabDown && !this.tabKeyWasDown && !host.isBlinded()) {
      const hostiles = host.getVisibleHostileTargetables();
      host.targetingSystem.selectNearestHostileInFront(hostiles, yardsToUnits(30));
      const newTargetId = host.findEntityIdByTargetable(host.targetingSystem.currentTarget);
      if (newTargetId !== host.getSelectedTargetId()) {
        host.selectTarget(host.targetingSystem.currentTarget);
      }
    }
    this.tabKeyWasDown = tabDown;

    // Target of target key
    const fDown = input.isBindDown(keybindManager.getCode('target_of_target'));
    const selectedId = host.getSelectedTargetId();
    if (fDown && !this.fKeyWasDown && selectedId) {
      const isSelf = selectedId === host.getLocalEntityId();
      const totId = isSelf
        ? selectedId
        : host.getRemoteEntityTargetId(selectedId) ?? null;
      if (totId && totId !== selectedId && !host.isEntityInvisibleToLocal(totId)) {
        const totTargetable = host.getTargetableById(totId);
        if (totTargetable) {
          host.selectTarget(totTargetable);
        }
      }
    }
    this.fKeyWasDown = fDown;

    // Process left click for target selection
    const leftClick = input.getLeftClick();
    if (leftClick) {
      if (host.targetingSystem.groundTargetActive) {
        if (!host.targetingSystem.groundTargetBlocked) {
          host.onGroundTargetConfirmed?.();
        }
      } else if (!input.isMouseButtonDown('right')) {
        // Only process target selection on normal left clicks — not while
        // right-click drag (pointer lock) is active, to avoid accidentally
        // clearing the current target.
        host.targetingSystem.processClick(leftClick.x, leftClick.y);
        const newTargetId = host.findEntityIdByTargetable(host.targetingSystem.currentTarget);
        if (newTargetId !== host.getSelectedTargetId()) {
          host.selectTarget(host.targetingSystem.currentTarget);
        }
      }
    }

    // Process right click for auto-attack
    const rightClick = input.getRightClick();
    if (rightClick) {
      const target = host.targetingSystem.processRightClick(rightClick.x, rightClick.y);
      if (target) {
        const targetId = host.findEntityIdByTargetable(target);
        if (targetId && targetId !== host.getSelectedTargetId()) {
          host.selectTarget(target);
        }
        if (targetId && host.isHostileToLocal(target) && !target.dead) {
          host.rightClickAttack(targetId);
        }
      }
    }

    // Update cursor for hover detection (only when pointer is unlocked)
    host.targetingSystem.updateHoverCursor(input.getMouseScreenPos(), input.isMouseButtonDown('right'));
  }
}
