import * as THREE from 'three';
import { getCharacterStats, type CharacterId } from '@gtr/shared';
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
  readonly id: CharacterId;
  readonly displayName: string;
  readonly abilities: readonly (Ability | null)[];

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

  // Base stats (pulled from shared character definitions)
  readonly baseMaxHp: number;
  readonly baseMaxMana: number;
  readonly autoAttackDamageMin: number;
  readonly autoAttackDamageMax: number;
  readonly autoAttackSpeed: number; // seconds between swings
  readonly autoAttackRange: number;
  readonly critChance: number;  // 0–1
  readonly dodgeChance: number; // 0–1

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
  protected attackIsCrit = false; // current swing is a critical hit

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

  // Team flag (MP only)
  private flagCloth: THREE.Mesh | null = null;
  private flagTime = 0;

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

  // Dodge animation state
  private static readonly DODGE_DURATION = 0.35;
  protected dodgeTime = -1; // -1 = not playing
  private dodgeSide = 1; // 1 = lean right, -1 = lean left (alternates)

  // PvP Trinket burst particles + shockwave ring
  private trinketParticles: { mesh: THREE.Mesh; vel: THREE.Vector3; life: number; maxLife: number }[] = [];
  private trinketRing: THREE.Mesh | null = null;
  private trinketRingTime = -1;
  private trinketBurstSpawned = false;

  // Death animation
  private static readonly DEATH_DURATION = 1.5;
  protected deathTime = -1; // -1 = alive, >= 0 = seconds since death

  constructor(characterId: CharacterId) {
    const stats = getCharacterStats(characterId);
    this.id = stats.id;
    this.displayName = stats.displayName;
    this.abilities = stats.abilities;
    this.baseMaxHp = stats.baseMaxHp;
    this.baseMaxMana = stats.baseMaxMana;
    this.autoAttackDamageMin = stats.autoAttackDamageMin;
    this.autoAttackDamageMax = stats.autoAttackDamageMax;
    this.autoAttackSpeed = stats.autoAttackSpeed;
    this.autoAttackRange = stats.autoAttackRange;
    this.critChance = stats.critChance;
    this.dodgeChance = stats.dodgeChance;

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

  /** World-space position of the auto-attack target (set before triggerSwing for ranged characters). */
  swingTargetWorldPos: THREE.Vector3 | null = null;

  triggerSwing(isCrit = false): void {
    this.attackAnimTime = 0;
    this.attackIsCrit = isCrit;
  }

  protected abilityTargetPos: THREE.Vector3 | null = null;

  triggerAbilityAnimation(abilityId: string, targetWorldPos?: THREE.Vector3): void {
    this.abilityAnimTime = 0;
    this.abilityAnimId = abilityId;
    this.abilityTargetPos = targetWorldPos ?? null;
    // PvP Trinket breaks free — immediately clear stun animation so the burst anim can play
    if (abilityId === 'pvp-trinket') {
      this.stunActive = false;
      this.stunWeight = 0;
      this.stunTime = 0;
    }
  }

  triggerFlinch(): void {
    this.flinchTime = 0;
  }

  triggerDodge(): void {
    this.dodgeTime = 0;
    this.dodgeSide = -this.dodgeSide; // alternate sides
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
    this.bodyGroup.position.set(0, 0, 0);
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
      const swingDuration = this.attackIsCrit ? this.getCritSwingDuration() : this.getSwingDuration();
      const t = Math.min(1, this.attackAnimTime / swingDuration);
      if (this.attackIsCrit) {
        this.animateCritSwing(t, this.attackArmToggle);
      } else {
        this.animateAttackSwing(t, this.attackArmToggle);
      }
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

    // --- Dodge layer (additive, quick lateral lean) ---
    if (this.dodgeTime >= 0) {
      this.dodgeTime += dt;
      const t = Math.min(1, this.dodgeTime / CharacterModel.DODGE_DURATION);
      this.animateDodge(t, this.dodgeSide);
      if (t >= 1) {
        this.dodgeTime = -1;
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

    // Flag wave animation — layered wind ripple
    if (this.flagCloth) {
      this.flagTime += dt;
      const t = this.flagTime;
      const verts = this.flagCloth.geometry.attributes.position;
      const count = verts.count;
      for (let i = 0; i < count; i++) {
        const x = verts.getX(i);   // 0 at pole edge, ~0.6 at free tip
        const y = verts.getY(i);
        const pct = x / 0.6;       // 0–1 normalized distance from pole
        const pct2 = pct * pct;    // quadratic falloff — tip moves most
        // Primary travelling wave
        const wave1 = Math.sin(t * 8 + x * 10) * 0.06 * pct2;
        // Secondary faster ripple for turbulence
        const wave2 = Math.sin(t * 13 + x * 18 + y * 6) * 0.025 * pct2;
        // Slow broad billow
        const wave3 = Math.sin(t * 3 + x * 4) * 0.03 * pct;
        verts.setZ(i, wave1 + wave2 + wave3);
      }
      verts.needsUpdate = true;
    }

    // --- PvP Trinket burst particles ---
    this.updateTrinketParticles(dt);

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

  /** Attach a team-colored flag to the character's back (MP only). */
  addTeamFlag(team: number): void {
    const flagGroup = new THREE.Group();
    // Upper back, slightly behind center (model-local +Z = back)
    flagGroup.position.set(0.05, 1.05, 0.15);

    // Pole
    const poleGeo = new THREE.CylinderGeometry(0.018, 0.018, 1.0, 5);
    const pole = this.createMesh(poleGeo, 0x888888, { roughness: 0.4, metalness: 0.4 });
    pole.position.y = 0.5;
    flagGroup.add(pole);

    // Flag cloth — hangs from top of pole
    const flagColor = team === 0 ? 0xcc2222 : 0x2266dd;
    const clothGeo = new THREE.PlaneGeometry(0.6, 0.4, 12, 4);
    const cloth = this.createMesh(clothGeo, flagColor, {
      roughness: 0.9,
      side: THREE.DoubleSide,
    });
    // Shift pivot to left edge so it hangs from the pole
    clothGeo.translate(0.3, 0, 0);
    cloth.position.set(0, 0.85, 0);
    this.flagCloth = cloth;
    flagGroup.add(cloth);

    this.bodyGroup.add(flagGroup);
  }

  protected getSwingDuration(): number {
    return 0.4;
  }

  protected getCritSwingDuration(): number {
    return 0.5;
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

  /** Default crit auto-attack: exaggerated two-handed overhead slam. Subclasses can override. */
  protected animateCritSwing(t: number, _alternateArm: boolean): void {
    // Phases: wind-up (0–0.25), slam (0.25–0.5), recovery (0.5–1.0)
    const windUp = t < 0.25 ? t / 0.25 : 1;
    const slam = t < 0.25 ? 0 : t < 0.5 ? (t - 0.25) / 0.25 : 1;
    const recover = t < 0.5 ? 0 : (t - 0.5) / 0.5;
    const easeWindUp = windUp * windUp;
    const easeSlam = slam * slam * (3 - 2 * slam);
    const easeRecover = recover * recover * (3 - 2 * recover);

    // Wind-up: pull both arms back overhead, lean back
    const windUpFade = 1 - easeSlam;
    this.leftArmGroup.rotation.x -= 1.2 * easeWindUp * windUpFade;
    this.rightArmGroup.rotation.x -= 1.2 * easeWindUp * windUpFade;
    this.leftArmGroup.rotation.z -= 0.2 * easeWindUp * windUpFade;
    this.rightArmGroup.rotation.z += 0.2 * easeWindUp * windUpFade;
    this.bodyGroup.rotation.x -= 0.2 * easeWindUp * windUpFade;
    this.headGroup.rotation.x += 0.15 * easeWindUp * windUpFade;

    // Slam: arms crash forward, body lunges
    const slamFade = 1 - easeRecover;
    this.leftArmGroup.rotation.x += 1.8 * easeSlam * slamFade;
    this.rightArmGroup.rotation.x += 1.8 * easeSlam * slamFade;
    this.bodyGroup.rotation.x += 0.3 * easeSlam * slamFade;
    this.bodyGroup.position.y -= 0.1 * easeSlam * slamFade;
    this.headGroup.rotation.x += 0.1 * easeSlam * slamFade;

    // Legs brace on impact
    this.leftLegGroup.rotation.x += 0.15 * easeSlam * slamFade;
    this.rightLegGroup.rotation.x += 0.15 * easeSlam * slamFade;
  }

  /** Shared PvP Trinket animation — "break free" burst with particles + shockwave. */
  protected animatePvPTrinket(t: number): void {
    if (t < 0.15) {
      // Wind-up: body tenses hard, arms pull inward, crouch
      const p = t / 0.15;
      const ease = p * p;
      this.bodyGroup.position.y -= 0.18 * ease;
      this.bodyGroup.rotation.x += 0.25 * ease;
      this.leftArmGroup.rotation.x += 0.6 * ease;
      this.rightArmGroup.rotation.x += 0.6 * ease;
      this.leftArmGroup.rotation.z += 0.7 * ease;
      this.rightArmGroup.rotation.z -= 0.7 * ease;
      this.headGroup.rotation.x += 0.2 * ease;
      this.trinketBurstSpawned = false;
    } else if (t < 0.4) {
      // Burst: arms explode outward, body springs up hard
      const p = (t - 0.15) / 0.25;
      const ease = 1 - (1 - p) * (1 - p);
      this.bodyGroup.position.y -= 0.18 * (1 - ease) + (-0.08) * ease;
      this.bodyGroup.rotation.x += 0.25 * (1 - ease) + (-0.3) * ease;
      this.leftArmGroup.rotation.x += 0.6 * (1 - ease);
      this.rightArmGroup.rotation.x += 0.6 * (1 - ease);
      this.leftArmGroup.rotation.z += 0.7 * (1 - ease) + (-1.1) * ease;
      this.rightArmGroup.rotation.z -= 0.7 * (1 - ease) + (-1.1) * ease;
      this.headGroup.rotation.x += 0.2 * (1 - ease) + (-0.15) * ease;

      // Spawn burst particles + shockwave at the moment of breaking free
      if (!this.trinketBurstSpawned) {
        this.trinketBurstSpawned = true;
        this.spawnTrinketBurst();
      }
    } else {
      // Recovery: return to idle
      const p = (t - 0.4) / 0.6;
      const ease = p * p * (3 - 2 * p);
      const fade = 1 - ease;
      this.bodyGroup.position.y -= 0.08 * fade;
      this.bodyGroup.rotation.x -= 0.3 * fade;
      this.leftArmGroup.rotation.z -= 1.1 * fade;
      this.rightArmGroup.rotation.z += 1.1 * fade;
      this.headGroup.rotation.x -= 0.15 * fade;
    }
  }

  /** Spawn golden burst particles + expanding shockwave ring. */
  private spawnTrinketBurst(): void {
    const parent = this.group.parent;
    if (!parent) return;
    const scene = parent.parent;
    if (!scene) return;

    // Character world position
    const worldPos = new THREE.Vector3();
    parent.getWorldPosition(worldPos);
    const burstOrigin = worldPos.clone();
    burstOrigin.y += 1.0; // chest height

    // --- Shockwave ring ---
    const ringGeo = new THREE.RingGeometry(0.1, 0.3, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffd700,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.copy(burstOrigin);
    ring.rotation.x = -Math.PI / 2; // horizontal
    ring.renderOrder = 10;
    scene.add(ring);
    this.trinketRing = ring;
    this.trinketRingTime = 0;

    // --- Burst particles ---
    const count = 28;
    const particleGeo = new THREE.SphereGeometry(0.05, 6, 4);

    for (let i = 0; i < count; i++) {
      const colors = [0xffd700, 0xffec80, 0xffffff, 0xffa500, 0xffe066];
      const color = colors[Math.floor(Math.random() * colors.length)];
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 1.0,
      });
      const mesh = new THREE.Mesh(particleGeo, mat);
      mesh.position.copy(burstOrigin);

      // Random scale
      const s = 0.4 + Math.random() * 1.2;
      mesh.scale.setScalar(s);

      // Explode outward in a sphere
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = 3.0 + Math.random() * 4.0;
      const vel = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta) * speed,
        Math.sin(phi) * Math.sin(theta) * speed * 0.6 + 1.5, // bias upward
        Math.cos(phi) * speed,
      );

      const life = 0.4 + Math.random() * 0.5;
      scene.add(mesh);
      this.trinketParticles.push({ mesh, vel, life, maxLife: life });
    }
  }

  /** Update trinket burst particles and shockwave ring. */
  private updateTrinketParticles(dt: number): void {
    // Particles
    for (let i = this.trinketParticles.length - 1; i >= 0; i--) {
      const p = this.trinketParticles[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.mesh.parent?.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        this.trinketParticles.splice(i, 1);
        continue;
      }
      // Gravity + drag
      p.vel.y -= 6.0 * dt;
      p.vel.multiplyScalar(1 - 2.0 * dt); // drag
      p.mesh.position.addScaledVector(p.vel, dt);

      // Fade out + shrink
      const frac = p.life / p.maxLife;
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = frac;
      p.mesh.scale.setScalar(p.mesh.scale.x * (1 - 1.5 * dt));
    }

    // Shockwave ring
    if (this.trinketRing && this.trinketRingTime >= 0) {
      this.trinketRingTime += dt;
      const ringDur = 0.5;
      const t = this.trinketRingTime / ringDur;

      if (t >= 1) {
        this.trinketRing.parent?.remove(this.trinketRing);
        (this.trinketRing.material as THREE.Material).dispose();
        this.trinketRing.geometry.dispose();
        this.trinketRing = null;
        this.trinketRingTime = -1;
      } else {
        // Expand outward
        const scale = 1 + t * 12;
        this.trinketRing.scale.setScalar(scale);
        // Fade out
        (this.trinketRing.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t * t);
      }
    }
  }
  protected animateCasting(_abilityId: string, _t: number): void {}
  protected animateChanneling(abilityId: string, t: number): void {
    if (abilityId === 'bandage') this.animateBandageChannel(t);
  }

  /** Bandage channel: kneeling wrap motion with alternating arms */
  private animateBandageChannel(t: number): void {
    const blend = Math.min(1, t / 0.08);

    // Kneel down slightly
    this.bodyGroup.rotation.x += 0.25 * blend;

    // Alternating arm wrap motion (one cycle per second over 8 seconds)
    const cycle = (t * 8) % 1; // 0-1 per tick
    const wrap = Math.sin(cycle * Math.PI * 2);

    // Right arm wraps inward then outward
    this.rightArmGroup.rotation.x += 0.6 * blend;
    this.rightArmGroup.rotation.z += wrap * 0.3 * blend;

    // Left arm mirrors with opposite phase
    this.leftArmGroup.rotation.x += 0.6 * blend;
    this.leftArmGroup.rotation.z -= wrap * 0.3 * blend;

    // Subtle body sway
    this.bodyGroup.rotation.y += Math.sin(cycle * Math.PI) * 0.05 * blend;
  }

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

  protected animateDodge(t: number, side: number): void {
    // Quick lateral lean: sharp peak at ~25% then ease out
    const impact = t < 0.25 ? t / 0.25 : Math.max(0, 1 - (t - 0.25) / 0.75);
    const ease = impact * impact * (3 - 2 * impact); // smoothstep

    // Body leans sideways (away from attacker)
    this.bodyGroup.rotation.z += ease * 0.3 * side;
    // Slight backward lean
    this.bodyGroup.rotation.x -= ease * 0.1;

    // Head turns away
    this.headGroup.rotation.y += ease * 0.25 * side;
    this.headGroup.rotation.x -= ease * 0.1;

    // Lead arm raises defensively, trailing arm swings out
    if (side > 0) {
      // Leaning right: left arm up to guard, right arm trails
      this.leftArmGroup.rotation.x += ease * 0.4;
      this.leftArmGroup.rotation.z += ease * 0.3;
      this.rightArmGroup.rotation.z += ease * 0.4;
    } else {
      // Leaning left: right arm up to guard, left arm trails
      this.rightArmGroup.rotation.x += ease * 0.4;
      this.rightArmGroup.rotation.z -= ease * 0.3;
      this.leftArmGroup.rotation.z -= ease * 0.4;
    }

    // Legs: weight shifts to the side being leaned toward
    if (side > 0) {
      this.rightLegGroup.rotation.z += ease * 0.15;
      this.leftLegGroup.rotation.x += ease * 0.1;
    } else {
      this.leftLegGroup.rotation.z -= ease * 0.15;
      this.rightLegGroup.rotation.x += ease * 0.1;
    }
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
    this.bodyGroup.position.set(0, 0, 0);
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

  /** Set opacity on all meshes in the model (0 = invisible, 1 = fully opaque). */
  setOpacity(opacity: number): void {
    this.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const mat = child.material as THREE.MeshStandardMaterial;
        if (!mat || !mat.isMeshStandardMaterial) return;
        // Store original state on first call
        if ((mat as any)._baseOpacity === undefined) {
          (mat as any)._baseOpacity = mat.opacity;
          (mat as any)._baseTransparent = mat.transparent;
        }
        const baseOpacity = (mat as any)._baseOpacity as number;
        const wasTransparent = mat.transparent;
        mat.opacity = baseOpacity * opacity;
        mat.transparent = opacity < 1 || (mat as any)._baseTransparent;
        // Three.js needs a shader recompile when transparent changes
        if (mat.transparent !== wasTransparent) {
          mat.needsUpdate = true;
        }
        // Hide shadow when fully invisible
        child.castShadow = opacity > 0;
      }
    });
  }

  dispose(): void {
    // Clean up trinket particles
    for (const p of this.trinketParticles) {
      p.mesh.parent?.remove(p.mesh);
      (p.mesh.material as THREE.Material).dispose();
    }
    this.trinketParticles.length = 0;
    if (this.trinketRing) {
      this.trinketRing.parent?.remove(this.trinketRing);
      (this.trinketRing.material as THREE.Material).dispose();
      this.trinketRing.geometry.dispose();
      this.trinketRing = null;
    }

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
