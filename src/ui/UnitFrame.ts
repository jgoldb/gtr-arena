import type { Targetable } from '../engine/types';

export interface UnitFrameOptions {
  hostileAware?: boolean;
  getPortrait?: (modelName: string) => string | undefined;
}

export class UnitFrame {
  readonly element: HTMLElement;
  private portraitImg: HTMLImageElement;
  private nameEl: HTMLElement;
  private modelEl: HTMLElement;
  private hpBar: HTMLElement;
  private hpFill: HTMLElement;
  private hpText: HTMLElement;
  private manaFill: HTMLElement;
  private manaText: HTMLElement;
  private hostileAware: boolean;
  private getPortrait: ((modelName: string) => string | undefined) | undefined;
  private lastModelName = '';

  constructor(options?: UnitFrameOptions) {
    this.hostileAware = options?.hostileAware ?? false;
    this.getPortrait = options?.getPortrait;

    this.element = document.createElement('div');
    this.element.style.cssText = `
      background: rgba(0, 0, 0, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      padding: 8px 10px;
      width: 260px;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      display: none;
    `;

    // Outer flex: portrait | info column
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; gap: 8px;';

    // Portrait
    const portraitWrap = document.createElement('div');
    portraitWrap.style.cssText = `
      width: 48px;
      height: 48px;
      flex-shrink: 0;
      border: 2px solid rgba(255, 255, 255, 0.2);
      border-radius: 4px;
      overflow: hidden;
      background: rgba(0, 0, 0, 0.5);
    `;
    this.portraitImg = document.createElement('img');
    this.portraitImg.style.cssText = 'width: 100%; height: 100%; object-fit: cover; display: block;';
    this.portraitImg.alt = '';
    portraitWrap.appendChild(this.portraitImg);

    // Info column (name + bars)
    const info = document.createElement('div');
    info.style.cssText = 'flex: 1; min-width: 0;';

    // Name row
    const nameRow = document.createElement('div');
    nameRow.style.cssText =
      'display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;';

    this.nameEl = document.createElement('span');
    this.nameEl.style.cssText = 'color: #fff; font-size: 13px; font-weight: bold;';

    this.modelEl = document.createElement('span');
    this.modelEl.style.cssText =
      'color: rgba(255,255,255,0.5); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';

    nameRow.appendChild(this.nameEl);
    nameRow.appendChild(this.modelEl);
    info.appendChild(nameRow);

    // HP bar
    const hp = this.createBar('#22aa22', '#0a3a0a', 16);
    this.hpBar = hp.bar;
    this.hpFill = hp.fill;
    this.hpText = hp.text;
    info.appendChild(hp.bar);

    // Mana bar
    const mana = this.createBar('#2255cc', '#0a1a3a', 12);
    this.manaFill = mana.fill;
    this.manaText = mana.text;
    info.appendChild(mana.bar);

    row.appendChild(portraitWrap);
    row.appendChild(info);
    this.element.appendChild(row);
  }

  private createBar(
    fillColor: string,
    bgColor: string,
    height: number
  ): { bar: HTMLElement; fill: HTMLElement; text: HTMLElement } {
    const bar = document.createElement('div');
    bar.style.cssText = `
      position: relative;
      height: ${height}px;
      background: ${bgColor};
      border-radius: 2px;
      margin-bottom: 3px;
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

    const text = document.createElement('div');
    text.style.cssText = `
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 10px;
      text-shadow: 1px 1px 1px rgba(0,0,0,0.9);
    `;

    bar.appendChild(fill);
    bar.appendChild(text);
    return { bar, fill, text };
  }

  update(target: Targetable | null): void {
    if (!target) {
      this.element.style.display = 'none';
      this.lastModelName = '';
      return;
    }
    this.element.style.display = '';

    const hostile = this.hostileAware && target.hostile;

    // Update portrait when model changes
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

    // Name and model
    this.nameEl.textContent = target.name;
    this.nameEl.style.color = hostile ? '#ff4444' : '#fff';
    this.modelEl.textContent = target.modelName;

    // HP bar — red for hostile targets, green otherwise
    const hpPct = target.maxHp > 0 ? (target.hp / target.maxHp) * 100 : 0;
    this.hpFill.style.width = `${hpPct}%`;
    this.hpFill.style.background = hostile ? '#cc2222' : '#22aa22';
    this.hpBar.style.background = hostile ? '#3a0a0a' : '#0a3a0a';
    this.hpText.textContent = `${Math.round(target.hp)} / ${target.maxHp}`;

    // Mana bar — always blue
    const manaPct =
      target.maxMana > 0 ? (target.mana / target.maxMana) * 100 : 0;
    this.manaFill.style.width = `${manaPct}%`;
    this.manaText.textContent = `${Math.round(target.mana)} / ${target.maxMana}`;

    // Hostile border indicator
    if (this.hostileAware) {
      this.element.style.borderLeftColor = hostile
        ? '#cc2222'
        : 'rgba(255, 255, 255, 0.15)';
      this.element.style.borderLeftWidth = hostile ? '3px' : '1px';
    }
  }
}
