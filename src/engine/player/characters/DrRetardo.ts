import * as THREE from 'three';
import { CharacterModel, AnimationInput } from './CharacterModel';
import type { Ability } from '../../combat/Ability';

const SKIN = 0xf0d6b8;
const LABCOAT = 0xf0f0f0;
const PANTS = 0x2d3748;
const SHOES = 0x1a1a2e;
const HAIR = 0xc0c0c0;
const GLASSES_FRAME = 0x444444;
const FLASK_LIQUID = 0x44ff44;
const FLASK_GLASS = 0xddffdd;
const TUBE_LIQUID = 0x9b59b6;
const TUBE_GLASS = 0xeeddff;
const CORK = 0x8b6914;

export class DrRetardo extends CharacterModel {
  readonly id = 'dr-retardo';
  readonly displayName = 'Dr. Retardo';
  readonly baseMaxHp = 369;
  readonly baseMaxMana = 125;
  readonly autoAttackDamageMin = 3;
  readonly autoAttackDamageMax = 6;
  readonly autoAttackSpeed = 1.2;
  readonly autoAttackRange = 1.8;
  readonly critChance = 0.07;
  readonly dodgeChance = 0.05;
  readonly abilities: readonly Ability[] = [];

  // Declared via declare to avoid useDefineForClassFields overwriting
  // values set during the parent constructor's buildModel() call.
  private declare flaskLight: THREE.PointLight;
  private declare flaskLiquid: THREE.Mesh;
  private declare hairMeshes: THREE.Mesh[];
  private declare bubbles: THREE.Mesh[];
  private declare gasWisps: THREE.Mesh[];

  protected buildModel(): void {
    this.hairMeshes = [];
    this.bubbles = [];
    this.gasWisps = [];
    // Lanky build with oversized coat — wider arm spread to clear bulk
    this.leftArmGroup.position.set(-0.30, 1.28, 0);
    this.rightArmGroup.position.set(0.30, 1.28, 0);

    this.buildHead();
    this.buildTorso();
    this.buildArms();
    this.buildLegs();
    this.buildFlask();
    this.buildTestTube();
  }

  // ── Head ───────────────────────────────────────────────

  private buildHead(): void {
    const head = this.createMesh(new THREE.SphereGeometry(0.16, 12, 10), SKIN);
    head.position.set(0, 0.16, 0);
    this.headGroup.add(head);

    // Pointy nose
    const nose = this.createMesh(
      new THREE.SphereGeometry(0.025, 6, 6),
      SKIN,
    );
    nose.position.set(0, 0.14, -0.16);
    nose.scale.set(0.8, 0.7, 1.3);
    this.headGroup.add(nose);

    // Wild Einstein hair — cluster of puffy spheres
    const hairGeo = new THREE.SphereGeometry(0.09, 8, 6);
    const positions: [number, number, number][] = [
      [0, 0.30, 0],
      [-0.14, 0.25, 0],
      [0.14, 0.25, 0],
      [-0.10, 0.28, -0.06],
      [0.10, 0.28, -0.06],
      [0, 0.24, 0.12],
      [-0.10, 0.22, 0.10],
      [0.10, 0.22, 0.10],
      [-0.17, 0.20, 0.04],
      [0.17, 0.20, 0.04],
    ];
    const hairScales: [number, number, number][] = [
      [1.1, 0.9, 1.1],
      [0.8, 0.7, 0.7],
      [0.9, 0.8, 0.7],
      [0.7, 0.8, 0.6],
      [0.7, 0.9, 0.6],
      [0.9, 0.6, 0.8],
      [0.6, 0.5, 0.6],
      [0.6, 0.5, 0.6],
      [0.7, 0.6, 0.5],
      [0.7, 0.7, 0.5],
    ];

    for (let i = 0; i < positions.length; i++) {
      const hair = this.createMesh(hairGeo, HAIR, { roughness: 0.9 });
      hair.position.set(...positions[i]);
      hair.scale.set(...hairScales[i]);
      hair.userData.baseY = positions[i][1];
      this.headGroup.add(hair);
      this.hairMeshes.push(hair);
    }

    // Glasses frames (torus rings)
    const frameGeo = new THREE.TorusGeometry(0.045, 0.005, 6, 16);
    const leftFrame = this.createMesh(frameGeo, GLASSES_FRAME, {
      metalness: 0.5,
      roughness: 0.3,
    });
    leftFrame.position.set(-0.055, 0.17, -0.155);
    this.headGroup.add(leftFrame);

    const rightFrame = this.createMesh(frameGeo, GLASSES_FRAME, {
      metalness: 0.5,
      roughness: 0.3,
    });
    rightFrame.position.set(0.055, 0.17, -0.155);
    this.headGroup.add(rightFrame);

    // Bridge
    const bridge = this.createMesh(
      new THREE.BoxGeometry(0.04, 0.008, 0.008),
      GLASSES_FRAME,
      { metalness: 0.5 },
    );
    bridge.position.set(0, 0.19, -0.155);
    this.headGroup.add(bridge);

    // Tinted lenses
    const lensGeo = new THREE.CircleGeometry(0.04, 12);
    const leftLens = this.createMesh(lensGeo, 0x88bbee, {
      transparent: true,
      opacity: 0.25,
    });
    leftLens.position.set(-0.055, 0.17, -0.156);
    this.headGroup.add(leftLens);

    const rightLens = this.createMesh(lensGeo, 0x88bbee, {
      transparent: true,
      opacity: 0.25,
    });
    rightLens.position.set(0.055, 0.17, -0.156);
    this.headGroup.add(rightLens);

    // Eyes behind glasses
    const eyeGeo = new THREE.SphereGeometry(0.022, 6, 6);
    const leftEye = this.createMesh(eyeGeo, 0x222222);
    leftEye.position.set(-0.055, 0.17, -0.145);
    this.headGroup.add(leftEye);

    const rightEye = this.createMesh(eyeGeo, 0x222222);
    rightEye.position.set(0.055, 0.17, -0.145);
    this.headGroup.add(rightEye);

    // Crooked grin
    const mouth = this.createMesh(
      new THREE.BoxGeometry(0.07, 0.012, 0.01),
      0x993333,
    );
    mouth.position.set(0.01, 0.07, -0.15);
    mouth.rotation.z = 0.15;
    this.headGroup.add(mouth);
  }

