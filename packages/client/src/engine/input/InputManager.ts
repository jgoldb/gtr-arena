import { keybindManager, parseCombo } from '../../ui/KeybindManager';

export class InputManager {
  private keys = new Map<string, boolean>();
  private mouseButtons = { left: false, right: false, middle: false };
  private mouseDelta = { x: 0, y: 0 };
  private scrollDelta = 0;
  private canvas: HTMLCanvasElement;

  // Left-click vs drag detection
  private leftClickPending = false;
  private leftClickStartX = 0;
  private leftClickStartY = 0;
  private leftDragDist = 0;
  private leftClickEvent: { x: number; y: number } | null = null;
  private rightClickEvent: { x: number; y: number } | null = null;
  private static readonly CLICK_THRESHOLD = 4;

  // Mouse screen position (for hover detection when pointer is NOT locked)
  private mouseScreenX = 0;
  private mouseScreenY = 0;

  // Skip first N mousemove events after pointer lock to discard browser transition spikes
  private pointerLockSkip = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Discard spurious mouse delta from the pointer lock transition
    document.addEventListener('pointerlockchange', this.onPointerLockChange);

    // Clear all key/mouse state when window loses focus — prevents stuck keys
    // (e.g. modifier held while Alt-Tabbing or browser menu bar activating)
    window.addEventListener('blur', this.onBlur);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys.set(e.code, true);
    if (keybindManager.getAllBoundCodes().has(e.code)) {
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.set(e.code, false);
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.mouseButtons.left = true;
      if (this.mouseButtons.right) {
        // Right held = pointer lock active. Emit an immediate click at virtual cursor
        // position so ground targeting can be confirmed during camera drag.
        this.leftClickEvent = { x: this.mouseScreenX, y: this.mouseScreenY };
      } else {
        this.leftClickPending = true;
        this.leftClickStartX = e.clientX;
        this.leftClickStartY = e.clientY;
        this.leftDragDist = 0;
        // Don't request pointer lock yet — wait to see if this is a click or drag
        return;
      }
    }
    if (e.button === 1) this.mouseButtons.middle = true;
    if (e.button === 2) {
      this.mouseButtons.right = true;
      this.rightClickEvent = { x: e.clientX, y: e.clientY };
      // Right-click always gets immediate pointer lock; cancel any pending left click
      this.leftClickPending = false;
      this.canvas.requestPointerLock();
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.mouseButtons.left = false;
      if (this.leftClickPending) {
        // Mouse didn't move enough to be a drag → fire as a click
        this.leftClickEvent = { x: this.leftClickStartX, y: this.leftClickStartY };
        this.leftClickPending = false;
      }
    }
    if (e.button === 1) this.mouseButtons.middle = false;
    if (e.button === 2) this.mouseButtons.right = false;

    // Only exit pointer lock when both left and right are released
    if (!this.mouseButtons.left && !this.mouseButtons.right) {
      document.exitPointerLock();
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    // Only accumulate camera deltas while pointer lock is active.
    // After pointer lock is acquired, skip a few events — browsers emit
    // spurious large deltas during the transition.
    if (document.pointerLockElement) {
      if (this.pointerLockSkip > 0) {
        this.pointerLockSkip--;
      } else {
        this.mouseDelta.x += e.movementX;
        this.mouseDelta.y += e.movementY;
        // Track virtual screen position during pointer lock (for ground targeting)
        this.mouseScreenX = Math.max(0, Math.min(window.innerWidth, this.mouseScreenX + e.movementX));
        this.mouseScreenY = Math.max(0, Math.min(window.innerHeight, this.mouseScreenY + e.movementY));
      }
    } else {
      // Track screen position for hover detection
      this.mouseScreenX = e.clientX;
      this.mouseScreenY = e.clientY;
    }

    if (this.leftClickPending) {
      this.leftDragDist += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (this.leftDragDist > InputManager.CLICK_THRESHOLD) {
        // Exceeded threshold → this is a drag, not a click
        this.leftClickPending = false;
        this.canvas.requestPointerLock();
      }
    }
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.mouseButtons.left = false;
    this.mouseButtons.right = false;
    this.mouseButtons.middle = false;
    this.leftClickPending = false;
  };

  private onPointerLockChange = (): void => {
    this.mouseDelta.x = 0;
    this.mouseDelta.y = 0;
    if (document.pointerLockElement) {
      // Skip the first couple of mousemove events after lock — browsers
      // can emit large spurious deltas during the transition
      this.pointerLockSkip = 2;
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.scrollDelta += e.deltaY;
  };

  isKeyDown(code: string): boolean {
    return this.keys.get(code) ?? false;
  }

  /** Check if a combo bind string (e.g. "Shift+Digit1") is currently active.
   *  Exact modifier matching — modifiers must match the bind precisely. */
  isBindDown(bindCode: string): boolean {
    const { shift, ctrl, alt, baseCode } = parseCombo(bindCode);
    if (!(this.keys.get(baseCode) ?? false)) return false;
    const shiftHeld = (this.keys.get('ShiftLeft') ?? false) || (this.keys.get('ShiftRight') ?? false);
    const ctrlHeld = (this.keys.get('ControlLeft') ?? false) || (this.keys.get('ControlRight') ?? false);
    const altHeld = (this.keys.get('AltLeft') ?? false) || (this.keys.get('AltRight') ?? false);
    return shiftHeld === shift && ctrlHeld === ctrl && altHeld === alt;
  }

  isMouseButtonDown(button: 'left' | 'right' | 'middle'): boolean {
    return this.mouseButtons[button];
  }

  getMouseDelta(): { x: number; y: number } {
    return { ...this.mouseDelta };
  }

  getScrollDelta(): number {
    return this.scrollDelta;
  }

  getLeftClick(): { x: number; y: number } | null {
    return this.leftClickEvent;
  }

  getRightClick(): { x: number; y: number } | null {
    return this.rightClickEvent;
  }

  /** Returns mouse screen position when pointer is NOT locked (for hover detection), or null if locked. */
  getMouseScreenPos(): { x: number; y: number } | null {
    if (document.pointerLockElement) return null;
    return { x: this.mouseScreenX, y: this.mouseScreenY };
  }

  /** Returns mouse screen position always, even during pointer lock (virtual tracking via movementX/Y). */
  getMouseScreenPosAlways(): { x: number; y: number } {
    return { x: this.mouseScreenX, y: this.mouseScreenY };
  }

  resetDeltas(): void {
    this.mouseDelta.x = 0;
    this.mouseDelta.y = 0;
    this.scrollDelta = 0;
    this.leftClickEvent = null;
    this.rightClickEvent = null;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    window.removeEventListener('blur', this.onBlur);
  }
}
