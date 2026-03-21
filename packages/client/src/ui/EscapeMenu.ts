export interface EscapeMenuCallbacks {
  onReturnToLobby: () => void;
  /** If provided, called when Escape is pressed while menu is closed. Return true to suppress opening the menu. */
  onEscapeWhilePlaying?: () => boolean;
}

export class EscapeMenu {
  readonly element: HTMLElement;
  private box: HTMLElement;
  private _isOpen = false;

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

    // Return to Lobby button
    const lobbyBtn = document.createElement('button');
    lobbyBtn.textContent = 'Return to Lobby';
    lobbyBtn.style.cssText = `
      display: block; width: 100%;
      padding: 10px 24px; font-size: 14px;
      background: rgba(40, 80, 160, 0.8); color: #ddd;
      border: 1px solid rgba(100, 140, 255, 0.3); border-radius: 4px;
      cursor: pointer; outline: none;
      font-family: inherit;
    `;
    lobbyBtn.addEventListener('mouseenter', () => {
      lobbyBtn.style.background = 'rgba(50, 100, 200, 0.9)';
    });
    lobbyBtn.addEventListener('mouseleave', () => {
      lobbyBtn.style.background = 'rgba(40, 80, 160, 0.8)';
    });
    lobbyBtn.addEventListener('click', () => {
      this.close();
      this.callbacks.onReturnToLobby();
    });

    this.box.append(title, lobbyBtn);
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
    this.element.style.display = 'flex';
  }

  close(): void {
    this._isOpen = false;
    this.element.style.display = 'none';
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.element.remove();
  }
}
