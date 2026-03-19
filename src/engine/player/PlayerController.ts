import * as THREE from 'three';
import { InputManager } from '../input/InputManager';
import { MapManager } from '../map/MapManager';
import { CharacterModel } from './characters/CharacterModel';
import { createCharacter, CharacterId } from './characters';
import type { Targetable } from '../types';

export class PlayerController implements Targetable {
  readonly mesh: THREE.Group;
  readonly name = 'Player';
  readonly hostile = false;
  hp = 100;
  maxHp = 100;
  mana = 100;
  maxMana = 100;
  speed = 8;
  jumpForce = 7;
  gravity = 20;
  waterSpeedMultiplier = 0.5;
  backpedalMultiplier = 0.5;
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
  private characterModel: CharacterModel;

  constructor(
    scene: THREE.Scene,
    input: InputManager,
    mapManager: MapManager,
    getCameraAzimuth: () => number
  ) {
    this.input = input;
    this.mapManager = mapManager;
    this.cameraAzimuthGetter = getCameraAzimuth;

    this.mesh = new THREE.Group();
    this.mesh.userData.targetRef = this;
    this.characterModel = createCharacter('janitor');
    this.mesh.add(this.characterModel.group);
    scene.add(this.mesh);

    this.respawn();
  }

  setCharacter(id: CharacterId): void {
    this.mesh.remove(this.characterModel.group);
    this.characterModel.dispose();
    this.characterModel = createCharacter(id);
    this.mesh.add(this.characterModel.group);
  }

  get modelName(): string {
    return this.characterModel.displayName;
  }

  respawn(): void {
    const spawn = this.mapManager.getSpawnPoint();
    this.mesh.position.set(spawn.x, spawn.y, spawn.z);
    // Face toward map center
    this.targetRotation = Math.atan2(-spawn.x, -spawn.z);
    this.mesh.rotation.y = this.targetRotation;
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

    const wDown = this.input.isKeyDown('KeyW');
    const sDown = this.input.isKeyDown('KeyS');
    if (wDown) moveDir.add(forward);
    if (sDown) moveDir.sub(forward);
    if (this.input.isKeyDown('KeyD')) moveDir.add(right);
    if (this.input.isKeyDown('KeyA')) moveDir.sub(right);

    const isMoving = moveDir.lengthSq() > 0;
    const isBackpedaling = sDown && !wDown;
    const speedMultiplier = isBackpedaling ? this.backpedalMultiplier : 1;
    const effectiveSpeed = (this.inWater ? this.speed * this.waterSpeedMultiplier : this.speed) * speedMultiplier;

    if (this.grounded) {
      // On ground: full movement control
      if (isMoving) {
        moveDir.normalize();
        this.mesh.position.addScaledVector(moveDir, effectiveSpeed * deltaTime);
        if (isBackpedaling) {
          // Face opposite of movement direction (toward "forward")
          this.targetRotation = Math.atan2(-moveDir.x, -moveDir.z);
        } else {
          this.targetRotation = Math.atan2(moveDir.x, moveDir.z);
        }
      } else if (rightHeld) {
        this.targetRotation = Math.atan2(-Math.sin(cameraAzimuth), -Math.cos(cameraAzimuth));
      }
    } else {
      // In air: use snapshotted velocity, but allow small drift if jumped stationary
      if (this.airVelocity.lengthSq() < 0.01 && isMoving) {
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
    const rotApplied = diff * Math.min(1, 12 * deltaTime);
    this.mesh.rotation.y += rotApplied;
    const turnSpeed = deltaTime > 0 ? rotApplied / deltaTime : 0;

    // Jump — requires fresh press (not held from previous frame)
    const spaceDown = this.input.isKeyDown('Space');
    if (spaceDown && !this.spaceWasDown && this.grounded) {
      // Snapshot current horizontal velocity for air movement
      if (isMoving) {
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

    // Drive character animation
    this.characterModel.update(deltaTime, {
      isMoving,
      isGrounded: this.grounded,
      velocityY: this.velocityY,
      turnSpeed,
      speedMultiplier,
    });
  }

  getPosition(): THREE.Vector3 {
    return this.mesh.position;
  }

  dispose(): void {
    this.characterModel.dispose();
  }
}
