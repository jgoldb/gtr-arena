import * as THREE from 'three';
import type { Targetable } from '../engine/types';
import { yardsToUnits } from '../engine/combat/Ability';

const MAX_RANGE = yardsToUnits(30);
const BAR_WIDTH = 100;
const BAR_HEIGHT = 8;

interface NameplateEntry {
  /** Full nameplate (name + model + health bar) — shown within 30 yd */
  plate: HTMLElement;
  nameEl: HTMLElement;
  modelEl: HTMLElement;
  barBg: HTMLElement;
  barFill: HTMLElement;
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

  constructor(camera: THREE.PerspectiveCamera, scene: THREE.Scene) {
    this.camera = camera;
    this.scene = scene;
    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 140;
      pointer-events: none;
      overflow: hidden;
    `;
  }

  update(player: Targetable, npcs: readonly Targetable[]): void {
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

      if (inRange) {
        // Show full nameplate, hide name label
        entry.plate.style.display = '';
        entry.label.style.display = 'none';

        entry.plate.style.left = `${screenX}px`;
        entry.plate.style.top = `${screenY}px`;

        // Update HP bar
        const hpPct = Math.max(0, target.hp / target.maxHp) * 100;
        entry.barFill.style.width = `${hpPct}%`;
        entry.barFill.style.background = hostile ? '#cc2222' : '#22aa22';

        // Update name color
        entry.nameEl.style.color = hostile ? '#ff4444' : '#44ff44';
      } else {
        // Out of nameplate range — show name-only label if not occluded
        entry.plate.style.display = 'none';

        if (this.isOccluded(this.worldPos)) {
          entry.label.style.display = 'none';
        } else {
          entry.label.style.display = '';
          entry.label.style.left = `${screenX}px`;
          entry.label.style.top = `${screenY}px`;
          entry.labelName.style.color = hostile ? '#ff4444' : '#44ff44';
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
      pointer-events: none;
      white-space: nowrap;
    `;

    const nameEl = document.createElement('div');
    nameEl.textContent = target.name;
    nameEl.style.cssText = `
      font-size: 11px;
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
      font-size: 9px;
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

    barBg.appendChild(barFill);
    plate.appendChild(nameEl);
    plate.appendChild(modelEl);
    plate.appendChild(barBg);
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

    return { plate, nameEl, modelEl, barBg, barFill, label, labelName, target };
  }

  dispose(): void {
    for (const [, entry] of this.entries) {
      entry.plate.remove();
      entry.label.remove();
    }
    this.entries.clear();
  }
}
