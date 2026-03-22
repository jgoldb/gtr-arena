import type { Targetable } from '../engine/types';
import type { ActiveBuff } from '../engine/combat/BuffSystem';

export interface ArenaFramesOptions {
  localPlayer: Targetable;
  getPortrait: (modelName: string) => string | undefined;
  onClick: (target: Targetable) => void;
}

interface ArenaFrameEntry {
  entityId: string;
  element: HTMLElement;
  portraitImg: HTMLImageElement;
  skullOverlay: HTMLElement;
  disconnectOverlay: HTMLElement;
  nameEl: HTMLElement;
  modelEl: HTMLElement;
  hpBar: HTMLElement;
  hpFill: HTMLElement;
  hpText: HTMLElement;
  manaBar: HTMLElement;
  manaFill: HTMLElement;
  manaText: HTMLElement;
  castBarContainer: HTMLElement;
  castBarFill: HTMLElement;
  castBarLabel: HTMLElement;
  debuffTray: HTMLElement;
  debuffIcons: HTMLElement[];
  lastModelName: string;
  targetable: Targetable | null;
  combatTextEl: HTMLElement;
  combatTextTimer: number;
}

export class ArenaFrames {
  readonly element: HTMLElement;
  private frames: ArenaFrameEntry[] = [];
  private localPlayer: Targetable;
  private getPortrait: (modelName: string) => string | undefined;
  private onClick: (target: Targetable) => void;
  private selectedEntityId: string | null = null;
  private tooltipEl: HTMLElement;
  private tooltipHoveredEl: HTMLElement | null = null;

  private static readonly CT_DURATION = 1.5;
  private static readonly CT_POP_IN = 0.15;
  private static readonly CT_FADE_START = 1.0;

