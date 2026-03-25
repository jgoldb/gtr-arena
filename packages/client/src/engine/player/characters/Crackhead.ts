import * as THREE from 'three';
import { CharacterModel, AnimationInput } from './CharacterModel';

const SKIN = 0x9b7b5a;       // sallow, unhealthy skin
const SKIN_DARK = 0x7a5f42;  // darker blotchy skin patches
const SORE = 0xcc4444;       // open sores
const TEETH = 0x998844;      // yellowed teeth
const EYES = 0xeeee44;       // jaundiced yellowish eyes
const PUPIL = 0x111111;
const RAGS_MAIN = 0x5a4a3a;  // grimy brown shirt
const RAGS_PANTS = 0x3a3a2a; // filthy dark pants
const HAIR = 0x444433;       // thin patchy dark hair
const NAILS = 0x776655;      // dirty fingernails

export class Crackhead extends CharacterModel {
  constructor() { super('crackhead'); }

  // Scratch animation state
  private scratchTimer = 0;
  private scratchPhase = 0;       // 0 = idle gap, 1-4 = scratch zones
  private scratchProgress = 0;    // 0-1 progress within current scratch
  private scratchCooldown = 0;    // time until next scratch burst
  private scratchArm: 'left' | 'right' = 'left';

  // Sore meshes for pulsing (initialized in buildModel via declare to avoid
  // field-initializer ordering — super() calls buildModel before field inits)
  private declare soreMeshes: THREE.Mesh[];

  // Knife mesh for Shank animation
  private declare knifeGroup: THREE.Group;

  // Sand particle state for Pocket Sand
  private sandParticles: { mesh: THREE.Mesh; vel: THREE.Vector3; life: number }[] = [];

  // Twitch state
  private twitchTimer = 0;
  private twitchIntensity = 0;

  protected buildModel(): void {
    this.soreMeshes = [];

    // Crackhead is gaunt — narrower shoulders, slightly hunched
    this.leftArmGroup.position.set(-0.24, 1.24, 0);
    this.rightArmGroup.position.set(0.24, 1.24, 0);
    this.headGroup.position.set(0, 1.30, 0);

    this.buildHead();
    this.buildTorso();
    this.buildArms();
    this.buildLegs();
    this.buildKnife();
  }

  // ── Head ───────────────────────────────────────────────

