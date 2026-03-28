import * as THREE from 'three';
import { BULLET_SPEED } from '@gtr/shared';
import { CharacterModel, AnimationInput } from './CharacterModel';

// ── Colour palette ──
const SKIN       = 0x5c3a1e;  // rich dark brown skin
const SKIN_LIGHT = 0x6b4527;  // lighter highlights (palms, inner arm)
const SKIN_DARK  = 0x4a2e16;  // darker shade (creases, under chin)
const AFRO       = 0x1a1008;  // very dark brown-black afro
const AFRO_HIGHLIGHT = 0x2a1a10; // subtle warm highlight in afro
const EYE_WHITE  = 0xf5f0e8;
const PUPIL      = 0x1a0e06;  // deep dark brown iris
const EYEBROW    = 0x1a1008;
const LIP        = 0x6b3020;  // full lips
const TEETH      = 0xf8f4f0;
const GOLD_TOOTH = 0xffd700;  // gold grillz
const TANK_TOP   = 0xf0ede8;  // slightly off-white wifebeater
const JEANS      = 0x3a4a6a;  // dark denim blue
const JEANS_DARK = 0x2a3a5a;  // darker denim folds
const BELT       = 0x2a1a0a;  // dark leather belt
const BUCKLE     = 0xffd700;  // gold belt buckle
const GOLD       = 0xffd700;  // gold chain
const GOLD_DARK  = 0xccaa00;  // gold shadow
const BANDANA    = 0xcc2222;  // red bandana
const BANDANA_DARK = 0x991818;
const SNEAKER    = 0xf8f8f8;  // fresh white kicks
const SNEAKER_SOLE = 0xe0e0e0;
const SNEAKER_ACCENT = 0xcc2222; // red accents matching bandana
const HEART      = 0xff3355;  // heart pendant
const TEDDY_BODY = 0xb8865a;  // teddy bear brown
const TEDDY_SNOUT = 0xd4a87a;
const TEDDY_NOSE = 0x2a1a0a;
const TEDDY_EYE  = 0x111111;
const TEDDY_BOW  = 0xcc2222;  // red bow tie on teddy
const WATCH      = 0xffd700;  // gold watch
const WATCH_FACE = 0x111111;
const PISTOL_BODY = 0x222222; // dark gunmetal
const PISTOL_SLIDE = 0x333333; // slightly lighter slide
const PISTOL_GRIP = 0x1a1008; // dark wood/rubber grip
const PISTOL_ACCENT = 0xffd700; // gold accents (matching Brad's bling)

const BULLET_COLOR = 0xccaa00;

export class BradClemons extends CharacterModel {
  // Swagger idle state
  private swaggerPhase = 0;
  private swaggerSpeed = 0.4; // slow confident sway

  // Teddy bear group (left hand)
  private declare teddyGroup: THREE.Group;
  // Pistol group (right hand)
  private declare pistolGroup: THREE.Group;

  // Bullet projectile + trail
  private bulletGroup: THREE.Group | null = null;
  private bulletHead: THREE.Mesh | null = null;
  private bulletTrail: THREE.Mesh | null = null;
  private trailSegments: { mesh: THREE.Mesh; life: number }[] = [];
  private bulletActive = false;
  private bulletLaunched = false; // reset per swing, ensures exactly one launch
  private bulletVelocity = new THREE.Vector3();
  private bulletTime = 0;
  private bulletMaxTime = 0;
  private static readonly TRAIL_SPAWN_INTERVAL = 0.015;
  private trailSpawnTimer = 0;
  private static readonly TRAIL_SEGMENT_LIFE = 0.15; // seconds each trail segment lingers


  constructor() {
    super('brad-clemons');
  }

  protected buildModel(): void {
    // Brad is BIG — wider shoulders, higher head for the afro volume
    this.leftArmGroup.position.set(-0.32, 1.28, 0);
    this.rightArmGroup.position.set(0.32, 1.28, 0);
    this.headGroup.position.set(0, 1.44, 0);
    // Wider hip stance
    this.leftLegGroup.position.set(-0.14, 0.78, 0);
    this.rightLegGroup.position.set(0.14, 0.78, 0);

    this.buildHead();
    this.buildTorso();
    this.buildArms();
    this.buildLegs();
    this.buildChain();
    this.buildTeddyBear();
    this.buildPistol();
  }

  // ── HEAD ──────────────────────────────────────────────────