  constructor(options: ArenaFramesOptions) {
    this.localPlayer = options.localPlayer;
    this.getPortrait = options.getPortrait;
    this.onClick = options.onClick;

    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed;
      top: 50%;
      right: 12px;
      transform: translateY(-50%);
      z-index: 200;
      display: flex;
      flex-direction: column;
      gap: 4px;
      pointer-events: none;
    `;

    // Shared tooltip
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.style.cssText = `
      position: fixed;
      z-index: 400;
      pointer-events: none;
      display: none;
      min-width: 160px;
      max-width: 240px;
      background: linear-gradient(to bottom, rgba(20, 12, 28, 0.97), rgba(10, 6, 16, 0.97));
      border: 1px solid #5535aa;
      border-radius: 4px;
      padding: 8px 10px;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.7);
    `;
    document.body.appendChild(this.tooltipEl);
  }

  /** Set the list of opponent entity IDs + targetables. Call once on game start, or when entities change. */
  setEntities(
    entities: { entityId: string; targetable: Targetable }[]
  ): void {
    // Clear old frames
    for (const f of this.frames) f.element.remove();
    this.frames = [];

    // Filter to only opponents (hostile to local player)
    const opponents = entities.filter(e => e.targetable.isHostileTo(this.localPlayer));

    for (const ent of opponents) {
      const frame = this.createFrame(ent.entityId);
      frame.targetable = ent.targetable;
      this.frames.push(frame);
      this.element.appendChild(frame.element);
    }
  }

  setVisible(visible: boolean): void {
    this.element.style.display = visible ? 'flex' : 'none';
  }

  setSelectedTarget(entityId: string | null): void {
    this.selectedEntityId = entityId;
  }

  private createFrame(entityId: string): ArenaFrameEntry {
    const el = document.createElement('div');
    el.style.cssText = `
      background: rgba(0, 0, 0, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      padding: 6px 8px;
      width: 220px;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      cursor: pointer;
      user-select: none;
      pointer-events: auto;
      transition: border-color 0.15s;
    `;

    el.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        const frame = this.frames.find(f => f.element === el);
        if (frame?.targetable) this.onClick(frame.targetable);
      }
    });

    // Main row: portrait | info
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; gap: 6px;';

    // Portrait
    const portraitWrap = document.createElement('div');
    portraitWrap.style.cssText = `
      position: relative;
      width: 36px;
      height: 36px;
      flex-shrink: 0;
      border: 2px solid rgba(255, 255, 255, 0.2);
      border-radius: 3px;
      overflow: hidden;
      background: rgba(0, 0, 0, 0.5);
    `;
    const portraitImg = document.createElement('img');
    portraitImg.style.cssText = 'width: 100%; height: 100%; object-fit: cover; display: block;';
    portraitImg.alt = '';
    portraitWrap.appendChild(portraitImg);

    const skullOverlay = document.createElement('div');
    skullOverlay.textContent = '\uD83D\uDC80';
    skullOverlay.style.cssText = `
      position: absolute; inset: 0;
      display: none; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.6);
      font-size: 18px; line-height: 36px; text-align: center;
    `;
    portraitWrap.appendChild(skullOverlay);

    const disconnectOverlay = document.createElement('div');
    disconnectOverlay.style.cssText = `
      position: absolute; inset: 0;
      display: none;
      background: rgba(128, 128, 128, 0.5);
      border-radius: 2px;
    `;
    portraitWrap.appendChild(disconnectOverlay);

    // Combat text overlay
    const combatTextEl = document.createElement('div');
    combatTextEl.style.cssText = `
      position: absolute; inset: 0;
      display: none; align-items: center; justify-content: center;
      font-size: 14px; font-weight: bold;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 4px rgba(0,0,0,0.8);
      pointer-events: none; z-index: 1;
    `;
    portraitWrap.appendChild(combatTextEl);

    // Info column
    const info = document.createElement('div');
    info.style.cssText = 'flex: 1; min-width: 0;';

    // Name row: player name + character name
    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 2px;';

    const nameEl = document.createElement('span');
    nameEl.style.cssText = 'color: #ff4444; font-size: 11px; font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';

    const modelEl = document.createElement('span');
    modelEl.style.cssText = 'color: rgba(255,255,255,0.5); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-left: 4px;';

    nameRow.appendChild(nameEl);
    nameRow.appendChild(modelEl);
    info.appendChild(nameRow);

    // HP bar
    const { bar: hpBar, fill: hpFill, text: hpText } = this.createBar('#cc2222', '#3a0a0a', 13);
    info.appendChild(hpBar);

    // Mana bar
    const { bar: manaBar, fill: manaFill, text: manaText } = this.createBar('#2255cc', '#0a1a3a', 10);
    info.appendChild(manaBar);

    row.appendChild(portraitWrap);
    row.appendChild(info);
    el.appendChild(row);

    // Cast bar (below main row, hidden by default)
    const castBarContainer = document.createElement('div');
    castBarContainer.style.cssText = `
      display: none;
      margin-top: 3px;
      height: 12px;
      background: rgba(0, 0, 0, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 2px;
      position: relative;
      overflow: hidden;
    `;

    const castBarFill = document.createElement('div');
    castBarFill.style.cssText = `
      position: absolute;
      top: 0; left: 0; bottom: 0;
      background: linear-gradient(to right, #4488ff, #66aaff);
      width: 0%;
      transition: width 0.05s linear;
    `;
    castBarContainer.appendChild(castBarFill);

    const castBarLabel = document.createElement('div');
    castBarLabel.style.cssText = `
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-size: 9px;
      text-shadow: 1px 1px 1px rgba(0,0,0,0.9);
    `;
    castBarContainer.appendChild(castBarLabel);
    el.appendChild(castBarContainer);

    // Debuff tray
    const debuffTray = document.createElement('div');
    debuffTray.style.cssText = 'display: flex; flex-wrap: wrap; gap: 2px; margin-top: 3px;';
    el.appendChild(debuffTray);

    return {
      entityId,
      element: el,
      portraitImg,
      skullOverlay,
      disconnectOverlay,
      nameEl,
      modelEl,
      hpBar,
      hpFill,
      hpText,
      manaBar,
      manaFill,
      manaText,
      castBarContainer,
      castBarFill,
      castBarLabel,
      debuffTray,
      debuffIcons: [],
      lastModelName: '',
      targetable: null,
      combatTextEl,
      combatTextTimer: -1,
    };
  }

  private createBar(fillColor: string, bgColor: string, height: number) {
    const bar = document.createElement('div');
    bar.style.cssText = `
      position: relative;
      height: ${height}px;
      background: ${bgColor};
      border-radius: 2px;
      margin-bottom: 2px;
      overflow: hidden;
    `;
    const fill = document.createElement('div');
    fill.style.cssText = `
      position: absolute; top: 0; left: 0; bottom: 0;
      background: ${fillColor};
      transition: width 0.2s;
      width: 100%;
    `;
    const text = document.createElement('div');
    text.style.cssText = `
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-size: 9px;
      text-shadow: 1px 1px 1px rgba(0,0,0,0.9);
    `;
    bar.appendChild(fill);
    bar.appendChild(text);
    return { bar, fill, text };
  }

  private createDebuffIcon(): HTMLElement {
    const icon = document.createElement('div');
    icon.style.cssText = `
      width: 22px; height: 22px;
      display: flex; align-items: center; justify-content: center;
      position: relative;
      background: rgba(80, 80, 100, 0.8);
      border: 1.5px solid #cc2222;
      border-radius: 2px;
      overflow: hidden;
      cursor: pointer;
    `;
    const emoji = document.createElement('span');
    emoji.style.cssText = 'font-size: 11px; line-height: 1; z-index: 1; position: relative;';
    icon.appendChild(emoji);

    const sweep = document.createElement('div');
    sweep.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      border-radius: 2px; pointer-events: none;
    `;
    icon.appendChild(sweep);

    const timer = document.createElement('span');
    timer.style.cssText = `
      position: absolute; bottom: -1px; right: 1px;
      font-size: 8px; color: #fff;
      text-shadow: 1px 1px 1px rgba(0,0,0,0.9);
      z-index: 2;
    `;
    icon.appendChild(timer);

    // Tooltip on hover
    icon.addEventListener('mouseenter', () => {
      this.tooltipHoveredEl = icon;
      this.refreshTooltip(icon);
    });
    icon.addEventListener('mouseleave', () => {
      if (this.tooltipHoveredEl === icon) {
        this.tooltipHoveredEl = null;
        this.tooltipEl.style.display = 'none';
      }
    });

    return icon;
  }

  private refreshTooltip(icon: HTMLElement): void {
    const aura = (icon as any)._aura as ActiveBuff | undefined;
    if (!aura) {
      this.tooltipEl.style.display = 'none';
      return;
    }
    const remaining = Math.ceil(aura.remaining);
    const durationLabel = !(remaining > 0 && isFinite(remaining)) ? '' : `<div style="
      color: #aaa; font-size: 11px; margin-top: 4px;
    ">${remaining} second${remaining !== 1 ? 's' : ''} remaining</div>`;

    this.tooltipEl.innerHTML = `
      <div style="color: #ffd100; font-size: 14px; font-weight: bold; margin-bottom: 4px;">${aura.definition.name}</div>
      <div style="color: #eee; font-size: 12px; line-height: 1.4;">${aura.definition.description}</div>
      ${durationLabel}
    `;

    const rect = icon.getBoundingClientRect();
    this.tooltipEl.style.display = 'block';
    const tipW = this.tooltipEl.offsetWidth;
    // Position to the left of the icon (since frames are on the right side)
    let left = rect.left - tipW - 6;
    if (left < 8) left = rect.right + 6;
    this.tooltipEl.style.left = `${left}px`;
    this.tooltipEl.style.top = `${rect.top}px`;
  }

  private updateDebuffTray(
    frame: ArenaFrameEntry,
    debuffs: readonly ActiveBuff[]
  ): void {
    while (frame.debuffIcons.length < debuffs.length) {
      const icon = this.createDebuffIcon();
      frame.debuffIcons.push(icon);
      frame.debuffTray.appendChild(icon);
    }
    for (let i = 0; i < frame.debuffIcons.length; i++) {
      if (i < debuffs.length) {
        const el = frame.debuffIcons[i];
        const aura = debuffs[i];
        (el as any)._aura = aura;
        el.style.display = 'flex';
        (el.children[0] as HTMLElement).textContent = aura.definition.icon;
        const hasFiniteDuration = (aura.definition.duration > 0 && isFinite(aura.definition.duration))
          || (aura.remaining > 0 && isFinite(aura.remaining));
        el.style.background = hasFiniteDuration ? 'rgba(80, 80, 100, 0.8)' : 'transparent';
        const elapsed = aura.definition.duration - aura.remaining;
        const degrees = hasFiniteDuration && isFinite(aura.definition.duration) && aura.definition.duration > 0
          ? (elapsed / aura.definition.duration) * 360 : 0;
        const sweepEl = el.children[1] as HTMLElement;
        sweepEl.style.display = hasFiniteDuration ? '' : 'none';
        sweepEl.style.background = degrees > 0
          ? `conic-gradient(from 0deg, rgba(0, 0, 0, 0.7) ${degrees}deg, transparent ${degrees}deg)`
          : 'transparent';
        (el.children[2] as HTMLElement).textContent = hasFiniteDuration ? Math.ceil(aura.remaining).toString() : '';
        if (this.tooltipHoveredEl === el) this.refreshTooltip(el);
      } else {
        frame.debuffIcons[i].style.display = 'none';
        (frame.debuffIcons[i] as any)._aura = undefined;
        if (this.tooltipHoveredEl === frame.debuffIcons[i]) {
          this.tooltipHoveredEl = null;
          this.tooltipEl.style.display = 'none';
        }
      }
    }
    // Show/hide tray
    frame.debuffTray.style.display = debuffs.length > 0 ? 'flex' : 'none';
  }

  showCombatText(entityId: string, amount: number, type: 'damage' | 'heal' | 'crit' | 'miss' | 'dodge'): void {
    const frame = this.frames.find(f => f.entityId === entityId);
    if (!frame) return;

    switch (type) {
      case 'heal':
        frame.combatTextEl.textContent = `+${amount}`;
        frame.combatTextEl.style.color = '#22ff44';
        frame.combatTextEl.style.fontSize = '14px';
        break;
      case 'crit':
        frame.combatTextEl.textContent = `${amount}`;
        frame.combatTextEl.style.color = '#ffcc00';
        frame.combatTextEl.style.fontSize = '18px';
        break;
      case 'miss':
        frame.combatTextEl.textContent = 'Miss';
        frame.combatTextEl.style.color = '#aaaaaa';
        frame.combatTextEl.style.fontSize = '12px';
        break;
      case 'dodge':
        frame.combatTextEl.textContent = 'Dodge';
        frame.combatTextEl.style.color = '#aaaaaa';
        frame.combatTextEl.style.fontSize = '12px';
        break;
      default:
        frame.combatTextEl.textContent = `${amount}`;
        frame.combatTextEl.style.color = '#ffffff';
        frame.combatTextEl.style.fontSize = '14px';
        break;
    }
    frame.combatTextTimer = 0;
    frame.combatTextEl.style.display = 'flex';
  }

  /** Call every frame with dt and per-entity buffs. */
  update(
    dt: number,
    getDebuffs: (entityId: string) => readonly ActiveBuff[],
  ): void {
    for (const frame of this.frames) {
      const t = frame.targetable;
      if (!t) continue;

      // Portrait
      if (t.modelName !== frame.lastModelName) {
        frame.lastModelName = t.modelName;
        const url = this.getPortrait(t.modelName);
        if (url) {
          frame.portraitImg.src = url;
          frame.portraitImg.style.display = 'block';
        } else {
          frame.portraitImg.style.display = 'none';
        }
      }

      const isDisconnected = t.disconnected ?? false;

      // Dead / disconnect overlays
      frame.skullOverlay.style.display = t.dead ? 'flex' : 'none';
      frame.disconnectOverlay.style.display = isDisconnected && !t.dead ? 'block' : 'none';

      // Name
      frame.nameEl.textContent = t.name;
      frame.nameEl.style.color = isDisconnected ? '#888' : t.dead ? '#888' : '#ff4444';
      frame.modelEl.textContent = t.modelName;

      // HP
      const hpPct = t.maxHp > 0 ? (t.hp / t.maxHp) * 100 : 0;
      frame.hpFill.style.width = `${hpPct}%`;
      frame.hpFill.style.background = isDisconnected ? '#666' : '#cc2222';
      frame.hpBar.style.background = isDisconnected ? '#333' : '#3a0a0a';
      frame.hpText.textContent = `${Math.round(t.hp)} / ${t.maxHp}`;

      // Mana
      const manaPct = t.maxMana > 0 ? (t.mana / t.maxMana) * 100 : 0;
      frame.manaFill.style.width = `${manaPct}%`;
      frame.manaFill.style.background = isDisconnected ? '#666' : '#2255cc';
      frame.manaBar.style.background = isDisconnected ? '#333' : '#0a1a3a';
      frame.manaText.textContent = `${Math.round(t.mana)} / ${t.maxMana}`;

      // Selection highlight
      const isSelected = frame.entityId === this.selectedEntityId;
      frame.element.style.borderColor = isSelected ? '#ff4444' : 'rgba(255, 255, 255, 0.15)';
      frame.element.style.borderWidth = isSelected ? '2px' : '1px';

      // Cast bar
      if (t.castingAbilityName && t.castingTotalTime > 0) {
        frame.castBarContainer.style.display = 'block';
        let progress: number;
        if (t.castingIsChannel) {
          progress = Math.max(0, (t.castingTotalTime - t.castingElapsed) / t.castingTotalTime);
          frame.castBarFill.style.background = 'linear-gradient(to right, #cc8833, #eebb55)';
        } else {
          progress = Math.min(1, t.castingElapsed / t.castingTotalTime);
          frame.castBarFill.style.background = 'linear-gradient(to right, #4488ff, #66aaff)';
        }
        frame.castBarFill.style.width = `${progress * 100}%`;
        const remaining = Math.max(0, t.castingTotalTime - t.castingElapsed);
        frame.castBarLabel.textContent = `${t.castingAbilityName} ${remaining.toFixed(1)}s`;
      } else {
        frame.castBarContainer.style.display = 'none';
      }

      // Debuffs
      this.updateDebuffTray(frame, getDebuffs(frame.entityId));

      // Combat text animation
      this.updateCombatText(frame, dt);
    }
  }

  private updateCombatText(frame: ArenaFrameEntry, dt: number): void {
    if (frame.combatTextTimer < 0) return;
    frame.combatTextTimer += dt;

    if (frame.combatTextTimer >= ArenaFrames.CT_DURATION) {
      frame.combatTextTimer = -1;
      frame.combatTextEl.style.display = 'none';
      return;
    }

    const t = frame.combatTextTimer;
    let scale: number;
    if (t < ArenaFrames.CT_POP_IN) {
      scale = 1.3 * (t / ArenaFrames.CT_POP_IN);
    } else if (t < ArenaFrames.CT_POP_IN * 2) {
      scale = 1.3 - 0.3 * ((t - ArenaFrames.CT_POP_IN) / ArenaFrames.CT_POP_IN);
    } else {
      scale = 1;
    }

    let opacity = 1;
    if (t > ArenaFrames.CT_FADE_START) {
      opacity = 1 - (t - ArenaFrames.CT_FADE_START) / (ArenaFrames.CT_DURATION - ArenaFrames.CT_FADE_START);
    }

    frame.combatTextEl.style.transform = `scale(${scale.toFixed(2)})`;
    frame.combatTextEl.style.opacity = `${opacity.toFixed(2)}`;
  }

  removeEntity(entityId: string): void {
    const idx = this.frames.findIndex(f => f.entityId === entityId);
    if (idx === -1) return;
    this.frames[idx].element.remove();
    this.frames.splice(idx, 1);
  }

  hasEntity(entityId: string): boolean {
    return this.frames.some(f => f.entityId === entityId);
  }

  dispose(): void {
    for (const f of this.frames) f.element.remove();
    this.frames = [];
    this.element.remove();
    this.tooltipEl.remove();
  }
}
