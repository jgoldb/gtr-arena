export class InputManager {
  private keys = new Map<string, boolean>();
  private mouseButtons = { left: false, right: false, middle: false };
  private mouseDelta = { x: 0, y: 0 };
  private scrollDelta = 0;
  private canvas: HTMLCanvasElement;

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
    if (e.button === 0) this.mouseButtons.left = true;
    if (e.button === 1) this.mouseButtons.middle = true;
    if (e.button === 2) this.mouseButtons.right = true;

    // Pointer lock on any mouse button drag
    if (e.button === 0 || e.button === 2) {
      this.canvas.requestPointerLock();
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseButtons.left = false;
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

  resetDeltas(): void {
    this.mouseDelta.x = 0;
    this.mouseDelta.y = 0;
    this.scrollDelta = 0;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
  }
}
