import type { Targetable } from '../engine/types';
import type { ActiveBuff } from '../engine/combat/BuffSystem';

export interface UnitFrameOptions {
  localPlayer?: Targetable;
  getPortrait?: (modelName: string) => string | undefined;
}

export class UnitFrame {
  readonly element: HTMLElement;
  private portraitImg: HTMLImageElement;
  private skullOverlay: HTMLElement;
  private nameEl: HTMLElement;
  private modelEl: HTMLElement;
  private combatIcon: HTMLElement;
  private hpBar: HTMLElement;
  private hpFill: HTMLElement;
  private hpText: HTMLElement;
  private manaFill: HTMLElement;
  private manaText: HTMLElement;
  private buffTray: HTMLElement;
  private debuffTray: HTMLElement;
  private buffIcons: HTMLElement[] = [];
  private debuffIcons: HTMLElement[] = [];
  private localPlayer: Targetable | undefined;
  private getPortrait: ((modelName: string) => string | undefined) | undefined;
  private lastModelName = '';
  private combatTextEl: HTMLElement;
  private combatTextTimer = -1; // -1 = inactive

  constructor(options?: UnitFrameOptions) {
    this.localPlayer = options?.localPlayer;
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
      position: relative;
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

    this.skullOverlay = document.createElement('div');
    this.skullOverlay.textContent = '\uD83D\uDC80';
    this.skullOverlay.style.cssText = `
      position: absolute;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.6);
      font-size: 24px;
      line-height: 48px;
      text-align: center;
    `;
    portraitWrap.appendChild(this.skullOverlay);

    // Combat text overlay (centered on portrait)
    this.combatTextEl = document.createElement('div');
    this.combatTextEl.style.cssText = `
      position: absolute;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      font-weight: bold;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      text-shadow:
        -1px -1px 0 #000,
         1px -1px 0 #000,
        -1px  1px 0 #000,
         1px  1px 0 #000,
         0 0 4px rgba(0,0,0,0.8);
      pointer-events: none;
      z-index: 1;
    `;
    portraitWrap.appendChild(this.combatTextEl);

    // Info column (name + bars)
    const info = document.createElement('div');
    info.style.cssText = 'flex: 1; min-width: 0;';

    // Name row
    const nameRow = document.createElement('div');
    nameRow.style.cssText =
      'display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;';

    this.nameEl = document.createElement('span');
    this.nameEl.style.cssText = 'color: #fff; font-size: 13px; font-weight: bold;';

    this.combatIcon = document.createElement('span');
    this.combatIcon.textContent = '\u2694';
    this.combatIcon.style.cssText =
      'color: #cc3333; font-size: 13px; margin-left: 4px; display: none;';

    this.modelEl = document.createElement('span');
    this.modelEl.style.cssText =
      'color: rgba(255,255,255,0.5); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';

    nameRow.appendChild(this.nameEl);
    nameRow.appendChild(this.combatIcon);
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

    // Buff tray (below main content)
    this.buffTray = document.createElement('div');
    this.buffTray.style.cssText = 'display: flex; flex-wrap: wrap; gap: 2px; margin-top: 4px;';
    this.element.appendChild(this.buffTray);

    // Debuff tray (below buffs)
    this.debuffTray = document.createElement('div');
    this.debuffTray.style.cssText = 'display: flex; flex-wrap: wrap; gap: 2px; margin-top: 2px;';
    this.element.appendChild(this.debuffTray);
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

  private createAuraIcon(isDebuff: boolean): HTMLElement {
    const icon = document.createElement('div');
    icon.style.cssText = `
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      background: rgba(80, 80, 100, 0.8);
      border-radius: 2px;
      overflow: hidden;
      ${isDebuff ? 'border: 1.5px solid #cc2222;' : 'border: 1px solid rgba(255,255,255,0.2);'}
    `;

    const emoji = document.createElement('span');
    emoji.style.cssText = 'font-size: 14px; line-height: 1; z-index: 1; position: relative;';
    icon.appendChild(emoji);

    // Duration sweep overlay (fills up, opposite of action bar cooldowns)
    const sweep = document.createElement('div');
    sweep.style.cssText = `
      position: absolute;
      top: 0; left: 0;
      width: 100%;
      height: 100%;
      border-radius: 2px;
      pointer-events: none;
    `;
    icon.appendChild(sweep);

    const timer = document.createElement('span');
    timer.style.cssText = `
      position: absolute;
      bottom: -1px;
      right: 1px;
      font-size: 9px;
      color: #fff;
      text-shadow: 1px 1px 1px rgba(0,0,0,0.9);
      z-index: 2;
    `;
    icon.appendChild(timer);

    return icon;
  }

  private updateAuraTray(
    tray: HTMLElement,
    pool: HTMLElement[],
    auras: readonly ActiveBuff[],
    isDebuff: boolean
  ): void {
    // Grow pool as needed
    while (pool.length < auras.length) {
      const icon = this.createAuraIcon(isDebuff);
      pool.push(icon);
      tray.appendChild(icon);
    }
    // Update each slot
    for (let i = 0; i < pool.length; i++) {
      if (i < auras.length) {
        const el = pool[i];
        const aura = auras[i];
        el.style.display = 'flex';
        (el.children[0] as HTMLElement).textContent = aura.definition.icon;
        // Duration sweep: fills up as time elapses (opposite of cooldown drain)
        const elapsed = aura.definition.duration - aura.remaining;
        const degrees = aura.definition.duration > 0
          ? (elapsed / aura.definition.duration) * 360
          : 0;
        (el.children[1] as HTMLElement).style.background =
          degrees > 0
            ? `conic-gradient(from 0deg, rgba(0, 0, 0, 0.7) ${degrees}deg, transparent ${degrees}deg)`
            : 'transparent';
        (el.children[2] as HTMLElement).textContent = Math.ceil(aura.remaining).toString();
        el.title = `${aura.definition.name}\n${aura.definition.description}`;
      } else {
        pool[i].style.display = 'none';
      }
    }
  }

  private static readonly CT_DURATION = 1.5;
  private static readonly CT_POP_IN = 0.15;
  private static readonly CT_FADE_START = 1.0;

  showCombatText(amount: number, type: 'damage' | 'heal' | 'crit' | 'miss' | 'dodge'): void {
    switch (type) {
      case 'heal':
        this.combatTextEl.textContent = `+${amount}`;
        this.combatTextEl.style.color = '#22ff44';
        this.combatTextEl.style.fontSize = '18px';
        break;
      case 'crit':
        this.combatTextEl.textContent = `${amount}`;
        this.combatTextEl.style.color = '#ffcc00';
        this.combatTextEl.style.fontSize = '24px';
        break;
      case 'miss':
        this.combatTextEl.textContent = 'Miss';
        this.combatTextEl.style.color = '#aaaaaa';
        this.combatTextEl.style.fontSize = '16px';
        break;
      case 'dodge':
        this.combatTextEl.textContent = 'Dodge';
        this.combatTextEl.style.color = '#aaaaaa';
        this.combatTextEl.style.fontSize = '16px';
        break;
      default:
        this.combatTextEl.textContent = `${amount}`;
        this.combatTextEl.style.color = '#ffffff';
        this.combatTextEl.style.fontSize = '18px';
        break;
    }
    this.combatTextTimer = 0;
    this.combatTextEl.style.display = 'flex';
  }

  updateCombatText(dt: number): void {
    if (this.combatTextTimer < 0) return;
    this.combatTextTimer += dt;

    if (this.combatTextTimer >= UnitFrame.CT_DURATION) {
      this.combatTextTimer = -1;
      this.combatTextEl.style.display = 'none';
      return;
    }

    const t = this.combatTextTimer;

    // Pop-in: scale 0 → 1.3 → 1.0
    let scale: number;
    if (t < UnitFrame.CT_POP_IN) {
      const p = t / UnitFrame.CT_POP_IN;
      scale = 1.3 * p;
    } else if (t < UnitFrame.CT_POP_IN * 2) {
      const p = (t - UnitFrame.CT_POP_IN) / UnitFrame.CT_POP_IN;
      scale = 1.3 - 0.3 * p;
    } else {
      scale = 1;
    }

    // Fade out over last portion
    let opacity = 1;
    if (t > UnitFrame.CT_FADE_START) {
      opacity = 1 - (t - UnitFrame.CT_FADE_START) / (UnitFrame.CT_DURATION - UnitFrame.CT_FADE_START);
    }

    this.combatTextEl.style.transform = `scale(${scale.toFixed(2)})`;
    this.combatTextEl.style.opacity = `${opacity.toFixed(2)}`;
  }

  update(
    target: Targetable | null,
    buffs?: readonly ActiveBuff[],
    debuffs?: readonly ActiveBuff[]
  ): void {
    if (!target) {
      this.element.style.display = 'none';
      this.lastModelName = '';
      return;
    }
    this.element.style.display = '';

    const hostile = this.localPlayer ? target.isHostileTo(this.localPlayer) : false;

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

    // Skull overlay on portrait when dead
    this.skullOverlay.style.display = target.dead ? 'flex' : 'none';

    // Name, combat indicator, and model
    this.nameEl.textContent = target.name;
    this.nameEl.style.color = hostile ? '#ff4444' : target.dead ? '#888' : '#fff';
    this.combatIcon.style.display = target.inCombat ? 'inline' : 'none';
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
    if (this.localPlayer) {
      this.element.style.borderLeftColor = hostile
        ? '#cc2222'
        : 'rgba(255, 255, 255, 0.15)';
      this.element.style.borderLeftWidth = hostile ? '3px' : '1px';
    }

    // Buff / debuff trays
    this.updateAuraTray(this.buffTray, this.buffIcons, buffs ?? [], false);
    this.updateAuraTray(this.debuffTray, this.debuffIcons, debuffs ?? [], true);
  }
}