  private buildHead(): void {
    // Slightly lumpy, misshapen head
    const head = this.createMesh(new THREE.SphereGeometry(0.155, 10, 8), SKIN);
    head.position.set(0, 0.15, 0);
    head.scale.set(1.05, 0.95, 1.0); // slightly squashed
    this.headGroup.add(head);

    // Prominent brow ridge
    const brow = this.createMesh(new THREE.BoxGeometry(0.22, 0.04, 0.08), SKIN_DARK);
    brow.position.set(0, 0.22, -0.12);
    this.headGroup.add(brow);

    // Sunken, jaundiced eyes
    const eyeGeo = new THREE.SphereGeometry(0.032, 6, 6);
    const leftEye = this.createMesh(eyeGeo, EYES);
    leftEye.position.set(-0.055, 0.17, -0.13);
    this.headGroup.add(leftEye);
    const rightEye = this.createMesh(eyeGeo, EYES);
    rightEye.position.set(0.055, 0.17, -0.13);
    this.headGroup.add(rightEye);

    // Pupils — one slightly larger than the other (asymmetric)
    const leftPupil = this.createMesh(new THREE.SphereGeometry(0.016, 6, 6), PUPIL);
    leftPupil.position.set(-0.055, 0.17, -0.155);
    this.headGroup.add(leftPupil);
    const rightPupil = this.createMesh(new THREE.SphereGeometry(0.02, 6, 6), PUPIL);
    rightPupil.position.set(0.055, 0.168, -0.155);
    this.headGroup.add(rightPupil);

    // Dark circles under eyes
    const circleGeo = new THREE.SphereGeometry(0.025, 6, 4);
    const leftCircle = this.createMesh(circleGeo, SKIN_DARK);
    leftCircle.position.set(-0.055, 0.14, -0.135);
    leftCircle.scale.set(1.3, 0.5, 0.5);
    this.headGroup.add(leftCircle);
    const rightCircle = this.createMesh(circleGeo, SKIN_DARK);
    rightCircle.position.set(0.055, 0.14, -0.135);
    rightCircle.scale.set(1.3, 0.5, 0.5);
    this.headGroup.add(rightCircle);

    // Crooked, bulbous nose
    const nose = this.createMesh(new THREE.SphereGeometry(0.035, 6, 6), SKIN_DARK);
    nose.position.set(0.01, 0.13, -0.14);
    nose.scale.set(0.9, 0.7, 1.2);
    this.headGroup.add(nose);

    // Sore on nose
    const noseSore = this.createMesh(new THREE.SphereGeometry(0.012, 5, 5), SORE);
    noseSore.position.set(0.025, 0.14, -0.16);
    this.headGroup.add(noseSore);
    this.soreMeshes.push(noseSore);

    // Mouth — permanent grimace showing yellowed teeth
    const mouth = this.createMesh(new THREE.BoxGeometry(0.06, 0.015, 0.02), 0x331111);
    mouth.position.set(0, 0.06, -0.14);
    mouth.rotation.z = 0.05; // slightly crooked
    this.headGroup.add(mouth);

    // Visible teeth
    const teethGeo = new THREE.BoxGeometry(0.04, 0.01, 0.015);
    const teeth = this.createMesh(teethGeo, TEETH);
    teeth.position.set(0, 0.065, -0.145);
    this.headGroup.add(teeth);

    // Missing tooth gap
    const gap = this.createMesh(new THREE.BoxGeometry(0.01, 0.012, 0.016), 0x331111);
    gap.position.set(0.008, 0.065, -0.144);
    this.headGroup.add(gap);

    // Patchy thin hair — sparse tufts
    const tufts = [
      { x: -0.08, y: 0.28, z: 0.02, sx: 0.6, sy: 1.2, sz: 0.6 },
      { x: 0.1, y: 0.27, z: -0.01, sx: 0.7, sy: 1.0, sz: 0.5 },
      { x: -0.03, y: 0.30, z: 0.05, sx: 0.5, sy: 0.8, sz: 0.5 },
      { x: 0.06, y: 0.29, z: 0.06, sx: 0.4, sy: 0.9, sz: 0.4 },
      { x: -0.06, y: 0.26, z: -0.05, sx: 0.5, sy: 0.7, sz: 0.6 },
    ];
    for (const t of tufts) {
      const tuft = this.createMesh(new THREE.SphereGeometry(0.03, 5, 4), HAIR);
      tuft.position.set(t.x, t.y, t.z);
      tuft.scale.set(t.sx, t.sy, t.sz);
      this.headGroup.add(tuft);
    }

    // Sore on forehead
    const foreheadSore = this.createMesh(new THREE.SphereGeometry(0.018, 5, 5), SORE);
    foreheadSore.position.set(-0.04, 0.25, -0.11);
    this.headGroup.add(foreheadSore);
    this.soreMeshes.push(foreheadSore);

    // Ears — slightly oversized, asymmetric
    const earGeo = new THREE.SphereGeometry(0.04, 5, 5);
    const leftEar = this.createMesh(earGeo, SKIN);
    leftEar.position.set(-0.16, 0.16, 0);
    leftEar.scale.set(0.5, 1.0, 0.8);
    this.headGroup.add(leftEar);
    const rightEar = this.createMesh(earGeo, SKIN);
    rightEar.position.set(0.16, 0.18, 0); // slightly higher
    rightEar.scale.set(0.5, 1.1, 0.8);
    this.headGroup.add(rightEar);
  }

  // ── Torso ──────────────────────────────────────────────

  private buildTorso(): void {
    // Gaunt torso — narrow, slightly concave
    const torso = this.createMesh(
      new THREE.BoxGeometry(0.38, 0.44, 0.22),
      RAGS_MAIN,
    );
    torso.position.set(0, 0.98, 0);
    this.bodyGroup.add(torso);

    // Visible collarbones / upper chest (skin showing through torn shirt)
    const collarbone = this.createMesh(
      new THREE.BoxGeometry(0.28, 0.04, 0.12),
      SKIN,
    );
    collarbone.position.set(0, 1.21, -0.06);
    this.bodyGroup.add(collarbone);

    // Ripped shirt holes showing skin
    const hole1 = this.createMesh(new THREE.SphereGeometry(0.04, 5, 5), SKIN);
    hole1.position.set(-0.1, 1.0, -0.12);
    this.bodyGroup.add(hole1);
    const hole2 = this.createMesh(new THREE.SphereGeometry(0.03, 5, 5), SKIN);
    hole2.position.set(0.08, 0.90, -0.11);
    this.bodyGroup.add(hole2);

    // Sore on chest (visible through hole)
    const chestSore = this.createMesh(new THREE.SphereGeometry(0.015, 5, 5), SORE);
    chestSore.position.set(-0.1, 1.0, -0.15);
    this.bodyGroup.add(chestSore);
    this.soreMeshes.push(chestSore);

    // Grimy stains on shirt
    const stain1 = this.createMesh(new THREE.BoxGeometry(0.08, 0.06, 0.01), 0x3a3020);
    stain1.position.set(0.06, 1.05, -0.115);
    this.bodyGroup.add(stain1);
    const stain2 = this.createMesh(new THREE.BoxGeometry(0.06, 0.08, 0.01), 0x4a402a);
    stain2.position.set(-0.12, 0.88, -0.115);
    this.bodyGroup.add(stain2);

    // Protruding ribs (visible gauntness)
    for (let i = 0; i < 3; i++) {
      const rib = this.createMesh(new THREE.BoxGeometry(0.25, 0.012, 0.015), SKIN_DARK);
      rib.position.set(0, 0.86 + i * 0.06, -0.115);
      this.bodyGroup.add(rib);
    }
  }

