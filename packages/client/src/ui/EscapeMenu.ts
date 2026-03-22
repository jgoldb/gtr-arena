export interface EscapeMenuCallbacks {
  onReturnToLobby: () => void;
  /** If provided, called when Escape is pressed while menu is closed. Return true to suppress opening the menu. */
  onEscapeWhilePlaying?: () => boolean;
  /** If provided, a rematch section is shown. Called when menu opens to determine if rematch should be enabled. */
  isRematchEnabled?: () => boolean;
  /** Called when the player clicks the rematch button. */
  onRematch?: (mapMode: 'random' | 'same' | 'new') => void;
  /** If true, show a confirmation before exiting. */
  confirmExit?: boolean;
}

export class EscapeMenu {
  readonly element: HTMLElement;
  private box: HTMLElement;
  private _isOpen = false;
  private rematchPollId: ReturnType<typeof setInterval> | null = null;
  private confirmRow: HTMLDivElement | null = null;

  // Rematch UI elements
  private rematchSection: HTMLDivElement | null = null;
  private rematchBtn: HTMLButtonElement | null = null;
  private rematchMapModeButtons: HTMLButtonElement[] = [];
  private rematchMapMode: 'random' | 'same' | 'new' = 'random';
  private rematchDisabledOverlay: HTMLDivElement | null = null;

