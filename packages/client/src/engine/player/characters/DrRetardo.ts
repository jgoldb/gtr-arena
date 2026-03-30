import * as THREE from 'three';
import { CharacterModel, AnimationInput } from './CharacterModel';

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
  constructor() { super('dr-retardo'); }

  // Declared via declare to avoid useDefineForClassFields overwriting
  // values set during the parent constructor's buildModel() call.
  private declare flaskLight: THREE.PointLight;
  private declare flaskLiquid: THREE.Mesh;
  private declare hairMeshes: THREE.Mesh[];
  private declare bubbles: THREE.Mesh[];
  private declare gasWisps: THREE.Mesh[];

  // ── Bottle Chuck projectile ──────────────────────────
  private static readonly FLIGHT_DURATION = 0.55;
  private static readonly SPLASH_COUNT = 10;
  private static readonly SPLASH_DURATION = 0.4;
  private static readonly REGEN_DURATION = 0.3;

  private declare tubeGroup: THREE.Group;
  private declare projectileTube: THREE.Group;
  private declare projectileVelocity: THREE.Vector3;
  private declare projectileActive: boolean;
  private declare projectileTime: number;
  private declare projectileLaunched: boolean;
  private declare splashDroplets: THREE.Mesh[];
  private declare splashVelocities: THREE.Vector3[];
  private declare splashMaterial: THREE.MeshStandardMaterial;
  private declare splashActive: boolean;
  private declare splashTime: number;
  private declare tubeRegenTime: number;
  private chudmaxChannelActive = false;
  private retardStrengthActive = false;
  private retardStrengthWeight = 0;
  private fullRetardActive = false;
  private fullRetardWeight = 0;

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
    this.buildProjectile();
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
    this.tubeGroup = tubeGroup;
    this.rightArmGroup.add(tubeGroup);
  }

  // ── Bottle Chuck projectile ──────────────────────────

  private buildProjectile(): void {
    this.projectileActive = false;
    this.projectileLaunched = false;
    this.projectileTime = 0;
    this.splashActive = false;
    this.splashTime = 0;
    this.tubeRegenTime = -1;
    this.projectileVelocity = new THREE.Vector3();

    // Projectile tube (simplified version of the hand-held tube)
    this.projectileTube = new THREE.Group();

    const glassMat = new THREE.MeshStandardMaterial({
      color: TUBE_GLASS,
      transparent: true,
      opacity: 0.4,
      roughness: 0.1,
    });
    const liquidMat = new THREE.MeshStandardMaterial({
      color: TUBE_LIQUID,
      emissive: 0x6633aa,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.7,
    });

    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.18, 6),
      glassMat,
    );
    this.projectileTube.add(glass);

    const bottom = new THREE.Mesh(
      new THREE.SphereGeometry(0.025, 6, 4),
      glassMat,
    );
    bottom.position.y = -0.09;
    this.projectileTube.add(bottom);

    const liquid = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 0.13, 6),
      liquidMat,
    );
    this.projectileTube.add(liquid);

    this.projectileTube.visible = false;

    // Splash droplets for impact
    this.splashDroplets = [];
    this.splashVelocities = [];
    const splashGeo = new THREE.SphereGeometry(0.025, 4, 4);
    this.splashMaterial = new THREE.MeshStandardMaterial({
      color: TUBE_LIQUID,
      emissive: 0x6633aa,
      emissiveIntensity: 0.3,
      roughness: 0.3,
      transparent: true,
      opacity: 0.8,
    });

    for (let i = 0; i < DrRetardo.SPLASH_COUNT; i++) {
      const droplet = new THREE.Mesh(splashGeo, this.splashMaterial);
      droplet.castShadow = false;
      droplet.visible = false;
      this.splashDroplets.push(droplet);
      this.splashVelocities.push(new THREE.Vector3());
    }
  }

  private launchProjectile(): void {
    this.projectileLaunched = true;
    this.projectileActive = true;
    this.projectileTime = 0;

    // Hide the tube in hand
    this.tubeGroup.visible = false;

    // Lazy-add projectile & splash to the scene so they fly in world space
    // (not affected by player movement). Hierarchy: group → mesh → scene.
    if (!this.projectileTube.parent) {
      const scene = this.group.parent!.parent!;
      scene.add(this.projectileTube);
      for (const d of this.splashDroplets) scene.add(d);
    }

    // Get tube world position as the launch origin
    this.tubeGroup.updateWorldMatrix(true, false);
    const startPos = new THREE.Vector3();
    this.tubeGroup.getWorldPosition(startPos);

    this.projectileTube.position.copy(startPos);
    this.projectileTube.rotation.set(0, 0, 0);
    this.projectileTube.visible = true;
    this.projectileTube.scale.setScalar(1);

    // Calculate velocity to arc toward the target position (world space)
    const dur = DrRetardo.FLIGHT_DURATION;
    const gravity = 16;

    if (this.abilityTargetPos) {
      this.projectileVelocity.set(
        (this.abilityTargetPos.x - startPos.x) / dur,
        (this.abilityTargetPos.y - startPos.y) / dur + 0.5 * gravity * dur,
        (this.abilityTargetPos.z - startPos.z) / dur,
      );
    } else {
      // Fallback: throw in the character's forward direction
      const quat = new THREE.Quaternion();
      this.group.getWorldQuaternion(quat);
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
      this.projectileVelocity.set(forward.x * 10, 3.5, forward.z * 10);
    }
  }

  private triggerSplash(): void {
    this.splashActive = true;
    this.splashTime = 0;

    const impactPos = this.projectileTube.position.clone();

    for (let i = 0; i < DrRetardo.SPLASH_COUNT; i++) {
      const d = this.splashDroplets[i];
      d.visible = true;
      d.scale.setScalar(0.5 + Math.random() * 0.8);
      d.position.copy(impactPos);

      // Scatter outward in a ring
      const angle =
        (i / DrRetardo.SPLASH_COUNT) * Math.PI * 2 + Math.random() * 0.5;
      const speed = 2 + Math.random() * 3;
      const upSpeed = 1 + Math.random() * 2.5;
      this.splashVelocities[i].set(
        Math.cos(angle) * speed,
        upSpeed,
        Math.sin(angle) * speed,
      );
    }

    this.splashMaterial.opacity = 0.8;
  }

  // ── Character-specific animation ──────────────────────

  protected onAnimate(dt: number, _input: AnimationInput): void {
    // Restore tube visibility when not channeling Chudmax
    if (this.tubeGroup && !this.tubeGroup.visible &&
        !this.chudmaxChannelActive && this.tubeRegenTime < 0 && !this.projectileActive) {
      this.tubeGroup.visible = true;
      this.tubeGroup.scale.setScalar(1);
    }
    this.chudmaxChannelActive = false; // reset per-frame flag

    // ── Retard Strength buff visual ────────────────────────
    const rsTarget = this.retardStrengthActive ? 1 : 0;
    const rsSpeed = 6;
    this.retardStrengthWeight += (rsTarget - this.retardStrengthWeight) * Math.min(1, dt * rsSpeed);
    if (this.retardStrengthWeight > 0.01) {
      const w = this.retardStrengthWeight;
      // Slightly grow in size
      const scale = 1 + 0.12 * w;
      this.group.scale.setScalar(scale);

      // Pulsate a radioactive green glow
      const pulse = 0.5 + Math.sin(this.idleTime * 8) * 0.5; // 0-1 pulsating
      const glow = w * (0.3 + pulse * 0.4);
      this.group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          const mat = child.material as THREE.MeshStandardMaterial;
          if (mat.emissive) {
            // Store original emissive to restore later
            if (mat.userData.rsOrigEmissiveR === undefined) {
              // If FR already stored true originals, copy from there
              if (mat.userData.frOrigEmissiveR !== undefined) {
                mat.userData.rsOrigEmissiveR = mat.userData.frOrigEmissiveR;
                mat.userData.rsOrigEmissiveG = mat.userData.frOrigEmissiveG;
                mat.userData.rsOrigEmissiveB = mat.userData.frOrigEmissiveB;
                mat.userData.rsOrigEmissiveIntensity = mat.userData.frOrigEmissiveIntensity;
              } else {
                mat.userData.rsOrigEmissiveR = mat.emissive.r;
                mat.userData.rsOrigEmissiveG = mat.emissive.g;
                mat.userData.rsOrigEmissiveB = mat.emissive.b;
                mat.userData.rsOrigEmissiveIntensity = mat.emissiveIntensity;
              }
            }
            // Blend toward radioactive green
            mat.emissive.r = mat.userData.rsOrigEmissiveR * (1 - w) + 0.2 * w;
            mat.emissive.g = mat.userData.rsOrigEmissiveG * (1 - w) + 0.9 * w;
            mat.emissive.b = mat.userData.rsOrigEmissiveB * (1 - w) + 0.1 * w;
            mat.emissiveIntensity = mat.userData.rsOrigEmissiveIntensity + glow;
          }
        }
      });
    } else if (this.retardStrengthWeight <= 0.01 && this.retardStrengthWeight > 0) {
      // Restore original emissives
      this.retardStrengthWeight = 0;
      this.group.scale.setScalar(1);
      this.group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          const mat = child.material as THREE.MeshStandardMaterial;
          if (mat.userData.rsOrigEmissiveR !== undefined) {
            mat.emissive.setRGB(
              mat.userData.rsOrigEmissiveR,
              mat.userData.rsOrigEmissiveG,
              mat.userData.rsOrigEmissiveB
            );
            mat.emissiveIntensity = mat.userData.rsOrigEmissiveIntensity;
            delete mat.userData.rsOrigEmissiveR;
            delete mat.userData.rsOrigEmissiveG;
            delete mat.userData.rsOrigEmissiveB;
            delete mat.userData.rsOrigEmissiveIntensity;
          }
        }
      });
    }

    // ── Full Retard buff visual ────────────────────────────
    const frTarget = this.fullRetardActive ? 1 : 0;
    const frSpeed = 6;
    this.fullRetardWeight += (frTarget - this.fullRetardWeight) * Math.min(1, dt * frSpeed);
    if (this.fullRetardWeight > 0.01) {
      const w = this.fullRetardWeight;

      // Pulsate a noxious yellow-brown glow
      const pulse = 0.5 + Math.sin(this.idleTime * 6) * 0.5;
      const glow = w * (0.3 + pulse * 0.5);
      this.group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          const mat = child.material as THREE.MeshStandardMaterial;
          if (mat.emissive) {
            // Store originals for restoration
            if (mat.userData.frOrigEmissiveR === undefined) {
              // If RS already stored true originals, copy from there
              if (mat.userData.rsOrigEmissiveR !== undefined) {
                mat.userData.frOrigEmissiveR = mat.userData.rsOrigEmissiveR;
                mat.userData.frOrigEmissiveG = mat.userData.rsOrigEmissiveG;
                mat.userData.frOrigEmissiveB = mat.userData.rsOrigEmissiveB;
                mat.userData.frOrigEmissiveIntensity = mat.userData.rsOrigEmissiveIntensity;
              } else {
                mat.userData.frOrigEmissiveR = mat.emissive.r;
                mat.userData.frOrigEmissiveG = mat.emissive.g;
                mat.userData.frOrigEmissiveB = mat.emissive.b;
                mat.userData.frOrigEmissiveIntensity = mat.emissiveIntensity;
              }
            }
            // Blend toward noxious yellow-brown
            mat.emissive.r = mat.userData.frOrigEmissiveR * (1 - w) + 0.7 * w;
            mat.emissive.g = mat.userData.frOrigEmissiveG * (1 - w) + 0.6 * w;
            mat.emissive.b = mat.userData.frOrigEmissiveB * (1 - w) + 0.05 * w;
            mat.emissiveIntensity = mat.userData.frOrigEmissiveIntensity + glow;
          }
        }
      });
    } else if (this.fullRetardWeight <= 0.01 && this.fullRetardWeight > 0) {
      // Restore original emissives
      this.fullRetardWeight = 0;
      this.group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          const mat = child.material as THREE.MeshStandardMaterial;
          if (mat.userData.frOrigEmissiveR !== undefined) {
            mat.emissive.setRGB(
              mat.userData.frOrigEmissiveR,
              mat.userData.frOrigEmissiveG,
              mat.userData.frOrigEmissiveB
            );
            mat.emissiveIntensity = mat.userData.frOrigEmissiveIntensity;
            delete mat.userData.frOrigEmissiveR;
            delete mat.userData.frOrigEmissiveG;
            delete mat.userData.frOrigEmissiveB;
            delete mat.userData.frOrigEmissiveIntensity;
          }
        }
      });
    }

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

    // ── Bottle Chuck projectile update ────────────────────
    if (this.projectileActive) {
      this.projectileTime += dt;
      this.projectileTube.position.addScaledVector(this.projectileVelocity, dt);
      this.projectileVelocity.y -= 16 * dt;
      this.projectileTube.rotation.x += 8 * dt;
      this.projectileTube.rotation.z += 3 * dt;

      if (this.projectileTime >= DrRetardo.FLIGHT_DURATION) {
        this.projectileActive = false;
        this.projectileTube.visible = false;
        this.triggerSplash();
        this.tubeRegenTime = 0;
      }
    }

    if (this.splashActive) {
      this.splashTime += dt;
      const splashLife = this.splashTime / DrRetardo.SPLASH_DURATION;

      for (let i = 0; i < this.splashDroplets.length; i++) {
        const d = this.splashDroplets[i];
        if (!d.visible) continue;
        d.position.addScaledVector(this.splashVelocities[i], dt);
        this.splashVelocities[i].y -= 10 * dt;
      }

      this.splashMaterial.opacity = 0.8 * Math.max(0, 1 - splashLife);

      if (splashLife >= 1) {
        this.splashActive = false;
        for (const d of this.splashDroplets) d.visible = false;
      }
    }

    if (this.tubeRegenTime >= 0) {
      this.tubeRegenTime += dt;
      const regenP = Math.min(1, this.tubeRegenTime / DrRetardo.REGEN_DURATION);
      if (!this.tubeGroup.visible) this.tubeGroup.visible = true;
      this.tubeGroup.scale.setScalar(1 - Math.pow(1 - regenP, 3));
      if (regenP >= 1) {
        this.tubeGroup.scale.setScalar(1);
        this.tubeRegenTime = -1;
      }
    }
  }

  protected override animateResting(time: number, weight: number): void {
    super.animateResting(time, weight);

    // Hair settles down
    for (let i = 0; i < this.hairMeshes.length; i++) {
      const hair = this.hairMeshes[i];
      hair.position.y = hair.userData.baseY -
        0.01 * weight + Math.sin(time * 0.5 + i) * 0.005 * weight;
    }

    // Flask dims to a gentle glow — relaxed state
    if (this.flaskLiquid) {
      (this.flaskLiquid.material as THREE.MeshStandardMaterial).emissiveIntensity =
        0.2 + Math.sin(time * 1.0) * 0.1 * weight;
    }
    if (this.flaskLight) {
      this.flaskLight.intensity = 0.1 + Math.sin(time * 1.0) * 0.05 * weight;
    }
  }

  protected override animateStun(time: number, weight: number): void {
    super.animateStun(time, weight);

    // Hair flops around wildly
    for (let i = 0; i < this.hairMeshes.length; i++) {
      const hair = this.hairMeshes[i];
      hair.position.y = hair.userData.baseY +
        Math.sin(time * 2.5 + i * 1.2) * 0.03 * weight;
    }

    // Flask swings erratically — liquid sloshes
    if (this.flaskLiquid) {
      (this.flaskLiquid.material as THREE.MeshStandardMaterial).emissiveIntensity =
        0.6 + Math.sin(time * 7) * 0.6 * weight;
    }
    if (this.flaskLight) {
      this.flaskLight.intensity = 0.3 + Math.sin(time * 7) * 0.4 * weight;
    }
  }

  protected override getSwingDuration(): number {
    return 0.35;
  }

  protected override getAbilityAnimDuration(abilityId: string): number {
    if (abilityId === 'bottle-chuck') return 0.7;
    if (abilityId === 'discombobulate') return 0.6;
    if (abilityId === 'chemical-spill') return 0.9;
    if (abilityId === 'kaboom') return 0.7;
    if (abilityId === 'pvp-trinket') return 0.5;
    return 0.6;
  }

  protected override animateAbilityUse(abilityId: string, t: number): void {
    if (abilityId === 'bottle-chuck') {
      this.animateBottleChuck(t);
    } else if (abilityId === 'discombobulate') {
      this.animateDiscombobCelebration(t);
    } else if (abilityId === 'chemical-spill') {
      this.animateChemicalSpill(t);
    } else if (abilityId === 'kaboom') {
      this.animateKaboom(t);
    } else if (abilityId === 'pvp-trinket') {
      this.animatePvPTrinket(t);
    }
  }

  private animateKaboom(t: number): void {
    if (t < 0.3) {
      // Wind-up: crouch and pull arms back, mixing chemicals
      const p = t / 0.3;
      const ease = p * p;
      // Crouch down
      this.bodyGroup.position.y -= 0.2 * ease;
      this.leftLegGroup.rotation.x += 0.3 * ease;
      this.rightLegGroup.rotation.x += 0.3 * ease;
      // Arms pull back at sides
      this.leftArmGroup.rotation.x -= 0.4 * ease;
      this.rightArmGroup.rotation.x -= 0.4 * ease;
      this.leftArmGroup.rotation.z += 0.4 * ease;
      this.rightArmGroup.rotation.z -= 0.4 * ease;
      // Head tucks down
      this.headGroup.rotation.x -= 0.2 * ease;
    } else if (t < 0.5) {
      // Explosion thrust: arms slam forward, body springs up
      const p = (t - 0.3) / 0.2;
      const ease = 1 - (1 - p) * (1 - p); // ease out
      // Hold crouch base
      this.bodyGroup.position.y -= 0.2 * (1 - ease);
      this.leftLegGroup.rotation.x += 0.3 * (1 - ease);
      this.rightLegGroup.rotation.x += 0.3 * (1 - ease);
      // Arms thrust forward explosively
      this.leftArmGroup.rotation.x += 1.6 * ease;
      this.rightArmGroup.rotation.x += 1.6 * ease;
      this.leftArmGroup.rotation.z -= 0.2 * ease;
      this.rightArmGroup.rotation.z += 0.2 * ease;
      // Body leans forward
      this.bodyGroup.rotation.x -= 0.25 * ease;
      // Head looks up from the blast
      this.headGroup.rotation.x += 0.15 * ease;
    } else {
      // Recovery: return to idle
      const p = (t - 0.5) / 0.5;
      const ease = p * p * (3 - 2 * p);
      const fade = 1 - ease;
      this.leftArmGroup.rotation.x += 1.6 * fade;
      this.rightArmGroup.rotation.x += 1.6 * fade;
      this.leftArmGroup.rotation.z -= 0.2 * fade;
      this.rightArmGroup.rotation.z += 0.2 * fade;
      this.bodyGroup.rotation.x -= 0.25 * fade;
      this.headGroup.rotation.x += 0.15 * fade;
    }
  }

  // ── Discombobulate cast animation (mixing flask & tube) ────
  protected override animateCasting(abilityId: string, t: number): void {
    if (abilityId === 'discombobulate') {
      this.animateDiscombobCast(t);
    } else if (abilityId === 'retard-strength') {
      this.animateRetardStrengthCast(t);
    } else if (abilityId === 'full-retard') {
      this.animateFullRetardCast(t);
    } else if (abilityId === 'crotch-rot') {
      this.animateCrotchRotCast(t);
    }
  }

  private animateDiscombobCast(t: number): void {
    // Quick blend-in over first 15% of cast
    const blend = Math.min(1, t / 0.15);

    // Bring both arms forward and inward — hands meet in front of chest
    // Positive X = forward in model space (model faces -Z, rotated 180°)
    this.leftArmGroup.rotation.x += 1.3 * blend;
    this.leftArmGroup.rotation.z += 0.7 * blend;
    this.rightArmGroup.rotation.x += 1.3 * blend;
    this.rightArmGroup.rotation.z -= 0.7 * blend;

    // Rubbing / mixing motion — rapid back-and-forth
    const rubSpeed = 18;
    const rub = Math.sin(t * rubSpeed) * 0.12 * blend;
    this.leftArmGroup.rotation.x += rub;
    this.rightArmGroup.rotation.x -= rub;

    // Slight cross-arm rocking
    const rock = Math.sin(t * rubSpeed * 0.5) * 0.06 * blend;
    this.leftArmGroup.rotation.z += rock;
    this.rightArmGroup.rotation.z -= rock;

    // Body leans forward, peering at concoction
    this.bodyGroup.rotation.x -= 0.12 * blend;
    // Head looks down at hands
    this.headGroup.rotation.x -= 0.25 * blend;
  }

  // ── Retard Strength cast animation (crouch down and shake) ────
  private animateRetardStrengthCast(t: number): void {
    // Blend in over first 15% of cast
    const blend = Math.min(1, t / 0.15);

    // Crouch down — bend legs outward and lower body
    this.leftLegGroup.rotation.x += 0.4 * blend;
    this.rightLegGroup.rotation.x += 0.4 * blend;
    this.leftLegGroup.rotation.z -= 0.15 * blend;
    this.rightLegGroup.rotation.z += 0.15 * blend;
    this.bodyGroup.position.y -= 0.25 * blend;

    // Arms tense at sides, fists clenched close to body
    this.leftArmGroup.rotation.x += 0.6 * blend;
    this.leftArmGroup.rotation.z += 0.5 * blend;
    this.rightArmGroup.rotation.x += 0.6 * blend;
    this.rightArmGroup.rotation.z -= 0.5 * blend;

    // Head tilts down, concentrating
    this.headGroup.rotation.x -= 0.3 * blend;

    // Rapid shaking — increases in intensity as cast progresses
    const shakeIntensity = blend * (0.3 + t * 0.7);
    const shakeSpeed = 25;
    const shakeX = Math.sin(t * shakeSpeed) * 0.04 * shakeIntensity;
    const shakeZ = Math.cos(t * shakeSpeed * 1.3) * 0.03 * shakeIntensity;
    this.bodyGroup.rotation.x += shakeX;
    this.bodyGroup.rotation.z += shakeZ;

    // Arms tremble
    const armShake = Math.sin(t * shakeSpeed * 1.1 + 1) * 0.05 * shakeIntensity;
    this.leftArmGroup.rotation.x += armShake;
    this.rightArmGroup.rotation.x -= armShake;

    // Head shakes
    this.headGroup.rotation.z += Math.sin(t * shakeSpeed * 0.9 + 2) * 0.06 * shakeIntensity;
  }

  // ── Full Retard cast animation (wild flexing) ────
  private animateFullRetardCast(t: number): void {
    const blend = Math.min(1, t / 0.1);

    // Wide stance — legs spread for power pose
    this.leftLegGroup.rotation.z -= 0.2 * blend;
    this.rightLegGroup.rotation.z += 0.2 * blend;
    this.leftLegGroup.rotation.x += 0.3 * blend;
    this.rightLegGroup.rotation.x += 0.3 * blend;

    // Body crouches slightly, puffs chest out
    this.bodyGroup.position.y -= 0.15 * blend;
    this.bodyGroup.rotation.x += 0.1 * blend;

    // Alternating flex poses — arms pump wildly
    const flexSpeed = 8;
    const flexPhase = Math.sin(t * flexSpeed * Math.PI * 2);

    // Left arm: bicep curl flex
    this.leftArmGroup.rotation.x += (-1.8 + flexPhase * 0.5) * blend;
    this.leftArmGroup.rotation.z -= (0.8 + flexPhase * 0.3) * blend;

    // Right arm: alternating with left
    this.rightArmGroup.rotation.x += (-1.8 - flexPhase * 0.5) * blend;
    this.rightArmGroup.rotation.z += (0.8 - flexPhase * 0.3) * blend;

    // Body rocks side to side with each flex
    this.bodyGroup.rotation.z += Math.sin(t * flexSpeed * Math.PI * 2) * 0.12 * blend;

    // Head tilts back — straining with effort
    this.headGroup.rotation.x += 0.35 * blend;
    this.headGroup.rotation.z += Math.sin(t * flexSpeed * Math.PI * 2 * 2) * 0.08 * blend;

    // Full-body shaking that intensifies over cast
    const shakeIntensity = blend * (0.2 + t * 0.8);
    const shakeSpeed = 30;
    this.bodyGroup.rotation.x += Math.sin(t * shakeSpeed) * 0.04 * shakeIntensity;
    this.bodyGroup.rotation.z += Math.cos(t * shakeSpeed * 1.3) * 0.03 * shakeIntensity;

    // Arms tremble
    const armShake = Math.sin(t * shakeSpeed * 1.1 + 1) * 0.06 * shakeIntensity;
    this.leftArmGroup.rotation.x += armShake;
    this.rightArmGroup.rotation.x -= armShake;
  }

  // ── Crotch Rot cast animation (hunched stirring a foul concoction) ────
  private animateCrotchRotCast(t: number): void {
    // Quick blend-in over first 12% of cast
    const blend = Math.min(1, t / 0.12);

    // One arm forward holding flask, other hand stirs — asymmetric pose
    this.leftArmGroup.rotation.x += 1.0 * blend;
    this.leftArmGroup.rotation.z += 0.4 * blend;
    this.rightArmGroup.rotation.x += 1.4 * blend;
    this.rightArmGroup.rotation.z -= 0.3 * blend;

    // Stirring motion — circular pattern on the right hand
    const stirSpeed = 14;
    const stirX = Math.sin(t * stirSpeed) * 0.18 * blend;
    const stirZ = Math.cos(t * stirSpeed) * 0.1 * blend;
    this.rightArmGroup.rotation.x += stirX;
    this.rightArmGroup.rotation.z += stirZ;

    // Left arm holds steady with a slight tremor
    const tremor = Math.sin(t * stirSpeed * 1.7) * 0.04 * blend;
    this.leftArmGroup.rotation.x += tremor;

    // Body hunches forward, leaning into the concoction
    this.bodyGroup.rotation.x -= 0.18 * blend;
    // Head peers down at hands
    this.headGroup.rotation.x -= 0.25 * blend;

    // Slight side-to-side sway as he stirs
    const sway = Math.sin(t * stirSpeed * 0.4) * 0.05 * blend;
    this.bodyGroup.rotation.z += sway;
  }

  private animateDiscombobCelebration(t: number): void {
    if (t < 0.45) {
      // Jump up with arms raised
      const p = t / 0.45;
      const arc = Math.sin(p * Math.PI);
      this.group.position.y = arc * 0.35;

      // Arms throw up in victory
      this.leftArmGroup.rotation.x -= 2.8 * arc;
      this.rightArmGroup.rotation.x -= 2.8 * arc;
      this.leftArmGroup.rotation.z -= 0.4 * arc;
      this.rightArmGroup.rotation.z += 0.4 * arc;

      // Legs tuck slightly
      this.leftLegGroup.rotation.x += 0.25 * arc;
      this.rightLegGroup.rotation.x += 0.25 * arc;
    } else {
      // Land and settle
      const p = (t - 0.45) / 0.55;
      const ease = p * p * (3 - 2 * p);
      this.group.position.y = 0;

      // Arms return smoothly
      const armFade = 1 - ease;
      this.leftArmGroup.rotation.x -= 0.3 * armFade;
      this.rightArmGroup.rotation.x -= 0.3 * armFade;
    }
  }

  override setAbilityBuffActive(buffId: string, active: boolean): void {
    if (buffId === 'retard-strength') {
      this.retardStrengthActive = active;
    } else if (buffId === 'full-retard') {
      this.fullRetardActive = active;
    }
  }

  // ── Chudmax channel animation (concentration pose, rocking) ────
  protected override animateChanneling(abilityId: string, t: number): void {
    if (abilityId === 'chudmax') {
      this.animateChudmaxChannel(t);
    } else {
      super.animateChanneling(abilityId, t);
    }
  }

  private animateChudmaxChannel(t: number): void {
    // Quick blend in
    const blend = Math.min(1, t / 0.08);

    // Hide flask and test tube (sheathed) — flag prevents onAnimate from restoring
    this.chudmaxChannelActive = true;
    if (this.tubeGroup) this.tubeGroup.visible = false;

    // Bring hands up to head — concentration pose
    // Arms up alongside head, elbows bent
    this.leftArmGroup.rotation.x -= 2.6 * blend;
    this.leftArmGroup.rotation.z -= 0.15 * blend;
    this.rightArmGroup.rotation.x -= 2.6 * blend;
    this.rightArmGroup.rotation.z += 0.15 * blend;

    // Rock back and forth
    const rockSpeed = 3.5;
    const rockAmount = 0.12 * blend;
    this.bodyGroup.rotation.x += Math.sin(t * rockSpeed * Math.PI * 2) * rockAmount;

    // Slight head sway
    this.headGroup.rotation.z += Math.sin(t * rockSpeed * Math.PI * 2 + 0.5) * 0.08 * blend;

    // Legs slightly spread for stability
    this.leftLegGroup.rotation.z -= 0.08 * blend;
    this.rightLegGroup.rotation.z += 0.08 * blend;
  }

  // ── Chemical Spill animation (pour flask & test tube onto the ground) ────
  private animateChemicalSpill(t: number): void {
    if (t < 0.25) {
      // Bring both arms forward and downward — preparing to pour
      const p = t / 0.25;
      const ease = p * p;
      // Arms swing forward and down
      this.leftArmGroup.rotation.x += 1.8 * ease;
      this.rightArmGroup.rotation.x += 1.8 * ease;
      // Spread arms slightly outward
      this.leftArmGroup.rotation.z += 0.3 * ease;
      this.rightArmGroup.rotation.z -= 0.3 * ease;
      // Body leans forward
      this.bodyGroup.rotation.x -= 0.3 * ease;
      // Head looks down at the ground
      this.headGroup.rotation.x -= 0.35 * ease;
    } else if (t < 0.7) {
      // Pouring phase — arms extended down, wrists rotate to pour
      const p = (t - 0.25) / 0.45;
      // Hold arms forward and down
      this.leftArmGroup.rotation.x += 1.8;
      this.rightArmGroup.rotation.x += 1.8;
      this.leftArmGroup.rotation.z += 0.3;
      this.rightArmGroup.rotation.z -= 0.3;
      this.bodyGroup.rotation.x -= 0.3;
      this.headGroup.rotation.x -= 0.35;
      // Rotate arms inward to tip flasks — pouring motion
      const pourAngle = Math.sin(p * Math.PI) * 0.6;
      this.leftArmGroup.rotation.z += pourAngle;
      this.rightArmGroup.rotation.z -= pourAngle;
      // Gentle rocking while pouring
      const rock = Math.sin(p * Math.PI * 3) * 0.06;
      this.leftArmGroup.rotation.x += rock;
      this.rightArmGroup.rotation.x -= rock;
    } else {
      // Recovery — stand back up
      const p = (t - 0.7) / 0.3;
      const ease = p * p * (3 - 2 * p);
      const fade = 1 - ease;
      this.leftArmGroup.rotation.x += 1.8 * fade;
      this.rightArmGroup.rotation.x += 1.8 * fade;
      this.leftArmGroup.rotation.z += 0.3 * fade;
      this.rightArmGroup.rotation.z -= 0.3 * fade;
      this.bodyGroup.rotation.x -= 0.3 * fade;
      this.headGroup.rotation.x -= 0.35 * fade;
    }
  }

  private animateBottleChuck(t: number): void {
    let rightArmX: number;
    let rightArmZ: number;
    let bodyRotY: number;
    let bodyRotX: number;
    let bodyY: number;

    if (t < 0.15) {
      // Wind-up: pull right arm back, coil body
      this.projectileLaunched = false;
      const p = t / 0.15;
      const ease = p * p;
      rightArmX = -0.5 * ease;
      rightArmZ = -0.15 * ease;
      bodyRotY = -0.15 * ease;
      bodyRotX = -0.05 * ease;
      bodyY = 0;
    } else if (t < 0.40) {
      // Throw: swing right arm forward overhead
      const p = (t - 0.15) / 0.25;
      const ease = 1 - Math.pow(1 - p, 3);
      rightArmX = -0.5 + 2.5 * ease;
      rightArmZ = -0.15 + 0.25 * ease;
      bodyRotY = -0.15 + 0.35 * ease;
      bodyRotX = -0.05 + 0.20 * ease;
      bodyY = -0.03 * ease;

      // Launch projectile at peak
      if (!this.projectileLaunched && p > 0.5) {
        this.launchProjectile();
      }
    } else {
      // Recovery: return to neutral
      const p = (t - 0.40) / 0.60;
      const ease = p * p * (3 - 2 * p);
      rightArmX = 2.0 * (1 - ease);
      rightArmZ = 0.1 * (1 - ease);
      bodyRotY = 0.2 * (1 - ease);
      bodyRotX = 0.15 * (1 - ease);
      bodyY = -0.03 * (1 - ease);
    }

    this.rightArmGroup.rotation.x += rightArmX;
    this.rightArmGroup.rotation.z += rightArmZ;
    this.bodyGroup.rotation.y += bodyRotY;
    this.bodyGroup.rotation.x += bodyRotX;
    this.bodyGroup.position.y += bodyY;
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