  private buildHead(): void {
    // Big round head
    const head = this.createMesh(new THREE.SphereGeometry(0.19, 12, 10), SKIN);
    head.position.set(0, 0.08, 0);
    head.scale.set(1.05, 1.0, 1.0);
    this.headGroup.add(head);

    // Jaw / chin — wider, stronger jaw
    const jaw = this.createMesh(new THREE.SphereGeometry(0.14, 10, 8), SKIN);
    jaw.position.set(0, -0.04, -0.04);
    jaw.scale.set(1.15, 0.55, 0.9);
    this.headGroup.add(jaw);

    // ── Afro ──
    this.buildAfro();

    // ── Red bandana (under the afro, visible at forehead) ──
    const bandana = this.createMesh(
      new THREE.CylinderGeometry(0.205, 0.2, 0.06, 14),
      BANDANA, { roughness: 0.8 },
    );
    bandana.position.set(0, 0.14, -0.01);
    this.headGroup.add(bandana);

    // Bandana knot hanging on right side
    const knot = this.createMesh(new THREE.SphereGeometry(0.03, 6, 6), BANDANA_DARK);
    knot.position.set(0.2, 0.12, -0.04);
    this.headGroup.add(knot);
    // Bandana tails hanging from knot
    for (let i = 0; i < 2; i++) {
      const tail = this.createMesh(
        new THREE.CylinderGeometry(0.015, 0.008, 0.12, 5),
        i === 0 ? BANDANA : BANDANA_DARK,
      );
      tail.position.set(0.22 + i * 0.015, 0.06, -0.04 + i * 0.02);
      tail.rotation.z = -0.4 - i * 0.15;
      tail.rotation.x = 0.1;
      this.headGroup.add(tail);
    }

    // ── Eyes — warm, kind eyes ──
    const eyeGeo = new THREE.SphereGeometry(0.035, 8, 8);
    for (const side of [-1, 1]) {
      const eye = this.createMesh(eyeGeo, EYE_WHITE);
      eye.position.set(side * 0.072, 0.09, -0.155);
      this.headGroup.add(eye);

      // Iris
      const iris = this.createMesh(new THREE.SphereGeometry(0.022, 7, 7), 0x3a2010);
      iris.position.set(side * 0.072, 0.09, -0.18);
      this.headGroup.add(iris);

      // Pupil
      const pupil = this.createMesh(new THREE.SphereGeometry(0.013, 6, 6), PUPIL);
      pupil.position.set(side * 0.072, 0.09, -0.19);
      this.headGroup.add(pupil);

      // Pupil highlight (warm glint)
      const glint = this.createMesh(new THREE.SphereGeometry(0.005, 4, 4), 0xffffff);
      glint.position.set(side * 0.072 + 0.005, 0.095, -0.195);
      this.headGroup.add(glint);

      // Upper eyelid
      const lid = this.createMesh(new THREE.SphereGeometry(0.037, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.4), SKIN_DARK);
      lid.position.set(side * 0.072, 0.09, -0.155);
      lid.rotation.x = -0.15;
      this.headGroup.add(lid);

      // Thick eyebrow
      const brow = this.createMesh(new THREE.CapsuleGeometry(0.015, 0.05, 4, 6), EYEBROW);
      brow.position.set(side * 0.072, 0.135, -0.15);
      brow.rotation.z = side * 0.15;
      brow.scale.set(1, 1, 0.6);
      this.headGroup.add(brow);
    }

    // ── Broad nose ──
    const noseBridge = this.createMesh(new THREE.CapsuleGeometry(0.022, 0.03, 5, 6), SKIN_DARK);
    noseBridge.position.set(0, 0.06, -0.16);
    this.headGroup.add(noseBridge);

    // Wide nostrils
    const nostrilBase = this.createMesh(new THREE.SphereGeometry(0.035, 7, 6), SKIN);
    nostrilBase.position.set(0, 0.03, -0.17);
    nostrilBase.scale.set(1.4, 0.7, 1.0);
    this.headGroup.add(nostrilBase);

    // Nostril holes
    for (const side of [-1, 1]) {
      const nostril = this.createMesh(new THREE.SphereGeometry(0.01, 5, 5), SKIN_DARK);
      nostril.position.set(side * 0.025, 0.02, -0.19);
      this.headGroup.add(nostril);
    }

    // ── Full lips — slight warm smile ──
    // Upper lip
    const upperLip = this.createMesh(new THREE.CapsuleGeometry(0.012, 0.045, 5, 6), LIP);
    upperLip.position.set(0, -0.01, -0.17);
    upperLip.rotation.z = Math.PI / 2;
    upperLip.scale.set(1, 1, 0.7);
    this.headGroup.add(upperLip);

    // Lower lip — fuller
    const lowerLip = this.createMesh(new THREE.CapsuleGeometry(0.016, 0.04, 5, 6), LIP);
    lowerLip.position.set(0, -0.03, -0.165);
    lowerLip.rotation.z = Math.PI / 2;
    lowerLip.scale.set(1, 1, 0.7);
    this.headGroup.add(lowerLip);

    // Teeth showing in smile
    const teeth = this.createMesh(new THREE.BoxGeometry(0.05, 0.012, 0.01), TEETH);
    teeth.position.set(0, -0.015, -0.172);
    this.headGroup.add(teeth);

    // Gold tooth (front left)
    const goldTooth = this.createMesh(new THREE.BoxGeometry(0.012, 0.012, 0.011), GOLD_TOOTH, { metalness: 0.8, roughness: 0.2 });
    goldTooth.position.set(-0.01, -0.015, -0.173);
    this.headGroup.add(goldTooth);

    // Smile creases
    for (const side of [-1, 1]) {
      const crease = this.createMesh(
        new THREE.CylinderGeometry(0.004, 0.004, 0.04, 4),
        SKIN_DARK,
      );
      crease.position.set(side * 0.055, -0.01, -0.155);
      crease.rotation.z = side * 0.6;
      this.headGroup.add(crease);
    }

    // ── Ears ──
    for (const side of [-1, 1]) {
      const ear = this.createMesh(new THREE.SphereGeometry(0.04, 6, 6), SKIN);
      ear.position.set(side * 0.19, 0.06, 0);
      ear.scale.set(0.45, 1.0, 0.8);
      this.headGroup.add(ear);

      // Earlobe
      const lobe = this.createMesh(new THREE.SphereGeometry(0.02, 5, 5), SKIN);
      lobe.position.set(side * 0.19, 0.02, 0);
      this.headGroup.add(lobe);

      // Gold stud earring
      const stud = this.createMesh(new THREE.SphereGeometry(0.012, 5, 5), GOLD, { metalness: 0.9, roughness: 0.1 });
      stud.position.set(side * 0.2, 0.02, -0.01);
      this.headGroup.add(stud);
    }

    // ── Goatee (short, trimmed) ──
    const goatee = this.createMesh(new THREE.SphereGeometry(0.04, 7, 6), AFRO, { roughness: 0.95 });
    goatee.position.set(0, -0.06, -0.14);
    goatee.scale.set(1.2, 1.0, 0.7);
    this.headGroup.add(goatee);

    // Chin patch connecting to goatee
    const chinPatch = this.createMesh(new THREE.CylinderGeometry(0.025, 0.035, 0.03, 6), AFRO, { roughness: 0.95 });
    chinPatch.position.set(0, -0.08, -0.12);
    this.headGroup.add(chinPatch);

    // Thin mustache
    const mustache = this.createMesh(new THREE.CapsuleGeometry(0.008, 0.05, 4, 6), AFRO, { roughness: 0.95 });
    mustache.position.set(0, 0.0, -0.175);
    mustache.rotation.z = Math.PI / 2;
    this.headGroup.add(mustache);
  }