  // ── Arms ───────────────────────────────────────────────

  private buildArms(): void {
    // Thin, sinewy arms
    const armGeo = new THREE.CapsuleGeometry(0.05, 0.38, 6, 8);

    const leftArm = this.createMesh(armGeo, SKIN);
    leftArm.position.set(0, -0.24, 0);
    this.leftArmGroup.add(leftArm);

    const rightArm = this.createMesh(armGeo, SKIN);
    rightArm.position.set(0, -0.24, 0);
    this.rightArmGroup.add(rightArm);

    // Bony hands with dirty nails
    const handGeo = new THREE.SphereGeometry(0.042, 6, 6);
    const leftHand = this.createMesh(handGeo, SKIN);
    leftHand.position.set(0, -0.48, 0);
    this.leftArmGroup.add(leftHand);

    const rightHand = this.createMesh(handGeo, SKIN);
    rightHand.position.set(0, -0.48, 0);
    this.rightArmGroup.add(rightHand);

    // Dirty fingernails (visible scratching implements)
    const nailGeo = new THREE.BoxGeometry(0.035, 0.008, 0.015);
    const leftNails = this.createMesh(nailGeo, NAILS);
    leftNails.position.set(0, -0.51, -0.02);
    this.leftArmGroup.add(leftNails);
    const rightNails = this.createMesh(nailGeo, NAILS);
    rightNails.position.set(0, -0.51, -0.02);
    this.rightArmGroup.add(rightNails);

    // Sores on arms
    const armSore1 = this.createMesh(new THREE.SphereGeometry(0.015, 5, 5), SORE);
    armSore1.position.set(0.02, -0.15, -0.05);
    this.leftArmGroup.add(armSore1);
    this.soreMeshes.push(armSore1);

    const armSore2 = this.createMesh(new THREE.SphereGeometry(0.012, 5, 5), SORE);
    armSore2.position.set(-0.02, -0.30, -0.04);
    this.rightArmGroup.add(armSore2);
    this.soreMeshes.push(armSore2);

    // Track marks on left arm (inner arm)
    for (let i = 0; i < 3; i++) {
      const mark = this.createMesh(new THREE.SphereGeometry(0.005, 4, 4), 0x662222);
      mark.position.set(0.03, -0.18 - i * 0.04, 0.02);
      this.leftArmGroup.add(mark);
    }

    // Torn sleeve remnants
    const sleeveL = this.createMesh(new THREE.CylinderGeometry(0.058, 0.055, 0.08, 6), RAGS_MAIN);
    sleeveL.position.set(0, -0.06, 0);
    this.leftArmGroup.add(sleeveL);
    const sleeveR = this.createMesh(new THREE.CylinderGeometry(0.058, 0.055, 0.10, 6), RAGS_MAIN);
    sleeveR.position.set(0, -0.05, 0);
    this.rightArmGroup.add(sleeveR);
  }

  // ── Legs ───────────────────────────────────────────────

  private buildLegs(): void {
    // Thin legs in dirty pants
    const legGeo = new THREE.CapsuleGeometry(0.06, 0.48, 6, 8);

    const leftLeg = this.createMesh(legGeo, RAGS_PANTS);
    leftLeg.position.set(0, -0.36, 0);
    this.leftLegGroup.add(leftLeg);

    const rightLeg = this.createMesh(legGeo, RAGS_PANTS);
    rightLeg.position.set(0, -0.36, 0);
    this.rightLegGroup.add(rightLeg);

    // Torn pant leg (showing skin underneath)
    const tornPant = this.createMesh(new THREE.SphereGeometry(0.035, 5, 5), SKIN);
    tornPant.position.set(0.03, -0.45, -0.04);
    this.rightLegGroup.add(tornPant);

    // Knee sore (visible through torn pants)
    const kneeSore = this.createMesh(new THREE.SphereGeometry(0.014, 5, 5), SORE);
    kneeSore.position.set(0.03, -0.45, -0.06);
    this.rightLegGroup.add(kneeSore);
    this.soreMeshes.push(kneeSore);

    // Beat-up shoes — mismatched
    const leftShoe = this.createMesh(
      new THREE.BoxGeometry(0.10, 0.06, 0.16),
      0x2a2a1a,
    );
    leftShoe.position.set(0, -0.65, -0.02);
    this.leftLegGroup.add(leftShoe);

    const rightShoe = this.createMesh(
      new THREE.BoxGeometry(0.10, 0.06, 0.16),
      0x3a2a2a, // slightly different color — mismatched
    );
    rightShoe.position.set(0, -0.65, -0.02);
    this.rightLegGroup.add(rightShoe);
  }

  // ── Animation Overrides ─────────────────────────────────

