import * as THREE from 'three';
import { InputManager } from '../input/InputManager';

export class ThirdPersonCamera {
  private camera: THREE.PerspectiveCamera;
  private input: InputManager;
  targetGetter: () => THREE.Vector3;
  private scene: THREE.Scene;
  private raycaster = new THREE.Raycaster();

  // Spherical coordinates
  azimuth = 0;
  elevation = 0.5; // radians (~28 degrees)
  distance = 12;

  // Limits
  minElevation = -Math.PI / 2; // directly below the player
  maxElevation = 1.4; // ~80 degrees
  minDistance = 3;
  maxDistance = 12;

  // Controls
  mouseSensitivity = 0.003;
  scrollSensitivity = 0.005;
  followSmoothing = 0.3;

  // Elevation threshold below which the player model starts fading out
  private readonly fadeStartElevation = -0.5; // same as the old minElevation

  // Camera collision
  private wallOffset = 0.3;

  // Vertical offset to look at character's chest, not feet
  targetOffset = new THREE.Vector3(0, 1.5, 0);

  private currentPosition = new THREE.Vector3();
  private currentLookAt = new THREE.Vector3();
  private initialized = false;

  constructor(
    camera: THREE.PerspectiveCamera,
    input: InputManager,
    getTarget: () => THREE.Vector3,
    scene: THREE.Scene
  ) {
    this.camera = camera;
    this.input = input;
    this.targetGetter = getTarget;
    this.scene = scene;
  }

  update(deltaTime: number): void {
    // Handle mouse rotation (left-click or right-click drag)
    if (this.input.isMouseButtonDown('left') || this.input.isMouseButtonDown('right')) {
      const delta = this.input.getMouseDelta();
      this.azimuth -= delta.x * this.mouseSensitivity;
      this.elevation += delta.y * this.mouseSensitivity;
      this.elevation = Math.max(this.minElevation, Math.min(this.maxElevation, this.elevation));
    }

    // Handle scroll zoom
    const scrollDelta = this.input.getScrollDelta();
    if (scrollDelta !== 0) {
      this.distance += scrollDelta * this.scrollSensitivity;
      this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.distance));
    }

    // Compute target look-at position (player + offset)
    const targetPos = this.targetGetter();
    const desiredLookAt = new THREE.Vector3().copy(targetPos).add(this.targetOffset);

    // Compute desired camera position from spherical coordinates
    const desiredPosition = new THREE.Vector3(
      desiredLookAt.x + this.distance * Math.cos(this.elevation) * Math.sin(this.azimuth),
      desiredLookAt.y + this.distance * Math.sin(this.elevation),
      desiredLookAt.z + this.distance * Math.cos(this.elevation) * Math.cos(this.azimuth)
    );

    // Camera collision: raycast from look-at target toward desired position
    const rayDir = new THREE.Vector3().subVectors(desiredPosition, desiredLookAt);
    const fullDistance = rayDir.length();
    rayDir.normalize();

    this.raycaster.set(desiredLookAt, rayDir);
    this.raycaster.far = fullDistance;

    const mapGroup = this.scene.getObjectByName('map');
    if (mapGroup) {
      const hits = this.raycaster.intersectObject(mapGroup, true);
      // Find first opaque hit (skip transparent objects like water surfaces)
      for (const hit of hits) {
        const mat = (hit.object as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (mat && mat.transparent) continue;
        // Clamp camera in front of the wall
        const clampedDistance = Math.max(this.minDistance * 0.5, hit.distance - this.wallOffset);
        desiredPosition.copy(desiredLookAt).addScaledVector(rayDir, clampedDistance);
        break;
      }
    }

    // Initialize or smooth follow
    if (!this.initialized) {
      this.currentPosition.copy(desiredPosition);
      this.currentLookAt.copy(desiredLookAt);
      this.initialized = true;
    } else {
      const smoothing = 1 - Math.pow(1 - this.followSmoothing, deltaTime * 60);
      this.currentPosition.lerp(desiredPosition, smoothing);
      this.currentLookAt.lerp(desiredLookAt, smoothing);
    }

    this.camera.position.copy(this.currentPosition);
    this.camera.lookAt(this.currentLookAt);
  }

  getAzimuth(): number {
    return this.azimuth;
  }

  setAzimuth(azimuth: number): void {
    this.azimuth = azimuth;
  }

  getElevation(): number {
    return this.elevation;
  }

  /** Returns 0–1 opacity for the local player model based on camera elevation. */
  getPlayerModelOpacity(): number {
    if (this.elevation >= this.fadeStartElevation) return 1;
    // Map from fadeStartElevation → minElevation  to  1 → 0
    const range = this.fadeStartElevation - this.minElevation;
    if (range <= 0) return 1;
    return Math.max(0, (this.elevation - this.minElevation) / range);
  }
}
