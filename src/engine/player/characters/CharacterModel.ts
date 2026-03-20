import * as THREE from 'three';
import type { Ability } from '../../combat/Ability';

export interface AnimationInput {
  isMoving: boolean;
  isGrounded: boolean;
  velocityY: number;
  turnSpeed: number;
  speedMultiplier: number;
  strafeDirection: number; // -1 = left, 0 = none, 1 = right
}

export abstract class CharacterModel {
  readonly group: THREE.Group;
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly abilities: readonly Ability[];

  // Skeleton bone groups (pivots for animation)
  protected bodyGroup = new THREE.Group();
  protected headGroup = new THREE.Group();
  protected leftArmGroup = new THREE.Group();
  protected rightArmGroup = new THREE.Group();
  protected leftLegGroup = new THREE.Group();
  protected rightLegGroup = new THREE.Group();

  // Animation blend state
  protected runWeight = 0;
  protected jumpWeight = 0;
  protected runPhase = 0;
  protected idleTime = 0;
  protected smoothedTurnSpeed = 0;
  protected smoothedStrafeDir = 0;

  // Base stats (defined by each character)
  abstract readonly baseMaxHp: number;
  abstract readonly baseMaxMana: number;

  // Auto-attack stats (defined by each character)
  abstract readonly autoAttackDamageMin: number;
  abstract readonly autoAttackDamageMax: number;
  abstract readonly autoAttackSpeed: number; // seconds between swings
  abstract readonly autoAttackRange: number;
  abstract readonly critChance: number;  // 0–1
  abstract readonly dodgeChance: number; // 0–1

  rollAutoAttackDamage(): number {
    return this.autoAttackDamageMin + Math.floor(
      Math.random() * (this.autoAttackDamageMax - this.autoAttackDamageMin + 1)
    );
  }

  // Auto-attack animation state
  private _autoAttacking = false;
  protected combatStanceWeight = 0;
  protected attackAnimTime = -1; // -1 = not swinging
  protected attackArmToggle = false; // for alternating arms

  // Ability animation state
  protected abilityAnimTime = -1; // -1 = not playing
  protected abilityAnimId = '';

  // Death animation
  private static readonly DEATH_DURATION = 1.5;
  protected deathTime = -1; // -1 = alive, >= 0 = seconds since death

  constructor() {
    this.group = new THREE.Group();
    this.initSkeleton();
    this.buildModel();
    // Model faces -Z locally; rotate 180° so it aligns with the
    // atan2(x,z) rotation convention used by PlayerController
    this.group.rotation.y = Math.PI;
    this.group.traverse((child) => {
      if (child instanceof THREE.Mesh) child.castShadow = true;
    });
  }

  private initSkeleton(): void {
    // Leg pivots at hip height
    this.leftLegGroup.position.set(-0.1, 0.78, 0);
    this.rightLegGroup.position.set(0.1, 0.78, 0);

    // Arm pivots at shoulder height
    this.leftArmGroup.position.set(-0.26, 1.28, 0);
    this.rightArmGroup.position.set(0.26, 1.28, 0);

    // Head pivot at neck
    this.headGroup.position.set(0, 1.42, 0);

    // Upper body hierarchy: head and arms move with body
    this.bodyGroup.add(this.headGroup);
    this.bodyGroup.add(this.leftArmGroup);
    this.bodyGroup.add(this.rightArmGroup);

    // Legs are independent of upper body
    this.group.add(this.leftLegGroup);
    this.group.add(this.rightLegGroup);
    this.group.add(this.bodyGroup);
  }

  protected abstract buildModel(): void;

  startDeath(): void {
    this.deathTime = 0;
    this._autoAttacking = false;
    this.combatStanceWeight = 0;
    this.attackAnimTime = -1;
    this.abilityAnimTime = -1;
    this.abilityAnimId = '';
  }

  resetDeath(): void {
    this.deathTime = -1;
    this._autoAttacking = false;
    this.combatStanceWeight = 0;
    this.attackAnimTime = -1;
    this.abilityAnimTime = -1;
    this.abilityAnimId = '';
    this.group.rotation.x = 0;
    this.group.position.y = 0;
  }

  get isDying(): boolean {
    return this.deathTime >= 0;
  }

  get isAutoAttacking(): boolean {
    return this._autoAttacking;
  }

  setAutoAttacking(active: boolean): void {
    this._autoAttacking = active;
  }

  triggerSwing(): void {
    this.attackAnimTime = 0;
  }

  triggerAbilityAnimation(abilityId: string): void {
    this.abilityAnimTime = 0;
    this.abilityAnimId = abilityId;
  }