  private updateScratching(dt: number): void {
    this.scratchTimer += dt;

    if (this.scratchPhase === 0) {
      // Waiting for next scratch
      this.scratchCooldown -= dt;
      if (this.scratchCooldown <= 0) {
        // Start a new scratch — pick random zone
        this.scratchPhase = 1 + Math.floor(Math.random() * 4);
        this.scratchProgress = 0;
        this.scratchArm = Math.random() > 0.5 ? 'left' : 'right';
      }
      return;
    }

    // Advance scratch progress
    const scratchDuration = 0.8 + Math.random() * 0.01; // ~0.8s per scratch
    this.scratchProgress += dt / scratchDuration;

    if (this.scratchProgress >= 1) {
      // Scratch done — go back to idle gap
      this.scratchPhase = 0;
      this.scratchCooldown = 0.5 + Math.random() * 2.0; // 0.5-2.5s gap
      return;
    }

    const p = this.scratchProgress;
    // Rapid back-and-forth scratching motion
    const scratchOscillation = Math.sin(p * Math.PI * 12) * (1 - p); // fast oscillation that fades

    switch (this.scratchPhase) {
      case 1: this.scratchHead(p, scratchOscillation); break;
      case 2: this.scratchArmpitArea(p, scratchOscillation); break;
      case 3: this.scratchChest(p, scratchOscillation); break;
      case 4: this.scratchLeg(p, scratchOscillation); break;
    }
  }

  private scratchHead(p: number, osc: number): void {
    // One arm reaches up to scratch head
    const reachUp = p < 0.15 ? p / 0.15 : p > 0.85 ? (1 - p) / 0.15 : 1;
    const ease = reachUp * reachUp * (3 - 2 * reachUp);
    if (this.scratchArm === 'right') {
      this.rightArmGroup.rotation.x -= 2.5 * ease;
      this.rightArmGroup.rotation.z -= 0.3 * ease;
      this.rightArmGroup.rotation.x += osc * 0.15;
    } else {
      this.leftArmGroup.rotation.x -= 2.5 * ease;
      this.leftArmGroup.rotation.z += 0.3 * ease;
      this.leftArmGroup.rotation.x += osc * 0.15;
    }
    // Head tilts into the scratch
    this.headGroup.rotation.z += (this.scratchArm === 'right' ? -0.15 : 0.15) * ease;
  }

  private scratchArmpitArea(p: number, osc: number): void {
    // Opposite arm reaches across to scratch armpit/side
    const reach = p < 0.15 ? p / 0.15 : p > 0.85 ? (1 - p) / 0.15 : 1;
    const ease = reach * reach * (3 - 2 * reach);
    if (this.scratchArm === 'right') {
      // Right arm scratches left armpit
      this.rightArmGroup.rotation.x += 1.2 * ease;
      this.rightArmGroup.rotation.z -= 0.8 * ease;
      this.rightArmGroup.rotation.x += osc * 0.12;
      // Lift left arm out of the way
      this.leftArmGroup.rotation.z -= 0.4 * ease;
    } else {
      this.leftArmGroup.rotation.x += 1.2 * ease;
      this.leftArmGroup.rotation.z += 0.8 * ease;
      this.leftArmGroup.rotation.x += osc * 0.12;
      this.rightArmGroup.rotation.z += 0.4 * ease;
    }
    // Body leans toward scratched side
    this.bodyGroup.rotation.z += (this.scratchArm === 'right' ? 0.08 : -0.08) * ease;
  }

  private scratchChest(p: number, osc: number): void {
    // Arm comes across to scratch chest/belly
    const reach = p < 0.15 ? p / 0.15 : p > 0.85 ? (1 - p) / 0.15 : 1;
    const ease = reach * reach * (3 - 2 * reach);
    if (this.scratchArm === 'right') {
      this.rightArmGroup.rotation.x += 0.8 * ease;
      this.rightArmGroup.rotation.z -= 0.5 * ease;
      this.rightArmGroup.rotation.y += osc * 0.1;
    } else {
      this.leftArmGroup.rotation.x += 0.8 * ease;
      this.leftArmGroup.rotation.z += 0.5 * ease;
      this.leftArmGroup.rotation.y += osc * 0.1;
    }
    // Head looks down at the itch
    this.headGroup.rotation.x += 0.15 * ease;
  }

  private scratchLeg(p: number, osc: number): void {
    // Arm reaches down to scratch thigh/leg
    const reach = p < 0.15 ? p / 0.15 : p > 0.85 ? (1 - p) / 0.15 : 1;
    const ease = reach * reach * (3 - 2 * reach);
    if (this.scratchArm === 'right') {
      this.rightArmGroup.rotation.x += 1.6 * ease;
      this.rightArmGroup.rotation.z -= 0.2 * ease;
      this.rightArmGroup.rotation.x += osc * 0.1;
    } else {
      this.leftArmGroup.rotation.x += 1.6 * ease;
      this.leftArmGroup.rotation.z += 0.2 * ease;
      this.leftArmGroup.rotation.x += osc * 0.1;
    }
    // Hunch over to reach
    this.bodyGroup.rotation.x += 0.2 * ease;
    this.headGroup.rotation.x += 0.1 * ease;
  }

