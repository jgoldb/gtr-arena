import * as THREE from 'three';
import { CharacterModel, type AnimationInput } from './CharacterModel';

// ── Colour palette ──
const SKIN      = 0xf5d0a9;
const SKIN_DARK = 0xd4a574;
const BEARD     = 0xf0f0f0;
const BEARD_TIP = 0xe0e0e0;
const HAIR      = 0x2a2a2a;  // dark hair for payis
const HAT_FUR   = 0x3a2a1a;  // sable-brown streimel fur
const HAT_TOP   = 0x1a1a2a;  // dark velvet crown
const BEKISHE   = 0x0a0a0a;  // black coat
const SUIT      = 0x1a1a2a;  // dark navy suit
const SHIRT     = 0xf8f8f0;  // white shirt
const SHOE      = 0x111111;
const PANTS     = 0x0e0e0e;
const LULAV_STEM   = 0x8db554; // palm green
const LULAV_LEAF   = 0x5a8c2a; // darker green fronds
const LULAV_WILLOW = 0x6b9e3a;
const LULAV_MYRTLE = 0x3d6b2a;
const ESROG     = 0xe8d44d;  // yellow citron
const ESROG_TIP = 0xc4a830;
const EYE_WHITE = 0xfafafa;
const PUPIL     = 0x3a2a1a;
const BUTTON    = 0xc0c0c0;  // silver buttons
const GARTEL    = 0x111111;  // black belt/gartel

export class RabbiZehnwirth extends CharacterModel {
  // Davening (prayer swaying) state
  private davenPhase = 0;
  private davenSpeed = 0.65; // sways per second — slow, meditative
  // Lulav held items
  private lulavGroup!: THREE.Group;
  private esrogMesh!: THREE.Mesh;

  constructor() {
    super('rabbi-zehnwirth');
  }

  protected buildModel(): void {
    this.buildHead();
    this.buildTorso();
    this.buildArms();
    this.buildLegs();
    this.buildLulav();
    this.buildEsrog();
  }

  // ── HEAD ──
  private buildHead(): void {
    // Base head
    const head = this.createMesh(new THREE.SphereGeometry(0.18, 10, 8), SKIN);
    head.position.set(0, 0.05, 0);
    head.scale.set(1, 1.1, 0.95);
    this.headGroup.add(head);

    // Eyes
    const eyeGeo = new THREE.SphereGeometry(0.035, 6, 6);
    const leftEye = this.createMesh(eyeGeo, EYE_WHITE);
    leftEye.position.set(-0.07, 0.07, -0.15);
    this.headGroup.add(leftEye);
    const rightEye = this.createMesh(eyeGeo, EYE_WHITE);
    rightEye.position.set(0.07, 0.07, -0.15);
    this.headGroup.add(rightEye);

    // Pupils
    const pupilGeo = new THREE.SphereGeometry(0.018, 6, 6);
    const leftPupil = this.createMesh(pupilGeo, PUPIL);
    leftPupil.position.set(-0.07, 0.07, -0.17);
    this.headGroup.add(leftPupil);
    const rightPupil = this.createMesh(pupilGeo, PUPIL);
    rightPupil.position.set(0.07, 0.07, -0.17);
    this.headGroup.add(rightPupil);

    // Eyebrows (bushy white)
    const browGeo = new THREE.BoxGeometry(0.06, 0.015, 0.025);
    const leftBrow = this.createMesh(browGeo, BEARD);
    leftBrow.position.set(-0.07, 0.105, -0.155);
    leftBrow.rotation.z = 0.1;
    this.headGroup.add(leftBrow);
    const rightBrow = this.createMesh(browGeo, BEARD);
    rightBrow.position.set(0.07, 0.105, -0.155);
    rightBrow.rotation.z = -0.1;
    this.headGroup.add(rightBrow);

    // Nose
    const nose = this.createMesh(
      new THREE.ConeGeometry(0.03, 0.06, 6),
      SKIN_DARK,
    );
    nose.position.set(0, 0.03, -0.18);
    nose.rotation.x = -Math.PI / 2;
    this.headGroup.add(nose);

    // ── Streimel (large fur hat) ──
    // Fur brim — wide torus shape
    const brimGeo = new THREE.CylinderGeometry(0.26, 0.28, 0.12, 16);
    const brim = this.createMesh(brimGeo, HAT_FUR, { roughness: 1.0, metalness: 0 });
    brim.position.set(0, 0.2, 0);
    this.headGroup.add(brim);

    // Fur texture bumps around the brim
    const bumpGeo = new THREE.SphereGeometry(0.035, 5, 4);
    for (let i = 0; i < 14; i++) {
      const angle = (i / 14) * Math.PI * 2;
      const bump = this.createMesh(bumpGeo, HAT_FUR, { roughness: 1.0 });
      bump.position.set(
        Math.cos(angle) * 0.25,
        0.2,
        Math.sin(angle) * 0.25,
      );
      bump.scale.set(1, 0.7, 1);
      this.headGroup.add(bump);
    }

    // Velvet crown top
    const crownGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.08, 16);
    const crown = this.createMesh(crownGeo, HAT_TOP, { roughness: 0.3 });
    crown.position.set(0, 0.28, 0);
    this.headGroup.add(crown);

