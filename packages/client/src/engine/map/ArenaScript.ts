import * as THREE from 'three';
import type { MapScript } from './MapScript';
import type { CollisionSystem } from '../physics/CollisionSystem';

export interface ArenaTheme {
  title: string;
  titleColor: string;
  subtitle: string;
  urgentColor: string;
  fightColor: string;
  flashColor: number;
  flashIntensity: number;
}

/**
 * Base class for arena map scripts.  Handles the 30-second countdown timer,
 * countdown / "FIGHT!" UI overlays, flash-light effects on open, and the
 * `forceOpenDoors()` hook used by the engine.
 *
 * Subclasses implement the six abstract hooks to supply arena-specific visuals,
 * collider management, and opening animations.
 */
export abstract class ArenaScript implements MapScript {
  protected group!: THREE.Group;
  protected collision!: CollisionSystem;
  protected elapsed = 0;
  protected opened = false;

  private openAnimProgress = 0;
  private flashLights: THREE.PointLight[] = [];
  private overlayEl: HTMLElement | null = null;
  private countdownEl: HTMLElement | null = null;
  private fightEl: HTMLElement | null = null;

  protected readonly OPEN_TIME: number = 30;
  protected readonly OPEN_ANIM_DURATION: number = 2.5;

  constructor(protected readonly theme: ArenaTheme) {}

  // ---------------------------------------------------------------------------
  // MapScript interface
  // ---------------------------------------------------------------------------
  init(scene: THREE.Scene, mapGroup: THREE.Group, collision: CollisionSystem): void {
    this.group = mapGroup;
    this.collision = collision;
    this.elapsed = 0;
    this.opened = false;
    this.openAnimProgress = 0;

    this.initArena(scene);
    this.createCountdownUI();
  }

  resetTimer(): void {
    this.elapsed = 0;
  }

  update(dt: number): void {
    this.elapsed += dt;
    this.updateArena(dt);

    // Countdown
    if (!this.opened) {
      const remaining = Math.max(0, Math.ceil(this.OPEN_TIME - this.elapsed));

      if (this.countdownEl) {
        this.countdownEl.textContent = String(remaining);

        if (remaining <= 10) {
          this.countdownEl.style.color = this.theme.urgentColor;
          this.countdownEl.style.textShadow =
            `0 0 30px ${this.theme.urgentColor}cc, 2px 2px 6px rgba(0,0,0,0.8)`;
        }
        if (remaining <= 3 && remaining > 0) {
          const pulse = 1 + Math.sin(this.elapsed * 10) * 0.08;
          this.countdownEl.style.transform = `scale(${pulse})`;
        }
      }

      if (this.elapsed >= this.OPEN_TIME) {
        this.triggerOpen();
      }
    }

    // Opening animation (ease-out cubic applied here)
    if (this.opened && this.openAnimProgress < 1) {
      this.openAnimProgress += dt / this.OPEN_ANIM_DURATION;
      if (this.openAnimProgress > 1) this.openAnimProgress = 1;
      const t = 1 - Math.pow(1 - this.openAnimProgress, 3);
      this.animateOpen(t);
    }

    // Flash light fade
    for (let i = this.flashLights.length - 1; i >= 0; i--) {
      const flash = this.flashLights[i];
      const age = this.elapsed - this.OPEN_TIME;
      if (age < 1.2) {
        flash.intensity = this.theme.flashIntensity * (1 - age / 1.2);
      } else {
        this.group.remove(flash);
        this.flashLights.splice(i, 1);
      }
    }

    // Fade out FIGHT text
    if (this.fightEl) {
      const age = this.elapsed - this.OPEN_TIME;
      if (age > 2.5) {
        this.fightEl.style.opacity = String(Math.max(0, 1 - (age - 2.5) / 1));
        if (age > 3.5) {
          this.fightEl.remove();
          this.fightEl = null;
        }
      }
    }
  }

  forceOpenDoors(): void {
    if (this.opened) return;
    this.elapsed = this.OPEN_TIME;
    this.triggerOpen();
  }