  private buildAfro(): void {
    // Core afro volume — sits on TOP of the head, above the bandana line
    // Head center is at y=0.08, bandana at y=0.14, so afro starts above ~0.18
    const coreGeo = new THREE.SphereGeometry(0.26, 14, 12);
    const core = this.createMesh(coreGeo, AFRO, { roughness: 1.0, metalness: 0 });
    core.position.set(0, 0.32, 0.02);
    core.scale.set(1.1, 0.9, 1.05);
    this.headGroup.add(core);

    // Afro highlight layer
    const highlightGeo = new THREE.SphereGeometry(0.265, 12, 10);
    const highlight = this.createMesh(highlightGeo, AFRO_HIGHLIGHT, { roughness: 1.0, metalness: 0 });
    highlight.position.set(0, 0.33, 0.02);
    highlight.scale.set(1.08, 0.88, 1.02);
    this.headGroup.add(highlight);

    // Afro texture bumps — all above the bandana/forehead line (y >= 0.18)
    const bumpGeo = new THREE.SphereGeometry(0.05, 5, 4);
    const positions = [
      // Top crown
      { x: 0, y: 0.54, z: 0.02 },
      { x: -0.08, y: 0.52, z: -0.02 },
      { x: 0.08, y: 0.52, z: -0.02 },
      { x: -0.05, y: 0.53, z: 0.08 },
      { x: 0.05, y: 0.53, z: 0.08 },
      // Upper ring
      { x: -0.2, y: 0.44, z: -0.04 },
      { x: 0.2, y: 0.44, z: -0.04 },
      { x: -0.22, y: 0.42, z: 0.06 },
      { x: 0.22, y: 0.42, z: 0.06 },
      { x: 0, y: 0.44, z: 0.2 },
      { x: -0.14, y: 0.46, z: 0.16 },
      { x: 0.14, y: 0.46, z: 0.16 },
      // Mid ring — widest part, at sides and back only (not covering face)
      { x: -0.28, y: 0.32, z: 0.02 },
      { x: 0.28, y: 0.32, z: 0.02 },
      { x: -0.26, y: 0.32, z: 0.12 },
      { x: 0.26, y: 0.32, z: 0.12 },
      { x: 0, y: 0.32, z: 0.28 },
      { x: -0.18, y: 0.32, z: 0.22 },
      { x: 0.18, y: 0.32, z: 0.22 },
      // Side volume (above ears, doesn't wrap to face)
      { x: -0.27, y: 0.24, z: 0.06 },
      { x: 0.27, y: 0.24, z: 0.06 },
      { x: -0.24, y: 0.24, z: 0.16 },
      { x: 0.24, y: 0.24, z: 0.16 },
      // Back volume
      { x: -0.15, y: 0.22, z: 0.22 },
      { x: 0.15, y: 0.22, z: 0.22 },
      { x: 0, y: 0.22, z: 0.26 },
      { x: 0, y: 0.38, z: 0.24 },
      { x: -0.1, y: 0.36, z: 0.22 },
      { x: 0.1, y: 0.36, z: 0.22 },
    ];

    for (const p of positions) {
      const bump = this.createMesh(bumpGeo, Math.random() > 0.3 ? AFRO : AFRO_HIGHLIGHT, { roughness: 1.0 });
      bump.position.set(p.x, p.y, p.z);
      const s = 0.7 + Math.random() * 0.5;
      bump.scale.set(s, s * (0.8 + Math.random() * 0.4), s);
      this.headGroup.add(bump);
    }

    // Hair pick stuck in the left side of the afro
    const pickHandle = this.createMesh(
      new THREE.CylinderGeometry(0.008, 0.008, 0.12, 5),
      0x222222,
    );
    pickHandle.position.set(-0.26, 0.34, 0.04);
    pickHandle.rotation.z = 0.5;
    pickHandle.rotation.x = 0.2;
    this.headGroup.add(pickHandle);

    // Pick teeth (fist-pick style handle)
    const fist = this.createMesh(new THREE.SphereGeometry(0.02, 6, 6), 0x222222);
    fist.position.set(-0.3, 0.28, 0.04);
    this.headGroup.add(fist);
  }

  // ── TORSO ─────────────────────────────────────────────────

  private buildTorso(): void {
    // Broad, muscular torso — uses spheres/capsules for rounded shape
    // Upper chest — wide, barrel-chested
    const chest = this.createMesh(
      new THREE.SphereGeometry(0.26, 12, 10),
      TANK_TOP, { roughness: 0.85 },
    );
    chest.position.set(0, 1.1, 0);
    chest.scale.set(1.0, 0.85, 0.7);
    this.bodyGroup.add(chest);

    // Lower torso / belly — slightly rounded, big guy
    const belly = this.createMesh(
      new THREE.SphereGeometry(0.24, 12, 10),
      TANK_TOP, { roughness: 0.85 },
    );
    belly.position.set(0, 0.9, -0.01);
    belly.scale.set(0.95, 0.7, 0.7);
    this.bodyGroup.add(belly);

    // Tank top straps
    for (const side of [-1, 1]) {
      const strap = this.createMesh(
        new THREE.CapsuleGeometry(0.025, 0.14, 4, 6),
        TANK_TOP, { roughness: 0.85 },
      );
      strap.position.set(side * 0.1, 1.28, -0.04);
      strap.rotation.z = side * 0.12;
      this.bodyGroup.add(strap);
    }

    // Tank top neckline (rounded)
    const neckline = this.createMesh(
      new THREE.TorusGeometry(0.12, 0.015, 6, 12, Math.PI),
      TANK_TOP,
    );
    neckline.position.set(0, 1.22, -0.1);
    neckline.rotation.x = -0.2;
    neckline.rotation.z = Math.PI;
    this.bodyGroup.add(neckline);

    // Visible skin at neckline / upper chest
    const upperSkin = this.createMesh(
      new THREE.SphereGeometry(0.12, 8, 6),
      SKIN,
    );
    upperSkin.position.set(0, 1.24, -0.06);
    upperSkin.scale.set(1.0, 0.5, 0.5);
    this.bodyGroup.add(upperSkin);

    // Neck — thick
    const neck = this.createMesh(
      new THREE.CylinderGeometry(0.09, 0.1, 0.12, 8),
      SKIN,
    );
    neck.position.set(0, 1.36, 0);
    this.bodyGroup.add(neck);

    // Shoulders — big rounded deltoids
    for (const side of [-1, 1]) {
      const shoulder = this.createMesh(
        new THREE.SphereGeometry(0.1, 8, 8),
        SKIN,
      );
      shoulder.position.set(side * 0.28, 1.26, 0);
      shoulder.scale.set(1.0, 0.8, 0.9);
      this.bodyGroup.add(shoulder);
    }

    // Belt
    const belt = this.createMesh(
      new THREE.TorusGeometry(0.24, 0.025, 6, 14),
      BELT,
    );
    belt.position.set(0, 0.78, 0);
    belt.rotation.x = Math.PI / 2;
    belt.scale.set(1.0, 0.65, 1);
    this.bodyGroup.add(belt);

    // Gold belt buckle — big and flashy
    const buckle = this.createMesh(
      new THREE.CylinderGeometry(0.04, 0.04, 0.02, 8),
      BUCKLE, { metalness: 0.85, roughness: 0.15 },
    );
    buckle.position.set(0, 0.78, -0.17);
    buckle.rotation.x = Math.PI / 2;
    this.bodyGroup.add(buckle);

    // Buckle center gem
    const gem = this.createMesh(
      new THREE.SphereGeometry(0.015, 6, 6),
      0xcc2222, { metalness: 0.3, roughness: 0.3 },
    );
    gem.position.set(0, 0.78, -0.185);
    this.bodyGroup.add(gem);
  }

