import type { Targetable } from '../engine/types';

export interface TargetOfTargetFrameOptions {
  localPlayer?: Targetable;
  getPortrait?: (modelName: string) => string | undefined;
  onClick?: (target: Targetable) => void;
}

export class TargetOfTargetFrame {
  readonly element: HTMLElement;
  private portraitImg: HTMLImageElement;
  private nameEl: HTMLElement;
  private hpFill: HTMLElement;
  private manaFill: HTMLElement;
  private lastModelName = '';
  private currentTarget: Targetable | null = null;
  private localPlayer: Targetable | undefined;
  private getPortrait: ((modelName: string) => string | undefined) | undefined;
  private onClick: ((target: Targetable) => void) | undefined;

  constructor(options?: TargetOfTargetFrameOptions) {
    this.localPlayer = options?.localPlayer;
    this.getPortrait = options?.getPortrait;
    this.onClick = options?.onClick;

    this.element = document.createElement('div');
    this.element.style.cssText = `
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 3px;
      padding: 4px 6px;
      width: 150px;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      display: none;
      cursor: pointer;
      user-select: none;
    `;

    this.element.addEventListener('mousedown', (e) => {
      if (e.button === 0 && this.currentTarget && this.onClick) {
        this.onClick(this.currentTarget);
      }
    });

    const row = document.createElement('div');
    row.style.cssText = 'display: flex; gap: 5px; align-items: center;';

    // Small portrait
    const portraitWrap = document.createElement('div');
    portraitWrap.style.cssText = `
      position: relative;
      width: 24px;
      height: 24px;
      flex-shrink: 0;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 2px;
      overflow: hidden;
      background: rgba(0, 0, 0, 0.5);
    `;
    this.portraitImg = document.createElement('img');
    this.portraitImg.style.cssText = 'width: 100%; height: 100%; object-fit: cover; display: block;';
    this.portraitImg.alt = '';
    portraitWrap.appendChild(this.portraitImg);

    // Info column
    const info = document.createElement('div');
    info.style.cssText = 'flex: 1; min-width: 0;';

    // Name
    this.nameEl = document.createElement('div');
    this.nameEl.style.cssText = `
      color: #fff;
      font-size: 10px;
      font-weight: bold;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-shadow: 1px 1px 1px rgba(0,0,0,0.9);
      margin-bottom: 2px;
    `;

    // HP bar
    const hp = this.createBar('#22aa22', '#0a3a0a', 8);
    this.hpFill = hp.fill;

    // Mana bar
    const mana = this.createBar('#2255cc', '#0a1a3a', 5);
    this.manaFill = mana.fill;

    info.appendChild(this.nameEl);
    info.appendChild(hp.bar);
    info.appendChild(mana.bar);

    row.appendChild(portraitWrap);
    row.appendChild(info);
    this.element.appendChild(row);
  }

  private createBar(
    fillColor: string,
    bgColor: string,
    height: number
  ): { bar: HTMLElement; fill: HTMLElement } {
    const bar = document.createElement('div');
    bar.style.cssText = `
      position: relative;
      height: ${height}px;
      background: ${bgColor};
      border-radius: 1px;
      margin-bottom: 1px;
      overflow: hidden;
    `;

    const fill = document.createElement('div');
    fill.style.cssText = `
      position: absolute;
      top: 0; left: 0; bottom: 0;
      background: ${fillColor};
      transition: width 0.2s;
      width: 100%;
    `;

    bar.appendChild(fill);
    return { bar, fill };
  }

  update(target: Targetable | null): void {
    this.currentTarget = target;
    if (!target) {
      this.element.style.display = 'none';
      this.lastModelName = '';
      return;
    }
    this.element.style.display = '';

    const hostile = this.localPlayer ? target.isHostileTo(this.localPlayer) : false;

    // Portrait
    if (target.modelName !== this.lastModelName) {
      this.lastModelName = target.modelName;
      const url = this.getPortrait?.(target.modelName);
      if (url) {
        this.portraitImg.src = url;
        this.portraitImg.style.display = 'block';
      } else {
        this.portraitImg.style.display = 'none';
      }
    }

    // Name
    this.nameEl.textContent = target.name;
    this.nameEl.style.color = target.dead ? '#888' : hostile ? '#ff4444' : '#fff';

    // HP bar
    const hpPct = target.maxHp > 0 ? (target.hp / target.maxHp) * 100 : 0;
    this.hpFill.style.width = `${hpPct}%`;
    this.hpFill.style.background = hostile ? '#cc2222' : '#22aa22';

    // Mana bar
    const manaPct = target.maxMana > 0 ? (target.mana / target.maxMana) * 100 : 0;
    this.manaFill.style.width = `${manaPct}%`;
  }
}
