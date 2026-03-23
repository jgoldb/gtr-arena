import * as THREE from 'three';
import { CharacterModel, AnimationInput } from './CharacterModel';

const SKIN = 0xb8896e;
const OVERALLS = 0x4a5568;
const SHIRT = 0x8a9aaf;
const BOOTS = 0x3d2b1f;
const CAP = 0x374151;
const MOP_HANDLE = 0x8b6914;
const MOP_HEAD = 0x8a8a7a;
const MOP_STRINGS = 0x7a7a6a;
const BUCKET_METAL = 0x6b7280;
const BUCKET_WATER = 0x6b8e23;
const BELT = 0x5c4033;

export class TheJanitor extends CharacterModel {
  constructor() { super('janitor'); }

  private declare mopHead: THREE.Mesh;
  private declare mopGroup: THREE.Group;
  private declare bucketWater: THREE.Mesh;
  private declare bucketGroup: THREE.Group;

  // Splash particle state
  private static readonly SPLASH_DROPLET_COUNT = 12;
  private static readonly SPLASH_FLIGHT_DURATION = 0.5;
  private declare splashDroplets: THREE.Mesh[];
  private declare splashVelocities: THREE.Vector3[];
  private declare splashMaterial: THREE.MeshStandardMaterial;
  private declare splashActive: boolean;
  private declare splashTime: number;
  private declare splashLaunched: boolean;
  private declare splashBucketTilt: number;

  // Crash Out visual state
  private crashOutActive = false;
  private crashOutWeight = 0;

  protected buildModel(): void {
    // Stocky build — wider shoulders
    this.leftArmGroup.position.set(-0.28, 1.26, 0);
    this.rightArmGroup.position.set(0.28, 1.26, 0);

    this.buildHead();
    this.buildTorso();
    this.buildArms();
    this.buildLegs();
    this.buildMop();
    this.buildBucket();
    this.buildSplashDroplets();
  }

  // ── Head ───────────────────────────────────────────────

  private buildHead(): void {
    const head = this.createMesh(new THREE.SphereGeometry(0.16, 12, 10), SKIN);
    head.position.set(0, 0.16, 0);
    this.headGroup.add(head);

    // Nose
    const nose = this.createMesh(
      new THREE.SphereGeometry(0.035, 6, 6),
      SKIN,
    );
    nose.position.set(0, 0.14, -0.15);
    nose.scale.set(1, 0.8, 1.1);
    this.headGroup.add(nose);

    // Flat cap
    const capBrim = this.createMesh(
      new THREE.CylinderGeometry(0.19, 0.19, 0.02, 12),
      CAP,
    );
    capBrim.position.set(0, 0.28, -0.02);
    this.headGroup.add(capBrim);

    const capTop = this.createMesh(
      new THREE.CylinderGeometry(0.12, 0.17, 0.06, 12),
      CAP,
    );
    capTop.position.set(0, 0.32, 0.01);
    this.headGroup.add(capTop);

    // Eyes
    const eyeGeo = new THREE.SphereGeometry(0.025, 6, 6);
    const leftEye = this.createMesh(eyeGeo, 0x222222);
    leftEye.position.set(-0.06, 0.18, -0.14);
    this.headGroup.add(leftEye);

    const rightEye = this.createMesh(eyeGeo, 0x222222);
    rightEye.position.set(0.06, 0.18, -0.14);
    this.headGroup.add(rightEye);

    // Stubble shadow on chin
    const stubble = this.createMesh(
      new THREE.SphereGeometry(0.08, 8, 6),
      0x9a7a60,
      { roughness: 1.0 },
    );
    stubble.scale.set(1, 0.4, 0.8);
    stubble.position.set(0, 0.05, -0.09);
    this.headGroup.add(stubble);
  }

  // ── Torso ──────────────────────────────────────────────

