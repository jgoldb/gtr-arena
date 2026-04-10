import { keybindManager, codeToDisplayLabel, matchesKeybindEvent, buildComboString, type KeybindEntry } from './KeybindManager';

/**
 * Full-screen keybind editor opened from the Escape menu.
 *
 * Shows every rebindable action with its current key. Clicking a row puts it
 * into "listening" mode — the next physical key press becomes the new binding.
 * Conflicts are resolved by swapping the two actions.
 */
function bindLabel(code: string): string {
  return code ? codeToDisplayLabel(code) : 'Unbound';
}

export class KeybindMenu {
  readonly element: HTMLElement;
  private box: HTMLElement;
  private rows: Map<string, { keyLabel: HTMLElement; entry: KeybindEntry }> = new Map();
  private listeningId: string | null = null;
  private _isOpen = false;
  private onCloseCallback: (() => void) | null = null;
  private openSnapshot: Map<string, string> | null = null;
  private hintEl: HTMLElement;

  constructor() {
    // Backdrop
    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed; inset: 0; z-index: 1060;
      display: none; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.6);
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    `;

    // Panel
    this.box = document.createElement('div');
    this.box.style.cssText = `
      background: linear-gradient(to bottom, rgba(20, 20, 35, 0.97), rgba(10, 10, 20, 0.97));
      border: 1px solid rgba(100, 120, 200, 0.3);
      border-radius: 8px; padding: 24px 32px;
      min-width: 340px; max-height: 80vh;
      display: flex; flex-direction: column;
    `;

    // Title
    const title = document.createElement('div');
    title.textContent = 'Keybinds';
    title.style.cssText = `
      color: #ccc; font-size: 20px; font-weight: bold;
      margin-bottom: 16px; text-align: center;
    `;
    this.box.appendChild(title);

    // Scrollable list
    const list = document.createElement('div');
    list.style.cssText = `
      overflow-y: auto; flex: 1;
      margin-bottom: 16px;
    `;

    const entries = keybindManager.getAll();
    let lastCategory = '';
    for (const entry of entries) {
      // Category headers
      const cat = entry.category;
      if (cat !== lastCategory) {
        lastCategory = cat;
        const header = document.createElement('div');
        header.textContent = cat;
        header.style.cssText = `
          color: #8899bb; font-size: 11px; font-weight: bold;
          text-transform: uppercase; letter-spacing: 1px;
          margin: ${list.children.length > 0 ? '12px' : '0'} 0 6px 0;
        `;
        list.appendChild(header);
      }

      const row = this.createRow(entry);
      list.appendChild(row);
    }
    this.box.appendChild(list);

    // Hint for cancelling rebind
    this.hintEl = document.createElement('div');
    this.hintEl.textContent = 'Right-click to cancel · Delete to unbind';
    this.hintEl.style.cssText = `
      color: #667; font-size: 11px; text-align: center;
      margin-bottom: 10px; display: none;
    `;
    this.box.appendChild(this.hintEl);

    // Bottom buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 10px; justify-content: center;';

    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset All';
    resetBtn.style.cssText = this.buttonStyle('rgba(160, 120, 50, 0.8)', 'rgba(200, 160, 80, 0.3)');
    resetBtn.addEventListener('mouseenter', () => { resetBtn.style.background = 'rgba(180, 140, 60, 0.9)'; });
    resetBtn.addEventListener('mouseleave', () => { resetBtn.style.background = 'rgba(160, 120, 50, 0.8)'; });
    resetBtn.addEventListener('click', () => {
      this.cancelListening();
      keybindManager.resetAll();
      this.refreshAllRows();
    });

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.style.cssText = this.buttonStyle('rgba(40, 160, 80, 0.8)', 'rgba(80, 200, 120, 0.3)');
    saveBtn.addEventListener('mouseenter', () => { saveBtn.style.background = 'rgba(50, 180, 100, 0.9)'; });
    saveBtn.addEventListener('mouseleave', () => { saveBtn.style.background = 'rgba(40, 160, 80, 0.8)'; });
    saveBtn.addEventListener('click', () => this.saveAndClose());

    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export';
    exportBtn.style.cssText = this.buttonStyle('rgba(60, 60, 100, 0.8)', 'rgba(100, 100, 160, 0.3)');
    exportBtn.addEventListener('mouseenter', () => { exportBtn.style.background = 'rgba(70, 70, 120, 0.9)'; });
    exportBtn.addEventListener('mouseleave', () => { exportBtn.style.background = 'rgba(60, 60, 100, 0.8)'; });
    exportBtn.addEventListener('click', () => this.exportKeybinds(exportBtn));

    const importBtn = document.createElement('button');
    importBtn.textContent = 'Import';
    importBtn.style.cssText = this.buttonStyle('rgba(60, 60, 100, 0.8)', 'rgba(100, 100, 160, 0.3)');
    importBtn.addEventListener('mouseenter', () => { importBtn.style.background = 'rgba(70, 70, 120, 0.9)'; });
    importBtn.addEventListener('mouseleave', () => { importBtn.style.background = 'rgba(60, 60, 100, 0.8)'; });
    importBtn.addEventListener('click', () => this.importKeybinds());

    btnRow.append(importBtn, exportBtn, resetBtn, saveBtn);
    this.box.appendChild(btnRow);

    this.element.appendChild(this.box);

    // Cancel on backdrop click
    this.element.addEventListener('mousedown', (e) => {
      if (e.target === this.element) this.cancelAndClose();
    });

    // Key listener for rebinding
    window.addEventListener('keydown', this.onKeyDown);
    // Right-click cancels listening
    window.addEventListener('contextmenu', this.onContextMenu);
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  open(onClose?: () => void): void {
    this.onCloseCallback = onClose ?? null;
    this.openSnapshot = keybindManager.snapshot();
    this._isOpen = true;
    this.refreshAllRows();
    this.element.style.display = 'flex';
  }

  /** Save changes to localStorage and close */
  private saveAndClose(): void {
    this.cancelListening();
    keybindManager.save();
    this.openSnapshot = null;
    this._isOpen = false;
    this.element.style.display = 'none';
    this.onCloseCallback?.();
    this.onCloseCallback = null;
  }

  /** Revert to the snapshot taken on open and close */
  private cancelAndClose(): void {
    this.cancelListening();
    if (this.openSnapshot) {
      keybindManager.restore(this.openSnapshot);
      this.openSnapshot = null;
    }
    this._isOpen = false;
    this.element.style.display = 'none';
    this.onCloseCallback?.();
    this.onCloseCallback = null;
  }

  private createRow(entry: KeybindEntry): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = `
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 10px; margin: 2px 0;
      border-radius: 4px; cursor: pointer;
      transition: background 0.1s;
    `;

    const nameEl = document.createElement('div');
    nameEl.textContent = entry.label;
    nameEl.style.cssText = 'color: #ccc; font-size: 13px; pointer-events: none;';

    const keyLabel = document.createElement('div');
    keyLabel.textContent = bindLabel(entry.code);
    keyLabel.style.cssText = `
      color: #ffd100; font-size: 13px; font-weight: bold;
      background: rgba(255, 255, 255, 0.06);
      padding: 3px 10px; border-radius: 3px;
      min-width: 40px; text-align: center;
      border: 1px solid rgba(255, 255, 255, 0.1);
      pointer-events: none;
    `;

    row.append(nameEl, keyLabel);

    row.addEventListener('mouseenter', () => {
      if (this.listeningId !== entry.id) {
        row.style.background = 'rgba(255, 255, 255, 0.05)';
      }
    });
    row.addEventListener('mouseleave', () => {
      if (this.listeningId !== entry.id) {
        row.style.background = 'transparent';
      }
    });

    row.addEventListener('click', () => {
      if (this.listeningId === entry.id) {
        this.cancelListening();
      } else {
        this.startListening(entry.id);
      }
    });

    this.rows.set(entry.id, { keyLabel, entry });
    return row;
  }

  private startListening(actionId: string): void {
    // Cancel any prior listening
    this.cancelListening();
    this.listeningId = actionId;

    const rowData = this.rows.get(actionId);
    if (rowData) {
      rowData.keyLabel.textContent = '...';
      rowData.keyLabel.style.borderColor = '#5588ff';
      rowData.keyLabel.style.color = '#5588ff';
      rowData.keyLabel.parentElement!.style.background = 'rgba(60, 100, 200, 0.1)';
    }
    this.hintEl.style.display = 'block';
  }

  private cancelListening(): void {
    if (!this.listeningId) return;
    const rowData = this.rows.get(this.listeningId);
    if (rowData) {
      rowData.keyLabel.textContent = bindLabel(rowData.entry.code);
      rowData.keyLabel.style.borderColor = 'rgba(255, 255, 255, 0.1)';
      rowData.keyLabel.style.color = '#ffd100';
      rowData.keyLabel.parentElement!.style.background = 'transparent';
    }
    this.listeningId = null;
    this.hintEl.style.display = 'none';
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this._isOpen) return;

    // When not listening, the game-menu keybind closes the menu
    if (!this.listeningId) {
      if (matchesKeybindEvent(keybindManager.getCode('toggle_game_menu'), e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.cancelAndClose();
      }
      return;
    }

    // Listening mode: don't allow binding modifier-only keys
    const ignore = ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];
    if (ignore.includes(e.code)) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    // Delete / Backspace unbinds the action
    if (e.code === 'Delete' || e.code === 'Backspace') {
      keybindManager.rebind(this.listeningId, '');
    } else {
      const combo = buildComboString(e);
      keybindManager.rebind(this.listeningId, combo);
    }
    this.listeningId = null;
    this.hintEl.style.display = 'none';
    this.refreshAllRows();
  };

  private onContextMenu = (e: MouseEvent): void => {
    if (!this._isOpen || !this.listeningId) return;
    e.preventDefault();
    this.cancelListening();
  };

  private exportKeybinds(anchorBtn: HTMLElement): void {
    this.cancelListening();
    const str = keybindManager.exportString();
    navigator.clipboard.writeText(str).then(() => {
      const orig = anchorBtn.textContent;
      anchorBtn.textContent = 'Copied!';
      setTimeout(() => { anchorBtn.textContent = orig; }, 1500);
    });
  }

  private importKeybinds(): void {
    this.cancelListening();
    const raw = prompt('Paste keybind config:');
    if (!raw) return;
    try {
      keybindManager.importString(raw);
      this.refreshAllRows();
    } catch {
      alert('Invalid keybind config.');
    }
  }

  private refreshAllRows(): void {
    const entries = keybindManager.getAll();
    for (const entry of entries) {
      const rowData = this.rows.get(entry.id);
      if (rowData) {
        rowData.entry = entry;
        rowData.keyLabel.textContent = bindLabel(entry.code);
        rowData.keyLabel.style.borderColor = 'rgba(255, 255, 255, 0.1)';
        rowData.keyLabel.style.color = '#ffd100';
        rowData.keyLabel.parentElement!.style.background = 'transparent';
      }
    }
  }

  private buttonStyle(bg: string, border: string): string {
    return `
      padding: 8px 24px; font-size: 13px; font-weight: bold;
      background: ${bg}; color: #ddd;
      border: 1px solid ${border}; border-radius: 4px;
      cursor: pointer; outline: none; font-family: inherit;
    `;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('contextmenu', this.onContextMenu);
    this.element.remove();
  }
}
