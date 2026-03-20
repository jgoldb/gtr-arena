import * as THREE from 'three';
import type { Targetable } from '../types';

export class TargetingSystem {
  currentTarget: Targetable | null = null;

  private camera: THREE.PerspectiveCamera;
  private scene: THREE.Scene;
  private canvas: HTMLCanvasElement;
  private raycaster = new THREE.Raycaster();

  // Ground ring indicator
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private ringTime = 0;

  constructor(
    camera: THREE.PerspectiveCamera,
    scene: THREE.Scene,
    canvas: HTMLCanvasElement
  ) {
    this.camera = camera;
    this.scene = scene;
    this.canvas = canvas;

    // Build target ring indicator
    const geo = new THREE.RingGeometry(0.5, 0.65, 64);
    geo.rotateX(-Math.PI / 2);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0x33ff33,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.ring = new THREE.Mesh(geo, this.ringMat);
    this.ring.renderOrder = 1;
    this.ring.visible = false;
    scene.add(this.ring);
  }

  update(dt: number): void {
    if (!this.currentTarget) {
      this.ring.visible = false;
      return;
    }

    this.ring.visible = true;
    this.ringTime += dt;

    // Follow target's feet
    const pos = this.currentTarget.mesh.position;
    this.ring.position.set(pos.x, pos.y + 0.03, pos.z);

    // Slow rotation
    this.ring.rotation.y = this.ringTime * 1.5;

    // Gentle opacity pulse
    this.ringMat.opacity = 0.4 + Math.sin(this.ringTime * 3) * 0.15;

    // Color: red for hostile, green for friendly
    this.ringMat.color.set(this.currentTarget.hostile ? 0xff3333 : 0x33ff33);
  }

  processClick(screenX: number, screenY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((screenX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((screenY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

    const intersects = this.raycaster.intersectObjects(
      this.scene.children,
      true
    );

    for (const hit of intersects) {
      const targetable = this.findTargetable(hit.object);
      if (targetable) {
        this.currentTarget = targetable;
        return;
      }
    }

    // Clicked on nothing targetable → clear target
    this.currentTarget = null;
  }

  /** Right-click: set target if found (does NOT clear on miss). Returns the target or null. */
  processRightClick(screenX: number, screenY: number): Targetable | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((screenX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((screenY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

    const intersects = this.raycaster.intersectObjects(
      this.scene.children,
      true
    );

    for (const hit of intersects) {
      const targetable = this.findTargetable(hit.object);
      if (targetable) {
        this.currentTarget = targetable;
        return targetable;
      }
    }

    return null;
  }

  private findTargetable(obj: THREE.Object3D): Targetable | null {
    let current: THREE.Object3D | null = obj;
    while (current) {
      if (current.userData.targetRef) return current.userData.targetRef as Targetable;
      current = current.parent;
    }
    return null;
  }

  dispose(): void {
    this.ring.geometry.dispose();
    this.ringMat.dispose();
    this.scene.remove(this.ring);
  }
}