  private buildTorso(): void {
    // Overalls body
    const torso = this.createMesh(
      new THREE.BoxGeometry(0.44, 0.48, 0.26),
      OVERALLS,
      { roughness: 0.9 },
    );
    torso.position.set(0, 1.06, 0);
    this.bodyGroup.add(torso);

    // Shirt collar visible at neckline
    const collar = this.createMesh(
      new THREE.BoxGeometry(0.30, 0.08, 0.20),
      SHIRT,
    );
    collar.position.set(0, 1.33, 0);
    this.bodyGroup.add(collar);

    // Overall straps
    const strapGeo = new THREE.BoxGeometry(0.06, 0.20, 0.04);
    for (const side of [-1, 1]) {
      const strap = this.createMesh(strapGeo, OVERALLS, { roughness: 0.9 });
      strap.position.set(side * 0.10, 1.30, -0.10);
      strap.rotation.x = 0.15;
      this.bodyGroup.add(strap);
    }

    // Belt
    const belt = this.createMesh(
      new THREE.BoxGeometry(0.46, 0.05, 0.27),
      BELT,
    );
    belt.position.set(0, 0.83, 0);
    this.bodyGroup.add(belt);

    // Belt buckle
    const buckle = this.createMesh(
      new THREE.BoxGeometry(0.06, 0.04, 0.02),
      0xb8860b,
      { metalness: 0.6, roughness: 0.3 },
    );
    buckle.position.set(0, 0.83, -0.145);
    this.bodyGroup.add(buckle);

    // Chest pocket
    const pocket = this.createMesh(
      new THREE.BoxGeometry(0.08, 0.07, 0.01),
      0x3d4a5c,
    );
    pocket.position.set(0.10, 1.14, -0.135);
    this.bodyGroup.add(pocket);

    // Dirt stains
    const stainGeo = new THREE.BoxGeometry(0.07, 0.06, 0.01);
    const stain1 = this.createMesh(stainGeo, 0x3a4550, { roughness: 1.0 });
    stain1.position.set(-0.12, 1.00, -0.135);
    this.bodyGroup.add(stain1);

    const stain2 = this.createMesh(stainGeo, 0x3e4854, { roughness: 1.0 });
    stain2.position.set(0.05, 0.90, -0.135);
    stain2.rotation.z = 0.3;
    this.bodyGroup.add(stain2);
  }

  // ── Arms ───────────────────────────────────────────────

  private buildArms(): void {
    const armGeo = new THREE.CapsuleGeometry(0.07, 0.36, 6, 8);

    const leftArm = this.createMesh(armGeo, SHIRT);
    leftArm.position.set(0, -0.26, 0);
    this.leftArmGroup.add(leftArm);

    const rightArm = this.createMesh(armGeo, SHIRT);
    rightArm.position.set(0, -0.26, 0);
    this.rightArmGroup.add(rightArm);

    // Hands
    const handGeo = new THREE.SphereGeometry(0.055, 6, 6);

    const leftHand = this.createMesh(handGeo, SKIN);
    leftHand.position.set(0, -0.50, 0);
    this.leftArmGroup.add(leftHand);

    const rightHand = this.createMesh(handGeo, SKIN);
    rightHand.position.set(0, -0.50, 0);
    this.rightArmGroup.add(rightHand);
  }

  // ── Legs ───────────────────────────────────────────────

  private buildLegs(): void {
    const legGeo = new THREE.CapsuleGeometry(0.08, 0.50, 6, 8);

    const leftLeg = this.createMesh(legGeo, OVERALLS, { roughness: 0.9 });
    leftLeg.position.set(0, -0.37, 0);
    this.leftLegGroup.add(leftLeg);

    const rightLeg = this.createMesh(legGeo, OVERALLS, { roughness: 0.9 });
    rightLeg.position.set(0, -0.37, 0);
    this.rightLegGroup.add(rightLeg);

    // Work boots
    const bootGeo = new THREE.BoxGeometry(0.13, 0.10, 0.17);

    const leftBoot = this.createMesh(bootGeo, BOOTS, { roughness: 0.9 });
    leftBoot.position.set(0, -0.72, -0.02);
    this.leftLegGroup.add(leftBoot);

    const rightBoot = this.createMesh(bootGeo, BOOTS, { roughness: 0.9 });
    rightBoot.position.set(0, -0.72, -0.02);
    this.rightLegGroup.add(rightBoot);
  }

