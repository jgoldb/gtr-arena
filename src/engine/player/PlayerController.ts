import * as THREE from 'three';
import { InputManager } from '../input/InputManager';
import { MapManager } from '../map/MapManager';

export class PlayerController {
  readonly mesh: THREE.Group;
  speed = 8;
  jumpForce = 7;
  gravity = 20;
  waterSpeedMultiplier = 0.5;
  airDriftFraction = 0.25;
  readonly collisionRadius = 0.4;
  private input: InputManager;
  private mapManager: MapManager;
  private cameraAzimuthGetter: () => number;
  private targetRotation = 0;
  private movementAzimuth = 0;
  private velocityY = 0;
  private grounded = true;
  private inWater = false;
  private spaceWasDown = false;
  private airVelocity = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    input: InputManager,
    mapManager: MapManager,
    getCameraAzimuth: () => number
  ) {
    this.input = input;
    this.mapManager = mapManager;
    this.cameraAzimuthGetter = getCameraAzimuth;

    this.mesh = this.createPlayerMesh();
    scene.add(this.mesh);

    this.respawn();
  }

  private createPlayerMesh(): THREE.Group {
    const group = new THREE.Group();

    // Body capsule
    const bodyGeometry = new THREE.CapsuleGeometry(0.4, 1.0, 8, 16);
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0x4488cc,
      roughness: 0.5,
      metalness: 0.2,
    });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.position.y = 0.9;
    body.castShadow = true;
    group.add(body);

    // Direction indicator (small cone on the front)
    const indicatorGeometry = new THREE.ConeGeometry(0.15, 0.3, 8);
    const indicatorMaterial = new THREE.MeshStandardMaterial({
      color: 0x88ccff,
      roughness: 0.3,
      metalness: 0.4,
    });
    const indicator = new THREE.Mesh(indicatorGeometry, indicatorMaterial);
    indicator.rotation.x = Math.PI / 2;
    indicator.position.set(0, 1.0, -0.55);
    indicator.castShadow = true;
    group.add(indicator);

    return group;
  }

  respawn(): void {
    const spawn = this.mapManager.getSpawnPoint();
    this.mesh.position.set(spawn.x, spawn.y, spawn.z);
  }

  update(deltaTime: number): void {
    const cameraAzimuth = this.cameraAzimuthGetter();
    const rightHeld = this.input.isMouseButtonDown('right');
    const leftHeld = this.input.isMouseButtonDown('left');

    // Movement azimuth only follows camera when right-click is held.
    // Left-click-only camera rotation does not affect movement direction.
    if (rightHeld) {
      this.movementAzimuth = cameraAzimuth;
    }

    const forward = new THREE.Vector3(-Math.sin(this.movementAzimuth), 0, -Math.cos(this.movementAzimuth));
    const right = new THREE.Vector3(-forward.z, 0, forward.x);

    const moveDir = new THREE.Vector3(0, 0, 0);

    // Both mouse buttons held = auto-forward
    if (leftHeld && rightHeld) {
      moveDir.add(forward);
    }

    if (this.input.isKeyDown('KeyW')) moveDir.add(forward);
    if (this.input.isKeyDown('KeyS')) moveDir.sub(forward);
    if (this.input.isKeyDown('KeyD')) moveDir.add(right);
    if (this.input.isKeyDown('KeyA')) moveDir.sub(right);

    const effectiveSpeed = this.inWater ? this.speed * this.waterSpeedMultiplier : this.speed;

    if (this.grounded) {
      // On ground: full movement control
      if (moveDir.lengthSq() > 0) {
        moveDir.normalize();
        this.mesh.position.addScaledVector(moveDir, effectiveSpeed * deltaTime);
        this.targetRotation = Math.atan2(moveDir.x, moveDir.z);
      } else if (rightHeld) {
        this.targetRotation = Math.atan2(-Math.sin(cameraAzimuth), -Math.cos(cameraAzimuth));
      }
    } else {
      // In air: use snapshotted velocity, but allow small drift if jumped stationary
      if (this.airVelocity.lengthSq() < 0.01 && moveDir.lengthSq() > 0) {
        moveDir.normalize();
        this.airVelocity.copy(moveDir).multiplyScalar(effectiveSpeed * this.airDriftFraction);
      }
      this.mesh.position.addScaledVector(this.airVelocity, deltaTime);
    }

    // Smooth rotation
    const currentRot = this.mesh.rotation.y;
    let diff = this.targetRotation - currentRot;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.mesh.rotation.y += diff * Math.min(1, 12 * deltaTime);

    // Jump — requires fresh press (not held from previous frame)
    const spaceDown = this.input.isKeyDown('Space');
    if (spaceDown && !this.spaceWasDown && this.grounded) {
      // Snapshot current horizontal velocity for air movement
      if (moveDir.lengthSq() > 0) {
        moveDir.normalize();
        this.airVelocity.copy(moveDir).multiplyScalar(effectiveSpeed);
      } else {
        this.airVelocity.set(0, 0, 0);
      }
      this.velocityY = this.jumpForce;
      this.grounded = false;
    }
    this.spaceWasDown = spaceDown;

    this.velocityY -= this.gravity * deltaTime;
    this.mesh.position.y += this.velocityY * deltaTime;

    // Resolve collisions (3D-aware: handles ground height, water, obstacle push-out)
    const preResolveX = this.mesh.position.x;
    const preResolveZ = this.mesh.position.z;
    const resolved = this.mapManager.collision.resolve(
      this.mesh.position.x,
      this.mesh.position.z,
      this.mesh.position.y,
      this.collisionRadius
    );
    this.mesh.position.x = resolved.x;
    this.mesh.position.z = resolved.z;
    this.inWater = resolved.inWater;

    // If collision pushed us back while airborne, kill air velocity
    // so jumping into a wall acts like a stationary jump
    if (!this.grounded) {
      const pushDx = resolved.x - preResolveX;
      const pushDz = resolved.z - preResolveZ;
      if (pushDx * pushDx + pushDz * pushDz > 0.0001) {
        this.airVelocity.set(0, 0, 0);
      }
    }

    // Land on surfaces
    if (this.mesh.position.y <= resolved.groundY) {
      this.mesh.position.y = resolved.groundY;
      this.velocityY = 0;
      this.grounded = true;
    }

    // Clamp to map bounds
    const bounds = this.mapManager.getBounds();
    const margin = this.collisionRadius;
    this.mesh.position.x = Math.max(bounds.minX + margin, Math.min(bounds.maxX - margin, this.mesh.position.x));
    this.mesh.position.z = Math.max(bounds.minZ + margin, Math.min(bounds.maxZ - margin, this.mesh.position.z));
  }

  getPosition(): THREE.Vector3 {
    return this.mesh.position;
  }

  dispose(): void {
    this.mesh.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });
  }
}
