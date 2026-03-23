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

  // Ground targeting (click-to-place AoE)
  groundTargetActive = false;
  groundTargetBlocked = false;
  private groundTargetCircle: THREE.Group;
  private groundTargetMats: THREE.MeshBasicMaterial[] = [];
  private groundTargetRange = 0;
  private groundTargetPos = new THREE.Vector3();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private groundTargetTime = 0;
  private losRaycaster = new THREE.Raycaster();

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

    // Build ground targeting reticle (AoE indicator)
    this.groundTargetCircle = new THREE.Group();
    this.groundTargetCircle.visible = false;
    this.groundTargetCircle.renderOrder = 2;

    const addGtMat = (opacity: number): THREE.MeshBasicMaterial => {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x44ff44, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
      });
      mat.userData.baseOpacity = opacity;
      this.groundTargetMats.push(mat);
      return mat;
    };

    // Outer ring
    const outerGeo = new THREE.RingGeometry(0.92, 1.0, 64);
    outerGeo.rotateX(-Math.PI / 2);
    this.groundTargetCircle.add(new THREE.Mesh(outerGeo, addGtMat(0.6)));

    // Inner ring
    const innerGeo = new THREE.RingGeometry(0.42, 0.46, 48);
    innerGeo.rotateX(-Math.PI / 2);
    this.groundTargetCircle.add(new THREE.Mesh(innerGeo, addGtMat(0.4)));

    // Crosshair lines (4 segments from inner ring to outer ring)
    const lineMat = addGtMat(0.35);
    for (let i = 0; i < 4; i++) {
      const lineGeo = new THREE.PlaneGeometry(0.03, 0.46);
      lineGeo.rotateX(-Math.PI / 2);
      lineGeo.translate(0, 0, 0.69); // center between inner (0.46) and outer (0.92)
      const line = new THREE.Mesh(lineGeo, lineMat);
      line.rotation.y = (i * Math.PI) / 2;
      this.groundTargetCircle.add(line);
    }

    // Center dot
    const dotGeo = new THREE.CircleGeometry(0.06, 16);
    dotGeo.rotateX(-Math.PI / 2);
    this.groundTargetCircle.add(new THREE.Mesh(dotGeo, addGtMat(0.7)));

    // Tick marks at 45-degree angles on the outer ring
    const tickMat = addGtMat(0.5);
    for (let i = 0; i < 4; i++) {
      const tickGeo = new THREE.PlaneGeometry(0.03, 0.12);
      tickGeo.rotateX(-Math.PI / 2);
      tickGeo.translate(0, 0, 0.96);
      const tick = new THREE.Mesh(tickGeo, tickMat);
      tick.rotation.y = (Math.PI / 4) + (i * Math.PI) / 2;
      this.groundTargetCircle.add(tick);
    }

    scene.add(this.groundTargetCircle);
  }

  /** Set hover state from nameplate mouseenter/mouseleave. */
  setNameplateHover(target: Targetable | null): void {
    this.nameplateHover = target;
  }

  update(dt: number): void {
    // Sync highlights for target + hover
    this.syncHighlights();

    // Animate ground targeting reticle
    if (this.groundTargetActive) {
      this.groundTargetTime += dt;
      this.groundTargetCircle.rotation.y = this.groundTargetTime * 1.5;
      const pulse = 0.8 + Math.sin(this.groundTargetTime * 4) * 0.2;
      const color = this.groundTargetBlocked ? 0xff4444 : 0x44ff44;
      for (const mat of this.groundTargetMats) {
        mat.color.set(color);
        mat.opacity = (mat.userData.baseOpacity as number) * pulse;
      }
    }

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

    const found = this.pickTarget(intersects);

    // Clicked on nothing targetable → clear target
    this.currentTarget = found;
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

    const found = this.pickTarget(intersects);
    if (found) {
      this.currentTarget = found;
    }
    return found;
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

  /** Scan raycast hits and return the best target — alive entities are preferred over dead ones. */
  private pickTarget(intersects: THREE.Intersection[]): Targetable | null {
    let deadFallback: Targetable | null = null;

    for (const hit of intersects) {
      const targetable = this.findTargetable(hit.object);
      if (targetable) {
        if (targetable === this.getLocalPlayer()) continue;
        if (targetable.dead) {
          if (!deadFallback) deadFallback = targetable;
          continue;
        }
        return targetable;
      }
      if (this.isEnvironmentBlocker(hit)) break;
    }

    return deadFallback;
  }

  private findTargetable(obj: THREE.Object3D): Targetable | null {
    let current: THREE.Object3D | null = obj;
    while (current) {
      if (current.userData.targetRef) return current.userData.targetRef as Targetable;
      current = current.parent;
    }
    return null;
  }

  /** Tab-target: select the nearest alive hostile in front of the player within the given range (world units). */
  selectNearestHostileInFront(hostiles: Targetable[], maxRange: number): void {
    const player = this.getLocalPlayer();
    const playerPos = player.mesh.position;
    const rotY = player.mesh.rotation.y;
    const forward = new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY));

    let best: Targetable | null = null;
    let bestDist = Infinity;

    for (const entity of hostiles) {
      if (entity.dead) continue;
      if (!entity.isHostileTo(player)) continue;

      const toEntity = new THREE.Vector3(
        entity.mesh.position.x - playerPos.x,
        0,
        entity.mesh.position.z - playerPos.z,
      );
      const dist = toEntity.length();
      if (dist > maxRange || dist < 0.01) continue;

      // Must be in the forward hemisphere (180° cone)
      toEntity.normalize();
      if (forward.dot(toEntity) <= 0) continue;

      if (dist < bestDist) {
        bestDist = dist;
        best = entity;
      }
    }

    if (best) {
      this.currentTarget = best;
    }
  }

  /** Raycast to check if a targetable entity is under the given screen position. */
  checkHover(screenX: number, screenY: number): Targetable | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((screenX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((screenY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

    const intersects = this.raycaster.intersectObjects(this.scene.children, true);
    return this.pickTarget(intersects);
  }

  /** The entity currently under the mouse (nameplate or 3D raycast). */
  getHoveredTarget(): Targetable | null {
    return this.nameplateHover ?? this.raycastHover;
  }

  /** Update canvas cursor based on whether mouse is hovering a targetable.
   *  @param alwaysScreenPos — mouse position that tracks even during pointer lock (for ground targeting reticle). */
  updateHoverCursor(screenPos: { x: number; y: number } | null, alwaysScreenPos?: { x: number; y: number }): void {
    if (this.groundTargetActive) {
      // During ground targeting, update the reticle using the always-available position
      // so the reticle follows the cursor even during right-click camera drag
      const gtPos = alwaysScreenPos ?? screenPos;
      if (gtPos) {
        this.updateGroundTargetPosition(gtPos.x, gtPos.y);
      }
      this.canvas.style.cursor = 'crosshair';
      return;
    }
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

  // ── Ground targeting (click-to-place AoE) ─────────────────────────

  /** Enter ground targeting mode — shows the AoE reticle following the cursor. */
  startGroundTarget(aoeRadius: number, range: number): void {
    this.groundTargetActive = true;
    this.groundTargetRange = range;
    this.groundTargetTime = 0;
    // Scale the unit-radius ring geometry to match the AoE radius
    this.groundTargetCircle.scale.setScalar(aoeRadius);
    this.groundTargetCircle.visible = true;
    this.canvas.style.cursor = 'crosshair';
  }

  /** Exit ground targeting mode without confirming. */
  cancelGroundTarget(): void {
    this.groundTargetActive = false;
    this.groundTargetCircle.visible = false;
    this.canvas.style.cursor = '';
  }

  /** Get the current ground target world position (XZ on ground plane). */
  getGroundTargetPosition(): THREE.Vector3 {
    return this.groundTargetPos.clone();
  }

  /** Raycast mouse position to the ground plane and update the reticle position, clamped to range. */
  private updateGroundTargetPosition(screenX: number, screenY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((screenX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((screenY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

    const hitPoint = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hitPoint)) return;

    // Clamp to max range from the player
    const playerPos = this.getLocalPlayer().mesh.position;
    const dx = hitPoint.x - playerPos.x;
    const dz = hitPoint.z - playerPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > this.groundTargetRange) {
      const scale = this.groundTargetRange / dist;
      hitPoint.x = playerPos.x + dx * scale;
      hitPoint.z = playerPos.z + dz * scale;
    }

    // LOS check: raycast horizontally from player to ground target point
    this.groundTargetBlocked = false;
    const losOrigin = new THREE.Vector3(playerPos.x, 0.5, playerPos.z);
    const losTarget = new THREE.Vector3(hitPoint.x, 0.5, hitPoint.z);
    const losDir = new THREE.Vector3().subVectors(losTarget, losOrigin);
    const losDist = losDir.length();
    if (losDist > 0.01) {
      losDir.normalize();
      this.losRaycaster.set(losOrigin, losDir);
      this.losRaycaster.far = losDist;
      this.losRaycaster.near = 0;
      const hits = this.losRaycaster.intersectObjects(this.scene.children, true);
      for (const hit of hits) {
        if (this.isEnvironmentBlocker(hit)) {
          this.groundTargetBlocked = true;
          break;
        }
      }
    }

    this.groundTargetPos.set(hitPoint.x, 0, hitPoint.z);
    this.groundTargetCircle.position.set(hitPoint.x, 0.04, hitPoint.z);
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
    this.groundTargetCircle.traverse(child => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    });
    for (const mat of this.groundTargetMats) mat.dispose();
    this.scene.remove(this.groundTargetCircle);
  }
}
