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
  private getLocalPlayer: () => Targetable;

  // Highlight system (color brightening for target + hover)
  private savedColors = new Map<THREE.Mesh, THREE.Color>();
  private hlTarget: Targetable | null = null;   // currently highlighted as target
  private hlHover: Targetable | null = null;    // currently highlighted as hover
  private raycastHover: Targetable | null = null;   // hovered via 3D raycast
  private nameplateHover: Targetable | null = null;  // hovered via nameplate
  private static readonly TARGET_BOOST = 0.12;
  private static readonly HOVER_BOOST = 0.07;

  constructor(
    camera: THREE.PerspectiveCamera,
    scene: THREE.Scene,
    canvas: HTMLCanvasElement,
    getLocalPlayer: () => Targetable
  ) {
    this.camera = camera;
    this.scene = scene;
    this.canvas = canvas;
    this.getLocalPlayer = getLocalPlayer;

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

  /** Set hover state from nameplate mouseenter/mouseleave. */
  setNameplateHover(target: Targetable | null): void {
    this.nameplateHover = target;
  }

  update(dt: number): void {
    // Sync highlights for target + hover
    this.syncHighlights();

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
    this.ringMat.color.set(
      this.currentTarget.isHostileTo(this.getLocalPlayer()) ? 0xff3333 : 0x33ff33
    );
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
      // Solid environment mesh blocks LOS — stop looking behind it
      if (this.isEnvironmentBlocker(hit)) break;
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
        if (targetable === this.getLocalPlayer()) return null;
        this.currentTarget = targetable;
        return targetable;
      }
      // Solid environment mesh blocks LOS — stop looking behind it
      if (this.isEnvironmentBlocker(hit)) break;
    }

    return null;
  }

  /** Returns true if the hit is on a solid vertical environment mesh (wall, pillar, door) that blocks targeting LOS. Horizontal surfaces (floors) and non-mesh helpers never block. */
  private isEnvironmentBlocker(hit: THREE.Intersection): boolean {
    // Only solid meshes can block — skip helpers, lines, etc.
    if (!(hit.object instanceof THREE.Mesh)) return false;

    // Horizontal faces (floors) don't block targeting regardless of parent name
    if (hit.face) {
      const worldNormal = hit.face.normal.clone()
        .transformDirection(hit.object.matrixWorld);
      if (worldNormal.y > 0.7) return false;
    }

    let current: THREE.Object3D | null = hit.object;
    while (current) {
      if (current.name === 'ground') return false;
      if (current.name === 'map') return true;
      current = current.parent;
    }
    return false;
  }

  private findTargetable(obj: THREE.Object3D): Targetable | null {
    let current: THREE.Object3D | null = obj;
    while (current) {
      if (current.userData.targetRef) return current.userData.targetRef as Targetable;
      current = current.parent;
    }
    return null;
  }

  /** Raycast to check if a targetable entity is under the given screen position. */
  checkHover(screenX: number, screenY: number): Targetable | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((screenX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((screenY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

    const intersects = this.raycaster.intersectObjects(this.scene.children, true);
    for (const hit of intersects) {
      const targetable = this.findTargetable(hit.object);
      if (targetable) return targetable;
      if (this.isEnvironmentBlocker(hit)) break;
    }
    return null;
  }

  /** Update canvas cursor based on whether mouse is hovering a targetable. */
  updateHoverCursor(screenPos: { x: number; y: number } | null): void {
    if (!screenPos) {
      this.raycastHover = null;
      this.canvas.style.cursor = '';
      return;
    }
    this.raycastHover = this.checkHover(screenPos.x, screenPos.y);
    // Only set canvas cursor when not hovering a nameplate (nameplate handles its own cursor via CSS)
    if (!this.nameplateHover) {
      this.canvas.style.cursor = this.raycastHover ? 'pointer' : '';
    }
  }

  // ── Highlight system (target + hover) ───────────────────────────────

  private syncHighlights(): void {
    const newTarget = this.currentTarget;
    const newHover = this.nameplateHover ?? this.raycastHover;

    if (newTarget === this.hlTarget && newHover === this.hlHover) return;

    // Restore all currently highlighted entities to original colors
    this.restoreAllColors();

    // Apply target highlight (stronger)
    if (newTarget) {
      this.applyColorBoost(newTarget, TargetingSystem.TARGET_BOOST);
    }

    // Apply hover highlight (softer) — only if different from target
    if (newHover && newHover !== newTarget) {
      this.applyColorBoost(newHover, TargetingSystem.HOVER_BOOST);
    }

    this.hlTarget = newTarget;
    this.hlHover = newHover;
  }

  private applyColorBoost(target: Targetable, boost: number): void {
    target.mesh.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const mat = child.material;
      if (!(mat instanceof THREE.MeshStandardMaterial)) return;
      if (!this.savedColors.has(child)) {
        this.savedColors.set(child, mat.color.clone());
      }
      mat.color.offsetHSL(0, 0, boost);
    });
  }

  private restoreAllColors(): void {
    for (const [mesh, color] of this.savedColors) {
      const mat = mesh.material;
      if (mat instanceof THREE.MeshStandardMaterial) {
        mat.color.copy(color);
      }
    }
    this.savedColors.clear();
  }

  dispose(): void {
    this.restoreAllColors();
    this.ring.geometry.dispose();
    this.ringMat.dispose();
    this.scene.remove(this.ring);
  }
}
