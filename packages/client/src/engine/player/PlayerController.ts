import * as THREE from 'three';
import { InputManager } from '../input/InputManager';
import { MapManager } from '../map/MapManager';
import { CharacterModel } from './characters/CharacterModel';
import { createCharacter, CharacterId } from './characters';
import type { Ability } from '../combat/Ability';
import type { Targetable } from '../types';
import { createTargetingHitArea } from '../targeting/targetingHitArea';
import { keybindManager } from '../../ui/KeybindManager';

export class PlayerController implements Targetable {
  readonly mesh: THREE.Group;
  readonly name = 'Player';
  readonly team = 0;
  hp = 0;
  maxHp = 0;
  mana = 0;
  maxMana = 0;
  inCombat = false;
  dead = false;
  castingAbilityName: string | null = null;
  castingElapsed = 0;
  castingTotalTime = 0;
  castingIsChannel = false;
  speed = 5.6;
  jumpForce = 7;
  gravity = 20;
  waterSpeedMultiplier = 0.5;
  backpedalMultiplier = 0.5;
  airDriftFraction = 0.25;
  readonly collisionRadius = 0.4;
  private input: InputManager;
  private mapManager: MapManager;
  private cameraAzimuthGetter: () => number;
  private cameraElevationGetter: () => number;
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
    getCameraAzimuth: () => number,
    getCameraElevation: () => number = () => 0
  ) {
    this.input = input;
    this.mapManager = mapManager;
    this.cameraAzimuthGetter = getCameraAzimuth;
    this.cameraElevationGetter = getCameraElevation;

    this.mesh = new THREE.Group();
    this.mesh.userData.targetRef = this;
    this.characterModel = createCharacter('janitor');
    this.mesh.add(this.characterModel.group);
    this.mesh.add(createTargetingHitArea());
    this.applyModelStats();
    scene.add(this.mesh);

    this.respawn();
  }

  setCharacter(id: CharacterId): void {
    this.mesh.remove(this.characterModel.group);
    this.characterModel.dispose();
    this.characterModel = createCharacter(id);
    this.mesh.add(this.characterModel.group);
    this.applyModelStats();
  }

  private applyModelStats(): void {
    this.maxHp = this.characterModel.baseMaxHp;
    this.maxMana = this.characterModel.baseMaxMana;
    this.hp = this.maxHp;
    this.mana = this.maxMana;
  }

  isHostileTo(other: Targetable): boolean {
    return this.team !== other.team;
  }

  get modelName(): string {
    return this.characterModel.displayName;
  }

  get characterId(): CharacterId {
    return this.characterModel.id;
  }

  rollAutoAttackDamage(): number {
    return this.characterModel.rollAutoAttackDamage();
  }

  get autoAttackSpeed(): number {
    return this.characterModel.autoAttackSpeed;
  }

  get autoAttackRange(): number {
    return this.characterModel.autoAttackRange;
  }

  get critChance(): number {
    return this.characterModel.critChance;
  }

  get dodgeChance(): number {
    return this.characterModel.dodgeChance;
  }

  get abilities(): readonly Ability[] {
    return this.characterModel.abilities;
  }

  setAutoAttacking(active: boolean): void {
    this.characterModel.setAutoAttacking(active);
  }

  triggerSwing(): void {
    this.characterModel.triggerSwing();
  }

  triggerAbilityAnimation(abilityId: string, targetWorldPos?: THREE.Vector3): void {
    this.characterModel.triggerAbilityAnimation(abilityId, targetWorldPos);
  }

  triggerFlinch(): void {
    this.characterModel.triggerFlinch();
  }

  setAbilityBuffActive(buffId: string, active: boolean): void {
    this.characterModel.setAbilityBuffActive(buffId, active);
  }

  setCastAnimation(abilityId: string | null, progress: number): void {
    this.characterModel.setCastAnimation(abilityId, progress);
  }

  setChannelAnimation(abilityId: string | null, progress: number): void {
    this.characterModel.setChannelAnimation(abilityId, progress);
  }

  setStunned(active: boolean): void {
    this.stunned = active;
    this.characterModel.setStunned(active);
  }

  setResting(active: boolean): void {
    this.characterModel.setResting(active);
  }

  setOpacity(opacity: number): void {
    this.characterModel.setOpacity(opacity);
  }

  movementSpeedModifier = 1;
  stunned = false;
  charging = false;
  discombobulated = false;
  isMoving = false;
  godMode = false;
  private keyScramble = new Map<string, string>();

  setDiscombobulated(active: boolean): void {
    if (active && !this.discombobulated) {
      this.generateKeyScramble();
    }
    this.discombobulated = active;
  }

  private generateKeyScramble(): void {
    const keys = [
      keybindManager.getCode('move_forward'),
      keybindManager.getCode('move_left'),
      keybindManager.getCode('move_backward'),
      keybindManager.getCode('move_right'),
    ];
    let shuffled: string[];
    do {
      shuffled = [...keys];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
    } while (shuffled.some((k, i) => k === keys[i]));

    this.keyScramble.clear();
    for (let i = 0; i < keys.length; i++) {
      this.keyScramble.set(keys[i], shuffled[i]);
    }
  }

  private getMovementKey(code: string): string {
    if (this.discombobulated) return this.keyScramble.get(code) ?? code;
    return code;
  }

  die(): void {
    if (this.dead) return;
    this.dead = true;
    this.hp = 0;
    this.inCombat = false;
    this.characterModel.startDeath();
  }

  respawn(): void {
    this.dead = false;
    this.hp = this.maxHp;
    this.mana = this.maxMana;
    this.inCombat = false;
    this.characterModel.resetDeath();
    const spawn = this.mapManager.getSpawnPoint();
    this.mesh.position.set(spawn.x, spawn.y, spawn.z);
    this.velocityY = 0;
    this.grounded = true;
    // Face toward map center
    this.targetRotation = Math.atan2(-spawn.x, -spawn.z);
    this.mesh.rotation.y = this.targetRotation;
    this.movementAzimuth = Math.atan2(spawn.x, spawn.z);
  }

  update(deltaTime: number): void {
    if (this.dead) {
      // Only animate the death pose, no movement
      this.characterModel.update(deltaTime, {
        isMoving: false,
        isGrounded: this.grounded,
        velocityY: 0,
        turnSpeed: 0,
        speedMultiplier: 1,
        strafeDirection: 0,
      });
      return;
    }

    if (this.stunned) {
      // No movement or input, just animate the stun
      this.velocityY -= this.gravity * deltaTime;
      this.mesh.position.y += this.velocityY * deltaTime;
      const resolved = this.mapManager.collision.resolve(
        this.mesh.position.x, this.mesh.position.z,
        this.mesh.position.y, this.collisionRadius
      );
      this.mesh.position.x = resolved.x;
      this.mesh.position.z = resolved.z;
      if (this.mesh.position.y <= resolved.groundY) {
        this.mesh.position.y = resolved.groundY;
        this.velocityY = 0;
        this.grounded = true;
      }
      this.characterModel.update(deltaTime, {
        isMoving: false,
        isGrounded: this.grounded,
        velocityY: this.velocityY,
        turnSpeed: 0,
        speedMultiplier: 1,
        strafeDirection: 0,
      });
      return;
    }

    if (this.charging) {
      // During charge: skip input, resolve collision on position set by Engine
      this.velocityY -= this.gravity * deltaTime;
      this.mesh.position.y += this.velocityY * deltaTime;
      const resolved = this.mapManager.collision.resolve(
        this.mesh.position.x, this.mesh.position.z,
        this.mesh.position.y, this.collisionRadius
      );
      this.mesh.position.x = resolved.x;
      this.mesh.position.z = resolved.z;
      if (this.mesh.position.y <= resolved.groundY) {
        this.mesh.position.y = resolved.groundY;
        this.velocityY = 0;
        this.grounded = true;
      }
      const bounds = this.mapManager.getBounds();
      const margin = this.collisionRadius;
      this.mesh.position.x = Math.max(bounds.minX + margin, Math.min(bounds.maxX - margin, this.mesh.position.x));
      this.mesh.position.z = Math.max(bounds.minZ + margin, Math.min(bounds.maxZ - margin, this.mesh.position.z));
      this.characterModel.update(deltaTime, {
        isMoving: true,
        isGrounded: this.grounded,
        velocityY: this.velocityY,
        turnSpeed: 0,
        speedMultiplier: 1,
        strafeDirection: 0,
      });
      return;
    }

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

    // Both mouse buttons held = virtual W key press (scrambled by discombobulate)
    const bothMouseHeld = leftHeld && rightHeld;

    const fwdCode = keybindManager.getCode('move_forward');
    const bwdCode = keybindManager.getCode('move_backward');
    const leftCode = keybindManager.getCode('move_left');
    const rightCode = keybindManager.getCode('move_right');
    const wDown = this.input.isBindDown(this.getMovementKey(fwdCode)) || (bothMouseHeld && this.getMovementKey(fwdCode) === fwdCode);
    const sDown = this.input.isBindDown(this.getMovementKey(bwdCode)) || (bothMouseHeld && this.getMovementKey(bwdCode) === fwdCode);
    const dDown = this.input.isBindDown(this.getMovementKey(rightCode)) || (bothMouseHeld && this.getMovementKey(rightCode) === fwdCode);
    const aDown = this.input.isBindDown(this.getMovementKey(leftCode)) || (bothMouseHeld && this.getMovementKey(leftCode) === fwdCode);
    if (this.godMode && rightHeld) {
      // 3D flight: W/S follows camera pitch, A/D strafes horizontally
      const elevation = this.cameraElevationGetter();
      const cosElev = Math.cos(elevation);
      const sinElev = Math.sin(elevation);
      const forward3D = new THREE.Vector3(
        -cosElev * Math.sin(this.movementAzimuth),
        -sinElev,
        -cosElev * Math.cos(this.movementAzimuth)
      );
      if (wDown) moveDir.add(forward3D);
      if (sDown) moveDir.sub(forward3D);
      if (dDown) moveDir.add(right);
      if (aDown) moveDir.sub(right);
    } else {
      if (wDown) moveDir.add(forward);
      if (sDown) moveDir.sub(forward);
      if (dDown) moveDir.add(right);
      if (aDown) moveDir.sub(right);
    }

    // Pure strafe (A/D without W/S) for animation
    let strafeDirection = 0;
    if ((aDown || dDown) && !wDown && !sDown) {
      strafeDirection = dDown ? 1 : -1;
    }

    const isMoving = moveDir.lengthSq() > 0;
    this.isMoving = isMoving;
    const isBackpedaling = sDown && !wDown;
    const speedMultiplier = isBackpedaling ? this.backpedalMultiplier : 1;
    const effectiveSpeed = (this.inWater ? this.speed * this.waterSpeedMultiplier : this.speed) * speedMultiplier * this.movementSpeedModifier;

    if (this.grounded || this.godMode) {
      // On ground (or flying in god mode): full movement control
      if (isMoving) {
        moveDir.normalize();
        this.mesh.position.addScaledVector(moveDir, effectiveSpeed * deltaTime);
      }
      // Facing only changes from right-click (camera direction)
      if (rightHeld) {
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

    // Jump / fly
    const spaceDown = this.input.isBindDown(keybindManager.getCode('jump'));
    if (this.godMode) {
      // Flying: Space = ascend, Shift = descend, no gravity
      if (spaceDown) {
        this.mesh.position.y += effectiveSpeed * deltaTime;
      }
      if (this.input.isKeyDown('ShiftLeft') || this.input.isKeyDown('ShiftRight')) {
        this.mesh.position.y -= effectiveSpeed * deltaTime;
      }
      this.velocityY = 0;
      this.grounded = false;
    } else {
      // Normal jump — requires fresh press (not held from previous frame)
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
      } else if (this.grounded && this.mesh.position.y - resolved.groundY < 1) {
        // Follow descending platforms smoothly instead of free-falling in tiny steps
        this.mesh.position.y = resolved.groundY;
        this.velocityY = 0;
      }
    }
    this.spaceWasDown = spaceDown;

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
      strafeDirection,
    });
  }

  getPosition(): THREE.Vector3 {
    return this.mesh.position;
  }

  dispose(): void {
    this.characterModel.dispose();
  }
}
