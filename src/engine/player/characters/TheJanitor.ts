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
  readonly id = 'janitor';
  readonly displayName = 'The Janitor';
  readonly autoAttackDamage = 15;
  readonly autoAttackSpeed = 2.5;
  readonly autoAttackRange = 3;

  private declare mopHead: THREE.Mesh;
  private declare bucketWater: THREE.Mesh;

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

  private buildMop(): void {
    const mopGroup = new THREE.Group();

    // Handle — offset so the hand grips slightly above center
    const handle = this.createMesh(
      new THREE.CylinderGeometry(0.02, 0.02, 1.0, 8),
      MOP_HANDLE,
      { roughness: 0.8 },
    );
    handle.position.set(0, -0.10, 0);
    mopGroup.add(handle);

    // Mop head (flat sponge/rag block)
    this.mopHead = this.createMesh(
      new THREE.BoxGeometry(0.18, 0.05, 0.12),
      MOP_HEAD,
      { roughness: 1.0 },
    );
    this.mopHead.position.set(0, -0.62, 0);
    mopGroup.add(this.mopHead);

    // Hanging mop strings
    for (let i = 0; i < 5; i++) {
      const string = this.createMesh(
        new THREE.CylinderGeometry(0.007, 0.007, 0.08, 4),
        MOP_STRINGS,
        { roughness: 1.0 },
      );
      string.position.set((i - 2) * 0.035, -0.68, 0);
      mopGroup.add(string);
    }

    // Position at hand, rotate to near-horizontal with slight upward angle
    mopGroup.position.set(0, -0.50, 0);
    mopGroup.rotation.x = Math.PI / 2 + 0.15;
    this.rightArmGroup.add(mopGroup);
  }

  // ── Bucket (left hand) ────────────────────────────────

  private buildBucket(): void {
    // Body (tapered cylinder)
    const body = this.createMesh(
      new THREE.CylinderGeometry(0.10, 0.08, 0.18, 10),
      BUCKET_METAL,
      { roughness: 0.5, metalness: 0.4 },
    );
    body.position.set(0, -0.69, -0.05);
    this.leftArmGroup.add(body);

    // Rim
    const rim = this.createMesh(
      new THREE.TorusGeometry(0.10, 0.012, 6, 12),
      BUCKET_METAL,
      { roughness: 0.4, metalness: 0.5 },
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, -0.60, -0.05);
    this.leftArmGroup.add(rim);

    // Dirty water surface
    this.bucketWater = this.createMesh(
      new THREE.CylinderGeometry(0.09, 0.09, 0.02, 10),
      BUCKET_WATER,
      { roughness: 0.3 },
    );
    this.bucketWater.position.set(0, -0.62, -0.05);
    this.leftArmGroup.add(this.bucketWater);

    // Handle (half-torus arc over the top)
    const handle = this.createMesh(
      new THREE.TorusGeometry(0.10, 0.008, 4, 8, Math.PI),
      BUCKET_METAL,
      { roughness: 0.4, metalness: 0.5 },
    );
    handle.position.set(0, -0.60, -0.05);
    this.leftArmGroup.add(handle);
  }

  // ── Character-specific animation ──────────────────────

  protected onAnimate(_dt: number, _input: AnimationInput): void {
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
    }
  }

  protected override getSwingDuration(): number {
    return 0.5;
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
