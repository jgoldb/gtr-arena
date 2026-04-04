import * as THREE from 'three';
import type { CharacterId } from '@gtr/shared';
import { createCharacter } from '../engine/player/characters';
import type { CharacterModel, AnimationInput } from '../engine/player/characters';

export class CharacterPreview {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private model: CharacterModel | null = null;
  private charId: CharacterId | null = null;
  private animId = 0;
  private lastTime = 0;
  private rotY = 0;
  private dragging = false;
  private dragLastX = 0;

  constructor(container: HTMLDivElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 400;
    this.canvas.height = 440;
    this.canvas.style.cssText = 'border-radius: 8px; max-width: 100%; max-height: 100%; object-fit: contain; cursor: default;';

    // Drag-to-rotate on preview canvas (Y-axis only)
    const dragCursorStyle = document.createElement('style');
    dragCursorStyle.textContent = 'body.glby-dragging, body.glby-dragging * { cursor: grabbing !important; }';
    container.appendChild(dragCursorStyle);

    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !this.model) return;
      this.dragging = true;
      this.dragLastX = e.clientX;
      document.body.classList.add('glby-dragging');
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.dragLastX;
      this.dragLastX = e.clientX;
      this.rotY += dx * 0.01;
    });
    window.addEventListener('mouseup', () => {
      if (!this.dragging) return;
      this.dragging = false;
      document.body.classList.remove('glby-dragging');
    });

    // Set up Three.js renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
    });
    this.renderer.setSize(400, 440);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(1, 2, 2);
    this.scene.add(dirLight);
    // Subtle rim light from behind
    const rimLight = new THREE.DirectionalLight(0x4466aa, 0.4);
    rimLight.position.set(-1, 1, -2);
    this.scene.add(rimLight);

    this.camera = new THREE.PerspectiveCamera(30, 400 / 440, 0.1, 20);
    this.camera.position.set(0, 1.0, 4.6);
    this.camera.lookAt(0, 0.9, 0);

    this.lastTime = performance.now();
    this.startLoop();
  }

  setCharacter(charId: CharacterId | null): void {
    if (charId === this.charId) return;
    this.charId = charId;
    this.rotY = 0;

    // Remove old model
    if (this.model) {
      this.scene.remove(this.model.group);
      this.model.dispose();
      this.model = null;
    }

    if (!charId) {
      // Render one clear frame so the canvas goes transparent
      this.renderer.render(this.scene, this.camera);
      this.canvas.style.cursor = 'default';
      return;
    }

    const model = createCharacter(charId);
    if (charId === 'rabbi-zehnwirth') model.group.position.y = -0.25;
    this.scene.add(model.group);
    this.model = model;
    this.canvas.style.cursor = 'grab';
  }

  private startLoop(): void {
    const idleInput: AnimationInput = {
      isMoving: false,
      isGrounded: true,
      velocityY: 0,
      turnSpeed: 0,
      speedMultiplier: 1,
      strafeDirection: 0,
    };

    const loop = (now: number) => {
      this.animId = requestAnimationFrame(loop);
      if (document.hidden) return;

      const dt = Math.min((now - this.lastTime) / 1000, 0.1);
      this.lastTime = now;

      if (this.model) {
        this.model.group.rotation.y = Math.PI + this.rotY;
        this.model.update(dt, idleInput);
        this.renderer.render(this.scene, this.camera);
      }
    };

    this.animId = requestAnimationFrame(loop);
  }

  destroy(): void {
    cancelAnimationFrame(this.animId);
    if (this.model) {
      this.scene.remove(this.model.group);
      this.model.dispose();
      this.model = null;
    }
    this.renderer.dispose();
  }
}
