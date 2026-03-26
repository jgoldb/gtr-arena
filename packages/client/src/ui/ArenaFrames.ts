import type { Targetable } from '../engine/types';

export interface DRTimerDisplay {
  icon: string;
  count: number;
  remaining: number;
  total: number;
}

export interface ArenaFramesOptions {
  localPlayer: Targetable;
  getPortrait: (modelName: string) => string | undefined;
  onClick: (target: Targetable) => void;
}

interface ArenaFrameEntry {
  entityId: string;
  wrapper: HTMLElement;   // Outer wrapper (DR tray + trinket + frame body)
  element: HTMLElement;    // Clickable frame body
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
  drTray: HTMLElement;
  drIcons: HTMLElement[];
  trinketIcon: HTMLElement;
  trinketCooldown: number;
  trinketCooldownTotal: number;
  lastModelName: string;
  targetable: Targetable | null;
  combatTextEl: HTMLElement;
  combatTextTimer: number;
  // Snapshot values frozen when entity goes invisible
  invisible: boolean;
  frozenHp: number;
  frozenMaxHp: number;
  frozenMana: number;
  frozenMaxMana: number;
}

export class ArenaFrames {
  readonly element: HTMLElement;
  private frames: ArenaFrameEntry[] = [];
  private localPlayer: Targetable;
  private getPortrait: (modelName: string) => string | undefined;
  private onClick: (target: Targetable) => void;
  private selectedEntityId: string | null = null;
  private _disabled = false;

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
  }

  /** Set the list of opponent entity IDs + targetables. Call once on game start, or when entities change. */
  setEntities(
    entities: { entityId: string; targetable: Targetable }[]
  ): void {
    // Clear old frames
    for (const f of this.frames) f.wrapper.remove();
    this.frames = [];

    // Filter to only opponents (hostile to local player)
    const opponents = entities.filter(e => e.targetable.isHostileTo(this.localPlayer));

    for (const ent of opponents) {
      const frame = this.createFrame(ent.entityId);
      frame.targetable = ent.targetable;
      this.frames.push(frame);
      this.element.appendChild(frame.wrapper);
    }
  }

  setVisible(visible: boolean): void {
    this.element.style.display = visible ? 'flex' : 'none';
  }

  setSelectedTarget(entityId: string | null): void {
    this.selectedEntityId = entityId;
  }

  setDisabled(disabled: boolean): void {
    this._disabled = disabled;
  }

  private createFrame(entityId: string): ArenaFrameEntry {
    // Outer wrapper: side panel (absolutely positioned left) + frame body
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
      position: relative;
      pointer-events: none;
    `;

    // Side panel — holds DR tray + trinket icon, to the left of the frame body
    const sidePanel = document.createElement('div');
    sidePanel.style.cssText = `
      position: absolute;
      right: 100%;
      top: 0;
      bottom: 0;
      display: flex;
      flex-direction: row;
      align-items: stretch;
      gap: 3px;
      margin-right: 3px;
      pointer-events: none;
    `;
    wrapper.appendChild(sidePanel);

    // DR tray — wraps into columns (2 rows per column)
    const drTray = document.createElement('div');
    drTray.style.cssText = `
      display: flex;
      flex-direction: column;
      flex-wrap: wrap;
      gap: 2px;
      align-items: center;
      align-content: flex-end;
      pointer-events: none;
    `;
    sidePanel.appendChild(drTray);

    // PvP Trinket cooldown icon — matches frame height
    const trinketIcon = this.createTrinketIcon();
    sidePanel.appendChild(trinketIcon);

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
    wrapper.appendChild(el);

    el.addEventListener('mousedown', (e) => {
      if (e.button === 0 && !this._disabled) {
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

    return {
      entityId,
      wrapper,
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
      drTray,
      drIcons: [],
      trinketIcon,
      trinketCooldown: 0,
      trinketCooldownTotal: 0,
      lastModelName: '',
      targetable: null,
      combatTextEl,
      combatTextTimer: -1,
      invisible: false,
      frozenHp: 0,
      frozenMaxHp: 0,
      frozenMana: 0,
      frozenMaxMana: 0,
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

  private createTrinketIcon(): HTMLElement {
    // children[0] = emoji, [1] = sweep, [2] = timer
    const icon = document.createElement('div');
    icon.style.cssText = `
      height: 100%;
      aspect-ratio: 1;
      display: flex; align-items: center; justify-content: center;
      position: relative;
      background: rgba(60, 60, 80, 0.8);
      border: 2px solid #4a4;
      border-radius: 4px;
      overflow: hidden;
      pointer-events: none;
      flex-shrink: 0;
    `;

    const emoji = document.createElement('span');
    emoji.textContent = '\uD83C\uDFC6';
    emoji.style.cssText = 'font-size: 26px; line-height: 1; z-index: 1; position: relative;';
    icon.appendChild(emoji);

    const sweep = document.createElement('div');
    sweep.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      border-radius: 4px; pointer-events: none;
    `;
    icon.appendChild(sweep);

    const timer = document.createElement('span');
    timer.style.cssText = `
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      font-size: 16px; font-weight: bold; color: #fff;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 4px rgba(0,0,0,0.8);
      z-index: 2;
      pointer-events: none;
    `;
    icon.appendChild(timer);

    return icon;
  }

  notifyTrinketUsed(entityId: string, cooldown: number = 90, total?: number): void {
    const frame = this.frames.find(f => f.entityId === entityId);
    if (!frame) return;
    frame.trinketCooldown = cooldown;
    frame.trinketCooldownTotal = total ?? cooldown;
  }

  private updateTrinketIcon(frame: ArenaFrameEntry): void {
    const icon = frame.trinketIcon;
    const remaining = frame.trinketCooldown;
    const total = frame.trinketCooldownTotal;

    if (remaining > 0) {
      // On cooldown
      icon.style.borderColor = '#666';
      (icon.children[0] as HTMLElement).style.opacity = '0.4';

      const elapsed = total - remaining;
      const degrees = total > 0 ? (elapsed / total) * 360 : 0;
      const sweepEl = icon.children[1] as HTMLElement;
      sweepEl.style.background = degrees > 0
        ? `conic-gradient(from 0deg, rgba(0, 0, 0, 0.7) ${degrees}deg, transparent ${degrees}deg)`
        : 'transparent';

      (icon.children[2] as HTMLElement).textContent = Math.ceil(remaining).toString();
    } else {
      // Available
      icon.style.borderColor = '#4a4';
      (icon.children[0] as HTMLElement).style.opacity = '1';
      (icon.children[1] as HTMLElement).style.background = 'transparent';
      (icon.children[2] as HTMLElement).textContent = '';
    }
  }

  showCombatText(entityId: string, amount: number, type: 'damage' | 'heal' | 'crit' | 'miss' | 'dodge' | 'immune'): void {
    const frame = this.frames.find(f => f.entityId === entityId);
    if (!frame || frame.invisible) return;

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
      case 'immune':
        frame.combatTextEl.textContent = 'Immune';
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

  private createDRIcon(): HTMLElement {
    // children[0] = emoji, [1] = sweep, [2] = timer, [3] = DR level label
    const icon = document.createElement('div');
    icon.style.cssText = `
      width: 30px; height: 30px;
      display: flex; align-items: center; justify-content: center;
      position: relative;
      background: rgba(60, 60, 80, 0.8);
      border: 1px solid #888;
      border-radius: 2px;
      overflow: hidden;
    `;
    const emoji = document.createElement('span');
    emoji.style.cssText = 'font-size: 14px; line-height: 1; z-index: 1; position: relative; opacity: 0.85;';
    icon.appendChild(emoji);

    const sweep = document.createElement('div');
    sweep.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      border-radius: 2px; pointer-events: none;
    `;
    icon.appendChild(sweep);

    const timer = document.createElement('span');
    timer.style.cssText = `
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      font-size: 10px; font-weight: bold; color: #fff;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 4px rgba(0,0,0,0.8);
      z-index: 2;
      pointer-events: none;
    `;
    icon.appendChild(timer);

    const drLevel = document.createElement('span');
    drLevel.style.cssText = `
      position: absolute;
      bottom: 0px; left: 1px;
      font-size: 8px; font-weight: bold;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;
      z-index: 3;
      pointer-events: none;
    `;
    icon.appendChild(drLevel);

    return icon;
  }

  private static readonly DR_LEVEL_LABELS: Record<number, { text: string; color: string }> = {
    1: { text: '\u00BD', color: '#4f4' },   // ½ — next is half duration
    2: { text: '\u00BC', color: '#ff4' },   // ¼ — next is quarter duration
    3: { text: 'X', color: '#f44' },         // immune
  };

  private updateDRTray(frame: ArenaFrameEntry, drTimers: readonly DRTimerDisplay[]): void {
    while (frame.drIcons.length < drTimers.length) {
      const icon = this.createDRIcon();
      frame.drIcons.push(icon);
      frame.drTray.appendChild(icon);
    }
    for (let i = 0; i < frame.drIcons.length; i++) {
      if (i < drTimers.length) {
        const el = frame.drIcons[i];
        const dr = drTimers[i];
        el.style.display = 'flex';
        (el.children[0] as HTMLElement).textContent = dr.icon;
        const elapsed = dr.total - dr.remaining;
        const degrees = dr.total > 0 ? (elapsed / dr.total) * 360 : 0;
        const sweepEl = el.children[1] as HTMLElement;
        sweepEl.style.background = degrees > 0
          ? `conic-gradient(from 0deg, rgba(0, 0, 0, 0.7) ${degrees}deg, transparent ${degrees}deg)`
          : 'transparent';
        (el.children[2] as HTMLElement).textContent = Math.ceil(dr.remaining).toString();
        // DR level indicator
        const level = ArenaFrames.DR_LEVEL_LABELS[dr.count];
        const drLevelEl = el.children[3] as HTMLElement;
        if (level) {
          drLevelEl.textContent = level.text;
          drLevelEl.style.color = level.color;
        } else {
          drLevelEl.textContent = '';
        }
      } else {
        frame.drIcons[i].style.display = 'none';
      }
    }
  }

  /** Call every frame with dt and per-entity DR timers. */
  update(
    dt: number,
    getDRTimers?: (entityId: string) => readonly DRTimerDisplay[],
    isEntityInvisible?: (entityId: string) => boolean,
  ): void {
    for (const frame of this.frames) {
      const t = frame.targetable;
      if (!t) continue;

      frame.wrapper.style.display = '';

      // Invisibility: freeze HP/mana on transition, show frame as disabled
      const nowInvisible = isEntityInvisible?.(frame.entityId) ?? false;
      if (nowInvisible && !frame.invisible) {
        // Just went invisible — snapshot current values
        frame.invisible = true;
        frame.frozenHp = t.hp;
        frame.frozenMaxHp = t.maxHp;
        frame.frozenMana = t.mana;
        frame.frozenMaxMana = t.maxMana;
      } else if (!nowInvisible && frame.invisible) {
        frame.invisible = false;
      }

      const isInvis = frame.invisible;
      const disabled = this._disabled || isInvis;

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
      frame.skullOverlay.style.display = t.dead && !isInvis ? 'flex' : 'none';
      frame.disconnectOverlay.style.display = isDisconnected && !t.dead && !isInvis ? 'block' : 'none';

      // Name
      frame.nameEl.textContent = t.name;
      frame.nameEl.style.color = isDisconnected ? '#888' : t.dead ? '#888' : '#ff4444';
      frame.modelEl.textContent = t.modelName;

      // HP — use frozen values while invisible
      const hp = isInvis ? frame.frozenHp : t.hp;
      const maxHp = isInvis ? frame.frozenMaxHp : t.maxHp;
      const hpPct = maxHp > 0 ? (hp / maxHp) * 100 : 0;
      frame.hpFill.style.width = `${hpPct}%`;
      frame.hpFill.style.background = isDisconnected ? '#666' : '#cc2222';
      frame.hpBar.style.background = isDisconnected ? '#333' : '#3a0a0a';
      frame.hpText.textContent = `${Math.round(hp)} / ${maxHp}`;

      // Mana — use frozen values while invisible
      const mana = isInvis ? frame.frozenMana : t.mana;
      const maxMana = isInvis ? frame.frozenMaxMana : t.maxMana;
      const manaPct = maxMana > 0 ? (mana / maxMana) * 100 : 0;
      frame.manaFill.style.width = `${manaPct}%`;
      frame.manaFill.style.background = isDisconnected ? '#666' : '#2255cc';
      frame.manaBar.style.background = isDisconnected ? '#333' : '#0a1a3a';
      frame.manaText.textContent = `${Math.round(mana)} / ${maxMana}`;

      // Disabled state (during arena prep or invisible)
      frame.element.style.opacity = disabled ? '0.75' : '1';
      frame.element.style.cursor = disabled ? 'default' : 'pointer';
      frame.element.style.pointerEvents = disabled ? 'none' : 'auto';

      // Selection highlight
      const isSelected = frame.entityId === this.selectedEntityId;
      frame.element.style.borderColor = isSelected ? '#ff4444' : 'rgba(255, 255, 255, 0.15)';
      frame.element.style.borderWidth = isSelected ? '2px' : '1px';

      // Cast bar (hidden during arena prep or invisibility)
      if (!disabled && t.castingAbilityName && t.castingTotalTime > 0) {
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

      // DR timers
      this.updateDRTray(frame, getDRTimers?.(frame.entityId) ?? []);

      // Trinket cooldown
      if (frame.trinketCooldown > 0) {
        frame.trinketCooldown = Math.max(0, frame.trinketCooldown - dt);
      }
      this.updateTrinketIcon(frame);

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
    this.frames[idx].wrapper.remove();
    this.frames.splice(idx, 1);
  }

  hasEntity(entityId: string): boolean {
    return this.frames.some(f => f.entityId === entityId);
  }

  dispose(): void {
    for (const f of this.frames) f.wrapper.remove();
    this.frames = [];
    this.element.remove();
  }
}