  // ── ARMS ──────────────────────────────────────────────────

  private buildArms(): void {
    this.buildArm(-1); // left
    this.buildArm(1);  // right
  }

  private buildArm(side: number): void {
    const armGroup = side < 0 ? this.leftArmGroup : this.rightArmGroup;

    // Big bicep — rounded, muscular
    const bicep = this.createMesh(
      new THREE.CapsuleGeometry(0.075, 0.18, 6, 8),
      SKIN,
    );
    bicep.position.set(0, -0.14, 0);
    bicep.scale.set(1.0, 1.0, 0.9);
    armGroup.add(bicep);

    // Forearm — slightly thinner, still beefy
    const forearm = this.createMesh(
      new THREE.CapsuleGeometry(0.06, 0.2, 6, 8),
      SKIN,
    );
    forearm.position.set(0, -0.38, 0);
    forearm.scale.set(1.0, 1.0, 0.9);
    armGroup.add(forearm);

    // Elbow
    const elbow = this.createMesh(new THREE.SphereGeometry(0.06, 6, 6), SKIN);
    elbow.position.set(0, -0.25, 0.02);
    elbow.scale.set(0.9, 0.7, 0.9);
    armGroup.add(elbow);

    // Hand — big, meaty
    const hand = this.createMesh(new THREE.SphereGeometry(0.06, 7, 7), SKIN_LIGHT);
    hand.position.set(0, -0.55, -0.01);
    hand.scale.set(0.85, 1.1, 0.7);
    armGroup.add(hand);

    // Fingers
    const fingerGeo = new THREE.CapsuleGeometry(0.013, 0.04, 3, 5);
    if (side > 0) {
      // Right hand — fingers curled around pistol grip
      for (let i = 0; i < 4; i++) {
        const finger = this.createMesh(fingerGeo, SKIN_LIGHT);
        const spread = (i - 1.5) * 0.017;
        finger.position.set(spread, -0.59, -0.03);
        finger.rotation.x = 1.2; // tightly curled around grip
        armGroup.add(finger);
      }
      // Thumb wraps on the opposite side of the grip
      const thumb = this.createMesh(
        new THREE.CapsuleGeometry(0.014, 0.035, 3, 5),
        SKIN_LIGHT,
      );
      thumb.position.set(0.04, -0.56, -0.02);
      thumb.rotation.x = 0.6;
      thumb.rotation.z = -0.8;
      armGroup.add(thumb);
    } else {
      // Left hand — open relaxed fingers (holding teddy)
      for (let i = 0; i < 4; i++) {
        const finger = this.createMesh(fingerGeo, SKIN_LIGHT);
        const spread = (i - 1.5) * 0.017;
        finger.position.set(spread, -0.61, -0.02);
        finger.rotation.x = 0.35;
        armGroup.add(finger);
      }
      // Thumb
      const thumb = this.createMesh(
        new THREE.CapsuleGeometry(0.014, 0.035, 3, 5),
        SKIN_LIGHT,
      );
      thumb.position.set(side * 0.035, -0.57, -0.03);
      thumb.rotation.x = 0.3;
      thumb.rotation.z = -side * 0.5;
      armGroup.add(thumb);
    }

    // Gold watch on left wrist
    if (side < 0) {
      const watchBand = this.createMesh(
        new THREE.TorusGeometry(0.055, 0.015, 6, 10),
        WATCH, { metalness: 0.85, roughness: 0.15 },
      );
      watchBand.position.set(0, -0.48, 0);
      watchBand.rotation.x = Math.PI / 2;
      armGroup.add(watchBand);

      const watchFace = this.createMesh(
        new THREE.CylinderGeometry(0.03, 0.03, 0.015, 8),
        WATCH_FACE,
      );
      watchFace.position.set(0, -0.48, -0.05);
      watchFace.rotation.x = Math.PI / 2;
      armGroup.add(watchFace);

      // Watch bezel
      const bezel = this.createMesh(
        new THREE.TorusGeometry(0.032, 0.005, 6, 10),
        WATCH, { metalness: 0.9, roughness: 0.1 },
      );
      bezel.position.set(0, -0.48, -0.055);
      armGroup.add(bezel);
    }

    // Gold ring on right ring finger
    if (side > 0) {
      const ring = this.createMesh(
        new THREE.TorusGeometry(0.015, 0.005, 5, 8),
        GOLD, { metalness: 0.9, roughness: 0.1 },
      );
      ring.position.set(-0.01, -0.6, -0.02);
      ring.rotation.x = Math.PI / 2;
      armGroup.add(ring);
    }
  }

  // ── LEGS ──────────────────────────────────────────────────