  // ── Torso ──────────────────────────────────────────────

  private buildTorso(): void {
    // Oversized lab coat — wider and longer than body
    const coat = this.createMesh(
      new THREE.BoxGeometry(0.52, 0.52, 0.28),
      LABCOAT,
      { roughness: 0.6 },
    );
    coat.position.set(0, 1.06, 0);
    this.bodyGroup.add(coat);

    // Coat lower flap extends below waist
    const coatLower = this.createMesh(
      new THREE.BoxGeometry(0.54, 0.22, 0.30),
      LABCOAT,
      { roughness: 0.6 },
    );
    coatLower.position.set(0, 0.72, 0);
    this.bodyGroup.add(coatLower);

    // Raised collar
    const collar = this.createMesh(
      new THREE.BoxGeometry(0.36, 0.10, 0.24),
      LABCOAT,
      { roughness: 0.5 },
    );
    collar.position.set(0, 1.36, 0);
    this.bodyGroup.add(collar);

    // Coat buttons
    for (let i = 0; i < 3; i++) {
      const button = this.createMesh(
        new THREE.SphereGeometry(0.015, 6, 6),
        0x333333,
      );
      button.position.set(0, 1.18 - i * 0.12, -0.145);
      this.bodyGroup.add(button);
    }

    // Breast pocket
    const pocket = this.createMesh(
      new THREE.BoxGeometry(0.07, 0.06, 0.01),
      0xe0e0e0,
    );
    pocket.position.set(-0.14, 1.18, -0.145);
    this.bodyGroup.add(pocket);

    // Pen in pocket
    const pen = this.createMesh(
      new THREE.CylinderGeometry(0.006, 0.006, 0.08, 4),
      0x2244aa,
    );
    pen.position.set(-0.14, 1.24, -0.15);
    pen.rotation.z = 0.1;
    this.bodyGroup.add(pen);

    // Pen clip
    const clip = this.createMesh(
      new THREE.BoxGeometry(0.003, 0.04, 0.008),
      0xcccccc,
      { metalness: 0.5 },
    );
    clip.position.set(-0.135, 1.25, -0.155);
    this.bodyGroup.add(clip);
  }

  // ── Arms ───────────────────────────────────────────────

  private buildArms(): void {
    // Oversized coat sleeves — shortened so hands are visible
    const sleeveGeo = new THREE.CapsuleGeometry(0.09, 0.22, 6, 8);

    const leftSleeve = this.createMesh(sleeveGeo, LABCOAT, { roughness: 0.6 });
    leftSleeve.position.set(0, -0.22, 0);
    this.leftArmGroup.add(leftSleeve);

    const rightSleeve = this.createMesh(sleeveGeo, LABCOAT, {
      roughness: 0.6,
    });
    rightSleeve.position.set(0, -0.22, 0);
    this.rightArmGroup.add(rightSleeve);

    // Thin hands poking out of big sleeves
    const handGeo = new THREE.SphereGeometry(0.04, 6, 6);

    const leftHand = this.createMesh(handGeo, SKIN);
    leftHand.position.set(0, -0.50, 0);
    this.leftArmGroup.add(leftHand);

    const rightHand = this.createMesh(handGeo, SKIN);
    rightHand.position.set(0, -0.50, 0);
    this.rightArmGroup.add(rightHand);
  }