  // ── Combat Stance ─────────────────────────────────────

  protected animateCombatStance(weight: number): void {
    const w = weight;
    const t = this.idleTime;

    // Twitchy, unhinged fighting stance — hunched, fists up, bouncing
    this.bodyGroup.position.y -= 0.06 * w;
    this.bodyGroup.rotation.x += 0.15 * w; // hunched forward

    // Legs wide and bouncy
    this.leftLegGroup.rotation.z -= 0.18 * w;
    this.rightLegGroup.rotation.z += 0.18 * w;
    this.leftLegGroup.rotation.x += 0.12 * w;
    this.rightLegGroup.rotation.x += 0.12 * w;

    // Fists up, twitchy guard — asymmetric
    this.leftArmGroup.rotation.x += 0.9 * w;
    this.leftArmGroup.rotation.z -= 0.5 * w;
    this.rightArmGroup.rotation.x += 0.7 * w;
    this.rightArmGroup.rotation.z += 0.6 * w;

    // Rapid twitchy bounce/sway — much faster than other characters
    const bounce = Math.sin(t * 8) * 0.03 * w;
    this.bodyGroup.position.y += bounce;
    this.bodyGroup.rotation.z += Math.sin(t * 5) * 0.06 * w;
    this.headGroup.rotation.y += Math.sin(t * 6) * 0.1 * w;

    // Hands jitter
    this.leftArmGroup.rotation.x += Math.sin(t * 15) * 0.05 * w;
    this.rightArmGroup.rotation.x += Math.cos(t * 13) * 0.05 * w;
  }

  // ── Auto-Attack Swing ────────────────────────────────

  protected getSwingDuration(): number { return 0.35; }

  protected animateAttackSwing(t: number, alternateArm: boolean): void {
    // Wild, uncontrolled flailing punches
    const p = t;
    const arm = alternateArm ? 'left' : 'right';

    // Smoothstep phases
    const windUp = p < 0.15 ? p / 0.15 : 1;
    const strike = p < 0.15 ? 0 : p < 0.4 ? (p - 0.15) / 0.25 : 1;
    const recover = p < 0.4 ? 0 : (p - 0.4) / 0.6;
    const easeStrike = strike * strike * (3 - 2 * strike);
    const easeRecover = recover * recover * (3 - 2 * recover);

    if (arm === 'right') {
      // Wild haymaker — pull back then thrust forward and inward
      this.rightArmGroup.rotation.x += (-0.5 * windUp + 2.4 * easeStrike) * (1 - easeRecover);
      this.rightArmGroup.rotation.z += (-0.3 * windUp - 0.5 * easeStrike) * (1 - easeRecover);
      this.bodyGroup.rotation.z -= 0.1 * easeStrike * (1 - easeRecover);
    } else {
      this.leftArmGroup.rotation.x += (-0.5 * windUp + 2.4 * easeStrike) * (1 - easeRecover);
      this.leftArmGroup.rotation.z += (0.3 * windUp + 0.5 * easeStrike) * (1 - easeRecover);
      this.bodyGroup.rotation.z += 0.1 * easeStrike * (1 - easeRecover);
    }

    // Lunge forward with the punch
    this.bodyGroup.rotation.x += 0.12 * easeStrike * (1 - easeRecover);
  }

  // ── Run Animation Override (Lunatic Run) ────────────────

  // The base class handles run animation, but we override via onAnimate
  // to add our lunatic flair on top of the base run cycle

