import type { Targetable } from '../engine/types';

export class UnitTooltip {
  readonly element: HTMLElement;
  private card: HTMLElement;
  private nameEl: HTMLElement;
  private modelEl: HTMLElement;
  private targetEl: HTMLElement;
  private hpBarFill: HTMLElement;
  private hpBarBg: HTMLElement;
  private localPlayer: Targetable | undefined;
  private lastTarget: Targetable | null = null;

  // Linger + fade state
  private lingerTimer = 0;
  private fadeOpacity = 1;
  private static readonly LINGER_DURATION = 2;   // seconds to hold after unhover
  private static readonly FADE_DURATION = 0.4;   // seconds to fade out

  constructor(localPlayer?: Targetable) {
    this.localPlayer = localPlayer;

    // Outer wrapper — positions everything, no background
    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed;
      bottom: 28px;
      right: 24px;
      z-index: 200;
      min-width: 180px;
      max-width: 220px;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      pointer-events: none;
      display: none;
    `;

    // Card (bordered area with text content)
    this.card = document.createElement('div');
    this.card.style.cssText = `
      background: rgba(0, 0, 0, 0.82);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      padding: 8px 10px;
    `;
    this.element.appendChild(this.card);

    // Player name
    this.nameEl = document.createElement('div');
    this.nameEl.style.cssText = 'font-size: 13px; font-weight: bold; color: #fff; margin-bottom: 2px;';
    this.card.appendChild(this.nameEl);

    // Character / model name
    this.modelEl = document.createElement('div');
    this.modelEl.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.5); margin-bottom: 4px;';
    this.card.appendChild(this.modelEl);

    // Target line
    this.targetEl = document.createElement('div');
    this.targetEl.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.6);';
    this.card.appendChild(this.targetEl);

    // HP bar — outside the card, directly below it
    this.hpBarBg = document.createElement('div');
    this.hpBarBg.style.cssText = `
      position: relative;
      height: 10px;
      margin-top: 3px;
      background: #0a3a0a;
      border-radius: 2px;
      overflow: hidden;
    `;

    this.hpBarFill = document.createElement('div');
    this.hpBarFill.style.cssText = `
      position: absolute;
      top: 0; left: 0; bottom: 0;
      background: #22aa22;
      transition: width 0.15s;
      width: 100%;
    `;

    this.hpBarBg.appendChild(this.hpBarFill);
    this.element.appendChild(this.hpBarBg);
  }

  update(
    hovered: Targetable | null,
    getTargetName: (entity: Targetable) => string,
    dt?: number,
  ): void {
    // Ignore self-hover
    if (hovered && this.localPlayer && hovered === this.localPlayer) {
      hovered = null;
    }

    // Active hover — reset linger, show immediately
    if (hovered) {
      this.lastTarget = hovered;
      this.lingerTimer = UnitTooltip.LINGER_DURATION;
      this.fadeOpacity = 1;
      this.element.style.display = '';
      this.element.style.opacity = '1';
      this.render(hovered, getTargetName);
      return;
    }

    // No hover — if we were showing, start linger countdown
    if (this.lastTarget) {
      const step = dt ?? 0.016;

      if (this.lingerTimer > 0) {
        // Still lingering — count down
        this.lingerTimer -= step;
        return;
      }

      // Linger expired — fade out
      this.fadeOpacity -= step / UnitTooltip.FADE_DURATION;
      if (this.fadeOpacity <= 0) {
        this.fadeOpacity = 0;
        this.element.style.display = 'none';
        this.element.style.opacity = '1';
        this.lastTarget = null;
        this.lingerTimer = 0;
      } else {
        this.element.style.opacity = `${this.fadeOpacity.toFixed(2)}`;
      }
    }
  }

  private render(target: Targetable, getTargetName: (entity: Targetable) => string): void {
    const hostile = this.localPlayer ? target.isHostileTo(this.localPlayer) : false;

    // Name — colored by hostility
    this.nameEl.textContent = target.name;
    this.nameEl.style.color = hostile ? '#ff4444' : '#44ff44';

    // Character model name
    this.modelEl.textContent = target.modelName;

    // Target
    this.targetEl.textContent = `Target: ${getTargetName(target)}`;

    // HP bar
    const hpPct = target.maxHp > 0 ? (target.hp / target.maxHp) * 100 : 0;
    this.hpBarFill.style.width = `${hpPct}%`;
    this.hpBarFill.style.background = hostile ? '#cc2222' : '#22aa22';
    this.hpBarBg.style.background = hostile ? '#3a0a0a' : '#0a3a0a';
  }

  dispose(): void {
    this.element.remove();
  }
}