  // ── Mop (right hand) ──────────────────────────────────

  private static readonly MOP_BASE_ROT_X = Math.PI / 2 + 0.15;

  private buildMop(): void {
    this.mopGroup = new THREE.Group();

    // Handle — offset so the hand grips slightly above center
    const handle = this.createMesh(
      new THREE.CylinderGeometry(0.02, 0.02, 1.0, 8),
      MOP_HANDLE,
      { roughness: 0.8 },
    );
    handle.position.set(0, -0.10, 0);
    this.mopGroup.add(handle);

    // Mop head (flat sponge/rag block)
    this.mopHead = this.createMesh(
      new THREE.BoxGeometry(0.18, 0.05, 0.12),
      MOP_HEAD,
      { roughness: 1.0 },
    );
    this.mopHead.position.set(0, -0.62, 0);
    this.mopGroup.add(this.mopHead);

    // Hanging mop strings
    for (let i = 0; i < 5; i++) {
      const string = this.createMesh(
        new THREE.CylinderGeometry(0.007, 0.007, 0.08, 4),
        MOP_STRINGS,
        { roughness: 1.0 },
      );
      string.position.set((i - 2) * 0.035, -0.68, 0);
      this.mopGroup.add(string);
    }

    // Position at hand, rotate to near-horizontal with slight upward angle
    this.mopGroup.position.set(0, -0.50, 0);
    this.mopGroup.rotation.x = TheJanitor.MOP_BASE_ROT_X;
    this.rightArmGroup.add(this.mopGroup);
  }

  // ── Bucket (left hand) ────────────────────────────────

  private buildBucket(): void {
    this.bucketGroup = new THREE.Group();

    // Body (tapered cylinder)
    const body = this.createMesh(
      new THREE.CylinderGeometry(0.10, 0.08, 0.18, 10),
      BUCKET_METAL,
      { roughness: 0.5, metalness: 0.4 },
    );
    body.position.set(0, -0.69, -0.05);
    this.bucketGroup.add(body);

    // Rim
    const rim = this.createMesh(
      new THREE.TorusGeometry(0.10, 0.012, 6, 12),
      BUCKET_METAL,
      { roughness: 0.4, metalness: 0.5 },
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, -0.60, -0.05);
    this.bucketGroup.add(rim);

    // Dirty water surface
    this.bucketWater = this.createMesh(
      new THREE.CylinderGeometry(0.09, 0.09, 0.02, 10),
      BUCKET_WATER,
      { roughness: 0.3 },
    );
    this.bucketWater.position.set(0, -0.62, -0.05);
    this.bucketGroup.add(this.bucketWater);

    // Handle (half-torus arc over the top)
    const handle = this.createMesh(
      new THREE.TorusGeometry(0.10, 0.008, 4, 8, Math.PI),
      BUCKET_METAL,
      { roughness: 0.4, metalness: 0.5 },
    );
    handle.position.set(0, -0.60, -0.05);
    this.bucketGroup.add(handle);

    this.leftArmGroup.add(this.bucketGroup);
  }

  // ── Splash droplets (water spray particles) ────────────

  private buildSplashDroplets(): void {
    this.splashDroplets = [];
    this.splashVelocities = [];
    this.splashActive = false;
    this.splashTime = 0;
    this.splashLaunched = false;
    this.splashBucketTilt = 0;

    const geo = new THREE.SphereGeometry(0.03, 4, 4);
    this.splashMaterial = new THREE.MeshStandardMaterial({
      color: BUCKET_WATER,
      roughness: 0.3,
      metalness: 0.1,
      transparent: true,
      opacity: 0.85,
    });

    for (let i = 0; i < TheJanitor.SPLASH_DROPLET_COUNT; i++) {
      const droplet = new THREE.Mesh(geo, this.splashMaterial);
      droplet.castShadow = false;
      droplet.visible = false;
      this.group.add(droplet);
      this.splashDroplets.push(droplet);
      this.splashVelocities.push(new THREE.Vector3());
    }
  }