  protected override onAnimate(dt: number, input: AnimationInput): void {
    // Update sand particles
    for (let i = this.sandParticles.length - 1; i >= 0; i--) {
      const p = this.sandParticles[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.mesh.parent?.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        this.sandParticles.splice(i, 1);
        continue;
      }
      p.vel.y -= 3.0 * dt; // gravity
      p.mesh.position.addScaledVector(p.vel, dt);
      // Fade out in last 30% of life
      const totalLife = 0.5 + 0.15; // average
      const fade = Math.min(1, p.life / (totalLife * 0.3));
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = fade * 0.9;
    }

    // Sore pulsing
    for (let i = 0; i < this.soreMeshes.length; i++) {
      const pulse = 1.0 + Math.sin(this.idleTime * 3 + i * 1.5) * 0.15;
      this.soreMeshes[i].scale.setScalar(pulse);
    }

    // Random twitching
    this.twitchTimer -= dt;
    if (this.twitchTimer <= 0) {
      this.twitchIntensity = 0.3 + Math.random() * 0.7;
      this.twitchTimer = 0.8 + Math.random() * 3.0;
    }
    const twitchDecay = Math.max(0, this.twitchIntensity - dt * 4);
    this.twitchIntensity = twitchDecay;
    this.headGroup.rotation.z += Math.sin(this.idleTime * 40) * 0.06 * this.twitchIntensity;
    this.headGroup.rotation.x += Math.cos(this.idleTime * 35) * 0.04 * this.twitchIntensity;

    // Lunatic run modifications (additive on top of base run cycle)
    if (this.runWeight > 0.01) {
      const w = this.runWeight;
      const phase = this.runPhase;

      // Exaggerated hunched-forward lean
      this.bodyGroup.rotation.x += 0.18 * w;

      // Head bobs wildly and looks around erratically
      this.headGroup.rotation.y += Math.sin(phase * 1.3) * 0.2 * w;
      this.headGroup.rotation.z += Math.sin(phase * 0.7) * 0.1 * w;

      // Arms flail asymmetrically — not synced like a normal run
      this.leftArmGroup.rotation.z -= Math.sin(phase * 0.8 + 1.0) * 0.25 * w;
      this.rightArmGroup.rotation.z += Math.cos(phase * 0.9) * 0.25 * w;

      // Exaggerated arm swing — wilder than normal
      this.leftArmGroup.rotation.x += Math.sin(phase * 1.1 + 0.5) * 0.3 * w;
      this.rightArmGroup.rotation.x -= Math.cos(phase * 1.1) * 0.3 * w;

      // Body sways side to side erratically
      this.bodyGroup.rotation.z += Math.sin(phase * 0.6) * 0.1 * w;

      // Extra chaotic leg movement — knees high, uneven stride
      this.leftLegGroup.rotation.x += Math.max(0, Math.sin(phase + 0.3)) * 0.2 * w;
      this.rightLegGroup.rotation.x += Math.max(0, Math.sin(phase + Math.PI + 0.3)) * 0.2 * w;

      // Torso bounces more than normal
      this.bodyGroup.position.y += Math.abs(Math.sin(phase * 1.5)) * 0.03 * w;
    }

    // Scratching (only when not running and not in combat)
    if (this.runWeight < 0.1 && this.combatStanceWeight < 0.1) {
      this.updateScratching(dt);
    } else {
      // Reset scratch state when moving/fighting
      this.scratchPhase = 0;
      this.scratchCooldown = 0.3 + Math.random() * 1.0;
    }
  }

  // ── Stun ─────────────────────────────────────────────

  protected override animateStun(time: number, weight: number): void {
    super.animateStun(time, weight);
    // Extra twitch during stun — involuntary muscle spasms
    this.leftArmGroup.rotation.x += Math.sin(time * 12) * 0.08 * weight;
    this.rightArmGroup.rotation.x += Math.cos(time * 11) * 0.08 * weight;
    this.headGroup.rotation.z += Math.sin(time * 8) * 0.12 * weight;
  }

  // ── Resting ──────────────────────────────────────────

  protected override animateResting(time: number, weight: number): void {
    super.animateResting(time, weight);
    // Even while resting, can't stop fidgeting
    const fidget = Math.sin(time * 4) * 0.04 * weight;
    this.leftArmGroup.rotation.x += fidget;
    // Occasional head scratch while sitting
    const scratchCycle = Math.sin(time * 0.8);
    if (scratchCycle > 0.7) {
      const intensity = (scratchCycle - 0.7) / 0.3;
      this.rightArmGroup.rotation.x -= 1.5 * intensity * weight;
      this.rightArmGroup.rotation.z -= 0.2 * intensity * weight;
      this.headGroup.rotation.z -= 0.1 * intensity * weight;
      // Scratch oscillation
      this.rightArmGroup.rotation.x += Math.sin(time * 14) * 0.08 * intensity * weight;
    }
  }

  // ── Death ────────────────────────────────────────────

  protected override animateDeath(t: number): void {
    super.animateDeath(t);
    // Final twitch spasm
    if (t > 0.7 && t < 0.9) {
      const spasm = (t - 0.7) / 0.2;
      const intensity = Math.sin(spasm * Math.PI) * 0.5;
      this.leftArmGroup.rotation.x += Math.sin(t * 30) * 0.15 * intensity;
      this.rightArmGroup.rotation.x += Math.cos(t * 25) * 0.15 * intensity;
      this.leftLegGroup.rotation.x += Math.sin(t * 20) * 0.1 * intensity;
    }
  }

  // ── Flinch ───────────────────────────────────────────

  protected override animateFlinch(t: number): void {
    super.animateFlinch(t);
    // Extra twitchy flinch — head snaps sideways
    const spike = t < 0.1 ? t / 0.1 : Math.max(0, 1 - (t - 0.1) / 0.5);
    this.headGroup.rotation.z += spike * 0.2 * (Math.random() > 0.5 ? 1 : -1);
  }

  // ── Knife (Shank prop) ────────────────────────────────

