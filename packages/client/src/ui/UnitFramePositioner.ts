const STORAGE_KEY = 'gtr_frame_positions_pct';
const GRID_SIZE = 160;
const SNAP_THRESHOLD = 15;

interface FrameConfig {
  id: string;
  element: HTMLElement;
  wrapper: HTMLElement;
  defaultPct: { top: number; left: number };   // 0–1 viewport fractions
  positionPct: { top: number; left: number };   // current position as 0–1
  locked: boolean;
  originalCursor: string;
  stayBelow?: { frameId: string; gap: number }; // enforce min distance below another frame
}

interface SavedPosition {
  top: number;   // 0–1
  left: number;  // 0–1
  locked: boolean;
}

export class UnitFramePositioner {
  private frames = new Map<string, FrameConfig>();
  private gridOverlay: HTMLElement | null = null;
  private contextMenu: HTMLElement | null = null;
  private dragging: FrameConfig | null = null;
  private dragOffset = { x: 0, y: 0 };

  constructor() {
    window.addEventListener('resize', this.onResize);
  }

  private onResize = (): void => {
    for (const config of this.frames.values()) {
      this.applyPctPosition(config);
    }
  };

  /** Convert default pixel position to 0–1 fraction of current viewport. */
  register(
    id: string,
    element: HTMLElement,
    defaultPosition: { top: number; left: number },
    options?: { stayBelow?: { frameId: string; gap: number } },
  ): HTMLElement {
    const defaultPct = {
      top: defaultPosition.top / window.innerHeight,
      left: defaultPosition.left / window.innerWidth,
    };

    const saved = this.loadPosition(id);
    const positionPct = saved ?? defaultPct;
    const locked = saved?.locked ?? true;
    const originalCursor = element.style.cursor;

    // Ensure element is interactable (wrapper has pointer-events: none to not block canvas)
    element.style.pointerEvents = 'auto';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
      position: fixed;
      z-index: 200;
      pointer-events: none;
    `;
    wrapper.appendChild(element);

    const config: FrameConfig = {
      id, element, wrapper, defaultPct, positionPct: { ...positionPct }, locked, originalCursor,
      stayBelow: options?.stayBelow,
    };
    this.frames.set(id, config);
    this.applyPctPosition(config);

    if (!locked) this.applyUnlockedStyle(config);

    // Right-click → context menu (bubble phase so buff icon stopPropagation bypasses this)
    element.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showContextMenu(e, id);
    });

    // Left-click drag when unlocked (capture phase to intercept target-selection handlers)
    element.addEventListener(
      'mousedown',
      (e) => {
        if (e.button === 0 && !config.locked) {
          e.preventDefault();
          e.stopPropagation();
          this.startDrag(config, e);
        }
      },
      true,
    );

    return wrapper;
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.closeContextMenu();
    this.hideGrid();
    this.stopDrag();
    for (const config of this.frames.values()) {
      config.wrapper.remove();
    }
    this.frames.clear();
  }

  // ─── Position Helpers ─────────────────────────────────────────

  private applyPctPosition(config: FrameConfig): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = Math.max(0, Math.min(Math.round(config.positionPct.top * vh), vh - 20));
    const left = Math.round(config.positionPct.left * vw);

    // Enforce minimum distance below a reference frame
    if (config.stayBelow) {
      const ref = this.frames.get(config.stayBelow.frameId);
      if (ref) {
        const refBottom = ref.wrapper.getBoundingClientRect().bottom;
        const minTop = refBottom + config.stayBelow.gap;
        if (top < minTop) top = Math.round(minTop);
      }
    }

    // Clamp so the frame can't extend past the right edge
    const width = config.wrapper.getBoundingClientRect().width || config.element.offsetWidth || 0;
    const maxLeft = Math.max(0, vw - width);
    config.wrapper.style.top = `${top}px`;
    config.wrapper.style.left = `${Math.min(left, maxLeft)}px`;
  }

  private pxToPct(top: number, left: number): { top: number; left: number } {
    return {
      top: window.innerHeight > 0 ? top / window.innerHeight : 0,
      left: window.innerWidth > 0 ? left / window.innerWidth : 0,
    };
  }

  // ─── Drag ──────────────────────────────────────────────────────

  private startDrag(config: FrameConfig, e: MouseEvent): void {
    this.closeContextMenu();
    this.dragging = config;
    const rect = config.wrapper.getBoundingClientRect();
    this.dragOffset.x = e.clientX - rect.left;
    this.dragOffset.y = e.clientY - rect.top;
    config.wrapper.style.zIndex = '250';
    this.showGrid();
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mouseup', this.onMouseUp);
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.dragging) return;
    let top = e.clientY - this.dragOffset.y;
    let left = e.clientX - this.dragOffset.x;

    // Snap to nearby grid lines (independently per axis)
    const nearestGridY = Math.round(top / GRID_SIZE) * GRID_SIZE;
    if (Math.abs(top - nearestGridY) < SNAP_THRESHOLD) top = nearestGridY;

    const nearestGridX = Math.round(left / GRID_SIZE) * GRID_SIZE;
    if (Math.abs(left - nearestGridX) < SNAP_THRESHOLD) left = nearestGridX;

    // Clamp to viewport
    top = Math.max(0, Math.min(top, window.innerHeight - 20));
    left = Math.max(0, Math.min(left, window.innerWidth - 20));

    this.dragging.wrapper.style.top = `${top}px`;
    this.dragging.wrapper.style.left = `${left}px`;
  };

  private onMouseUp = (): void => {
    if (!this.dragging) return;
    const config = this.dragging;
    const rect = config.wrapper.getBoundingClientRect();
    config.positionPct = this.pxToPct(rect.top, rect.left);
    this.savePosition(config.id, config.positionPct, config.locked);
    config.wrapper.style.zIndex = '200';
    this.dragging = null;
    this.hideGrid();
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mouseup', this.onMouseUp);
  };

  private stopDrag(): void {
    if (this.dragging) {
      this.dragging.wrapper.style.zIndex = '200';
      this.dragging = null;
      document.removeEventListener('mousemove', this.onMouseMove);
      document.removeEventListener('mouseup', this.onMouseUp);
    }
  }

  // ─── Grid Overlay ──────────────────────────────────────────────

  private showGrid(): void {
    if (this.gridOverlay) return;
    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 210;
      pointer-events: auto;
      cursor: move;
      background-image:
        linear-gradient(rgba(255, 255, 255, 0.08) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.08) 1px, transparent 1px);
      background-size: ${GRID_SIZE}px ${GRID_SIZE}px;
    `;
    document.body.appendChild(el);
    this.gridOverlay = el;
  }

