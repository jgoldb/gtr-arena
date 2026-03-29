const STORAGE_KEY = 'gtr_chat_window_pos';
const SCROLL_STEP = 60;

export class ChatWindow {
  readonly element: HTMLDivElement;
  private log: HTMLDivElement;
  private inputRow: HTMLDivElement;
  private input: HTMLInputElement;
  private tab: HTMLDivElement;
  private scrollControls: HTMLDivElement;
  private _chatOpen = false;
  private onSend: ((message: string) => void) | null = null;
  private canOpen: (() => boolean) | null = null;

  // Drag state
  private dragging = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;

  constructor(options?: { onSend?: (message: string) => void; canOpen?: () => boolean }) {
    this.onSend = options?.onSend ?? null;
    this.canOpen = options?.canOpen ?? null;

    // Inject style to hide scrollbar
    const style = document.createElement('style');
    style.textContent = `
      .chat-log-hidden-scrollbar::-webkit-scrollbar { display: none; }
      .chat-log-hidden-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
    `;
    document.head.appendChild(style);

    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed; left: 30px;
      width: 330px;
      display: flex; flex-direction: column;
      z-index: 200; pointer-events: none;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    `;

    // Default top position (equivalent to bottom: 40px with 160px log height)
    this.element.style.top = `${window.innerHeight - 160 - 40}px`;

    // Restore cached position (overrides default if present)
    this.restorePosition();

    // Invisible hover zone — captures mouseenter/leave and wheel, passes clicks through
    const hoverZone = document.createElement('div');
    hoverZone.style.cssText = `
      position: absolute; inset: -22px 0 0 0; bottom: 0;
      pointer-events: auto;
    `;
    // Let clicks fall through to the game (except tab and scroll buttons)
    hoverZone.addEventListener('mousedown', (e) => {
      const t = e.target as HTMLElement;
      if (t === this.tab || t.dataset.chatBtn) return;
      e.stopPropagation();
      hoverZone.style.pointerEvents = 'none';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      hoverZone.style.pointerEvents = 'auto';
      if (el && el !== hoverZone && el !== this.element) {
        el.dispatchEvent(new MouseEvent('mousedown', e));
      }
    });
    // Scroll wheel on hover zone scrolls the log
    hoverZone.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.log.scrollTop += e.deltaY;
    }, { passive: false });
    hoverZone.addEventListener('mouseenter', () => {
      if (!this.dragging) {
        this.tab.style.opacity = '1';
        this.scrollControls.style.opacity = '1';
        this.log.style.background = 'rgba(0, 0, 0, 0.4)';
      }
    });
    hoverZone.addEventListener('mouseleave', () => {
      if (!this.dragging) {
        this.tab.style.opacity = '0';
        this.scrollControls.style.opacity = '0';
        this.log.style.background = 'transparent';
      }
    });
    this.element.appendChild(hoverZone);

    // Draggable tab
    this.tab = document.createElement('div');
    this.tab.textContent = 'Chat';
    this.tab.style.cssText = `
      position: absolute; top: 0; left: 0;
      padding: 2px 10px; font-size: 11px; font-weight: 600;
      color: rgba(180, 190, 220, 0.8); letter-spacing: 1px;
      background: rgba(0, 0, 0, 0.45);
      border-radius: 4px 4px 0 0;
      cursor: grab; user-select: none;
      pointer-events: auto;
      opacity: 0; transition: opacity 0.25s ease;
    `;
    this.tab.addEventListener('mousedown', this.onTabMouseDown);
    hoverZone.appendChild(this.tab);

    // Scroll up/down buttons on the left side
    this.scrollControls = document.createElement('div');
    this.scrollControls.style.cssText = `
      position: absolute; top: 22px; left: -20px;
      display: flex; flex-direction: column; gap: 4px;
      height: 160px; justify-content: center;
      opacity: 0; transition: opacity 0.25s ease;
      pointer-events: auto;
    `;

    const makeBtn = (label: string, dir: number): HTMLDivElement => {
      const btn = document.createElement('div');
      btn.textContent = label;
      btn.dataset.chatBtn = '1';
      btn.style.cssText = `
        width: 18px; height: 24px;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0, 0, 0, 0.45); color: rgba(180, 190, 220, 0.8);
        border-radius: 3px; cursor: pointer; user-select: none;
        font-size: 10px; pointer-events: auto;
      `;
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.log.scrollTop += dir * SCROLL_STEP;
      });
      btn.addEventListener('mouseenter', () => {
        btn.style.background = 'rgba(0, 0, 0, 0.65)';
        btn.style.color = 'rgba(210, 220, 240, 0.95)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'rgba(0, 0, 0, 0.45)';
        btn.style.color = 'rgba(180, 190, 220, 0.8)';
      });
      return btn;
    };

    this.scrollControls.appendChild(makeBtn('\u25B2', -1));
    this.scrollControls.appendChild(makeBtn('\u25BC', 1));
    hoverZone.appendChild(this.scrollControls);

    // Log area — fixed height, hidden scrollbar
    this.log = document.createElement('div');
    this.log.className = 'chat-log-hidden-scrollbar';
    this.log.style.cssText = `
      height: 160px; overflow-y: scroll; padding: 6px 10px;
      font-size: 13px; line-height: 1.5;
      pointer-events: none;
      background: transparent; border-radius: 4px;
      transition: background 0.25s ease;
    `;
    this.element.appendChild(this.log);

    this.inputRow = document.createElement('div');
    this.inputRow.style.cssText = `
      display: none; padding: 4px 0;
      pointer-events: auto;
    `;

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.maxLength = 500;
    this.input.placeholder = 'Send a message...';
    this.input.style.cssText = `
      width: 100%; box-sizing: border-box;
      padding: 6px 10px; font-size: 13px;
      background: rgba(0, 0, 0, 0.6); color: #ddd;
      border: 1px solid rgba(100, 120, 200, 0.25); border-radius: 4px;
      outline: none;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    `;

    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const text = this.input.value.trim();
        if (text) {
          this.onSend?.(text);
        }
        this.closeChat();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeChat();
      }
    });

    // Prevent keyup from propagating to game input while chat is open
    this.input.addEventListener('keyup', (e) => {
      e.stopPropagation();
    });

    this.input.addEventListener('blur', () => {
      if (this._chatOpen) this.closeChat();
    });

    this.inputRow.appendChild(this.input);
    this.element.appendChild(this.inputRow);

    window.addEventListener('keydown', this.onGlobalKeyDown);
  }

  private onGlobalKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !this._chatOpen) {
      // Don't open chat if another input/textarea is focused
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      if (this.canOpen && !this.canOpen()) return;
      e.preventDefault();
      this.openChat();
    }
  };

  // ── Drag handling ─────────────────────────────────────────────────────

  private onTabMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    this.dragging = true;
    this.tab.style.cursor = 'grabbing';
    const rect = this.element.getBoundingClientRect();
    this.dragOffsetX = e.clientX - rect.left;
    this.dragOffsetY = e.clientY - rect.top;
    window.addEventListener('mousemove', this.onDragMove);
    window.addEventListener('mouseup', this.onDragEnd);
  };

  private onDragMove = (e: MouseEvent): void => {
    // Switch from bottom/left to top/left positioning on first drag
    this.element.style.bottom = '';
    const x = Math.max(0, Math.min(e.clientX - this.dragOffsetX, window.innerWidth - this.element.offsetWidth));
    const inputReserve = 40;
    const y = Math.max(0, Math.min(e.clientY - this.dragOffsetY, window.innerHeight - this.element.offsetHeight - inputReserve));
    this.element.style.left = `${x}px`;
    this.element.style.top = `${y}px`;
  };

  private onDragEnd = (): void => {
    this.dragging = false;
    this.tab.style.cursor = 'grab';
    window.removeEventListener('mousemove', this.onDragMove);
    window.removeEventListener('mouseup', this.onDragEnd);
    this.savePosition();
  };

  private savePosition(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        left: this.element.style.left,
        top: this.element.style.top,
      }));
    } catch { /* quota or private mode */ }
  }

  private restorePosition(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const pos = JSON.parse(raw);
      if (pos.left && pos.top) {
        this.element.style.bottom = '';
        this.element.style.left = pos.left;
        this.element.style.top = pos.top;
      }
    } catch { /* ignore */ }
  }

  // ── Chat open/close ───────────────────────────────────────────────────

  get chatOpen(): boolean {
    return this._chatOpen;
  }

  openChat(): void {
    this._chatOpen = true;
    this.inputRow.style.display = 'block';
    this.log.style.pointerEvents = 'auto';
    this.input.value = '';
    this.input.focus();
    this.log.scrollTop = this.log.scrollHeight;
  }

  closeChat(): void {
    this._chatOpen = false;
    this.inputRow.style.display = 'none';
    this.log.style.pointerEvents = 'none';
    this.input.blur();
  }

  addMessage(username: string, message: string): void {
    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 30;
    const line = document.createElement('div');
    line.style.cssText = 'text-shadow: 1px 1px 3px rgba(0,0,0,0.9);';
    line.innerHTML = `<span style="color: #7a9de0; font-weight: 600;">${this.escapeHtml(username)}</span><span style="color: rgba(100,120,160,0.5); margin: 0 5px;">:</span><span style="color: rgba(220,225,235,0.9);">${this.escapeHtml(message)}</span>`;
    this.log.appendChild(line);
    // Limit to 50 messages
    while (this.log.children.length > 50) {
      this.log.removeChild(this.log.firstChild!);
    }
    // Only auto-scroll if user was already at the bottom
    if (atBottom) {
      this.log.scrollTop = this.log.scrollHeight;
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onGlobalKeyDown);
    window.removeEventListener('mousemove', this.onDragMove);
    window.removeEventListener('mouseup', this.onDragEnd);
    this.element.remove();
  }
}
