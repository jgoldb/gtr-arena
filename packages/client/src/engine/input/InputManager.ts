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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys.set(e.code, true);
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight'].includes(e.code)) {
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.set(e.code, false);
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.mouseButtons.left = true;
      // Only set up click detection if right button isn't already held
      // (right held = pointer lock active, this left press is just for auto-forward)
      if (!this.mouseButtons.right) {
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
    this.mouseDelta.x += e.movementX;
    this.mouseDelta.y += e.movementY;

    // Track screen position when pointer is not locked (for hover detection)
    if (!document.pointerLockElement) {
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

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.scrollDelta += e.deltaY;
  };

  isKeyDown(code: string): boolean {
    return this.keys.get(code) ?? false;
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
  }
}