  private hideGrid(): void {
    this.gridOverlay?.remove();
    this.gridOverlay = null;
  }

  // ─── Context Menu ─────────────────────────────────────────────

  private showContextMenu(e: MouseEvent, frameId: string): void {
    this.closeContextMenu();
    const config = this.frames.get(frameId);
    if (!config) return;

    const menu = document.createElement('div');
    menu.style.cssText = `
      position: fixed;
      z-index: 10000;
      background: linear-gradient(to bottom, rgba(30, 20, 45, 0.97), rgba(15, 10, 25, 0.97));
      border: 1px solid rgba(100, 80, 160, 0.5);
      border-radius: 4px;
      padding: 4px 0;
      min-width: 150px;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.7);
      pointer-events: auto;
    `;

    menu.appendChild(
      this.menuItem(config.locked ? 'Unlock Frame' : 'Lock Frame', () => {
        config.locked = !config.locked;
        if (config.locked) this.removeUnlockedStyle(config);
        else this.applyUnlockedStyle(config);
        this.savePosition(config.id, config.positionPct, config.locked);
        this.closeContextMenu();
      }),
    );

    menu.appendChild(
      this.menuItem('Reset Position', () => {
        config.positionPct = { ...config.defaultPct };
        config.locked = true;
        this.removeUnlockedStyle(config);
        this.applyPctPosition(config);
        this.deletePosition(config.id);
        this.closeContextMenu();
      }),
    );

    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    document.body.appendChild(menu);

    // Clamp to viewport
    requestAnimationFrame(() => {
      const r = menu.getBoundingClientRect();
      if (r.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - r.width - 4}px`;
      }
      if (r.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - r.height - 4}px`;
      }
    });

    this.contextMenu = menu;
    setTimeout(() => document.addEventListener('mousedown', this.onOutsideClick), 0);
  }

  private menuItem(label: string, action: () => void): HTMLElement {
    const el = document.createElement('div');
    el.textContent = label;
    el.style.cssText = `
      padding: 6px 16px;
      color: #ddd;
      font-size: 13px;
      cursor: pointer;
      white-space: nowrap;
    `;
    el.addEventListener('mouseenter', () => {
      el.style.background = 'rgba(100, 80, 160, 0.4)';
    });
    el.addEventListener('mouseleave', () => {
      el.style.background = '';
    });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      action();
    });
    return el;
  }

  private onOutsideClick = (e: MouseEvent): void => {
    if (this.contextMenu && !this.contextMenu.contains(e.target as Node)) {
      this.closeContextMenu();
    }
  };

  private closeContextMenu(): void {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
      document.removeEventListener('mousedown', this.onOutsideClick);
    }
  }

  // ─── Style Helpers ─────────────────────────────────────────────

  private applyUnlockedStyle(config: FrameConfig): void {
    config.element.style.outline = '1px dashed rgba(255, 200, 50, 0.5)';
    config.element.style.cursor = 'move';
  }

  private removeUnlockedStyle(config: FrameConfig): void {
    config.element.style.outline = '';
    config.element.style.cursor = config.originalCursor;
  }

  // ─── Persistence ──────────────────────────────────────────────

  private loadPosition(id: string): SavedPosition | null {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return data[id] ?? null;
    } catch {
      return null;
    }
  }

  private savePosition(id: string, pct: { top: number; left: number }, locked: boolean): void {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      data[id] = { top: pct.top, left: pct.left, locked };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch { /* ignore */ }
  }

  private deletePosition(id: string): void {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      delete data[id];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch { /* ignore */ }
  }
}
