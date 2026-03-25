/**
 * Full-screen blind visual effect:
 * - Heavy blur on the game canvas
 * - Brown sand specks smudged across the screen
 * - Frequent, randomized eyelid blinks (arched black bars from top/bottom)
 */

const SPECK_COUNT = 250;
const BLUR_AMOUNT = 24; // px
const BLINK_CLOSE_SPEED = 0.10; // seconds to close
const BLINK_OPEN_SPEED = 0.18;  // seconds to open
const BLINK_MIN_INTERVAL = 0.08; // min seconds between blinks
const BLINK_MAX_INTERVAL = 0.4;  // max seconds between blinks
const BLINK_HOLD_MIN = 0.15;     // min seconds held shut
const BLINK_HOLD_MAX = 0.45;     // max seconds held shut

export class BlindEffect {
  private container: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private specksLayer: HTMLElement | null = null;
  private topLid: HTMLElement | null = null;
  private bottomLid: HTMLElement | null = null;
  private active = false;

  // Blink state
  private blinkTimer = 0;
  private blinkPhase: 'waiting' | 'closing' | 'holding' | 'opening' = 'waiting';
  private blinkNextInterval = 0;
  private blinkHoldDuration = 0;
  private blinkProgress = 0; // 0 = open, 1 = shut

  activate(canvas: HTMLCanvasElement): void {
    if (this.active) return;
    this.active = true;
    this.canvas = canvas;

    // Apply blur to the canvas
    canvas.style.filter = `blur(${BLUR_AMOUNT}px)`;

    // Create overlay container
    this.container = document.createElement('div');
    Object.assign(this.container.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '100vh',
      pointerEvents: 'none',
      zIndex: '900',
      overflow: 'hidden',
    });
    document.body.appendChild(this.container);

    // Brown sand specks layer
    this.specksLayer = document.createElement('div');
    Object.assign(this.specksLayer.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
    });
    this.container.appendChild(this.specksLayer);
    this.generateSpecks();

    // Top eyelid (arched)
    this.topLid = this.createLid('top');
    this.container.appendChild(this.topLid);

    // Bottom eyelid (arched, flipped)
    this.bottomLid = this.createLid('bottom');
    this.container.appendChild(this.bottomLid);

    // Start with eyes open, schedule first blink soon
    this.blinkProgress = 0;
    this.blinkPhase = 'waiting';
    this.blinkTimer = 0;
    this.blinkNextInterval = 0.05 + Math.random() * 0.2; // first blink comes fast
    this.updateLids();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;

    if (this.canvas) {
      this.canvas.style.filter = '';
      this.canvas = null;
    }

    if (this.container) {
      this.container.remove();
      this.container = null;
    }

    this.specksLayer = null;
    this.topLid = null;
    this.bottomLid = null;
  }

  isActive(): boolean {
    return this.active;
  }

  update(dt: number): void {
    if (!this.active) return;

    this.blinkTimer += dt;

    switch (this.blinkPhase) {
      case 'waiting':
        if (this.blinkTimer >= this.blinkNextInterval) {
          this.blinkPhase = 'closing';
          this.blinkTimer = 0;
        }
        break;

      case 'closing':
        this.blinkProgress = Math.min(1, this.blinkTimer / BLINK_CLOSE_SPEED);
        if (this.blinkProgress >= 1) {
          this.blinkPhase = 'holding';
          this.blinkTimer = 0;
          this.blinkHoldDuration = BLINK_HOLD_MIN + Math.random() * (BLINK_HOLD_MAX - BLINK_HOLD_MIN);
        }
        break;

      case 'holding':
        this.blinkProgress = 1;
        if (this.blinkTimer >= this.blinkHoldDuration) {
          this.blinkPhase = 'opening';
          this.blinkTimer = 0;
        }
        break;

      case 'opening':
        this.blinkProgress = Math.max(0, 1 - this.blinkTimer / BLINK_OPEN_SPEED);
        if (this.blinkProgress <= 0) {
          this.blinkPhase = 'waiting';
          this.blinkTimer = 0;
          this.blinkNextInterval = BLINK_MIN_INTERVAL + Math.random() * (BLINK_MAX_INTERVAL - BLINK_MIN_INTERVAL);
        }
        break;
    }

    this.updateLids();
  }

  private generateSpecks(): void {
    if (!this.specksLayer) return;

    for (let i = 0; i < SPECK_COUNT; i++) {
      const speck = document.createElement('div');
      const size = 15 + Math.random() * 70;
      const x = Math.random() * 100;
      const y = Math.random() * 100;
      const opacity = 0.3 + Math.random() * 0.5;
      // Vary brown tones
      const r = 100 + Math.floor(Math.random() * 80);
      const g = 60 + Math.floor(Math.random() * 50);
      const b = 20 + Math.floor(Math.random() * 30);
      const blur = Math.random() * 3;
      const scaleX = 0.6 + Math.random() * 1.2;
      const scaleY = 0.6 + Math.random() * 1.2;
      const rotation = Math.floor(Math.random() * 360);

      Object.assign(speck.style, {
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: '50%',
        backgroundColor: `rgba(${r}, ${g}, ${b}, ${opacity})`,
        filter: `blur(${blur}px)`,
        transform: `rotate(${rotation}deg) scale(${scaleX}, ${scaleY})`,
        boxShadow: `0 0 ${size * 0.5}px rgba(${r}, ${g}, ${b}, ${opacity * 0.5})`,
      });

      this.specksLayer.appendChild(speck);
    }
  }

  private createLid(position: 'top' | 'bottom'): HTMLElement {
    const lid = document.createElement('div');
    const isTop = position === 'top';

    Object.assign(lid.style, {
      position: 'absolute',
      left: '-5%',
      width: '110%',
      height: '55%',
      backgroundColor: '#000',
      // Very subtle arch — just enough curvature to look like an eyelid
      borderRadius: isTop ? '0 0 6% 6%' : '6% 6% 0 0',
      transition: 'none',
    });

    // Start well offscreen so they fly in
    if (isTop) lid.style.bottom = '150%';
    else lid.style.top = '150%';

    return lid;
  }

  private updateLids(): void {
    if (!this.topLid || !this.bottomLid) return;

    // blinkProgress: 0 = fully open, 1 = fully shut
    // At 1.0, the lids meet in the middle (each covers 50% of screen)
    const eased = this.easeInOut(this.blinkProgress);

    // At 0: lids sit at 150% (well offscreen — flying in from beyond the edge)
    // At 1: lids sit at 50% (each covers its half of the screen, meeting in middle)
    const offset = 150 - eased * 100; // 150% -> 50%

    this.topLid.style.bottom = `${offset}%`;
    this.bottomLid.style.top = `${offset}%`;
  }

  private easeInOut(t: number): number {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }
}
