import type { ConnectionState } from '../network/NetworkManager';

export class ReconnectOverlay {
  readonly element: HTMLElement;
  private textEl: HTMLElement;

  constructor() {
    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.3s ease;
    `;

    this.textEl = document.createElement('div');
    this.textEl.style.cssText = `
      color: #fff;
      font-size: 22px;
      font-weight: bold;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.8);
      text-align: center;
    `;
    this.element.appendChild(this.textEl);
    document.body.appendChild(this.element);
  }

  update(state: ConnectionState): void {
    switch (state.status) {
      case 'disconnected':
        this.textEl.textContent = 'Connection lost';
        this.show();
        break;
      case 'reconnecting':
        this.textEl.textContent = `Reconnecting... (${state.attempt}/${state.maxAttempts})`;
        this.show();
        break;
      case 'reconnected':
        this.hide();
        break;
      case 'failed':
        // Don't hide — let main.ts decide what to show based on game state
        break;
    }
  }

  /** Show a custom message on the overlay (e.g. for failed-while-in-game). */
  showMessage(text: string): void {
    this.textEl.textContent = text;
    this.show();
  }

  private show(): void {
    this.element.style.opacity = '1';
  }

  hide(): void {
    this.element.style.opacity = '0';
  }

  destroy(): void {
    this.element.remove();
  }
}