  private buildKnife(): void {
    this.knifeGroup = new THREE.Group();
    // Blade — slim silver shard
    const blade = this.createMesh(new THREE.BoxGeometry(0.012, 0.10, 0.02), 0xaaaaaa);
    blade.position.set(0, -0.05, 0);
    this.knifeGroup.add(blade);
    // Blade tip
    const tip = this.createMesh(new THREE.ConeGeometry(0.009, 0.03, 4), 0xbbbbbb);
    tip.position.set(0, -0.115, 0);
    tip.rotation.x = Math.PI; // point downward
    this.knifeGroup.add(tip);
    // Handle — wrapped grip
    const handle = this.createMesh(new THREE.BoxGeometry(0.018, 0.045, 0.022), 0x3a2a1a);
    handle.position.set(0, 0.015, 0);
    this.knifeGroup.add(handle);

    // Position at right hand, pointing downward (ice-pick grip)
    this.knifeGroup.position.set(0, -0.48, -0.02);
    this.knifeGroup.visible = false;
    this.rightArmGroup.add(this.knifeGroup);
  }

  // ── Shank Ability Animation ───────────────────────────

  protected override getAbilityAnimDuration(abilityId: string): number {
    if (abilityId === 'shank') return 0.7;
    if (abilityId === 'pocket-sand') return 0.6;
    return 0.6;
  }

  protected override animateAbilityUse(abilityId: string, t: number): void {
    if (abilityId === 'shank') this.animateShank(t);
    if (abilityId === 'pocket-sand') this.animatePocketSand(t);
  }

  private sandSpawned = false;

  private animatePocketSand(t: number): void {
    // rotation.x: positive = forward, negative = backward/up
    // rotation.z on right arm: negative = outward, positive = inward

    // Pocket position: arm reaches down to hip pocket
    const pocketX = 0.8;   // arm hangs down
    const pocketZ = -0.6;  // tucked inward

    // Throw position: arm fully extended forward
    const throwX = 1.6;    // arm thrust forward
    const throwZ = 0.3;    // slightly inward

    if (t < 0.15) {
      // Phase 1: Reach into pocket at hip
      const p = t / 0.15;
      const ease = p * p;
      this.rightArmGroup.rotation.x += pocketX * ease;
      this.rightArmGroup.rotation.z += pocketZ * ease;
      this.bodyGroup.rotation.x += 0.08 * ease;
      this.sandSpawned = false;
    } else if (t < 0.30) {
      // Phase 2: Scoop sand, pull arm up to chest, wind up body
      const p = (t - 0.15) / 0.15;
      const ease = p * p * (3 - 2 * p);
      // Arm lifts from pocket to ready position (slight forward lean)
      this.rightArmGroup.rotation.x += pocketX * (1 - ease) + 0.3 * ease;
      this.rightArmGroup.rotation.z += pocketZ * (1 - ease) + (-0.3) * ease;
      this.bodyGroup.rotation.x += 0.08 * (1 - ease * 0.5);
      // Body winds up (rotate torso to the right)
      this.bodyGroup.rotation.y += 0.2 * ease;
    } else if (t < 0.50) {
      // Phase 3: Throw! Explosive forward arm thrust + sand particles
      const p = (t - 0.30) / 0.20;
      const ease = 1 - Math.pow(1 - p, 3); // ease-out snap

      // Right arm thrusts forward
      this.rightArmGroup.rotation.x += 0.3 * (1 - ease) + throwX * ease;
      this.rightArmGroup.rotation.z += -0.3 * (1 - ease) + throwZ * ease;
      // Body lunges forward and unwinds
      this.bodyGroup.rotation.x += 0.04 + 0.15 * ease;
      this.bodyGroup.rotation.y += 0.2 * (1 - ease) + (-0.15) * ease;
      // Left arm counterbalance
      this.leftArmGroup.rotation.x -= 0.3 * ease;
      this.leftArmGroup.rotation.z -= 0.15 * ease;
      // Head tracks forward
      this.headGroup.rotation.x += 0.1 * ease;

      // Spawn sand at the moment of release
      if (!this.sandSpawned && p > 0.3) {
        this.spawnSandParticles();
        this.sandSpawned = true;
      }
    } else {
      // Phase 4: Recovery
      const p = (t - 0.50) / 0.50;
      const ease = p * p * (3 - 2 * p);
      this.rightArmGroup.rotation.x += throwX * (1 - ease);
      this.rightArmGroup.rotation.z += throwZ * (1 - ease);
      this.bodyGroup.rotation.x += 0.19 * (1 - ease);
      this.bodyGroup.rotation.y += -0.15 * (1 - ease);
      this.leftArmGroup.rotation.x -= 0.3 * (1 - ease);
      this.leftArmGroup.rotation.z -= 0.15 * (1 - ease);
      this.headGroup.rotation.x += 0.1 * (1 - ease);
    }
  }

