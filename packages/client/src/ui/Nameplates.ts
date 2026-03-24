import * as THREE from 'three';
import type { Targetable } from '../engine/types';
import { yardsToUnits } from '../engine/combat/Ability';

const MAX_RANGE = yardsToUnits(30);
const BAR_WIDTH = 100;
const BAR_HEIGHT = 8;

const CAST_BAR_WIDTH = 100;
const CAST_BAR_HEIGHT = 12;

const DEBUFF_ICON_SIZE = 20;

/** Lightweight debuff data for nameplate display. */
export interface NameplateAura {
  icon: string;
  remaining: number;
  duration: number;
}

interface NameplateEntry {
  /** Full nameplate (name + model + health bar) — shown within 30 yd */
  plate: HTMLElement;
  debuffTray: HTMLElement;
  debuffIcons: HTMLElement[];
  nameEl: HTMLElement;
  modelEl: HTMLElement;
  barBg: HTMLElement;
  barFill: HTMLElement;
  /** Cast bar elements */
  castBarBg: HTMLElement;
  castBarFill: HTMLElement;
  castBarText: HTMLElement;
  /** Name-only label — shown beyond 30 yd */
  label: HTMLElement;
  labelName: HTMLElement;
  target: Targetable;
}

export class Nameplates {
  readonly element: HTMLElement;
  private camera: THREE.PerspectiveCamera;
  private scene: THREE.Scene;
  private raycaster = new THREE.Raycaster();
  private rayDir = new THREE.Vector3();
  private entries: Map<Targetable, NameplateEntry> = new Map();
  private worldPos = new THREE.Vector3();
  private onClickTarget?: (target: Targetable) => void;
  private onHoverTarget?: (target: Targetable | null) => void;