  private launchSplashDroplets(): void {
    this.splashLaunched = true;
    this.splashActive = true;
    this.splashTime = 0;

    // Get bucket position in group-local space
    this.bucketWater.updateWorldMatrix(true, false);
    const worldPos = new THREE.Vector3();
    this.bucketWater.getWorldPosition(worldPos);
    this.group.worldToLocal(worldPos);

    for (let i = 0; i < TheJanitor.SPLASH_DROPLET_COUNT; i++) {
      const droplet = this.splashDroplets[i];
      droplet.visible = true;
      droplet.scale.setScalar(0.6 + Math.random() * 0.8);
      droplet.position.copy(worldPos);

      // Forward is -Z in group-local space; spray with random spread
      const spreadH = (Math.random() - 0.5) * 1.0;
      const speedFwd = 3.0 + Math.random() * 2.5;
      const speedUp = 0.5 + Math.random() * 2.5;
      this.splashVelocities[i].set(
        Math.sin(spreadH) * speedFwd,
        speedUp,
        -Math.cos(spreadH) * speedFwd
      );
    }

    this.splashMaterial.opacity = 0.85;
  }

  // ── Character-specific animation ──────────────────────

  protected override onAnimate(dt: number, _input: AnimationInput): void {
    // Mop head wobble
    if (this.mopHead) {
      this.mopHead.rotation.z = Math.sin(this.idleTime * 3) * 0.05;
    }

    // Bucket water slosh (stronger when running)
    if (this.bucketWater) {
      const intensity = 0.3 + this.runWeight * 0.7;
      this.bucketWater.rotation.x =
        Math.sin(this.idleTime * 2.5 + 1) * 0.08 * intensity;
      this.bucketWater.rotation.z =
        Math.cos(this.idleTime * 2.0) * 0.06 * intensity;
      // Add splash pour tilt
      this.bucketWater.rotation.x += this.splashBucketTilt;
      this.splashBucketTilt = 0;
    }

    // Update splash droplets
    if (this.splashActive) {
      this.splashTime += dt;
      const life = this.splashTime / TheJanitor.SPLASH_FLIGHT_DURATION;

      for (let i = 0; i < this.splashDroplets.length; i++) {
        const d = this.splashDroplets[i];
        if (!d.visible) continue;
        d.position.addScaledVector(this.splashVelocities[i], dt);
        this.splashVelocities[i].y -= 8 * dt;
      }

      this.splashMaterial.opacity = 0.85 * Math.max(0, 1 - life);

      if (life >= 1) {
        this.splashActive = false;
        for (const d of this.splashDroplets) d.visible = false;
      }
    }

    // Crash Out visual: scale up + red tint
    const wantCrash = this.crashOutActive ? 1 : 0;
    this.crashOutWeight += (wantCrash - this.crashOutWeight) * Math.min(1, 8 * dt);
    if (this.crashOutWeight < 0.001 && !this.crashOutActive) this.crashOutWeight = 0;

    this.group.scale.setScalar(1 + this.crashOutWeight * 0.25);
    const r = this.crashOutWeight * 0.35;
    this.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        (child.material as THREE.MeshStandardMaterial).emissive.setRGB(r, 0, 0);
      }
    });
  }

  override setAbilityBuffActive(buffId: string, active: boolean): void {
    if (buffId === 'crash-out') {
      this.crashOutActive = active;
    }
  }

  protected override getSwingDuration(): number {
    return 0.5;
  }

  protected override getAbilityAnimDuration(abilityId: string): number {
    if (abilityId === 'mop') return 0.5;
    if (abilityId === 'big-boot') return 0.55;
    if (abilityId === 'fart-bomb') return 0.6;
    if (abilityId === 'sweep') return 1.0;
    return 0.6; // bucket-splash default
  }

  protected override animateAbilityUse(abilityId: string, t: number): void {
    if (abilityId === 'bucket-splash') {
      this.animateBucketSplash(t);
    } else if (abilityId === 'mop') {
      this.animateMopStrike(t);
    } else if (abilityId === 'big-boot') {
      this.animateBigBoot(t);
    } else if (abilityId === 'fart-bomb') {
      this.animateFartBomb(t);
    } else if (abilityId === 'crash-out') {
      this.animateCrashOut(t);
    } else if (abilityId === 'sweep') {
      this.animateSweep(t);
    }
  }

  private animateBucketSplash(t: number): void {
    let leftArmX: number;
    let leftArmZ: number;
    let bodyRotY: number;
    let bodyRotX: number;
    let bodyY: number;
    let bucketTilt: number;

    if (t < 0.20) {
      // Wind up: pull bucket back, coil body
      this.splashLaunched = false;
      const p = t / 0.20;
      const ease = p * p;
      leftArmX = -0.4 * ease;
      leftArmZ = 0.15 * ease;
      bodyRotY = 0.15 * ease;
      bodyRotX = -0.05 * ease;
      bodyY = 0;
      bucketTilt = 0;
    } else if (t < 0.45) {
      // Thrust: arm swings forward, bucket tips to pour
      const p = (t - 0.20) / 0.25;
      const ease = 1 - Math.pow(1 - p, 3);
      leftArmX = -0.4 + 1.9 * ease;
      leftArmZ = 0.15 - 0.25 * ease;
      bodyRotY = 0.15 - 0.35 * ease;
      bodyRotX = -0.05 + 0.20 * ease;
      bodyY = -0.03 * ease;
      bucketTilt = 1.2 * ease;

      // Launch droplets at peak thrust
      if (!this.splashLaunched && p > 0.6) {
        this.launchSplashDroplets();
      }
    } else {
      // Recovery: return to normal
      const p = (t - 0.45) / 0.55;
      const ease = p * p * (3 - 2 * p);
      leftArmX = 1.5 * (1 - ease);
      leftArmZ = -0.1 * (1 - ease);
      bodyRotY = -0.2 * (1 - ease);
      bodyRotX = 0.15 * (1 - ease);
      bodyY = -0.03 * (1 - ease);
      bucketTilt = 1.2 * (1 - ease);
    }

    this.leftArmGroup.rotation.x += leftArmX;
    this.leftArmGroup.rotation.z += leftArmZ;
    this.bodyGroup.rotation.y += bodyRotY;
    this.bodyGroup.rotation.x += bodyRotX;
    this.bodyGroup.position.y += bodyY;
    this.splashBucketTilt = bucketTilt;
  }

  private animateMopStrike(t: number): void {
    let rightArmX: number;
    let rightArmZ: number;
    let bodyRotX: number;
    let bodyRotY: number;
    let bodyY: number;

    if (t < 0.30) {
      // Wind up: raise mop high overhead
      const p = t / 0.30;
      const ease = p * p;
      rightArmX = -2.2 * ease;
      rightArmZ = 0.2 * ease;
      bodyRotX = -0.1 * ease;
      bodyRotY = -0.1 * ease;
      bodyY = 0.02 * ease;
    } else if (t < 0.55) {
      // Strike: slam mop down
      const p = (t - 0.30) / 0.25;
      const ease = 1 - Math.pow(1 - p, 3);
      rightArmX = -2.2 + 4.0 * ease;
      rightArmZ = 0.2 * (1 - ease);
      bodyRotX = -0.1 + 0.35 * ease;
      bodyRotY = -0.1 + 0.25 * ease;
      bodyY = 0.02 - 0.07 * ease;
    } else {
      // Recovery: return to normal
      const p = (t - 0.55) / 0.45;
      const ease = p * p * (3 - 2 * p);
      rightArmX = 1.8 * (1 - ease);
      rightArmZ = 0;
      bodyRotX = 0.25 * (1 - ease);
      bodyRotY = 0.15 * (1 - ease);
      bodyY = -0.05 * (1 - ease);
    }

    this.rightArmGroup.rotation.x += rightArmX;
    this.rightArmGroup.rotation.z += rightArmZ;
    this.bodyGroup.rotation.x += bodyRotX;
    this.bodyGroup.rotation.y += bodyRotY;
    this.bodyGroup.position.y += bodyY;
  }

  private animateBigBoot(t: number): void {
    let rightLegX: number;
    let bodyRotX: number;
    let bodyY: number;
    let leftLegX: number;
    let armSpread: number;

    if (t < 0.25) {
      // Wind up: shift weight back, raise right leg
      const p = t / 0.25;
      const ease = p * p;
      rightLegX = -0.6 * ease;
      leftLegX = 0.15 * ease;
      bodyRotX = -0.12 * ease;
      bodyY = -0.03 * ease;
      armSpread = 0.2 * ease;
    } else if (t < 0.50) {
      // Kick: thrust right leg forward hard
      const p = (t - 0.25) / 0.25;
      const ease = 1 - Math.pow(1 - p, 3);
      rightLegX = -0.6 + 2.2 * ease;
      leftLegX = 0.15 + 0.05 * ease;
      bodyRotX = -0.12 + 0.30 * ease;
      bodyY = -0.03 - 0.02 * ease;
      armSpread = 0.2 + 0.3 * ease;
    } else {
      // Recovery: return to standing
      const p = (t - 0.50) / 0.50;
      const ease = p * p * (3 - 2 * p);
      rightLegX = 1.6 * (1 - ease);
      leftLegX = 0.2 * (1 - ease);
      bodyRotX = 0.18 * (1 - ease);
      bodyY = -0.05 * (1 - ease);
      armSpread = 0.5 * (1 - ease);
    }

    this.rightLegGroup.rotation.x += rightLegX;
    this.leftLegGroup.rotation.x += leftLegX;
    this.bodyGroup.rotation.x += bodyRotX;
    this.bodyGroup.position.y += bodyY;
    this.leftArmGroup.rotation.z -= armSpread;
    this.rightArmGroup.rotation.z += armSpread;
  }

  private animateFartBomb(t: number): void {
    let bodyY: number;
    let bodyRotX: number;
    let legBend: number;
    let armTense: number;

    if (t < 0.30) {
      // Crouch down — tense up
      const p = t / 0.30;
      const ease = p * p;
      bodyY = -0.10 * ease;
      bodyRotX = 0.15 * ease;
      legBend = 0.3 * ease;
      armTense = -0.15 * ease;
    } else if (t < 0.50) {
      // Hold / release — slight jolt
      const p = (t - 0.30) / 0.20;
      const ease = 1 - Math.pow(1 - p, 3);
      bodyY = -0.10 + 0.04 * ease;
      bodyRotX = 0.15 - 0.08 * ease;
      legBend = 0.3 + 0.05 * ease;
      armTense = -0.15 - 0.1 * ease;
    } else {
      // Spring back up
      const p = (t - 0.50) / 0.50;
      const ease = p * p * (3 - 2 * p);
      bodyY = -0.06 * (1 - ease);
      bodyRotX = 0.07 * (1 - ease);
      legBend = 0.35 * (1 - ease);
      armTense = -0.25 * (1 - ease);
    }

    this.bodyGroup.position.y += bodyY;
    this.bodyGroup.rotation.x += bodyRotX;
    this.leftLegGroup.rotation.x += legBend;
    this.rightLegGroup.rotation.x += legBend;
    this.leftArmGroup.rotation.z += armTense;
    this.rightArmGroup.rotation.z -= armTense;
  }

  private animateCrashOut(t: number): void {
    let armSpreadZ: number;
    let headTiltX: number;
    let bodyY: number;

    if (t < 0.40) {
      // Tense up: arms pull in, body crouches
      const p = t / 0.40;
      const ease = p * p;
      armSpreadZ = -0.2 * ease;
      headTiltX = 0.15 * ease;
      bodyY = -0.05 * ease;
    } else if (t < 0.70) {
      // Explode: arms thrust wide, head tilts back, body rises
      const p = (t - 0.40) / 0.30;
      const ease = 1 - Math.pow(1 - p, 3);
      armSpreadZ = -0.2 + 1.0 * ease;
      headTiltX = 0.15 - 0.55 * ease;
      bodyY = -0.05 + 0.11 * ease;
    } else {
      // Settle
      const p = (t - 0.70) / 0.30;
      const ease = p * p * (3 - 2 * p);
      armSpreadZ = 0.8 * (1 - ease);
      headTiltX = -0.4 * (1 - ease);
      bodyY = 0.06 * (1 - ease);
    }

    this.leftArmGroup.rotation.z -= armSpreadZ;
    this.rightArmGroup.rotation.z += armSpreadZ;
    this.headGroup.rotation.x += headTiltX;
    this.bodyGroup.position.y += bodyY;
  }

  private animateSweep(t: number): void {
    // Mop rotation: transition from default (forward) to horizontal (sideways)
    const baseRotX = TheJanitor.MOP_BASE_ROT_X;
    const horizRotX = 0;           // remove forward tilt
    const horizRotZ = -Math.PI / 2; // swing handle from Y-axis to X-axis (horizontal)

    let leftArmX: number;
    let rightArmX: number;
    let leftArmZ: number;
    let rightArmZ: number;
    let bodyRotX: number;
    let bodyY: number;
    let mopBlend: number; // 0 = default, 1 = horizontal

    if (t < 0.08) {
      // Quick wind-up: tuck bucket away, bring both arms forward to grip mop
      const p = t / 0.08;
      const ease = p * p;
      leftArmX = 1.4 * ease;    // Left arm forward
      rightArmX = 0.8 * ease;   // Right arm forward
      leftArmZ = 0.3 * ease;    // Pull left arm inward
      rightArmZ = -0.15 * ease; // Pull right arm inward
      bodyRotX = 0.25 * ease;   // Lean forward
      bodyY = -0.04 * ease;     // Slight crouch
      mopBlend = ease;
      this.bucketGroup.visible = ease < 0.5;
    } else if (t < 0.88) {
      // Full charge: both arms extended, mop horizontal between hands
      leftArmX = 1.4;
      rightArmX = 0.8;
      leftArmZ = 0.3;
      rightArmZ = -0.15;
      bodyRotX = 0.25;
      bodyY = -0.04;
      mopBlend = 1;
      this.bucketGroup.visible = false;
    } else {
      // Recovery: return to normal, unsheath bucket
      const p = (t - 0.88) / 0.12;
      const ease = p * p * (3 - 2 * p);
      leftArmX = 1.4 * (1 - ease);
      rightArmX = 0.8 * (1 - ease);
      leftArmZ = 0.3 * (1 - ease);
      rightArmZ = -0.15 * (1 - ease);
      bodyRotX = 0.25 * (1 - ease);
      bodyY = -0.04 * (1 - ease);
      mopBlend = 1 - ease;
      this.bucketGroup.visible = ease > 0.5;
    }

    this.leftArmGroup.rotation.x += leftArmX;
    this.rightArmGroup.rotation.x += rightArmX;
    this.leftArmGroup.rotation.z += leftArmZ;
    this.rightArmGroup.rotation.z += rightArmZ;
    this.bodyGroup.rotation.x += bodyRotX;
    this.bodyGroup.position.y += bodyY;

    // Blend mop rotation from default pose to horizontal two-handed grip
    this.mopGroup.rotation.x = baseRotX + (horizRotX - baseRotX) * mopBlend;
    this.mopGroup.rotation.z = horizRotZ * mopBlend;
  }

  protected override animateCombatStance(weight: number): void {
    // Legs into fighting stance — spread apart, slight bend
    this.leftLegGroup.rotation.z -= 0.15 * weight;
    this.rightLegGroup.rotation.z += 0.15 * weight;
    this.leftLegGroup.rotation.x += 0.12 * weight;
    this.rightLegGroup.rotation.x += 0.12 * weight;

    // Right arm raises mop ready to strike
    this.rightArmGroup.rotation.x -= 1.0 * weight;
    this.rightArmGroup.rotation.z += 0.15 * weight;

    // Left arm holds bucket forward slightly
    this.leftArmGroup.rotation.x += 0.3 * weight;
    this.leftArmGroup.rotation.z -= 0.1 * weight;

    // Body slight crouch
    this.bodyGroup.position.y -= 0.04 * weight;

    // Sway back and forth
    const sway = Math.sin(this.idleTime * 1.5);
    this.bodyGroup.rotation.y += sway * 0.06 * weight;
    this.rightArmGroup.rotation.x += Math.sin(this.idleTime * 2) * 0.08 * weight;
  }

  protected override animateAttackSwing(t: number, _alternateArm: boolean): void {
    // Thrust mop down and forward
    let armX: number;
    let bodyX: number;
    let bodyY: number;

    if (t < 0.25) {
      // Wind up: pull mop back
      const p = t / 0.25;
      const ease = p * p;
      armX = -0.4 * ease;
      bodyX = -0.06 * ease;
      bodyY = 0;
    } else if (t < 0.55) {
      // Strike: thrust forward and down
      const p = (t - 0.25) / 0.3;
      const ease = 1 - Math.pow(1 - p, 3);
      armX = -0.4 + 2.2 * ease;
      bodyX = -0.06 + 0.22 * ease;
      bodyY = -0.03 * ease;
    } else {
      // Recovery: return to combat stance
      const p = (t - 0.55) / 0.45;
      const ease = p * p * (3 - 2 * p);
      armX = 1.8 * (1 - ease);
      bodyX = 0.16 * (1 - ease);
      bodyY = -0.03 * (1 - ease);
    }

    this.rightArmGroup.rotation.x += armX;
    this.bodyGroup.rotation.x += bodyX;
    this.bodyGroup.position.y += bodyY;
  }

  override startDeath(): void {
    super.startDeath();
    this.splashActive = false;
    this.splashBucketTilt = 0;
    this.bucketGroup.visible = true;
    this.mopGroup.rotation.x = TheJanitor.MOP_BASE_ROT_X;
    this.mopGroup.rotation.z = 0;
    for (const d of this.splashDroplets) d.visible = false;
    // Reset crash out visual
    this.crashOutActive = false;
    this.crashOutWeight = 0;
    this.group.scale.setScalar(1);
    this.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        (child.material as THREE.MeshStandardMaterial).emissive.setRGB(0, 0, 0);
      }
    });
  }

  protected override animateResting(time: number, weight: number): void {
    super.animateResting(time, weight);

    // Mop laid across the lap
    if (this.mopHead) {
      this.mopHead.rotation.z = 0.4 * weight;
      this.mopHead.rotation.x = 0.1 * weight;
    }

    // Bucket set down beside — tilt slightly
    if (this.bucketWater) {
      this.bucketWater.rotation.x = Math.sin(time * 0.8) * 0.02 * weight;
    }
  }

  protected override animateStun(time: number, weight: number): void {
    super.animateStun(time, weight);

    // Mop droops and sways limply
    if (this.mopHead) {
      this.mopHead.rotation.z = Math.sin(time * 1.8) * 0.3 * weight;
      this.mopHead.rotation.x = 0.2 * weight;
    }
  }

  protected override animateDeath(t: number): void {
    super.animateDeath(t);

    const fall = t < 0.15 ? 0 : Math.min(1, (t - 0.15) / 0.55);
    const fallEase = 1 - Math.pow(1 - fall, 2);

    // Cap tips off the head
    this.headGroup.rotation.z += fallEase * 0.4;

    // Mop head droops
    if (this.mopHead) {
      this.mopHead.rotation.z = fallEase * 0.6;
    }

    // Bucket water spills
    if (this.bucketWater) {
      this.bucketWater.rotation.x = fallEase * 0.8;
    }
  }
}