  private buildLegs(): void {
    this.buildLeg(-1);
    this.buildLeg(1);
  }

  private buildLeg(side: number): void {
    const legGroup = side < 0 ? this.leftLegGroup : this.rightLegGroup;

    // Upper leg — baggy jeans, rounded
    const thigh = this.createMesh(
      new THREE.CapsuleGeometry(0.09, 0.22, 7, 8),
      JEANS, { roughness: 0.9 },
    );
    thigh.position.set(0, -0.17, 0);
    thigh.scale.set(1.0, 1.0, 0.85);
    legGroup.add(thigh);

    // Knee area — baggy fold
    const knee = this.createMesh(
      new THREE.SphereGeometry(0.085, 7, 6),
      JEANS_DARK, { roughness: 0.9 },
    );
    knee.position.set(0, -0.33, -0.01);
    knee.scale.set(0.9, 0.6, 0.9);
    legGroup.add(knee);

    // Lower leg — baggy jeans stacking at ankle
    const shin = this.createMesh(
      new THREE.CapsuleGeometry(0.08, 0.22, 7, 8),
      JEANS, { roughness: 0.9 },
    );
    shin.position.set(0, -0.5, 0);
    shin.scale.set(1.0, 1.0, 0.85);
    legGroup.add(shin);

    // Jean cuff stacking (fabric bunching at ankle)
    const cuff = this.createMesh(
      new THREE.TorusGeometry(0.08, 0.02, 6, 10),
      JEANS_DARK, { roughness: 0.9 },
    );
    cuff.position.set(0, -0.62, 0);
    cuff.rotation.x = Math.PI / 2;
    legGroup.add(cuff);

    // Extra jean fold
    const fold = this.createMesh(
      new THREE.TorusGeometry(0.075, 0.015, 6, 10),
      JEANS, { roughness: 0.9 },
    );
    fold.position.set(0, -0.58, 0);
    fold.rotation.x = Math.PI / 2;
    legGroup.add(fold);

    // ── Fresh sneakers ──
    // Shoe body — rounded, chunky sneaker
    const shoeBody = this.createMesh(
      new THREE.CapsuleGeometry(0.065, 0.08, 6, 8),
      SNEAKER, { roughness: 0.3 },
    );
    shoeBody.position.set(0, -0.72, -0.02);
    shoeBody.rotation.x = Math.PI / 2;
    shoeBody.scale.set(1.0, 1.3, 0.8);
    legGroup.add(shoeBody);

    // Sole — darker, thicker
    const sole = this.createMesh(
      new THREE.CapsuleGeometry(0.07, 0.09, 6, 8),
      SNEAKER_SOLE, { roughness: 0.6 },
    );
    sole.position.set(0, -0.76, -0.02);
    sole.rotation.x = Math.PI / 2;
    sole.scale.set(1.0, 1.2, 0.5);
    legGroup.add(sole);

    // Sneaker accent stripe
    const stripe = this.createMesh(
      new THREE.CapsuleGeometry(0.01, 0.07, 3, 5),
      SNEAKER_ACCENT,
    );
    stripe.position.set(side * 0.06, -0.72, -0.02);
    stripe.rotation.x = Math.PI / 2;
    stripe.scale.set(0.5, 1.0, 1.0);
    legGroup.add(stripe);

    // Lace area
    const laces = this.createMesh(
      new THREE.BoxGeometry(0.03, 0.02, 0.06),
      0xdddddd,
    );
    laces.position.set(0, -0.69, -0.06);
    legGroup.add(laces);
  }

  // ── GOLD CHAIN ────────────────────────────────────────────

  private buildChain(): void {
    // Full necklace loop around the neck — a tilted torus so the front
    // drapes down onto the chest while the back sits at the nape.
    // Neck is at y≈1.36, chest front is at y≈1.14.
    // Tilt forward so the front hangs lower than the back.
    const chainBand = this.createMesh(
      new THREE.TorusGeometry(0.14, 0.008, 8, 28),
      GOLD, { metalness: 0.9, roughness: 0.1 },
    );
    chainBand.position.set(0, 1.30, -0.02);
    chainBand.rotation.x = Math.PI / 2 - 0.35; // tilted forward so front hangs lower
    this.bodyGroup.add(chainBand);

    // Second chain loop slightly lower for a thicker/layered look
    const chainBand2 = this.createMesh(
      new THREE.TorusGeometry(0.145, 0.006, 8, 28),
      GOLD_DARK, { metalness: 0.85, roughness: 0.15 },
    );
    chainBand2.position.set(0, 1.29, -0.02);
    chainBand2.rotation.x = Math.PI / 2 - 0.35;
    this.bodyGroup.add(chainBand2);

    // Heart pendant hanging from the front-lowest point of the chain.
    // With the tilt, the front-bottom of the torus is at roughly:
    //   y ≈ 1.24 - 0.14*cos(0.35) ≈ 1.24 - 0.13 ≈ 1.11
    //   z ≈ -0.02 - 0.14*sin(0.35) ≈ -0.02 - 0.05 ≈ -0.07
    // But the chest surface is at z ≈ -0.17, so push pendant onto the chest.
    const heartGroup = new THREE.Group();

    const heartLeft = this.createMesh(new THREE.SphereGeometry(0.025, 7, 7), HEART, { metalness: 0.3, roughness: 0.4 });
    heartLeft.position.set(-0.015, 0, 0);
    heartGroup.add(heartLeft);

    const heartRight = this.createMesh(new THREE.SphereGeometry(0.025, 7, 7), HEART, { metalness: 0.3, roughness: 0.4 });
    heartRight.position.set(0.015, 0, 0);
    heartGroup.add(heartRight);

    const heartPoint = this.createMesh(
      new THREE.ConeGeometry(0.032, 0.05, 6),
      HEART, { metalness: 0.3, roughness: 0.4 },
    );
    heartPoint.position.set(0, -0.03, 0);
    heartPoint.rotation.z = Math.PI;
    heartGroup.add(heartPoint);

    const heartOutline = this.createMesh(
      new THREE.TorusGeometry(0.035, 0.004, 5, 8),
      GOLD, { metalness: 0.9, roughness: 0.1 },
    );
    heartOutline.position.set(0, -0.005, 0);
    heartGroup.add(heartOutline);

    heartGroup.position.set(0, 1.13, -0.17);
    this.bodyGroup.add(heartGroup);
  }