  constructor(private callbacks: EscapeMenuCallbacks) {
    // Backdrop
    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed; inset: 0; z-index: 950;
      display: none; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.5);
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    `;

    // Panel
    this.box = document.createElement('div');
    this.box.style.cssText = `
      background: linear-gradient(to bottom, rgba(20, 20, 35, 0.95), rgba(10, 10, 20, 0.95));
      border: 1px solid rgba(100, 120, 200, 0.3);
      border-radius: 8px; padding: 30px 50px;
      text-align: center; min-width: 220px;
    `;

    // Title
    const title = document.createElement('div');
    title.textContent = 'Game Menu';
    title.style.cssText = `
      color: #ccc; font-size: 22px; font-weight: bold;
      margin-bottom: 24px;
    `;

    this.box.appendChild(title);

    // Rematch section (if callback provided)
    if (callbacks.isRematchEnabled && callbacks.onRematch) {
      this.buildRematchSection();
      this.box.appendChild(this.rematchSection!);
    }

    // Exit Game button
    const exitBtn = document.createElement('button');
    exitBtn.textContent = 'Exit Game';
    exitBtn.style.cssText = `
      display: block; width: 100%;
      padding: 10px 24px; font-size: 14px;
      background: rgba(160, 50, 50, 0.8); color: #ddd;
      border: 1px solid rgba(200, 80, 80, 0.3); border-radius: 4px;
      cursor: pointer; outline: none;
      font-family: inherit;
    `;
    exitBtn.addEventListener('mouseenter', () => {
      if (!this.confirmRow) exitBtn.style.background = 'rgba(180, 60, 60, 0.9)';
    });
    exitBtn.addEventListener('mouseleave', () => {
      if (!this.confirmRow) exitBtn.style.background = 'rgba(160, 50, 50, 0.8)';
    });
    exitBtn.addEventListener('click', () => {
      if (this.callbacks.confirmExit) {
        this.showExitConfirm();
      } else {
        this.close();
        this.callbacks.onReturnToLobby();
      }
    });

    this.box.appendChild(exitBtn);
    this.element.appendChild(this.box);

    // Close when clicking backdrop (not the panel)
    this.element.addEventListener('mousedown', (e) => {
      if (e.target === this.element) this.close();
    });

    window.addEventListener('keydown', this.onKeyDown);
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  private buildRematchSection(): void {
    this.rematchSection = document.createElement('div');
    this.rematchSection.style.cssText = 'margin-bottom: 16px; position: relative;';

    const label = document.createElement('div');
    label.textContent = 'Rematch';
    label.style.cssText = 'color: #aab; font-size: 13px; font-weight: bold; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;';

    // Map mode toggle row
    const mapModeRow = document.createElement('div');
    mapModeRow.style.cssText = 'display: flex; gap: 6px; justify-content: center; margin-bottom: 10px;';

    const toggleBtnStyle = (active: boolean) => `
      padding: 6px 14px; font-size: 12px; font-weight: bold;
      background: ${active ? 'rgba(60, 120, 200, 0.9)' : 'rgba(40, 40, 60, 0.6)'};
      color: ${active ? '#fff' : '#888'};
      border: 1px solid ${active ? 'rgba(100, 160, 255, 0.5)' : 'rgba(80, 80, 100, 0.3)'};
      border-radius: 4px; cursor: pointer; outline: none; transition: all 0.15s;
      font-family: inherit;
    `;

    const modes: Array<{ mode: 'random' | 'same' | 'new'; label: string }> = [
      { mode: 'random', label: 'Random' },
      { mode: 'same', label: 'Same' },
      { mode: 'new', label: 'New' },
    ];

    this.rematchMapModeButtons = [];
    for (const { mode, label: text } of modes) {
      const btn = document.createElement('button');
      btn.textContent = text;
      btn.style.cssText = toggleBtnStyle(mode === 'random');
      btn.addEventListener('click', () => {
        this.rematchMapMode = mode;
        for (let i = 0; i < modes.length; i++) {
          this.rematchMapModeButtons[i].style.cssText = toggleBtnStyle(modes[i].mode === mode);
        }
      });
      this.rematchMapModeButtons.push(btn);
      mapModeRow.appendChild(btn);
    }

    // Challenge button
    this.rematchBtn = document.createElement('button');
    this.rematchBtn.textContent = 'Challenge';
    this.rematchBtn.style.cssText = `
      display: block; width: 100%;
      padding: 10px 24px; font-size: 14px;
      background: rgba(40, 160, 80, 0.8); color: #ddd;
      border: 1px solid rgba(80, 200, 120, 0.4); border-radius: 4px;
      cursor: pointer; outline: none;
      font-family: inherit;
    `;
    this.rematchBtn.addEventListener('mouseenter', () => {
      if (!this.rematchDisabledOverlay?.style.display || this.rematchDisabledOverlay.style.display === 'none') {
        this.rematchBtn!.style.background = 'rgba(50, 180, 100, 0.9)';
      }
    });
    this.rematchBtn.addEventListener('mouseleave', () => {
      this.rematchBtn!.style.background = 'rgba(40, 160, 80, 0.8)';
    });
    this.rematchBtn.addEventListener('click', () => {
      this.close();
      this.callbacks.onRematch?.(this.rematchMapMode);
    });

    // Disabled overlay (covers the whole rematch section)
    this.rematchDisabledOverlay = document.createElement('div');
    this.rematchDisabledOverlay.style.cssText = `
      position: absolute; inset: 0;
      background: rgba(10, 10, 15, 0.7);
      display: none; align-items: center; justify-content: center;
      border-radius: 4px; cursor: not-allowed;
    `;
    const disabledText = document.createElement('div');
    disabledText.textContent = 'Only available before gates open';
    disabledText.style.cssText = 'color: #667; font-size: 12px; font-weight: bold;';
    this.rematchDisabledOverlay.appendChild(disabledText);

    this.rematchSection.append(label, mapModeRow, this.rematchBtn, this.rematchDisabledOverlay);
  }

  private updateRematchState(): void {
    if (!this.rematchSection || !this.callbacks.isRematchEnabled) return;
    const enabled = this.callbacks.isRematchEnabled();
    this.rematchDisabledOverlay!.style.display = enabled ? 'none' : 'flex';
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Escape') {
      e.preventDefault();
      if (this._isOpen) {
        this.close();
      } else if (!this.callbacks.onEscapeWhilePlaying?.()) {
        this.open();
      }
    }
  };

  open(): void {
    this._isOpen = true;
    this.updateRematchState();
    this.element.style.display = 'flex';
    if (this.rematchSection && !this.rematchPollId) {
      this.rematchPollId = setInterval(() => this.updateRematchState(), 250);
    }
  }

  close(): void {
    this._isOpen = false;
    this.element.style.display = 'none';
    this.hideExitConfirm();
    if (this.rematchPollId) {
      clearInterval(this.rematchPollId);
      this.rematchPollId = null;
    }
  }

  private showExitConfirm(): void {
    if (this.confirmRow) return;

    this.confirmRow = document.createElement('div');
    this.confirmRow.style.cssText = 'margin-top: 10px; text-align: center;';

    const prompt = document.createElement('div');
    prompt.textContent = 'This will count as a loss. Are you sure?';
    prompt.style.cssText = 'color: #c99; font-size: 13px; margin-bottom: 10px;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 10px; justify-content: center;';

    const yesBtn = document.createElement('button');
    yesBtn.textContent = 'Yes, leave';
    yesBtn.style.cssText = `
      padding: 8px 20px; font-size: 13px; font-weight: bold;
      background: rgba(160, 50, 50, 0.8); color: #ddd;
      border: 1px solid rgba(200, 80, 80, 0.4); border-radius: 4px;
      cursor: pointer; outline: none; font-family: inherit;
    `;
    yesBtn.addEventListener('click', () => {
      this.close();
      this.callbacks.onReturnToLobby();
    });

    const noBtn = document.createElement('button');
    noBtn.textContent = 'Cancel';
    noBtn.style.cssText = `
      padding: 8px 20px; font-size: 13px; font-weight: bold;
      background: rgba(60, 60, 80, 0.8); color: #ddd;
      border: 1px solid rgba(100, 100, 130, 0.3); border-radius: 4px;
      cursor: pointer; outline: none; font-family: inherit;
    `;
    noBtn.addEventListener('click', () => this.hideExitConfirm());

    btnRow.append(yesBtn, noBtn);
    this.confirmRow.append(prompt, btnRow);
    this.box.appendChild(this.confirmRow);
  }

  private hideExitConfirm(): void {
    this.confirmRow?.remove();
    this.confirmRow = null;
  }

  dispose(): void {
    if (this.rematchPollId) {
      clearInterval(this.rematchPollId);
      this.rematchPollId = null;
    }
    window.removeEventListener('keydown', this.onKeyDown);
    this.element.remove();
  }
}