    // ── Payis (long curly sidelocks) ──
    this.buildPayis(-1); // left
    this.buildPayis(1);  // right

    // ── Beard ──
    this.buildBeard();
  }

  private buildPayis(side: number): void {
    const x = side * 0.17;
    // Build 4 curl segments cascading down
    for (let i = 0; i < 5; i++) {
      const curlGeo = new THREE.TorusGeometry(0.025, 0.012, 6, 8);
      const curl = this.createMesh(curlGeo, HAIR, { roughness: 0.9 });
      // Each curl hangs lower, spiraling slightly
      curl.position.set(
        x + Math.sin(i * 1.2) * 0.015 * side,
        -0.02 - i * 0.065,
        -0.06 - i * 0.01,
      );
      curl.rotation.x = Math.PI / 2 + i * 0.15;
      curl.rotation.y = side * 0.3;
      this.headGroup.add(curl);
    }
    // Connecting strand between curls
    const strandGeo = new THREE.CylinderGeometry(0.01, 0.008, 0.32, 5);
    const strand = this.createMesh(strandGeo, HAIR, { roughness: 0.9 });
    strand.position.set(x, -0.15, -0.08);
    strand.rotation.z = side * 0.08;
    this.headGroup.add(strand);
  }

  private buildBeard(): void {
    // Mustache — sits right under nose
    const mustGeo = new THREE.CylinderGeometry(0.07, 0.06, 0.025, 8);
    const mustache = this.createMesh(mustGeo, BEARD, { roughness: 0.9 });
    mustache.position.set(0, 0.0, -0.16);
    mustache.rotation.x = Math.PI / 2;
    this.headGroup.add(mustache);
    // Mustache droop sides
    for (const s of [-1, 1]) {
      const droop = this.createMesh(
        new THREE.CylinderGeometry(0.014, 0.008, 0.07, 5),
        BEARD,
      );
      droop.position.set(s * 0.06, -0.025, -0.16);
      droop.rotation.z = s * 0.3;
      this.headGroup.add(droop);
    }

    // Upper beard — wide volume hugging the chin/jaw, pushed well forward of torso
    const chinGeo = new THREE.SphereGeometry(0.14, 10, 8);
    const chin = this.createMesh(chinGeo, BEARD, { roughness: 0.9 });
    chin.position.set(0, -0.08, -0.13);
    chin.scale.set(1, 0.65, 0.7);
    this.headGroup.add(chin);

    // Side whiskers wrapping along the jaw
    for (const s of [-1, 1]) {
      const whiskerGeo = new THREE.SphereGeometry(0.08, 7, 6);
      const whisker = this.createMesh(whiskerGeo, BEARD, { roughness: 0.9 });
      whisker.position.set(s * 0.1, -0.06, -0.1);
      whisker.scale.set(0.7, 0.8, 0.7);
      this.headGroup.add(whisker);
    }

    // Mid-beard — tapered cylinder, pushed forward as it descends
    const midGeo = new THREE.CylinderGeometry(0.06, 0.1, 0.2, 8);
    const mid = this.createMesh(midGeo, BEARD, { roughness: 0.9 });
    mid.position.set(0, -0.2, -0.2);
    mid.rotation.x = 0.25; // tilt forward so it arcs away from chest
    this.headGroup.add(mid);

    // Lower beard — curls back inward to form the arc
    const lowerGeo = new THREE.CylinderGeometry(0.035, 0.065, 0.18, 8);
    const lower = this.createMesh(lowerGeo, BEARD_TIP, { roughness: 0.9 });
    lower.position.set(0, -0.36, -0.22);
    lower.rotation.x = -0.25; // tilt back inward
    this.headGroup.add(lower);

    // Flowing beard strands — curl back in at the tips
    for (let i = 0; i < 7; i++) {
      const spread = (i - 3) * 0.022;
      const len = 0.08 + Math.random() * 0.06;
      const strandGeo = new THREE.CylinderGeometry(0.003, 0.012, len, 4);
      const strand = this.createMesh(strandGeo, BEARD_TIP, { roughness: 0.95 });
      strand.position.set(
        spread,
        -0.46 - Math.random() * 0.02,
        -0.18 + Math.abs(spread) * 0.3,
      );
      strand.rotation.z = spread * 0.8;
      strand.rotation.x = -0.3; // tilt back inward
      this.headGroup.add(strand);
    }

    // Beard volume fill — arcs forward then back: peaks around the middle
    for (let i = 0; i < 6; i++) {
      const t = i / 5; // 0 at top, 1 at bottom
      // Parabolic arc: peaks at t=0.5, returns toward body at t=1
      const arc = -4 * (t - 0.5) * (t - 0.5) + 1; // 0→1→0
      const zOff = -0.15 - arc * 0.12;
      const fillGeo = new THREE.SphereGeometry(0.03 + Math.random() * 0.02, 6, 5);
      const fill = this.createMesh(fillGeo, BEARD, { roughness: 0.95 });
      fill.position.set(
        (Math.random() - 0.5) * 0.1,
        -0.15 - i * 0.04,
        zOff - Math.random() * 0.02,
      );
      this.headGroup.add(fill);
    }
  }

  // ── TORSO ──
  private buildTorso(): void {
    // Bekishe (long black coat) — flattened cylinder (wide shoulders, narrow front-to-back)
    const coatGeo = new THREE.CylinderGeometry(0.2, 0.22, 0.7, 10);
    const coat = this.createMesh(coatGeo, BEKISHE, { roughness: 0.85 });
    coat.position.set(0, 0.95, 0);
    coat.scale.set(1, 1, 0.6);
    this.bodyGroup.add(coat);

    // Coat skirt — flares out slightly below the waist, same flattened profile
    const skirtGeo = new THREE.CylinderGeometry(0.22, 0.26, 0.35, 10);
    const skirt = this.createMesh(skirtGeo, BEKISHE, { roughness: 0.85 });
    skirt.position.set(0, 0.58, 0);
    skirt.scale.set(1, 1, 0.6);
    this.bodyGroup.add(skirt);

    // White shirt visible at center chest — sits on the flattened coat surface
    const shirtGeo = new THREE.CylinderGeometry(0.06, 0.055, 0.28, 6);
    const shirt = this.createMesh(shirtGeo, SHIRT);
    shirt.position.set(0, 1.08, -0.1);
    shirt.rotation.x = Math.PI / 2;
    shirt.scale.set(1, 0.15, 1);
    this.bodyGroup.add(shirt);

    // Coat lapels — curved strips flanking the shirt
    for (const s of [-1, 1]) {
      const lapelGeo = new THREE.CylinderGeometry(0.03, 0.035, 0.32, 5);
      const lapel = this.createMesh(lapelGeo, BEKISHE);
      lapel.position.set(s * 0.08, 1.08, -0.12);
      lapel.rotation.z = s * 0.06;
      this.bodyGroup.add(lapel);
    }

    // Suit vest underneath (visible between lapels)
    const vestGeo = new THREE.CylinderGeometry(0.08, 0.09, 0.22, 6);
    const vest = this.createMesh(vestGeo, SUIT);
    vest.position.set(0, 0.98, -0.08);
    vest.rotation.x = Math.PI / 2;
    vest.scale.set(1, 0.2, 1);
    this.bodyGroup.add(vest);

    // Silver buttons down the front
    const buttonGeo = new THREE.SphereGeometry(0.012, 5, 5);
    for (let i = 0; i < 5; i++) {
      const btn = this.createMesh(buttonGeo, BUTTON, { metalness: 0.5 });
      btn.position.set(0, 1.15 - i * 0.07, -0.14);
      this.bodyGroup.add(btn);
    }

    // Gartel (belt/sash worn over the bekishe) — flattened to match torso
    const gartelGeo = new THREE.TorusGeometry(0.22, 0.02, 6, 16);
    const gartel = this.createMesh(gartelGeo, GARTEL);
    gartel.position.set(0, 0.78, 0);
    gartel.rotation.x = Math.PI / 2;
    gartel.scale.set(1, 0.6, 1);
    this.bodyGroup.add(gartel);

    // Collar — flattened ring at neck
    const collarGeo = new THREE.TorusGeometry(0.14, 0.02, 6, 12);
    const collar = this.createMesh(collarGeo, SHIRT);
    collar.position.set(0, 1.28, -0.01);
    collar.rotation.x = Math.PI / 2;
    collar.scale.set(1, 0.6, 1);
    this.bodyGroup.add(collar);
  }

  // ── ARMS ──
  private buildArms(): void {
    this.buildArm(-1); // left
    this.buildArm(1);  // right
  }

  private buildArm(side: number): void {
    const armGroup = side < 0 ? this.leftArmGroup : this.rightArmGroup;

    // Upper arm (bekishe sleeve)
    const upperGeo = new THREE.CylinderGeometry(0.055, 0.06, 0.3, 7);
    const upper = this.createMesh(upperGeo, BEKISHE);
    upper.position.set(0, -0.15, 0);
    armGroup.add(upper);

    // Lower arm / suit sleeve showing at cuff
    const lowerGeo = new THREE.CylinderGeometry(0.04, 0.05, 0.25, 7);
    const lower = this.createMesh(lowerGeo, SUIT);
    lower.position.set(0, -0.4, 0);
    armGroup.add(lower);

    // White shirt cuff
    const cuffGeo = new THREE.TorusGeometry(0.05, 0.015, 5, 8);
    const cuff = this.createMesh(cuffGeo, SHIRT);
    cuff.position.set(0, -0.3, 0);
    cuff.rotation.x = Math.PI / 2;
    armGroup.add(cuff);

    // Hand
    const handGeo = new THREE.SphereGeometry(0.05, 6, 6);
    const hand = this.createMesh(handGeo, SKIN);
    hand.position.set(0, -0.55, 0);
    hand.scale.set(0.9, 1.2, 0.7);
    armGroup.add(hand);

    // Fingers (curled, to grip items)
    const fingerGeo = new THREE.CylinderGeometry(0.012, 0.01, 0.06, 4);
    for (let i = 0; i < 4; i++) {
      const finger = this.createMesh(fingerGeo, SKIN);
      const spread = (i - 1.5) * 0.018;
      finger.position.set(spread, -0.59, -0.02);
      finger.rotation.x = 0.4; // slightly curled
      armGroup.add(finger);
    }
    // Thumb
    const thumb = this.createMesh(
      new THREE.CylinderGeometry(0.013, 0.011, 0.05, 4),
      SKIN,
    );
    thumb.position.set(side * 0.03, -0.56, -0.03);
    thumb.rotation.x = 0.3;
    thumb.rotation.z = -side * 0.5;
    armGroup.add(thumb);
  }

  // ── LEGS ──
  private buildLegs(): void {
    this.buildLeg(-1);
    this.buildLeg(1);
  }

  private buildLeg(side: number): void {
    const legGroup = side < 0 ? this.leftLegGroup : this.rightLegGroup;

    // Upper leg (hidden under bekishe skirt, but needed for shape)
    const upperGeo = new THREE.CylinderGeometry(0.055, 0.06, 0.35, 7);
    const upper = this.createMesh(upperGeo, PANTS);
    upper.position.set(0, -0.2, 0);
    legGroup.add(upper);

    // Lower leg
    const lowerGeo = new THREE.CylinderGeometry(0.045, 0.05, 0.35, 7);
    const lower = this.createMesh(lowerGeo, PANTS);
    lower.position.set(0, -0.52, 0);
    legGroup.add(lower);

    // Shoe — keep slightly boxy for a dress shoe look
    const shoeGeo = new THREE.BoxGeometry(0.1, 0.06, 0.16);
    const shoe = this.createMesh(shoeGeo, SHOE, { roughness: 0.4 });
    shoe.position.set(0, -0.72, -0.02);
    legGroup.add(shoe);
  }

  // ── LULAV (right/main hand) ──
  private buildLulav(): void {
    this.lulavGroup = new THREE.Group();

    // Main palm branch stem
    const stemGeo = new THREE.CylinderGeometry(0.02, 0.025, 1.4, 6);
    const stem = this.createMesh(stemGeo, LULAV_STEM);
    stem.position.set(0, 0.3, 0);
    this.lulavGroup.add(stem);

    // Palm fronds at the top — fan of flat leaves
    for (let i = 0; i < 7; i++) {
      const angle = (i - 3) * 0.15;
      const leafGeo = new THREE.BoxGeometry(0.04, 0.4, 0.008);
      const leaf = this.createMesh(leafGeo, LULAV_LEAF);
      leaf.position.set(
        Math.sin(angle) * 0.03,
        1.15 + Math.abs(i - 3) * -0.04,
        Math.cos(angle) * 0.03,
      );
      leaf.rotation.z = angle * 0.6;
      leaf.rotation.x = -0.1;
      this.lulavGroup.add(leaf);
    }

    // Willow branches (aravot) — 2 thinner branches on one side
    for (let i = 0; i < 2; i++) {
      const willowGeo = new THREE.CylinderGeometry(0.008, 0.006, 0.9, 4);
      const willow = this.createMesh(willowGeo, LULAV_WILLOW);
      willow.position.set(-0.03 - i * 0.015, 0.5, 0.02);
      willow.rotation.z = 0.05 + i * 0.03;
      this.lulavGroup.add(willow);

      // Small leaves on willow
      for (let j = 0; j < 4; j++) {
        const wLeafGeo = new THREE.SphereGeometry(0.015, 4, 3);
        const wLeaf = this.createMesh(wLeafGeo, LULAV_WILLOW);
        wLeaf.position.set(
          -0.035 - i * 0.015,
          0.6 + j * 0.15,
          0.02,
        );
        wLeaf.scale.set(1.5, 0.6, 0.4);
        this.lulavGroup.add(wLeaf);
      }
    }

    // Myrtle branches (hadassim) — 3 branches on the other side
    for (let i = 0; i < 3; i++) {
      const myrtleGeo = new THREE.CylinderGeometry(0.007, 0.005, 0.85, 4);
      const myrtle = this.createMesh(myrtleGeo, LULAV_MYRTLE);
      myrtle.position.set(0.025 + i * 0.012, 0.48, -0.01 + i * 0.01);
      myrtle.rotation.z = -0.04 - i * 0.02;
      this.lulavGroup.add(myrtle);

      // Tiny triple-leaf clusters on myrtle
      for (let j = 0; j < 5; j++) {
        const mLeafGeo = new THREE.SphereGeometry(0.01, 4, 3);
        const mLeaf = this.createMesh(mLeafGeo, LULAV_MYRTLE);
        mLeaf.position.set(
          0.03 + i * 0.012,
          0.5 + j * 0.13,
          -0.01 + i * 0.01,
        );
        mLeaf.scale.set(1, 0.5, 1);
        this.lulavGroup.add(mLeaf);
      }
    }

    // Binding rings (white strips tying the species together)
    const bindGeo = new THREE.TorusGeometry(0.035, 0.006, 6, 8);
    for (let i = 0; i < 3; i++) {
      const bind = this.createMesh(bindGeo, SHIRT);
      bind.position.set(0, 0.15 + i * 0.2, 0);
      bind.rotation.x = Math.PI / 2;
      this.lulavGroup.add(bind);
    }

    // Position in right hand
    this.lulavGroup.position.set(0, -0.45, -0.06);
    this.lulavGroup.rotation.x = -0.1; // slight forward tilt
    this.rightArmGroup.add(this.lulavGroup);
  }

  // ── ESROG (left/off hand) ──
  private buildEsrog(): void {
    const esrogGroup = new THREE.Group();

    // Main citron body — elongated lemon shape
    const bodyGeo = new THREE.SphereGeometry(0.06, 8, 8);
    this.esrogMesh = this.createMesh(bodyGeo, ESROG, { roughness: 0.6 });
    this.esrogMesh.scale.set(0.8, 1.2, 0.8);
    esrogGroup.add(this.esrogMesh);

    // Pitom (stem/nipple at top of esrog)
    const pitomGeo = new THREE.ConeGeometry(0.012, 0.04, 5);
    const pitom = this.createMesh(pitomGeo, ESROG_TIP);
    pitom.position.set(0, 0.07, 0);
    esrogGroup.add(pitom);

    // Uketz (stem at bottom)
    const uketzGeo = new THREE.CylinderGeometry(0.008, 0.005, 0.025, 4);
    const uketz = this.createMesh(uketzGeo, ESROG_TIP);
    uketz.position.set(0, -0.065, 0);
    esrogGroup.add(uketz);

    // Subtle bumpy texture dots
    const dotGeo = new THREE.SphereGeometry(0.008, 4, 4);
    for (let i = 0; i < 12; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.6 + Math.PI * 0.2;
      const dot = this.createMesh(dotGeo, ESROG_TIP);
      dot.position.set(
        Math.sin(phi) * Math.cos(theta) * 0.05,
        Math.cos(phi) * 0.065,
        Math.sin(phi) * Math.sin(theta) * 0.05,
      );
      esrogGroup.add(dot);
    }

    // Position in left hand — held upright, cradled
    esrogGroup.position.set(0, -0.55, -0.05);
    this.leftArmGroup.add(esrogGroup);
  }

  // ── ANIMATION ──
  protected override onAnimate(dt: number, input: AnimationInput): void {
    // Davening (prayer swaying) — only when idle (not moving, on ground)
    if (!input.isMoving && input.isGrounded && !this.isAutoAttacking && !this.stunActive && !this.restingActive) {
      this.davenPhase += dt * this.davenSpeed;

      const sway = Math.sin(this.davenPhase * Math.PI * 2);
      // Smoothstep-ish curve — gentle ease at the extremes
      const swaySmooth = sway * (0.8 + 0.2 * Math.abs(sway));

      // Body rocks forward and back
      this.bodyGroup.rotation.x += swaySmooth * 0.12;

      // Head follows body with slight lag and a gentle extra nod
      this.headGroup.rotation.x += swaySmooth * 0.06
        + Math.sin(this.davenPhase * Math.PI * 4) * 0.015;

      // Subtle knee bend on the forward rock
      const kneeBend = Math.max(0, sway) * 0.03;
      this.leftLegGroup.rotation.x += kneeBend;
      this.rightLegGroup.rotation.x += kneeBend;

      // Arms sway gently with the motion — holding items steady
      this.rightArmGroup.rotation.x += swaySmooth * 0.04;
      this.leftArmGroup.rotation.x += swaySmooth * 0.03;

      // Very subtle body rise on forward lean
      this.bodyGroup.position.y += Math.max(0, sway) * 0.008;
    }
  }

  // ── Combat stance — holds lulav forward like a weapon ──
  protected override animateCombatStance(weight: number): void {
    // Right arm brings lulav forward
    this.rightArmGroup.rotation.x += 0.5 * weight;
    this.rightArmGroup.rotation.z -= 0.15 * weight;

    // Left arm cups esrog protectively against chest
    this.leftArmGroup.rotation.x += 0.3 * weight;
    this.leftArmGroup.rotation.z += 0.25 * weight;

    // Slight forward lean
    this.bodyGroup.rotation.x += 0.05 * weight;
  }

  // ── Attack swing — swipes lulav at target ──
  protected override animateAttackSwing(t: number, alternateArm: boolean): void {
    if (!alternateArm) {
      // Primary: horizontal lulav sweep
      if (t < 0.3) {
        // Wind up — pull lulav back
        const p = t / 0.3;
        this.rightArmGroup.rotation.x += 0.8 * p;
        this.rightArmGroup.rotation.y -= 0.4 * p;
        this.bodyGroup.rotation.y -= 0.15 * p;
      } else if (t < 0.6) {
        // Sweep across
        const p = (t - 0.3) / 0.3;
        const ease = p * p * (3 - 2 * p);
        this.rightArmGroup.rotation.x += 0.8 - 0.3 * ease;
        this.rightArmGroup.rotation.y -= 0.4 + 0.8 * ease;
        this.bodyGroup.rotation.y -= 0.15 + 0.3 * ease;
      } else {
        // Recovery
        const p = (t - 0.6) / 0.4;
        const fade = 1 - p;
        this.rightArmGroup.rotation.x += 0.5 * fade;
        this.rightArmGroup.rotation.y += 0.4 * fade;
        this.bodyGroup.rotation.y += 0.15 * fade;
      }
    } else {
      // Alternate: overhead lulav bonk
      if (t < 0.25) {
        const p = t / 0.25;
        this.rightArmGroup.rotation.x -= 0.9 * p;  // raise overhead
        this.bodyGroup.rotation.x -= 0.1 * p;
      } else if (t < 0.5) {
        const p = (t - 0.25) / 0.25;
        const ease = p * p;
        // Swing down
        this.rightArmGroup.rotation.x -= 0.9 * (1 - ease) - 0.6 * ease;
        this.rightArmGroup.rotation.x += 1.5 * ease;
        this.bodyGroup.rotation.x += 0.2 * ease - 0.1 * (1 - ease);
      } else {
        const p = (t - 0.5) / 0.5;
        const fade = 1 - p;
        this.rightArmGroup.rotation.x += 0.6 * fade;
        this.bodyGroup.rotation.x += 0.1 * fade;
      }
    }
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