  // ── TEDDY BEAR (left hand) ────────────────────────────────

  private buildTeddyBear(): void {
    this.teddyGroup = new THREE.Group();

    // Teddy body — round and huggable
    const body = this.createMesh(
      new THREE.SphereGeometry(0.06, 8, 8),
      TEDDY_BODY, { roughness: 0.95 },
    );
    body.scale.set(0.9, 1.1, 0.8);
    this.teddyGroup.add(body);

    // Teddy head
    const head = this.createMesh(
      new THREE.SphereGeometry(0.045, 8, 8),
      TEDDY_BODY, { roughness: 0.95 },
    );
    head.position.set(0, 0.09, -0.01);
    this.teddyGroup.add(head);

    // Ears
    for (const side of [-1, 1]) {
      const ear = this.createMesh(new THREE.SphereGeometry(0.02, 5, 5), TEDDY_BODY, { roughness: 0.95 });
      ear.position.set(side * 0.035, 0.13, 0);
      this.teddyGroup.add(ear);

      const innerEar = this.createMesh(new THREE.SphereGeometry(0.012, 5, 5), TEDDY_SNOUT);
      innerEar.position.set(side * 0.035, 0.13, -0.008);
      this.teddyGroup.add(innerEar);
    }

    // Snout
    const snout = this.createMesh(new THREE.SphereGeometry(0.025, 6, 6), TEDDY_SNOUT, { roughness: 0.9 });
    snout.position.set(0, 0.07, -0.035);
    snout.scale.set(1, 0.8, 0.8);
    this.teddyGroup.add(snout);

    // Nose
    const nose = this.createMesh(new THREE.SphereGeometry(0.008, 5, 5), TEDDY_NOSE);
    nose.position.set(0, 0.08, -0.05);
    this.teddyGroup.add(nose);

    // Eyes — button eyes
    for (const side of [-1, 1]) {
      const eye = this.createMesh(new THREE.SphereGeometry(0.007, 5, 5), TEDDY_EYE);
      eye.position.set(side * 0.018, 0.1, -0.04);
      this.teddyGroup.add(eye);
    }

    // Teddy arms (stubby)
    for (const side of [-1, 1]) {
      const arm = this.createMesh(
        new THREE.CapsuleGeometry(0.015, 0.03, 3, 5),
        TEDDY_BODY, { roughness: 0.95 },
      );
      arm.position.set(side * 0.055, 0.0, -0.01);
      arm.rotation.z = side * 0.8;
      this.teddyGroup.add(arm);
    }

    // Teddy legs (stubby)
    for (const side of [-1, 1]) {
      const leg = this.createMesh(
        new THREE.CapsuleGeometry(0.018, 0.025, 3, 5),
        TEDDY_BODY, { roughness: 0.95 },
      );
      leg.position.set(side * 0.025, -0.07, 0);
      this.teddyGroup.add(leg);
    }

    // Red bow tie
    // Left bow lobe
    const bowLeft = this.createMesh(new THREE.SphereGeometry(0.015, 5, 5), TEDDY_BOW);
    bowLeft.position.set(-0.015, 0.055, -0.03);
    bowLeft.scale.set(1.3, 0.8, 0.5);
    this.teddyGroup.add(bowLeft);
    // Right bow lobe
    const bowRight = this.createMesh(new THREE.SphereGeometry(0.015, 5, 5), TEDDY_BOW);
    bowRight.position.set(0.015, 0.055, -0.03);
    bowRight.scale.set(1.3, 0.8, 0.5);
    this.teddyGroup.add(bowRight);
    // Bow knot center
    const bowKnot = this.createMesh(new THREE.SphereGeometry(0.006, 4, 4), TEDDY_BOW);
    bowKnot.position.set(0, 0.055, -0.035);
    this.teddyGroup.add(bowKnot);

    // Position teddy so hand grips the neck (neck is at ~y=0.09 in teddy space)
    // Hand is at y=-0.55 in arm space, so offset teddy down: -0.55 - 0.09 = -0.64
    this.teddyGroup.position.set(0, -0.64, -0.04);
    this.teddyGroup.rotation.x = 0.2; // slight tilt toward body
    this.leftArmGroup.add(this.teddyGroup);
  }

  // ── PISTOL (right hand) ────────────────────────────────────
  // Built grip-centric: (0,0,0) = center of where the hand grips.
  // In arm-local space: -Y = down arm, -Z = forward (character facing).
  // Slide/barrel sit above (+Y) and forward (-Z) of the grip.

