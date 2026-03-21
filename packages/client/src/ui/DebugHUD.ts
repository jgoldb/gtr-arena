export class DebugHUD {
  readonly element: HTMLElement;
  private fpsEl: HTMLElement;
  private latencyEl: HTMLElement;
  private _visible = false;
  private _isMultiplayer: boolean;

  // FPS smoothing
  private frameTimes: number[] = [];
  private readonly MAX_SAMPLES = 60;

  // Latency — update display every 3 seconds
  private latencyAccum = 0;
  private latencySamples: number[] = [];

  constructor(isMultiplayer: boolean) {
    this._isMultiplayer = isMultiplayer;

    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed; bottom: 12px; left: 12px; z-index: 201;
      background: rgba(0, 0, 0, 0.6); padding: 6px 10px;
      border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.1);
      font-family: 'Consolas', 'Courier New', monospace;
      font-size: 12px; color: #ccc; pointer-events: none;
      display: none;
    `;

    this.fpsEl = document.createElement('div');
    this.fpsEl.textContent = 'FPS: --';

    this.latencyEl = document.createElement('div');
    this.latencyEl.textContent = 'Ping: --';
    if (!isMultiplayer) this.latencyEl.style.display = 'none';

    this.element.appendChild(this.fpsEl);
    this.element.appendChild(this.latencyEl);

    window.addEventListener('keydown', this.onKeyDown);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'KeyL') {
      // Don't toggle if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      this._visible = !this._visible;
      this.element.style.display = this._visible ? 'block' : 'none';
    }
  };

  update(dt: number): void {
    if (!this._visible) return;

    if (dt > 0) {
      this.frameTimes.push(dt);
      if (this.frameTimes.length > this.MAX_SAMPLES) this.frameTimes.shift();
    }
    const avgDt = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.fpsEl.textContent = `FPS: ${avgDt > 0 ? Math.round(1 / avgDt) : 0}`;

    if (this._isMultiplayer) {
      this.latencyAccum += dt;
      if (this.latencyAccum >= 3 && this.latencySamples.length > 0) {
        const avg = this.latencySamples.reduce((a, b) => a + b, 0) / this.latencySamples.length;
        this.latencyEl.textContent = `Ping: ${Math.round(avg)}ms`;
        this.latencySamples.length = 0;
        this.latencyAccum = 0;
      }
    }
  }

  pushLatency(ms: number): void {
    if (!this._isMultiplayer) return;
    this.latencySamples.push(ms);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.element.remove();
  }
}