  constructor(
    camera: THREE.PerspectiveCamera,
    scene: THREE.Scene,
    onClickTarget?: (target: Targetable) => void,
    onHoverTarget?: (target: Targetable | null) => void,
  ) {
    this.camera = camera;
    this.scene = scene;
    this.onClickTarget = onClickTarget;
    this.onHoverTarget = onHoverTarget;
    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 140;
      pointer-events: none;
      overflow: hidden;
    `;
  }

  update(player: Targetable, npcs: readonly Targetable[], getDebuffs?: (target: Targetable) => readonly NameplateAura[]): void {
    const allTargets = npcs;
    const activeSet = new Set<Targetable>(allTargets);

    // Remove stale entries
    for (const [target, entry] of this.entries) {
      if (!activeSet.has(target)) {
        entry.plate.remove();
        entry.label.remove();
        this.entries.delete(target);
      }
    }

    for (const target of allTargets) {
      // Get or create entry
      let entry = this.entries.get(target);
      if (!entry) {
        entry = this.createEntry(target, player);
        this.entries.set(target, entry);
      }

      // Don't show anything for dead targets
      if (target.dead) {
        entry.plate.style.display = 'none';
        entry.label.style.display = 'none';
        continue;
      }

      // Distance check
      const dx = target.mesh.position.x - player.mesh.position.x;
      const dz = target.mesh.position.z - player.mesh.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const inRange = dist <= MAX_RANGE;

      const hostile = target.isHostileTo(player);

      // Project world position to screen
      target.mesh.getWorldPosition(this.worldPos);
      this.worldPos.y += 2.5; // above head

      const ndc = this.worldPos.clone().project(this.camera);

      // Behind camera — hide both
      if (ndc.z > 1) {
        entry.plate.style.display = 'none';
        entry.label.style.display = 'none';
        continue;
      }

      const screenX = (ndc.x * 0.5 + 0.5) * window.innerWidth;
      const screenY = (-ndc.y * 0.5 + 0.5) * window.innerHeight;

      const isDisconnected = target.disconnected ?? false;

      if (inRange) {
        // Show full nameplate, hide name label
        entry.plate.style.display = '';
        entry.label.style.display = 'none';

        entry.plate.style.left = `${screenX}px`;
        entry.plate.style.top = `${screenY}px`;

        // Update HP bar
        const hpPct = Math.max(0, target.hp / target.maxHp) * 100;
        entry.barFill.style.width = `${hpPct}%`;
        entry.barFill.style.background = isDisconnected ? '#666' : hostile ? '#cc2222' : '#22aa22';

        // Update cast bar
        if (target.castingAbilityName && target.castingTotalTime > 0) {
          entry.castBarBg.style.display = '';
          let progress: number;
          if (target.castingIsChannel) {
            progress = Math.max(0, 1 - target.castingElapsed / target.castingTotalTime);
            entry.castBarFill.style.background = 'linear-gradient(to right, #cc8833, #eebb55)';
          } else {
            progress = Math.min(1, target.castingElapsed / target.castingTotalTime);
            entry.castBarFill.style.background = 'linear-gradient(to right, #cc8833, #eebb55)';
          }
          entry.castBarFill.style.width = `${progress * 100}%`;
          entry.castBarText.textContent = target.castingAbilityName;
        } else {
          entry.castBarBg.style.display = 'none';
        }

        // Update name color
        entry.nameEl.style.color = isDisconnected ? '#888' : hostile ? '#ff4444' : '#44ff44';

        // Update debuff tray
        const debuffs = getDebuffs?.(target) ?? [];
        this.updateDebuffTray(entry, debuffs);
      } else {
        // Out of nameplate range — show name-only label if not occluded
        entry.plate.style.display = 'none';

        if (this.isOccluded(this.worldPos)) {
          entry.label.style.display = 'none';
        } else {
          entry.label.style.display = '';
          entry.label.style.left = `${screenX}px`;
          entry.label.style.top = `${screenY}px`;
          entry.labelName.style.color = isDisconnected ? '#888' : hostile ? '#ff4444' : '#44ff44';
        }
      }
    }
  }

  /** Raycast from camera to worldPos; true if an opaque map object blocks it. */
  private isOccluded(worldPos: THREE.Vector3): boolean {
    const mapGroup = this.scene.getObjectByName('map');
    if (!mapGroup) return false;

    this.rayDir.subVectors(worldPos, this.camera.position);
    const fullDist = this.rayDir.length();
    this.rayDir.normalize();

    this.raycaster.set(this.camera.position, this.rayDir);
    this.raycaster.far = fullDist;

    const hits = this.raycaster.intersectObject(mapGroup, true);
    for (const hit of hits) {
      const mat = (hit.object as THREE.Mesh).material as THREE.MeshStandardMaterial;
      if (mat && mat.transparent) continue;
      return true;
    }
    return false;
  }

  private createEntry(target: Targetable, player: Targetable): NameplateEntry {
    const hostile = target.isHostileTo(player);

    // --- Full nameplate ---
    const plate = document.createElement('div');
    plate.style.cssText = `
      position: absolute;
      transform: translate(-50%, -100%);
      text-align: center;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      pointer-events: auto;
      cursor: pointer;
      white-space: nowrap;
    `;
    plate.addEventListener('click', () => {
      this.onClickTarget?.(target);
    });
    plate.addEventListener('mouseenter', () => {
      this.onHoverTarget?.(target);
    });
    plate.addEventListener('mouseleave', () => {
      this.onHoverTarget?.(null);
    });

    const nameEl = document.createElement('div');
    nameEl.textContent = target.name;
    nameEl.style.cssText = `
      font-size: 13px;
      font-weight: bold;
      color: ${hostile ? '#ff4444' : '#44ff44'};
      text-shadow:
        -1px -1px 0 #000,
         1px -1px 0 #000,
        -1px  1px 0 #000,
         1px  1px 0 #000,
         0 0 4px rgba(0,0,0,0.9);
      line-height: 1.2;
    `;

    const modelEl = document.createElement('div');
    modelEl.textContent = target.modelName;
    modelEl.style.cssText = `
      font-size: 11px;
      color: #cccccc;
      text-shadow:
        -1px -1px 0 #000,
         1px -1px 0 #000,
        -1px  1px 0 #000,
         1px  1px 0 #000;
      line-height: 1.2;
      margin-bottom: 2px;
    `;

    const barBg = document.createElement('div');
    barBg.style.cssText = `
      width: ${BAR_WIDTH}px;
      height: ${BAR_HEIGHT}px;
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 2px;
      overflow: hidden;
      margin: 0 auto;
    `;

    const barFill = document.createElement('div');
    barFill.style.cssText = `
      height: 100%;
      width: 100%;
      background: ${hostile ? '#cc2222' : '#22aa22'};
      transition: width 0.15s ease-out;
    `;

    // --- Cast bar (below health bar) ---
    const castBarBg = document.createElement('div');
    castBarBg.style.cssText = `
      width: ${CAST_BAR_WIDTH}px;
      height: ${CAST_BAR_HEIGHT}px;
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 2px;
      overflow: hidden;
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      bottom: -${CAST_BAR_HEIGHT + 4}px;
      display: none;
    `;

    const castBarFill = document.createElement('div');
    castBarFill.style.cssText = `
      height: 100%;
      width: 0%;
      background: linear-gradient(to right, #cc8833, #eebb55);
      transition: width 0.05s linear;
    `;

    const castBarText = document.createElement('div');
    castBarText.style.cssText = `
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: bold;
      color: #fff;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;
      white-space: nowrap;
      overflow: hidden;
    `;

    castBarBg.appendChild(castBarFill);
    castBarBg.appendChild(castBarText);

    // --- Debuff tray (above name) ---
    const debuffTray = document.createElement('div');
    debuffTray.style.cssText = `
      display: flex;
      flex-wrap: wrap;
      gap: 2px;
      justify-content: center;
      margin-bottom: 2px;
    `;

    barBg.appendChild(barFill);
    plate.appendChild(debuffTray);
    plate.appendChild(nameEl);
    plate.appendChild(modelEl);
    plate.appendChild(barBg);
    plate.appendChild(castBarBg);
    this.element.appendChild(plate);

    // --- Name-only label (shown when out of nameplate range) ---
    const label = document.createElement('div');
    label.style.cssText = `
      position: absolute;
      transform: translate(-50%, -100%);
      text-align: center;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      pointer-events: none;
      white-space: nowrap;
      display: none;
    `;

    const labelName = document.createElement('div');
    labelName.textContent = target.name;
    labelName.style.cssText = `
      font-size: 11px;
      font-weight: bold;
      color: ${hostile ? '#ff4444' : '#44ff44'};
      text-shadow:
        -1px -1px 0 #000,
         1px -1px 0 #000,
        -1px  1px 0 #000,
         1px  1px 0 #000,
         0 0 4px rgba(0,0,0,0.9);
    `;

    label.appendChild(labelName);
    this.element.appendChild(label);

    return { plate, debuffTray, debuffIcons: [], nameEl, modelEl, barBg, barFill, castBarBg, castBarFill, castBarText, label, labelName, target };
  }

  private createDebuffIcon(): HTMLElement {
    const icon = document.createElement('div');
    icon.style.cssText = `
      width: ${DEBUFF_ICON_SIZE}px;
      height: ${DEBUFF_ICON_SIZE}px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      background: rgba(80, 80, 100, 0.8);
      border-radius: 2px;
      overflow: hidden;
      border: 1.5px solid #cc2222;
    `;

    const emoji = document.createElement('span');
    emoji.style.cssText = 'font-size: 11px; line-height: 1; z-index: 1; position: relative;';
    icon.appendChild(emoji);

    // Duration sweep overlay
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
      font-size: 8px;
      color: #fff;
      text-shadow: 1px 1px 1px rgba(0,0,0,0.9);
      z-index: 2;
    `;
    icon.appendChild(timer);

    return icon;
  }

  private updateDebuffTray(entry: NameplateEntry, debuffs: readonly NameplateAura[]): void {
    const { debuffTray, debuffIcons } = entry;

    // Grow pool as needed
    while (debuffIcons.length < debuffs.length) {
      const icon = this.createDebuffIcon();
      debuffIcons.push(icon);
      debuffTray.appendChild(icon);
    }

    for (let i = 0; i < debuffIcons.length; i++) {
      if (i < debuffs.length) {
        const el = debuffIcons[i];
        const aura = debuffs[i];
        el.style.display = 'flex';
        (el.children[0] as HTMLElement).textContent = aura.icon;

        const hasFiniteDuration = (aura.duration > 0 && isFinite(aura.duration))
          || (aura.remaining > 0 && isFinite(aura.remaining));
        el.style.background = hasFiniteDuration ? 'rgba(80, 80, 100, 0.8)' : 'transparent';

        const elapsed = aura.duration - aura.remaining;
        const degrees = hasFiniteDuration && isFinite(aura.duration) && aura.duration > 0
          ? (elapsed / aura.duration) * 360
          : 0;
        const sweepEl = el.children[1] as HTMLElement;
        sweepEl.style.display = hasFiniteDuration ? '' : 'none';
        sweepEl.style.background = degrees > 0
          ? `conic-gradient(from 0deg, rgba(0, 0, 0, 0.7) ${degrees}deg, transparent ${degrees}deg)`
          : 'transparent';

        (el.children[2] as HTMLElement).textContent = hasFiniteDuration
          ? (aura.remaining < 10 ? aura.remaining.toFixed(1) : Math.ceil(aura.remaining).toString())
          : '';
      } else {
        debuffIcons[i].style.display = 'none';
      }
    }
  }

  dispose(): void {
    for (const [, entry] of this.entries) {
      entry.plate.remove();
      entry.label.remove();
    }
    this.entries.clear();
  }
}
