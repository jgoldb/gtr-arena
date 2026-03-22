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

  // Cast / channel animation state (driven externally by Engine)
  private castAnimId = '';
  private castAnimProgress = 0;
  private castAnimActive = false;
  private channelAnimId = '';
  private channelAnimProgress = 0;
  private channelAnimActive = false;

  // Stun animation state
  protected stunActive = false;
  protected stunWeight = 0;
  protected stunTime = 0;

  // Resting animation state
  protected restingActive = false;
  protected restingWeight = 0;
  protected restingTime = 0;

  // Flinch animation state (hit reaction)
  private static readonly FLINCH_DURATION = 0.25;
  protected flinchTime = -1; // -1 = not playing

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

  protected abilityTargetPos: THREE.Vector3 | null = null;

  triggerAbilityAnimation(abilityId: string, targetWorldPos?: THREE.Vector3): void {
    this.abilityAnimTime = 0;
    this.abilityAnimId = abilityId;
    this.abilityTargetPos = targetWorldPos ?? null;
  }

  triggerFlinch(): void {
    this.flinchTime = 0;
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

    // Stun animation blend
    const wantStun = this.stunActive ? 1 : 0;
    this.stunWeight += (wantStun - this.stunWeight) * Math.min(1, 8 * dt);
    if (this.stunActive) this.stunTime += dt;

    // When fully stunned, override normal animation
    if (this.stunWeight > 0.01) {
      // Reset all bone transforms
      this.leftArmGroup.rotation.set(0, 0, 0);
      this.rightArmGroup.rotation.set(0, 0, 0);
      this.leftLegGroup.rotation.set(0, 0, 0);
      this.rightLegGroup.rotation.set(0, 0, 0);
      this.bodyGroup.rotation.set(0, 0, 0);
      this.bodyGroup.position.y = 0;
      this.headGroup.rotation.set(0, 0, 0);

      this.animateStun(this.stunTime, this.stunWeight);
      this.onAnimate(dt, input);
      return;
    }

    // Resting animation blend
    const wantRest = this.restingActive ? 1 : 0;
    this.restingWeight += (wantRest - this.restingWeight) * Math.min(1, 6 * dt);
    if (this.restingActive) this.restingTime += dt;

    // When resting, override normal animation with sitting pose
    if (this.restingWeight > 0.01) {
      this.leftArmGroup.rotation.set(0, 0, 0);
      this.rightArmGroup.rotation.set(0, 0, 0);
      this.leftLegGroup.rotation.set(0, 0, 0);
      this.rightLegGroup.rotation.set(0, 0, 0);
      this.bodyGroup.rotation.set(0, 0, 0);
      this.bodyGroup.position.y = 0;
      this.headGroup.rotation.set(0, 0, 0);
      // Reset leg pivot positions (modified by animateResting)
      this.leftLegGroup.position.y = 0.78;
      this.rightLegGroup.position.y = 0.78;

      this.animateResting(this.restingTime, this.restingWeight);
      this.onAnimate(dt, input);
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

    // --- Flinch layer (additive, short recoil on hit) ---
    if (this.flinchTime >= 0) {
      this.flinchTime += dt;
      const t = Math.min(1, this.flinchTime / CharacterModel.FLINCH_DURATION);
      this.animateFlinch(t);
      if (t >= 1) {
        this.flinchTime = -1;
      }
    }

    // --- Cast animation layer (driven by Engine during cast bar) ---
    if (this.castAnimActive) {
      this.animateCasting(this.castAnimId, this.castAnimProgress);
    }

    // --- Channel animation layer (driven by Engine during channel) ---
    if (this.channelAnimActive) {
      this.animateChanneling(this.channelAnimId, this.channelAnimProgress);
    }

    // Character-specific animation
    this.onAnimate(dt, input);
  }

  protected onAnimate(_dt: number, _input: AnimationInput): void {}

  setStunned(active: boolean): void {
    this.stunActive = active;
    if (!active) {
      this.stunTime = 0;
    }
  }

  setResting(active: boolean): void {
    this.restingActive = active;
    if (!active) {
      this.restingTime = 0;
    }
  }

  setAbilityBuffActive(_buffId: string, _active: boolean): void {}

  protected getSwingDuration(): number {
    return 0.4;
  }

  setCastAnimation(abilityId: string | null, progress: number): void {
    if (abilityId) {
      this.castAnimId = abilityId;
      this.castAnimProgress = progress;
      this.castAnimActive = true;
    } else {
      this.castAnimActive = false;
    }
  }

  setChannelAnimation(abilityId: string | null, progress: number): void {
    if (abilityId) {
      this.channelAnimId = abilityId;
      this.channelAnimProgress = progress;
      this.channelAnimActive = true;
    } else {
      this.channelAnimActive = false;
    }
  }

  protected animateCombatStance(_weight: number): void {}
  protected animateAttackSwing(_t: number, _alternateArm: boolean): void {}
  protected getAbilityAnimDuration(_abilityId: string): number { return 0.6; }
  protected animateAbilityUse(_abilityId: string, _t: number): void {}
  protected animateCasting(_abilityId: string, _t: number): void {}
  protected animateChanneling(_abilityId: string, _t: number): void {}

  protected animateFlinch(t: number): void {
    // Quick recoil: sharp peak at ~20% then ease out
    const impact = t < 0.2 ? t / 0.2 : Math.max(0, 1 - (t - 0.2) / 0.8);
    const ease = impact * impact * (3 - 2 * impact); // smoothstep

    // Body recoils backward with slight lateral twist
    this.bodyGroup.rotation.x -= ease * 0.2;
    this.bodyGroup.rotation.z += ease * 0.08;

    // Head snaps back
    this.headGroup.rotation.x -= ease * 0.15;

    // Arms flare out
    this.leftArmGroup.rotation.z -= ease * 0.15;
    this.rightArmGroup.rotation.z += ease * 0.15;
    this.leftArmGroup.rotation.x -= ease * 0.1;
    this.rightArmGroup.rotation.x -= ease * 0.1;
  }

  protected animateResting(time: number, weight: number): void {
    const w = weight;
    const sitDrop = 0.55; // how far the whole character drops to sit

    // Lower body and leg pivots together so hips sit near ground
    this.bodyGroup.position.y -= sitDrop * w;
    this.leftLegGroup.position.y -= sitDrop * w;
    this.rightLegGroup.position.y -= sitDrop * w;

    // Lean back slightly
    this.bodyGroup.rotation.x -= 0.15 * w;

    // Legs extended forward from the lowered hip pivot
    this.leftLegGroup.rotation.x += 1.4 * w;
    this.rightLegGroup.rotation.x += 1.4 * w;
    // Slight splay
    this.leftLegGroup.rotation.z -= 0.08 * w;
    this.rightLegGroup.rotation.z += 0.08 * w;

    // Arms resting on knees
    this.leftArmGroup.rotation.x += 0.5 * w;
    this.rightArmGroup.rotation.x += 0.5 * w;
    this.leftArmGroup.rotation.z -= 0.15 * w;
    this.rightArmGroup.rotation.z += 0.15 * w;

    // Gentle idle breathing
    const breathe = Math.sin(time * 1.5) * 0.02;
    this.bodyGroup.position.y += breathe * w;

    // Slight head look-around
    this.headGroup.rotation.y += Math.sin(time * 0.6) * 0.08 * w;
    this.headGroup.rotation.x -= 0.1 * w; // look slightly down
  }

  protected animateStun(time: number, weight: number): void {
    const w = weight;

    // Body sways in a wobbly circular pattern — barely keeping balance
    const swayX = Math.sin(time * 2.3) * 0.18 + Math.sin(time * 5.1) * 0.06;
    const swayZ = Math.cos(time * 1.9) * 0.15 + Math.cos(time * 4.3) * 0.05;
    this.bodyGroup.rotation.x += swayX * w;
    this.bodyGroup.rotation.z += swayZ * w;
    this.bodyGroup.position.y -= 0.06 * w; // slight crouch

    // Head lolls around loosely
    this.headGroup.rotation.x += (Math.sin(time * 3.1 + 1.0) * 0.25 + Math.sin(time * 6.7) * 0.08) * w;
    this.headGroup.rotation.z += (Math.cos(time * 2.7 + 0.5) * 0.3 + Math.cos(time * 5.9) * 0.1) * w;
    this.headGroup.rotation.y += Math.sin(time * 2.0) * 0.15 * w;

    // Arms hang limp and swing with body momentum
    this.leftArmGroup.rotation.x += Math.sin(time * 2.3 + 0.8) * 0.2 * w;
    this.leftArmGroup.rotation.z -= (0.25 + Math.sin(time * 1.7) * 0.15) * w;
    this.rightArmGroup.rotation.x += Math.sin(time * 2.3 - 0.8) * 0.2 * w;
    this.rightArmGroup.rotation.z += (0.25 + Math.cos(time * 1.7) * 0.15) * w;

    // Knees buckle — legs slightly bent and wobbly
    this.leftLegGroup.rotation.x += (0.15 + Math.sin(time * 3.5) * 0.08) * w;
    this.rightLegGroup.rotation.x += (0.15 + Math.cos(time * 3.5) * 0.08) * w;
    this.leftLegGroup.rotation.z -= 0.08 * w;
    this.rightLegGroup.rotation.z += 0.08 * w;
  }

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