  private buildPistol(): void {
    this.pistolGroup = new THREE.Group();

    // ── Grip (origin = grip center, hand wraps around this) ──
    const grip = this.createMesh(
      new THREE.BoxGeometry(0.026, 0.07, 0.032),
      PISTOL_GRIP, { roughness: 0.9 },
    );
    grip.position.set(0, 0, 0);
    this.pistolGroup.add(grip);

    // Grip texture lines
    for (let i = 0; i < 3; i++) {
      const line = this.createMesh(
        new THREE.BoxGeometry(0.028, 0.003, 0.030),
        0x0d0806,
      );
      line.position.set(0, 0.015 - i * 0.018, 0);
      this.pistolGroup.add(line);
    }

    // ── Frame / lower receiver (sits above the grip) ──
    const frame = this.createMesh(
      new THREE.BoxGeometry(0.028, 0.028, 0.12),
      PISTOL_BODY, { metalness: 0.6, roughness: 0.35 },
    );
    frame.position.set(0, 0.05, -0.03);
    this.pistolGroup.add(frame);

    // ── Slide (top of the gun, above frame) ──
    const slide = this.createMesh(
      new THREE.BoxGeometry(0.03, 0.03, 0.14),
      PISTOL_SLIDE, { metalness: 0.7, roughness: 0.3 },
    );
    slide.position.set(0, 0.08, -0.04);
    this.pistolGroup.add(slide);

    // ── Barrel (extends forward from slide) ──
    const barrel = this.createMesh(
      new THREE.CylinderGeometry(0.008, 0.008, 0.03, 6),
      PISTOL_BODY, { metalness: 0.8, roughness: 0.2 },
    );
    barrel.position.set(0, 0.08, -0.125);
    barrel.rotation.x = Math.PI / 2;
    this.pistolGroup.add(barrel);

    // Barrel hole (dark)
    const barrelHole = this.createMesh(
      new THREE.CylinderGeometry(0.005, 0.005, 0.005, 6),
      0x000000,
    );
    barrelHole.position.set(0, 0.08, -0.14);
    barrelHole.rotation.x = Math.PI / 2;
    this.pistolGroup.add(barrelHole);

    // ── Trigger guard ──
    const triggerGuard = this.createMesh(
      new THREE.TorusGeometry(0.016, 0.004, 4, 8, Math.PI),
      PISTOL_BODY, { metalness: 0.6, roughness: 0.35 },
    );
    triggerGuard.position.set(0, 0.025, -0.025);
    triggerGuard.rotation.y = Math.PI / 2;
    triggerGuard.rotation.x = Math.PI;
    this.pistolGroup.add(triggerGuard);

    // Trigger
    const trigger = this.createMesh(
      new THREE.BoxGeometry(0.005, 0.018, 0.006),
      PISTOL_BODY, { metalness: 0.7, roughness: 0.3 },
    );
    trigger.position.set(0, 0.03, -0.025);
    this.pistolGroup.add(trigger);

    // ── Gold accent stripe along slide top ──
    const accent = this.createMesh(
      new THREE.BoxGeometry(0.032, 0.004, 0.06),
      PISTOL_ACCENT, { metalness: 0.9, roughness: 0.1 },
    );
    accent.position.set(0, 0.098, -0.05);
    this.pistolGroup.add(accent);

    // Rear sight
    const rearSight = this.createMesh(
      new THREE.BoxGeometry(0.02, 0.008, 0.005),
      PISTOL_BODY, { metalness: 0.7, roughness: 0.3 },
    );
    rearSight.position.set(0, 0.10, 0.02);
    this.pistolGroup.add(rearSight);

    // Front sight
    const frontSight = this.createMesh(
      new THREE.BoxGeometry(0.008, 0.007, 0.005),
      PISTOL_BODY, { metalness: 0.7, roughness: 0.3 },
    );
    frontSight.position.set(0, 0.10, -0.10);
    this.pistolGroup.add(frontSight);

    // Position pistol in the curled fingers, rotated ~60° downward so
    // barrel points toward the ground when the arm hangs at rest.
    this.pistolGroup.position.set(0, -0.60, -0.02);
    this.pistolGroup.rotation.x = -1.05; // ~60° barrel-down
    this.rightArmGroup.add(this.pistolGroup);
  }

  // ── BULLET PROJECTILE ─────────────────────────────────────

  private getScene(): THREE.Object3D {
    // group → PlayerController.mesh → scene
    return this.group.parent!.parent!;
  }