  // ── Legs ───────────────────────────────────────────────

  private buildLegs(): void {
    const legGeo = new THREE.CapsuleGeometry(0.065, 0.50, 6, 8);

    const leftLeg = this.createMesh(legGeo, PANTS);
    leftLeg.position.set(0, -0.37, 0);
    this.leftLegGroup.add(leftLeg);

    const rightLeg = this.createMesh(legGeo, PANTS);
    rightLeg.position.set(0, -0.37, 0);
    this.rightLegGroup.add(rightLeg);

    // Dress shoes
    const shoeGeo = new THREE.BoxGeometry(0.10, 0.06, 0.16);

    const leftShoe = this.createMesh(shoeGeo, SHOES, {
      roughness: 0.4,
      metalness: 0.2,
    });
    leftShoe.position.set(0, -0.74, -0.02);
    this.leftLegGroup.add(leftShoe);

    const rightShoe = this.createMesh(shoeGeo, SHOES, {
      roughness: 0.4,
      metalness: 0.2,
    });
    rightShoe.position.set(0, -0.74, -0.02);
    this.rightLegGroup.add(rightShoe);
  }

  // ── Flask (left hand) ─────────────────────────────────

  private buildFlask(): void {
    const flaskGroup = new THREE.Group();

    // Erlenmeyer flask body (cone — wide bottom, narrow top)
    const flaskBody = this.createMesh(
      new THREE.ConeGeometry(0.09, 0.21, 8),
      FLASK_GLASS,
      { transparent: true, opacity: 0.3, roughness: 0.1, depthWrite: false },
    );
    flaskBody.position.set(0, -0.06, 0);
    flaskBody.renderOrder = 1;
    flaskGroup.add(flaskBody);

    // Flask neck
    const neck = this.createMesh(
      new THREE.CylinderGeometry(0.022, 0.03, 0.08, 8),
      FLASK_GLASS,
      { transparent: true, opacity: 0.3, roughness: 0.1, depthWrite: false },
    );
    neck.position.set(0, 0.08, 0);
    neck.renderOrder = 1;
    flaskGroup.add(neck);

    // Glowing liquid — fills most of the flask
    this.flaskLiquid = this.createMesh(
      new THREE.ConeGeometry(0.085, 0.19, 8),
      FLASK_LIQUID,
      {
        emissive: 0x33dd33,
        emissiveIntensity: 1.2,
        transparent: true,
        opacity: 0.85,
      },
    );
    this.flaskLiquid.position.set(0, -0.06, 0);
    flaskGroup.add(this.flaskLiquid);

    // Liquid filling the neck
    const neckLiquid = this.createMesh(
      new THREE.CylinderGeometry(0.018, 0.022, 0.05, 8),
      FLASK_LIQUID,
      {
        emissive: 0x33dd33,
        emissiveIntensity: 1.2,
        transparent: true,
        opacity: 0.85,
      },
    );
    neckLiquid.position.set(0, 0.06, 0);
    flaskGroup.add(neckLiquid);

    // Point light for green glow — tighter range to avoid lighting the sleeve
    this.flaskLight = new THREE.PointLight(0x44ff44, 0.6, 0.5);
    this.flaskLight.position.set(0, -0.06, 0);
    flaskGroup.add(this.flaskLight);

    // Position at hand, opening faces forward, bottom points behind
    flaskGroup.position.set(0, -0.50, 0);
    flaskGroup.rotation.z = 0.4;
    flaskGroup.rotation.x = -1.4;
    this.leftArmGroup.add(flaskGroup);
  }

  // ── Test tube (right hand) ────────────────────────────

