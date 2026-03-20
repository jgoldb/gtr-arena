import * as THREE from 'three';

interface CombatTextEntry {
  element: HTMLElement;
  target: THREE.Object3D;
  offsetY: number; // accumulates upward drift in screen-px
  elapsed: number;
  jitterX: number;
  isCrit: boolean;
}

const DURATION = 1.5; // seconds
const RISE_SPEED = 60; // pixels per second
const FONT_SIZE = 22;

export class FloatingCombatText {
  readonly element: HTMLElement;
  private entries: CombatTextEntry[] = [];
  private camera: THREE.PerspectiveCamera;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 150;
      pointer-events: none;
      overflow: hidden;
    `;
  }

  spawn(target: THREE.Object3D, amount: number, type: 'damage' | 'heal' | 'crit' | 'miss' | 'dodge'): void {
    const el = document.createElement('div');

    let text: string;
    let color: string;
    let fontSize: number;
    switch (type) {
      case 'heal':
        text = `+${amount}`;
        color = '#22ff44';
        fontSize = FONT_SIZE;
        break;
      case 'crit':
        text = `${amount}`;
        color = '#ffcc00';
        fontSize = FONT_SIZE * 1.6;
        break;
      case 'miss':
        text = 'Miss';
        color = '#aaaaaa';
        fontSize = FONT_SIZE;
        break;
      case 'dodge':
        text = 'Dodge';
        color = '#aaaaaa';
        fontSize = FONT_SIZE;
        break;
      default:
        text = `${amount}`;
        color = '#ffffff';
        fontSize = FONT_SIZE;
        break;
    }
    el.textContent = text;

    // Random horizontal jitter so overlapping hits spread out
    const jitterX = (Math.random() - 0.5) * 30;

    el.style.cssText = `
      position: absolute;
      color: ${color};
      font-size: ${fontSize}px;
      font-weight: bold;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      text-shadow:
        -1px -1px 0 #000,
         1px -1px 0 #000,
        -1px  1px 0 #000,
         1px  1px 0 #000,
         0 0 6px rgba(0,0,0,0.8);
      white-space: nowrap;
      pointer-events: none;
      transform: translate(${jitterX}px, 0);
      will-change: transform, opacity;
    `;
    this.element.appendChild(el);

    this.entries.push({
      element: el,
      target,
      offsetY: 0,
      elapsed: 0,
      jitterX,
      isCrit: type === 'crit',
    });
  }

  update(dt: number): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      entry.elapsed += dt;

      if (entry.elapsed >= DURATION) {
        entry.element.remove();
        this.entries.splice(i, 1);
        continue;
      }

      entry.offsetY += RISE_SPEED * dt;

      // Project target's head position to screen
      const worldPos = new THREE.Vector3();
      entry.target.getWorldPosition(worldPos);
      worldPos.y += 2.2; // above head

      // Project to NDC
      const ndc = worldPos.clone().project(this.camera);

      // Behind camera — hide
      if (ndc.z > 1) {
        entry.element.style.display = 'none';
        continue;
      }
      entry.element.style.display = '';

      const screenX = (ndc.x * 0.5 + 0.5) * window.innerWidth;
      const screenY = (-ndc.y * 0.5 + 0.5) * window.innerHeight;

      // Fade out over the last 40% of duration
      const fadeStart = DURATION * 0.6;
      const opacity = entry.elapsed > fadeStart
        ? 1 - (entry.elapsed - fadeStart) / (DURATION - fadeStart)
        : 1;

      // Scale: start slightly large, settle to normal (crits are more dramatic)
      const scaleBonus = entry.isCrit ? 0.8 : 0.4;
      const scale = entry.elapsed < 0.15
        ? 1 + scaleBonus * (1 - entry.elapsed / 0.15)
        : 1;

      entry.element.style.left = `${screenX}px`;
      entry.element.style.top = `${screenY - entry.offsetY}px`;
      entry.element.style.transform = `translate(${entry.jitterX}px, 0) translate(-50%, -50%) scale(${scale.toFixed(2)})`;
      entry.element.style.opacity = `${opacity.toFixed(2)}`;
    }
  }

  dispose(): void {
    for (const entry of this.entries) {
      entry.element.remove();
    }
    this.entries.length = 0;
  }
}
