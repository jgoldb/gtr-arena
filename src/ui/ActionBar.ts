import { YARDS_TO_UNITS, type Ability } from '../engine/combat/Ability';
import type { CombatSystem } from '../engine/combat/CombatSystem';

export interface ActionBarSlot {
  ability: Ability | null;
  keybind: string; // display label ("1", "2", etc.)
  keyCode: string; // KeyboardEvent.code ("Digit1", etc.)
}

export type AbilityUsabilityStatus = 'usable' | 'no-target' | 'out-of-range' | 'not-enough-resource';

export interface ActionBarCallbacks {
  onActivate: (ability: Ability) => void;
  getAbilityStatus: (ability: Ability) => AbilityUsabilityStatus;
  getCombatSystem: () => CombatSystem;
  isDisabled?: () => boolean;
}

const DEFAULT_KEYBINDS: { label: string; code: string }[] = [
  { label: '1', code: 'Digit1' },
  { label: '2', code: 'Digit2' },
  { label: '3', code: 'Digit3' },
  { label: '4', code: 'Digit4' },
  { label: '5', code: 'Digit5' },
  { label: '6', code: 'Digit6' },
];

export class ActionBar {
  readonly element: HTMLElement;
  private slots: ActionBarSlot[] = [];
  private slotElements: HTMLElement[] = [];
  private cooldownOverlays: HTMLElement[] = [];
  private cooldownTexts: HTMLElement[] = [];
  private statusOverlays: HTMLElement[] = [];
  private tooltipEl: HTMLElement;
  private callbacks: ActionBarCallbacks;
  private dragSourceIndex: number | null = null;