  dispose(): void {
    this.overlayEl?.remove();
    this.fightEl?.remove();
    this.overlayEl = null;
    this.fightEl = null;
    this.countdownEl = null;
    this.flashLights = [];
    this.disposeArena();
  }

  // ---------------------------------------------------------------------------
  // Subclass hooks
  // ---------------------------------------------------------------------------

  /** Create all arena-specific visuals, colliders, lighting, etc. */
  protected abstract initArena(scene: THREE.Scene): void;

  /** Per-frame arena-specific updates (e.g. shader uniforms). */
  protected abstract updateArena(dt: number): void;

  /** Clean up arena-specific resources. */
  protected abstract disposeArena(): void;

  /** Called once when the timer expires — remove starting-zone colliders, etc. */
  protected abstract onOpen(): void;

  /**
   * Animate the opening each frame.
   * @param t eased progress 0 → 1 (ease-out cubic already applied).
   */
  protected abstract animateOpen(t: number): void;

  /** Positions where flash-lights spawn on open. */
  protected abstract getFlashPositions(): { x: number; y: number; z: number }[];

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------
  private triggerOpen(): void {
    this.opened = true;
    this.openAnimProgress = 0;

    this.onOpen();

    // Flash effects
    for (const pos of this.getFlashPositions()) {
      const flash = new THREE.PointLight(this.theme.flashColor, this.theme.flashIntensity, 40);
      flash.position.set(pos.x, pos.y, pos.z);
      this.group.add(flash);
      this.flashLights.push(flash);
    }

    // Remove countdown overlay
    if (this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
      this.countdownEl = null;
    }

    this.showFightText();
  }

  private createCountdownUI(): void {
    const { title, titleColor, subtitle } = this.theme;

    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0;
      pointer-events: none;
      z-index: 50;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding-top: 55px;
    `;

    const titleEl = document.createElement('div');
    titleEl.style.cssText = `
      font-family: 'Impact', 'Arial Black', sans-serif;
      font-size: 52px;
      color: ${titleColor};
      text-shadow: 0 0 20px ${titleColor}88, 0 0 50px ${titleColor}44, 2px 2px 4px rgba(0,0,0,0.8);
      letter-spacing: 10px;
      text-transform: uppercase;
    `;
    titleEl.textContent = title;
    overlay.appendChild(titleEl);

    const subtitleEl = document.createElement('div');
    subtitleEl.style.cssText = `
      font-size: 18px;
      color: #888;
      margin-top: 4px;
      font-family: Arial, sans-serif;
      text-shadow: 1px 1px 3px rgba(0,0,0,0.8);
      letter-spacing: 4px;
      text-transform: uppercase;
    `;
    subtitleEl.textContent = subtitle;
    overlay.appendChild(subtitleEl);

    const countdown = document.createElement('div');
    countdown.style.cssText = `
      font-family: 'Impact', 'Arial Black', sans-serif;
      font-size: 64px;
      color: #ffffff;
      text-shadow: 0 0 20px rgba(255,255,255,0.3), 2px 2px 6px rgba(0,0,0,0.8);
      margin-top: 0;
      transition: color 0.3s, text-shadow 0.3s;
    `;
    countdown.textContent = String(this.OPEN_TIME);
    overlay.appendChild(countdown);

    document.body.appendChild(overlay);
    this.overlayEl = overlay;
    this.countdownEl = countdown;
  }

  private showFightText(): void {
    const { fightColor } = this.theme;

    const fight = document.createElement('div');
    fight.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none;
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Impact', 'Arial Black', sans-serif;
      font-size: 120px;
      color: ${fightColor};
      text-shadow:
        0 0 40px ${fightColor}cc,
        0 0 80px ${fightColor}66,
        4px 4px 8px rgba(0,0,0,0.9);
      letter-spacing: 15px;
      transition: opacity 1s ease-out;
    `;
    fight.textContent = 'FIGHT!';
    document.body.appendChild(fight);
    this.fightEl = fight;
  }
}