  private spawnSandParticles(): void {
    // Get right hand world position as the spawn point
    const handPos = new THREE.Vector3();
    this.rightArmGroup.getWorldPosition(handPos);

    // Parent mesh (PlayerController.mesh / RemoteEntity.mesh) holds the facing rotation
    const parent = this.group.parent;
    if (!parent) return;
    const scene = parent.parent; // mesh -> scene
    if (!scene) return;

    // Forward direction from mesh rotation (same convention as Engine.ts)
    const rotY = parent.rotation.y;
    const forward = new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY));

    // Spawn a burst of sand grains
    const count = 20;
    const geo = new THREE.SphereGeometry(0.02, 4, 4);

    for (let i = 0; i < count; i++) {
      const sandColors = [0xc2a34f, 0xd4b96a, 0xa88c3a, 0xe0c878, 0x9b7d2e];
      const color = sandColors[Math.floor(Math.random() * sandColors.length)];
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
      const mesh = new THREE.Mesh(geo, mat);

      // Start at hand position, offset slightly forward
      mesh.position.copy(handPos);
      mesh.position.y += 0.1 + Math.random() * 0.2;
      mesh.position.addScaledVector(forward, 0.2);

      // Random scale for variety
      const s = 0.5 + Math.random() * 1.5;
      mesh.scale.setScalar(s);

      // Velocity: primarily forward with spread
      const spread = 0.4;
      const vel = forward.clone().multiplyScalar(2.5 + Math.random() * 1.5);
      vel.x += (Math.random() - 0.5) * spread;
      vel.y += Math.random() * 1.0 + 0.3;
      vel.z += (Math.random() - 0.5) * spread;

      scene.add(mesh);
      this.sandParticles.push({ mesh, vel, life: 0.5 + Math.random() * 0.3 });
    }
  }

  private animateShank(t: number): void {
    // Pocket position: arm hangs at side of torso, tucked inward
    const pocketX = -0.5;  // drop down from guard
    const pocketZ = -0.8;  // tuck inward against body
    // Stab position: arm forward at chest height, slightly inward
    const stabX = 0;
    const stabZ = -0.2;

    if (t < 0.13) {
      // Phase 1: Reach down to pocket at side of torso
      const p = t / 0.13;
      const ease = p * p;
      this.rightArmGroup.rotation.x += pocketX * ease;
      this.rightArmGroup.rotation.z += pocketZ * ease;
      this.bodyGroup.rotation.x += 0.05 * ease;
      this.knifeGroup.visible = false;
    } else if (t < 0.25) {
      // Phase 2: Draw knife — arm comes up from pocket to stab position
      const p = (t - 0.13) / 0.12;
      const ease = 1 - Math.pow(1 - p, 3); // ease-out
      this.knifeGroup.visible = true;
      this.rightArmGroup.rotation.x += pocketX * (1 - ease) + stabX * ease;
      this.rightArmGroup.rotation.z += pocketZ * (1 - ease) + stabZ * ease;
      this.bodyGroup.rotation.x += 0.05 + 0.08 * ease;
    } else if (t < 0.60) {
      // Phase 3: 3 rapid forward stabs
      const stabPhase = (t - 0.25) / 0.35;
      const stabCount = 3;
      const stabCycle = stabPhase * stabCount;
      const inStab = stabCycle % 1;
      let stabExtend: number;
      if (inStab < 0.3) {
        stabExtend = (inStab / 0.3);
        stabExtend = stabExtend * stabExtend * (3 - 2 * stabExtend);
      } else if (inStab < 0.4) {
        stabExtend = 1;
      } else {
        stabExtend = 1 - (inStab - 0.4) / 0.6;
      }

      this.knifeGroup.visible = true;
      this.rightArmGroup.rotation.x += stabX + 0.5 * stabExtend;
      this.rightArmGroup.rotation.z += stabZ;
      this.bodyGroup.rotation.x += 0.13 + 0.06 * stabExtend;

      const stabIndex = Math.floor(stabCycle);
      this.bodyGroup.rotation.y += (stabIndex % 2 === 0 ? 1 : -1) * 0.06 * stabExtend;

      this.leftArmGroup.rotation.x -= 0.3 * stabExtend;
      this.leftArmGroup.rotation.z += 0.15;
    } else if (t < 0.78) {
      // Phase 4: Sheathe — arm drops back down to pocket
      const p = (t - 0.60) / 0.18;
      const ease = p * p * (3 - 2 * p);
      this.knifeGroup.visible = ease < 0.6;
      this.rightArmGroup.rotation.x += stabX * (1 - ease) + pocketX * ease;
      this.rightArmGroup.rotation.z += stabZ * (1 - ease) + pocketZ * ease;
      this.bodyGroup.rotation.x += 0.13 * (1 - ease);
    } else {
      // Phase 5: Return — arm comes back up to normal guard
      const p = (t - 0.78) / 0.22;
      const ease = p * p * (3 - 2 * p);
      this.rightArmGroup.rotation.x += pocketX * (1 - ease);
      this.rightArmGroup.rotation.z += pocketZ * (1 - ease);
    }
  }
}
