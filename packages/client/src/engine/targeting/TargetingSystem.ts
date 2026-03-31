import * as THREE from 'three';
import type { Targetable } from '../types';

export class TargetingSystem {
  currentTarget: Targetable | null = null;
  /** Optional filter — return true for targets that should be skipped by raycasts. */
  isUntargetable?: (target: Targetable) => boolean;

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
  onGroundTargetCancelled?: () => void;
  private groundTargetCircle: THREE.Group;
  private groundTargetMats: THREE.MeshBasicMaterial[] = [];
  private groundTargetRange = 0;
  private groundTargetSkipLOS = false;
  private groundTargetPos = new THREE.Vector3();
  private groundTargetNormal = new THREE.Vector3(0, 1, 0);
  private _quatHelper?: THREE.Quaternion;
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
      // Align reticle to surface normal, then apply spin around that normal
      const up = new THREE.Vector3(0, 1, 0);
      const q = new THREE.Quaternion().setFromUnitVectors(up, this.groundTargetNormal);
      const spin = new THREE.Quaternion().setFromAxisAngle(this.groundTargetNormal, this.groundTargetTime * 1.5);
      this.groundTargetCircle.quaternion.copy(spin.multiply(q));
      const pulse = 0.8 + Math.sin(this.groundTargetTime * 4) * 0.2;
      const color = this.groundTargetBlocked ? 0xff4444 : 0x44ff44;
      for (const mat of this.groundTargetMats) {
        mat.color.set(color);
        mat.opacity = (mat.userData.baseOpacity as number) * pulse;
      }
    }

    if (!this.currentTarget || !this.currentTarget.mesh.parent) {
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
        if (this.isUntargetable?.(targetable)) continue;
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
  updateHoverCursor(screenPos: { x: number; y: number } | null, rightMouseDown = false): void {
    if (this.groundTargetActive) {
      // Right-click drag cancels ground targeting
      if (rightMouseDown) {
        this.cancelGroundTarget();
        return;
      }
      if (screenPos) {
        this.updateGroundTargetPosition(screenPos.x, screenPos.y);
        this.groundTargetCircle.visible = true;
        this.canvas.style.cursor = 'crosshair';
      } else {
        this.groundTargetCircle.visible = false;
        this.canvas.style.cursor = '';
      }
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
  startGroundTarget(aoeRadius: number, range: number, skipLOS = false): void {
    this.groundTargetActive = true;
    this.groundTargetRange = range;
    this.groundTargetSkipLOS = skipLOS;
    this.groundTargetTime = 0;
    // Scale the unit-radius ring geometry to match the AoE radius
    this.groundTargetCircle.scale.setScalar(aoeRadius);
    this.groundTargetCircle.visible = true;
    this.canvas.style.cursor = 'crosshair';
  }

  /** Exit ground targeting mode without confirming. */
  cancelGroundTarget(): void {
    const wasActive = this.groundTargetActive;
    this.groundTargetActive = false;
    this.groundTargetCircle.visible = false;
    this.canvas.style.cursor = '';
    if (wasActive) this.onGroundTargetCancelled?.();
  }

  /** Get the current ground target world position (XZ on ground plane). */
  getGroundTargetPosition(): THREE.Vector3 {
    return this.groundTargetPos.clone();
  }

  /** Returns true if the hit is on a walkable (upward-facing) surface that is part of the map. */
  private isWalkableSurface(hit: THREE.Intersection): boolean {
    if (!(hit.object instanceof THREE.Mesh)) return false;
    if (!hit.face) return false;
    const worldNormal = hit.face.normal.clone()
      .transformDirection(hit.object.matrixWorld);
    if (worldNormal.y <= 0.5) return false;
    // Must be part of the map or ground group
    let current: THREE.Object3D | null = hit.object;
    while (current) {
      if (current.name === 'ground' || current.name === 'map') return true;
      current = current.parent;
    }
    return false;
  }

  /** Raycast mouse position to the ground plane and update the reticle position, clamped to range. */
  private updateGroundTargetPosition(screenX: number, screenY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((screenX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((screenY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

    const playerPos = this.getLocalPlayer().mesh.position;

    // Try to hit a walkable surface in the scene (elevated platforms, archways, pillars, ground)
    const hitPoint = new THREE.Vector3();
    let surfaceY = playerPos.y;

    const sceneHits = this.raycaster.intersectObjects(this.scene.children, true);
    let foundSurface = false;
    let surfaceNormal = new THREE.Vector3(0, 1, 0);
    for (const hit of sceneHits) {
      if (this.isWalkableSurface(hit)) {
        hitPoint.copy(hit.point);
        surfaceY = hit.point.y;
        if (hit.face) {
          surfaceNormal.copy(hit.face.normal);
          // Transform normal from object-local to world space
          hit.object.getWorldQuaternion(this._quatHelper ??= new THREE.Quaternion());
          surfaceNormal.applyQuaternion(this._quatHelper);
        }
        foundSurface = true;
        break;
      }
    }

    // Fallback: intersect a ground plane at the player's current Y
    if (!foundSurface) {
      this.groundPlane.constant = -playerPos.y;
      if (!this.raycaster.ray.intersectPlane(this.groundPlane, hitPoint)) return;
      surfaceY = playerPos.y;
    }

    // Clamp to max range from the player (XZ distance only)
    const dx = hitPoint.x - playerPos.x;
    const dz = hitPoint.z - playerPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > this.groundTargetRange) {
      const scale = this.groundTargetRange / dist;
      hitPoint.x = playerPos.x + dx * scale;
      hitPoint.z = playerPos.z + dz * scale;
      // When clamped, revert to player Y since we moved off the original surface
      surfaceY = playerPos.y;
      surfaceNormal.set(0, 1, 0);
    }

    // LOS check: raycast from player eye height to target surface height
    this.groundTargetBlocked = false;
    if (!this.groundTargetSkipLOS) {
      const losOriginY = playerPos.y + 0.5;
      const losTargetY = surfaceY + 0.5;
      const losOrigin = new THREE.Vector3(playerPos.x, losOriginY, playerPos.z);
      const losTarget = new THREE.Vector3(hitPoint.x, losTargetY, hitPoint.z);
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
    }

    this.groundTargetPos.set(hitPoint.x, surfaceY, hitPoint.z);
    this.groundTargetNormal.copy(surfaceNormal);
    this.groundTargetCircle.position.set(hitPoint.x, surfaceY + 0.04, hitPoint.z);
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