  get isSwinging(): boolean {
    return this.attackAnimTime >= 0;
  }

  update(dt: number, input: AnimationInput): void {
    // Death animation overrides everything
    if (this.deathTime >= 0) {
      this.deathTime += dt;
      const t = Math.min(1, this.deathTime / CharacterModel.DEATH_DURATION);
      this.animateDeath(t);
      return;
    }

    // Blend weights toward targets
    const wantRun = input.isMoving && input.isGrounded ? 1 : 0;
    this.runWeight += (wantRun - this.runWeight) * Math.min(1, 10 * dt);

    const wantJump = input.isGrounded ? 0 : 1;
    this.jumpWeight += (wantJump - this.jumpWeight) * Math.min(1, 8 * dt);

    // Phase accumulators
    this.idleTime += dt;
    if (input.isMoving && input.isGrounded) {
      this.runPhase += dt * 10 * input.speedMultiplier;
    }

    this.smoothedTurnSpeed +=
      (input.turnSpeed - this.smoothedTurnSpeed) * Math.min(1, 5 * dt);
    this.smoothedStrafeDir +=
      (input.strafeDirection - this.smoothedStrafeDir) * Math.min(1, 10 * dt);

    // Reset all bone transforms each frame
    this.leftArmGroup.rotation.set(0, 0, 0);
    this.rightArmGroup.rotation.set(0, 0, 0);
    this.leftLegGroup.rotation.set(0, 0, 0);
    this.rightLegGroup.rotation.set(0, 0, 0);
    this.bodyGroup.rotation.set(0, 0, 0);
    this.bodyGroup.position.y = 0;
    this.headGroup.rotation.set(0, 0, 0);

    // --- Idle layer (fades out during run) ---
    const idleW = 1 - this.runWeight;
    this.bodyGroup.position.y += Math.sin(this.idleTime * 2) * 0.015 * idleW;
    this.leftArmGroup.rotation.z -=
      Math.sin(this.idleTime * 1.5) * 0.04 * idleW;
    this.rightArmGroup.rotation.z +=
      Math.sin(this.idleTime * 1.5 + 0.5) * 0.04 * idleW;
    this.headGroup.rotation.y +=
      Math.sin(this.idleTime * 0.7) * 0.03 * idleW;

    // --- Run / strafe layer ---
    const runSin = Math.sin(this.runPhase);
    const runCos = Math.cos(this.runPhase);
    const strafeBlend = Math.abs(this.smoothedStrafeDir);
    const forwardBlend = 1 - strafeBlend;
    const strafeSign = this.smoothedStrafeDir > 0 ? 1 : this.smoothedStrafeDir < 0 ? -1 : 0;

    // Forward/back run (fades out during strafe)
    this.leftArmGroup.rotation.x -= runSin * 0.7 * this.runWeight * forwardBlend;
    this.rightArmGroup.rotation.x += runSin * 0.7 * this.runWeight * forwardBlend;
    this.leftLegGroup.rotation.x += runSin * 0.6 * this.runWeight * forwardBlend;
    this.rightLegGroup.rotation.x -= runSin * 0.6 * this.runWeight * forwardBlend;

    // Strafe shuffle (fades in during strafe)
    if (strafeBlend > 0.01) {
      // Legs step sideways
      this.leftLegGroup.rotation.z += runSin * 0.35 * this.runWeight * strafeBlend * strafeSign;
      this.rightLegGroup.rotation.z -= runSin * 0.35 * this.runWeight * strafeBlend * strafeSign;
      // Alternating leg lift during steps
      this.leftLegGroup.rotation.x -= Math.max(0, runSin) * 0.15 * this.runWeight * strafeBlend;
      this.rightLegGroup.rotation.x -= Math.max(0, -runSin) * 0.15 * this.runWeight * strafeBlend;
      // Reduced arm swing for balance
      this.leftArmGroup.rotation.x -= runSin * 0.3 * this.runWeight * strafeBlend;
      this.rightArmGroup.rotation.x += runSin * 0.3 * this.runWeight * strafeBlend;
      // Body lean into strafe direction
      this.bodyGroup.rotation.z -= 0.08 * this.runWeight * strafeBlend * strafeSign;
    }

    // Body bob (shared by run and strafe)
    this.bodyGroup.position.y += Math.abs(runCos) * 0.04 * this.runWeight;
    // Forward lean (only during forward run)
    this.bodyGroup.rotation.x += 0.1 * this.runWeight * forwardBlend;
    this.headGroup.rotation.x -= 0.1 * this.runWeight * forwardBlend;

    // --- Turn lean (only while running) ---
    this.bodyGroup.rotation.z -=
      this.smoothedTurnSpeed * 0.04 * this.runWeight;

    // --- Jump layer (additive) ---
    this.leftArmGroup.rotation.z -= this.jumpWeight * 0.5;
    this.rightArmGroup.rotation.z += this.jumpWeight * 0.5;
    this.leftArmGroup.rotation.x -= this.jumpWeight * 0.2;
    this.rightArmGroup.rotation.x -= this.jumpWeight * 0.2;
    this.leftLegGroup.rotation.x += this.jumpWeight * 0.3;
    this.rightLegGroup.rotation.x += this.jumpWeight * 0.3;

    // --- Combat stance layer ---
    const wantCombat = this._autoAttacking ? 1 : 0;
    this.combatStanceWeight += (wantCombat - this.combatStanceWeight) * Math.min(1, 8 * dt);
    if (this.combatStanceWeight > 0.001) {
      this.animateCombatStance(this.combatStanceWeight);
    }

    // --- Attack swing layer ---
    if (this.attackAnimTime >= 0) {
      this.attackAnimTime += dt;
      const swingDuration = this.getSwingDuration();
      const t = Math.min(1, this.attackAnimTime / swingDuration);
      this.animateAttackSwing(t, this.attackArmToggle);
      if (t >= 1) {
        this.attackAnimTime = -1;
        this.attackArmToggle = !this.attackArmToggle;
      }
    }

    // --- Ability animation layer ---
    if (this.abilityAnimTime >= 0) {
      this.abilityAnimTime += dt;
      const dur = this.getAbilityAnimDuration(this.abilityAnimId);
      const t = Math.min(1, this.abilityAnimTime / dur);
      this.animateAbilityUse(this.abilityAnimId, t);
      if (t >= 1) {
        this.abilityAnimTime = -1;
        this.abilityAnimId = '';
      }
    }

    // Character-specific animation
    this.onAnimate(dt, input);
  }

