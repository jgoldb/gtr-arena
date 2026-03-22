export class DeathFrame {
  readonly element: HTMLElement;

  constructor() {
    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed;
      top: 15%;
      left: 50%;
      transform: translateX(-50%);
      z-index: 500;
      pointer-events: none;
      display: none;
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      background: linear-gradient(to bottom, rgba(30, 10, 10, 0.9), rgba(15, 5, 5, 0.9));
      border: 1px solid #882222;
      border-radius: 4px;
      padding: 16px 40px;
      text-align: center;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    `;

    const title = document.createElement('div');
    title.textContent = 'You have died';
    title.style.cssText = `
      color: #cc2222;
      font-size: 22px;
      font-weight: bold;
      text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.8);
    `;

    box.appendChild(title);
    this.element.appendChild(box);
  }

  show(): void {
    this.element.style.display = 'block';
  }

  hide(): void {
    this.element.style.display = 'none';
  }

  get visible(): boolean {
    return this.element.style.display !== 'none';
  }
}
