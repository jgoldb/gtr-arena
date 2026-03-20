interface FloatingMessage {
  element: HTMLElement;
  expiresAt: number;
}

export class ErrorText {
  readonly element: HTMLElement;
  private messages: FloatingMessage[] = [];

  constructor() {
    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed;
      top: 30%;
      left: 50%;
      transform: translateX(-50%);
      z-index: 200;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    `;
  }

  show(text: string, duration = 2000): void {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = `
      color: #ff4444;
      font-size: 18px;
      font-weight: bold;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.9);
      opacity: 1;
      transition: opacity 0.5s ease-out;
      white-space: nowrap;
    `;
    this.element.appendChild(el);

    const msg: FloatingMessage = {
      element: el,
      expiresAt: performance.now() + duration,
    };
    this.messages.push(msg);

    // Start fade-out near end
    setTimeout(() => {
      el.style.opacity = '0';
    }, duration - 500);

    setTimeout(() => {
      el.remove();
      const idx = this.messages.indexOf(msg);
      if (idx !== -1) this.messages.splice(idx, 1);
    }, duration);
  }
}