  private ensureBullet(): void {
    if (this.bulletGroup) return;

    this.bulletGroup = new THREE.Group();

    // Bright tracer head
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xffffcc,
      emissive: 0xffeeaa,
      emissiveIntensity: 4,
    });
    this.bulletHead = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), headMat);
    this.bulletGroup.add(this.bulletHead);

    // Elongated streak behind the head (cylinder rotated to lie along -Z local)
    const streakMat = new THREE.MeshStandardMaterial({
      color: BULLET_COLOR,
      emissive: BULLET_COLOR,
      emissiveIntensity: 2.5,
      transparent: true,
      opacity: 0.8,
    });
    this.bulletTrail = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.01, 0.6, 5, 1),
      streakMat,
    );
    // Rotate cylinder so it lies along -Z (behind the head in the group's local space)
    this.bulletTrail.rotation.x = Math.PI / 2;
    this.bulletTrail.position.set(0, 0, 0.3);
    this.bulletGroup.add(this.bulletTrail);

    this.bulletGroup.visible = false;
  }

  private spawnTrailSegment(): void {
    const scene = this.getScene();
    const mat = new THREE.MeshStandardMaterial({
      color: BULLET_COLOR,
      emissive: BULLET_COLOR,
      emissiveIntensity: 1.5,
      transparent: true,
      opacity: 0.45,
    });
    const seg = new THREE.Mesh(new THREE.SphereGeometry(0.04, 4, 3), mat);
    seg.position.copy(this.bulletGroup!.position);
    scene.add(seg);
    this.trailSegments.push({ mesh: seg, life: BradClemons.TRAIL_SEGMENT_LIFE });
  }

  launchBullet(targetWorldPos: THREE.Vector3): void {
    this.ensureBullet();
    const scene = this.getScene();

    // Add to scene (world space) if not already parented
    if (!this.bulletGroup!.parent) {
      scene.add(this.bulletGroup!);
    }

    // Derive start position from parent mesh (per CLAUDE.md: derive forward
    // from parent.rotation.y, not from getWorldDirection or model group).
    const parentMesh = this.group.parent!; // PlayerController.mesh or RemoteEntity.mesh
    const rotY = parentMesh.rotation.y;
    const forward = new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY));
    // Start at shoulder height, slightly forward + right for gun hand
    const right = new THREE.Vector3(forward.z, 0, -forward.x); // perpendicular
    const startPos = parentMesh.position.clone();
    startPos.y += 1.45;            // shoulder height
    startPos.addScaledVector(forward, 0.4); // forward of body
    startPos.addScaledVector(right, 0.2);   // offset to gun-hand side

    this.bulletGroup!.position.copy(startPos);
    this.bulletGroup!.visible = true;

    // Aim at center-of-body, not feet (mesh.position is ground level)
    const aimPos = targetWorldPos.clone();
    aimPos.y += 1.1;

    const dir = new THREE.Vector3().subVectors(aimPos, startPos);
    const dist = dir.length();
    if (dist > 0.01) dir.normalize();
    // Orient bullet group so -Z points along travel direction
    this.bulletGroup!.lookAt(aimPos);

    this.bulletVelocity.copy(dir).multiplyScalar(BULLET_SPEED);
    this.bulletTime = 0;
    this.bulletMaxTime = dist / BULLET_SPEED + 0.05;
    this.bulletActive = true;
    this.trailSpawnTimer = 0;

  }

  // ── ANIMATION ─────────────────────────────────────────────

  protected override onAnimate(dt: number, input: AnimationInput): void {
    // Confident swagger when idle
    if (!input.isMoving && input.isGrounded && !this.isAutoAttacking && !this.stunActive && !this.restingActive) {
      this.swaggerPhase += dt * this.swaggerSpeed;

      const sway = Math.sin(this.swaggerPhase * Math.PI * 2);
      const swaySmooth = sway * (0.85 + 0.15 * Math.abs(sway));

      // Subtle side-to-side body lean
      this.bodyGroup.rotation.z += swaySmooth * 0.03;

      // Head bobs opposite to body — cool nod
      this.headGroup.rotation.z -= swaySmooth * 0.02;
      // Slight head tilt back — confident posture
      this.headGroup.rotation.x -= 0.03;

      // Weight shift to legs
      this.leftLegGroup.rotation.z -= swaySmooth * 0.015;
      this.rightLegGroup.rotation.z += swaySmooth * 0.015;

      // Arms hang with a gentle sway
      this.rightArmGroup.rotation.z -= 0.06; // arm slightly out, relaxed
      this.leftArmGroup.rotation.z += 0.04;  // teddy arm closer to body
      this.rightArmGroup.rotation.x += swaySmooth * 0.02;
      this.leftArmGroup.rotation.x -= swaySmooth * 0.015;

      // Subtle breathing
      const breathe = Math.sin(this.swaggerPhase * Math.PI * 3) * 0.008;
      this.bodyGroup.position.y += breathe;
    }

    // ── Bullet flight + trail update ──
    if (this.bulletActive && this.bulletGroup) {
      this.bulletTime += dt;
      this.bulletGroup.position.addScaledVector(this.bulletVelocity, dt);

      // Spawn trail segments at intervals
      this.trailSpawnTimer += dt;
      if (this.trailSpawnTimer >= BradClemons.TRAIL_SPAWN_INTERVAL) {
        this.trailSpawnTimer -= BradClemons.TRAIL_SPAWN_INTERVAL;
        this.spawnTrailSegment();
      }

      if (this.bulletTime >= this.bulletMaxTime) {
        this.bulletActive = false;
        this.bulletGroup.visible = false;
      }
    }

    // Fade and remove trail segments
    for (let i = this.trailSegments.length - 1; i >= 0; i--) {
      const seg = this.trailSegments[i];
      seg.life -= dt;
      const t = Math.max(0, seg.life / BradClemons.TRAIL_SEGMENT_LIFE);
      (seg.mesh.material as THREE.MeshStandardMaterial).opacity = t * 0.5;
      seg.mesh.scale.setScalar(t);
      if (seg.life <= 0) {
        seg.mesh.removeFromParent();
        seg.mesh.geometry.dispose();
        (seg.mesh.material as THREE.Material).dispose();
        this.trailSegments.splice(i, 1);
      }
    }

  }

  // ── Combat stance — gun drawn, ready to shoot ──
  protected override animateCombatStance(weight: number): void {
    // Right arm raised forward aiming the pistol
    this.rightArmGroup.rotation.x += 1.15 * weight;
    this.rightArmGroup.rotation.z -= 0.15 * weight;

    // Left arm — teddy tucked close, slightly forward
    this.leftArmGroup.rotation.x += 0.3 * weight;
    this.leftArmGroup.rotation.z += 0.15 * weight;

    // Slight forward lean
    this.bodyGroup.rotation.x += 0.04 * weight;

    // Wider stance
    this.leftLegGroup.rotation.z -= 0.04 * weight;
    this.rightLegGroup.rotation.z += 0.04 * weight;
  }

  // ── Attack swing — pistol shot ──
  protected override animateAttackSwing(t: number, _alternateArm: boolean): void {
    // Phase 1 (0–0.15): Quick raise — snap arm up to aim
    if (t < 0.15) {
      const p = t / 0.15;
      const ease = p * p * (3 - 2 * p);
      this.rightArmGroup.rotation.x += 1.35 * ease;
      this.rightArmGroup.rotation.z -= 0.1 * ease;
      this.bodyGroup.rotation.x += 0.03 * ease;
    }
    // Phase 2 (0.15–0.3): Fire + recoil kick
    else if (t < 0.3) {
      const p = (t - 0.15) / 0.15;
      // Arm stays aimed, recoil kicks it up
      this.rightArmGroup.rotation.x += 1.35 + 0.2 * p;
      this.rightArmGroup.rotation.z -= 0.1;
      this.bodyGroup.rotation.x += 0.03 - 0.04 * p; // body leans back from recoil
    }
    // Phase 3 (0.3–1.0): Recovery — return to ready
    else {
      const p = (t - 0.3) / 0.7;
      const fade = 1 - p * p;
      this.rightArmGroup.rotation.x += (1.35 + 0.2 * (1 - p)) * fade;
      this.rightArmGroup.rotation.z -= 0.1 * fade;
      this.bodyGroup.rotation.x += -0.01 * fade;
    }

    // Launch bullet once arm reaches aim position (t >= 0.15)
    if (t >= 0.15 && !this.bulletLaunched && this.swingTargetWorldPos) {
      this.bulletLaunched = true;
      this.launchBullet(this.swingTargetWorldPos);
    }
  }

  override triggerSwing(): void {
    super.triggerSwing();
    this.bulletLaunched = false;
  }

  protected override getSwingDuration(): number {
    return 0.5; // full shoot cycle: raise, fire, recover
  }

  protected override getAbilityAnimDuration(abilityId: string): number {
    if (abilityId === 'pvp-trinket') return 1.0;
    return 0.6;
  }

  protected override animateAbilityUse(abilityId: string, t: number): void {
    if (abilityId === 'pvp-trinket') {
      this.animatePvPTrinket(t);
    }
  }
}