  protected onAnimate(_dt: number, _input: AnimationInput): void {}

  setAbilityBuffActive(_buffId: string, _active: boolean): void {}

  protected getSwingDuration(): number {
    return 0.4;
  }

  protected animateCombatStance(_weight: number): void {}
  protected animateAttackSwing(_t: number, _alternateArm: boolean): void {}
  protected getAbilityAnimDuration(_abilityId: string): number { return 0.6; }
  protected animateAbilityUse(_abilityId: string, _t: number): void {}

  protected animateDeath(t: number): void {
    // Reset all bones
    this.leftArmGroup.rotation.set(0, 0, 0);
    this.rightArmGroup.rotation.set(0, 0, 0);
    this.leftLegGroup.rotation.set(0, 0, 0);
    this.rightLegGroup.rotation.set(0, 0, 0);
    this.bodyGroup.rotation.set(0, 0, 0);
    this.bodyGroup.position.y = 0;
    this.headGroup.rotation.set(0, 0, 0);

    // Phase timing
    const stagger = Math.min(1, t / 0.15);
    const fall = t < 0.15 ? 0 : Math.min(1, (t - 0.15) / 0.55);
    const fallEase = 1 - Math.pow(1 - fall, 2);

    // Arms flail outward and back
    this.leftArmGroup.rotation.z = -(stagger * 0.3 + fallEase * 0.9);
    this.rightArmGroup.rotation.z = stagger * 0.3 + fallEase * 0.9;
    this.leftArmGroup.rotation.x = -(stagger * 0.2 + fallEase * 0.5);
    this.rightArmGroup.rotation.x = -(stagger * 0.2 + fallEase * 0.5);

    // Body slight twist for drama
    this.bodyGroup.rotation.z = fallEase * 0.15;

    // Tip the whole model backward (group.rotation.y = PI is preserved)
    // Stagger recoil fades out so final rotation is exactly PI/2 (flat)
    const recoil = stagger * (1 - fallEase) * 0.08;
    this.group.rotation.x = recoil + fallEase * (Math.PI / 2);
    // Lift just enough to keep the torso depth above the ground plane
    this.group.position.y = fallEase * 0.15;
  }

  dispose(): void {
    this.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const mat = child.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    });
  }

  protected createMesh(
    geometry: THREE.BufferGeometry,
    color: number,
    opts?: Partial<THREE.MeshStandardMaterialParameters>
  ): THREE.Mesh {
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.7,
      metalness: 0.1,
      ...opts,
    });
    return new THREE.Mesh(geometry, material);
  }
}