  private buildTestTube(): void {
    const tubeGroup = new THREE.Group();

    // Glass tube
    const tube = this.createMesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.21, 8),
      TUBE_GLASS,
      { transparent: true, opacity: 0.3, roughness: 0.1 },
    );
    tube.position.set(0, -0.04, 0);
    tubeGroup.add(tube);

    // Rounded bottom
    const bottom = this.createMesh(
      new THREE.SphereGeometry(0.03, 8, 6),
      TUBE_GLASS,
      { transparent: true, opacity: 0.3, roughness: 0.1 },
    );
    bottom.position.set(0, -0.145, 0);
    tubeGroup.add(bottom);

    // Purple liquid inside
    const liquid = this.createMesh(
      new THREE.CylinderGeometry(0.024, 0.024, 0.15, 8),
      TUBE_LIQUID,
      {
        emissive: 0x6633aa,
        emissiveIntensity: 0.4,
        transparent: true,
        opacity: 0.6,
      },
    );
    liquid.position.set(0, -0.05, 0);
    tubeGroup.add(liquid);

    // Bubbles rising inside the tube
    for (let i = 0; i < 8; i++) {
      const radius = 0.006 + Math.random() * 0.012;
      const bubble = this.createMesh(
        new THREE.SphereGeometry(radius, 6, 6),
        0xddccff,
        { transparent: true, opacity: 0.6 },
      );
      const baseY = -0.12 + i * 0.03;
      bubble.position.set(0, baseY, 0);
      bubble.userData.baseY = baseY;
      bubble.userData.speed = 0.8 + Math.random() * 0.6;
      bubble.userData.xOffset = (Math.random() - 0.5) * 0.02;
      tubeGroup.add(bubble);
      this.bubbles.push(bubble);
    }

    // Foam / overflow bubbles spilling out the top
    for (let i = 0; i < 6; i++) {
      const radius = 0.01 + Math.random() * 0.015;
      const bubble = this.createMesh(
        new THREE.SphereGeometry(radius, 6, 6),
        0xeeddff,
        {
          transparent: true,
          opacity: 0.5,
          emissive: 0x6633aa,
          emissiveIntensity: 0.3,
        },
      );
      const baseY = 0.06 + i * 0.025;
      bubble.position.set(0, baseY, 0);
      bubble.userData.baseY = baseY;
      bubble.userData.speed = 0.5 + Math.random() * 0.8;
      bubble.userData.xOffset = (Math.random() - 0.5) * 0.04;
      bubble.userData.zOffset = (Math.random() - 0.5) * 0.04;
      tubeGroup.add(bubble);
      this.bubbles.push(bubble);
    }

    // Gas wisps escaping above the tube
    for (let i = 0; i < 5; i++) {
      const wisp = this.createMesh(
        new THREE.SphereGeometry(0.02 + Math.random() * 0.015, 6, 6),
        TUBE_LIQUID,
        { transparent: true, opacity: 0.25 },
      );
      const baseY = 0.14 + i * 0.04;
      wisp.position.set(0, baseY, 0);
      wisp.userData.baseY = baseY;
      wisp.userData.xDrift = (Math.random() - 0.5) * 2;
      wisp.userData.zDrift = (Math.random() - 0.5) * 2;
      tubeGroup.add(wisp);
      this.gasWisps.push(wisp);
    }

    // Position at hand, opening faces forward, bottom points behind
    tubeGroup.position.set(0, -0.50, 0);
    tubeGroup.rotation.z = -0.4;
    tubeGroup.rotation.x = -1.4;
    this.rightArmGroup.add(tubeGroup);
  }

  // ── Character-specific animation ──────────────────────

  protected onAnimate(_dt: number, _input: AnimationInput): void {
    // Angle arms outward slightly to clear the bulky coat
    this.leftArmGroup.rotation.z -= 0.2;
    this.rightArmGroup.rotation.z += 0.2;

    // Flask glow pulse
    if (this.flaskLight) {
      this.flaskLight.intensity = 0.5 + Math.sin(this.idleTime * 3) * 0.2;
    }
    if (this.flaskLiquid) {
      (
        this.flaskLiquid.material as THREE.MeshStandardMaterial
      ).emissiveIntensity = 1.0 + Math.sin(this.idleTime * 3) * 0.4;
    }

    // Test tube bubbles — rapid rising with wobble
    for (let i = 0; i < this.bubbles.length; i++) {
      const bubble = this.bubbles[i];
      const speed = bubble.userData.speed ?? 1;
      const period = 1.2 / speed;
      const t = ((this.idleTime * speed + i * 0.3) % period) / period;
      bubble.position.y = bubble.userData.baseY + t * 0.15;
      bubble.position.x =
        (bubble.userData.xOffset ?? 0) +
        Math.sin(this.idleTime * 6 + i * 2.1) * 0.012;
      bubble.position.z =
        (bubble.userData.zOffset ?? 0) +
        Math.cos(this.idleTime * 5 + i * 1.7) * 0.012;
      const pop = Math.sin(t * Math.PI);
      bubble.scale.setScalar(0.4 + pop * 1.0);
      (bubble.material as THREE.MeshStandardMaterial).opacity = pop * 0.7;
    }

    // Gas wisps — chaotic drift upward and outward
    for (let i = 0; i < this.gasWisps.length; i++) {
      const wisp = this.gasWisps[i];
      const t = ((this.idleTime * 0.9 + i * 1.1) % 2.5) / 2.5;
      wisp.position.y = wisp.userData.baseY + t * 0.12;
      const xDrift = wisp.userData.xDrift ?? 0;
      const zDrift = wisp.userData.zDrift ?? 0;
      wisp.position.x =
        Math.sin(this.idleTime * 2.5 + i * 1.3) * 0.03 + t * xDrift * 0.03;
      wisp.position.z =
        Math.cos(this.idleTime * 2.0 + i * 1.7) * 0.03 + t * zDrift * 0.03;
      (wisp.material as THREE.MeshStandardMaterial).opacity = (1 - t) * 0.35;
      wisp.scale.setScalar(0.6 + t * 1.0);
    }

    // Hair bounces during movement
    for (let i = 0; i < this.hairMeshes.length; i++) {
      const hair = this.hairMeshes[i];
      hair.position.y =
        hair.userData.baseY +
        Math.sin(this.runPhase * 1.2 + i * 0.8) * 0.012 * this.runWeight;
    }
  }

  protected override getSwingDuration(): number {
    return 0.35;
  }

  protected override animateCombatStance(weight: number): void {
    // Legs spread wider, uncoordinated stance
    this.leftLegGroup.rotation.z -= 0.2 * weight;
    this.rightLegGroup.rotation.z += 0.18 * weight;
    this.leftLegGroup.rotation.x += 0.05 * weight;
    this.rightLegGroup.rotation.x += 0.08 * weight;

    // Arms flailing in the air
    this.leftArmGroup.rotation.x -= 0.9 * weight;
    this.rightArmGroup.rotation.x -= 0.9 * weight;
    this.leftArmGroup.rotation.z -= 0.3 * weight;
    this.rightArmGroup.rotation.z += 0.3 * weight;

    // Chaotic flailing motion
    const flailTime = this.idleTime * 4;
    this.leftArmGroup.rotation.x += Math.sin(flailTime) * 0.2 * weight;
    this.leftArmGroup.rotation.z += Math.cos(flailTime * 1.3) * 0.15 * weight;
    this.rightArmGroup.rotation.x += Math.sin(flailTime * 1.1 + 2) * 0.2 * weight;
    this.rightArmGroup.rotation.z += Math.cos(flailTime * 0.9 + 1) * 0.15 * weight;

    // Body sways side to side
    this.bodyGroup.rotation.z += Math.sin(this.idleTime * 1.8) * 0.04 * weight;
    this.bodyGroup.rotation.y += Math.sin(this.idleTime * 1.2) * 0.05 * weight;
  }

  protected override animateAttackSwing(t: number, alternateArm: boolean): void {
    // Bonk: swing one arm down, alternating each attack
    const armGroup = alternateArm ? this.leftArmGroup : this.rightArmGroup;
    const zSign = alternateArm ? -1 : 1;

    let armX: number;
    let armZ: number;

    if (t < 0.2) {
      // Quick wind up
      const p = t / 0.2;
      armX = -0.3 * p;
      armZ = 0;
    } else if (t < 0.5) {
      // Bonk down
      const p = (t - 0.2) / 0.3;
      const ease = 1 - Math.pow(1 - p, 3);
      armX = -0.3 + 2.0 * ease;
      armZ = -zSign * 0.3 * ease;
    } else {
      // Recovery
      const p = (t - 0.5) / 0.5;
      const ease = p * p * (3 - 2 * p);
      armX = 1.7 * (1 - ease);
      armZ = -zSign * 0.3 * (1 - ease);
    }

    armGroup.rotation.x += armX;
    armGroup.rotation.z += armZ;
  }

  protected override animateDeath(t: number): void {
    super.animateDeath(t);

    const fall = t < 0.15 ? 0 : Math.min(1, (t - 0.15) / 0.55);
    const fallEase = 1 - Math.pow(1 - fall, 2);

    // Flask glow fades out
    if (this.flaskLight) {
      this.flaskLight.intensity = 0.5 * (1 - fallEase);
    }
    if (this.flaskLiquid) {
      (this.flaskLiquid.material as THREE.MeshStandardMaterial).emissiveIntensity =
        1.0 * (1 - fallEase);
    }

    // Hair droops downward
    for (let i = 0; i < this.hairMeshes.length; i++) {
      const hair = this.hairMeshes[i];
      hair.position.y = hair.userData.baseY - fallEase * 0.04;
    }

    // Glasses tilt
    this.headGroup.rotation.z += fallEase * 0.3;
  }
}