  constructor(callbacks: ActionBarCallbacks) {
    this.callbacks = callbacks;

    // Initialize 6 slots with default keybinds
    for (let i = 0; i < 6; i++) {
      this.slots.push({
        ability: null,
        keybind: DEFAULT_KEYBINDS[i].label,
        keyCode: DEFAULT_KEYBINDS[i].code,
      });
    }

    // Shared tooltip element (positioned on hover, avoids per-slot clipping)
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.style.cssText = `
      position: fixed;
      z-index: 400;
      pointer-events: none;
      display: none;
      min-width: 180px;
      max-width: 260px;
      background: linear-gradient(to bottom, rgba(20, 12, 28, 0.97), rgba(10, 6, 16, 0.97));
      border: 1px solid #5535aa;
      border-radius: 4px;
      padding: 10px 12px;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.7);
    `;
    document.body.appendChild(this.tooltipEl);

    // Build DOM
    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 100;
      display: flex;
      gap: 4px;
      padding: 6px 8px;
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      user-select: none;
    `;

    for (let i = 0; i < 6; i++) {
      const slot = this.createSlotElement(i);
      this.element.appendChild(slot);
    }

    // Keyboard listener
    window.addEventListener('keydown', this.onKeyDown);
  }

  setSlotAbility(index: number, ability: Ability | null): void {
    if (index < 0 || index >= this.slots.length) return;
    this.slots[index].ability = ability;
    this.renderSlot(index);
  }

  clearAllSlots(): void {
    for (let i = 0; i < this.slots.length; i++) {
      this.setSlotAbility(i, null);
    }
  }

  update(): void {
    const combat = this.callbacks.getCombatSystem();
    const disabled = this.callbacks.isDisabled?.() ?? false;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const slotEl = this.slotElements[i];
      const overlay = this.cooldownOverlays[i];
      const cdText = this.cooldownTexts[i];
      const statusOv = this.statusOverlays[i];

      if (!slot.ability) {
        slotEl.style.opacity = disabled ? '0.3' : '1';
        overlay.style.background = 'transparent';
        statusOv.style.background = 'transparent';
        cdText.textContent = '';
        continue;
      }

      if (disabled) {
        slotEl.style.opacity = '0.3';
        overlay.style.background = 'transparent';
        statusOv.style.background = 'transparent';
        cdText.textContent = '';
        continue;
      }

      const status = this.callbacks.getAbilityStatus(slot.ability);
      const cdRemaining = combat.getCooldownRemaining(slot.ability.id);
      const onCooldown = cdRemaining > 0;

      // Status tint: red for out-of-range, blue for not-enough-resource
      if (status === 'out-of-range') {
        statusOv.style.background = 'rgba(255, 40, 40, 0.35)';
      } else if (status === 'not-enough-resource') {
        statusOv.style.background = 'rgba(40, 80, 220, 0.4)';
      } else {
        statusOv.style.background = 'transparent';
      }

      // Dim if no target or on cooldown; tinted states stay full brightness
      slotEl.style.opacity =
        status === 'no-target' || onCooldown ? '0.5' : '1';

      // Circular cooldown sweep (clock-wipe from 12 o'clock, clockwise)
      if (onCooldown) {
        const totalCd = combat.getCooldownTotal(slot.ability.id);
        const degrees = totalCd > 0 ? (cdRemaining / totalCd) * 360 : 0;
        overlay.style.background =
          `conic-gradient(from 0deg, rgba(0, 0, 0, 0.7) ${degrees}deg, transparent ${degrees}deg)`;
        cdText.textContent = cdRemaining < 10
          ? cdRemaining.toFixed(1)
          : String(Math.ceil(cdRemaining));
      } else {
        overlay.style.background = 'transparent';
        cdText.textContent = '';
      }
    }
  }

  private createSlotElement(index: number): HTMLElement {
    const container = document.createElement('div');
    container.style.cssText = `
      position: relative;
      width: 48px;
      height: 48px;
      background: rgba(30, 30, 40, 0.9);
      border: 2px solid rgba(255, 255, 255, 0.2);
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    `;

    // Ability icon
    const iconEl = document.createElement('div');
    iconEl.style.cssText = `
      font-size: 22px;
      line-height: 1;
      color: #ddd;
      pointer-events: none;
    `;
    container.appendChild(iconEl);

    // Status overlay — colored tint for out-of-range / not-enough-resource
    const statusOverlay = document.createElement('div');
    statusOverlay.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border-radius: 2px;
      pointer-events: none;
    `;
    container.appendChild(statusOverlay);
    this.statusOverlays.push(statusOverlay);

    // Cooldown overlay — circular sweep via conic-gradient
    const cooldownOverlay = document.createElement('div');
    cooldownOverlay.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border-radius: 2px;
      pointer-events: none;
    `;
    container.appendChild(cooldownOverlay);
    this.cooldownOverlays.push(cooldownOverlay);

    // Cooldown text (centered number)
    const cdText = document.createElement('div');
    cdText.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: #ffd100;
      font-size: 16px;
      font-weight: bold;
      text-shadow: 1px 1px 2px rgba(0,0,0,0.9);
      pointer-events: none;
    `;
    container.appendChild(cdText);
    this.cooldownTexts.push(cdText);

    // Keybind label (top-right corner)
    const keybindEl = document.createElement('div');
    keybindEl.style.cssText = `
      position: absolute;
      top: 2px;
      right: 3px;
      color: rgba(255, 255, 255, 0.6);
      font-size: 10px;
      font-weight: bold;
      pointer-events: none;
      text-shadow: 1px 1px 1px rgba(0,0,0,0.9);
    `;
    keybindEl.textContent = this.slots[index].keybind;
    container.appendChild(keybindEl);

    // Tooltip hover
    container.addEventListener('mouseenter', () => {
      const ab = this.slots[index].ability;
      if (!ab) return;
      this.showTooltip(ab, container);
    });
    container.addEventListener('mouseleave', () => {
      this.tooltipEl.style.display = 'none';
    });

    // Click to activate (only on quick click, not drag)
    let didDrag = false;
    container.addEventListener('mousedown', (e) => {
      if (e.button === 0) didDrag = false;
    });
    container.addEventListener('click', (e) => {
      if (e.button !== 0 || didDrag) return;
      if (this.callbacks.isDisabled?.()) return;
      const ab = this.slots[index].ability;
      if (ab) {
        this.callbacks.onActivate(ab);
      }
    });

    // --- Drag and drop ---
    container.draggable = true;

    container.addEventListener('dragstart', (e) => {
      if (!this.slots[index].ability) {
        e.preventDefault();
        return;
      }
      didDrag = true;
      this.dragSourceIndex = index;
      container.style.opacity = '0.4';
      e.dataTransfer!.effectAllowed = 'move';
      this.tooltipEl.style.display = 'none';
    });

    container.addEventListener('dragend', () => {
      container.style.opacity = '1';
      this.dragSourceIndex = null;
      for (const el of this.slotElements) {
        el.style.borderColor = 'rgba(255, 255, 255, 0.2)';
      }
    });

    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (this.dragSourceIndex !== null && this.dragSourceIndex !== index) {
        container.style.borderColor = '#5588ff';
      }
    });

    container.addEventListener('dragleave', () => {
      container.style.borderColor = 'rgba(255, 255, 255, 0.2)';
    });

    container.addEventListener('drop', (e) => {
      e.preventDefault();
      container.style.borderColor = 'rgba(255, 255, 255, 0.2)';
      if (this.dragSourceIndex !== null && this.dragSourceIndex !== index) {
        const srcAbility = this.slots[this.dragSourceIndex].ability;
        const dstAbility = this.slots[index].ability;
        this.slots[this.dragSourceIndex].ability = dstAbility;
        this.slots[index].ability = srcAbility;
        this.renderSlot(this.dragSourceIndex);
        this.renderSlot(index);
      }
      this.dragSourceIndex = null;
    });

    this.slotElements.push(container);
    return container;
  }

  private showTooltip(ability: Ability, anchor: HTMLElement): void {
    const hasRange = ability.range !== undefined;
    const hasCooldown = ability.cooldown > 0;

    let statsHtml = '';
    if (hasRange) {
      const rangeYards = Math.round(ability.range! / YARDS_TO_UNITS);
      const label = rangeYards <= 5 ? 'Melee Range' : `${rangeYards} yd range`;
      statsHtml += `<div style="color:#aaa;font-size:11px;margin-bottom:2px;">${label}</div>`;
    }
    if (hasCooldown) {
      statsHtml += `<div style="color:#aaa;font-size:11px;margin-bottom:2px;">${ability.cooldown}s cooldown</div>`;
    }

    this.tooltipEl.innerHTML = `
      <div style="
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 4px;
      ">
        <span style="color:#ffd100;font-size:14px;font-weight:bold;">${ability.name}</span>
        <span style="color:#aaa;font-size:11px;margin-left:12px;">${ability.manaCost} Mana</span>
      </div>

      ${statsHtml}

      <div style="
        color: #eee;
        font-size: 12px;
        line-height: 1.4;
        margin-top: 4px;
      ">${ability.description}</div>
    `;

    // Position above the slot
    const rect = anchor.getBoundingClientRect();
    this.tooltipEl.style.display = 'block';
    const tipW = this.tooltipEl.offsetWidth;
    let left = rect.left + rect.width / 2 - tipW / 2;
    // Clamp to viewport
    left = Math.max(8, Math.min(left, window.innerWidth - tipW - 8));
    this.tooltipEl.style.left = `${left}px`;
    this.tooltipEl.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    this.tooltipEl.style.top = '';
  }

  private renderSlot(index: number): void {
    const slot = this.slots[index];
    const el = this.slotElements[index];
    const iconEl = el.children[0] as HTMLElement;

    if (slot.ability) {
      iconEl.textContent = slot.ability.icon;
      el.style.borderColor = 'rgba(255, 255, 255, 0.2)';
    } else {
      iconEl.textContent = '';
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.callbacks.isDisabled?.()) return;
    for (const slot of this.slots) {
      if (e.code === slot.keyCode && slot.ability) {
        this.callbacks.onActivate(slot.ability);
        break;
      }
    }
  };

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.tooltipEl.remove();
    this.element.remove();
  }
}
