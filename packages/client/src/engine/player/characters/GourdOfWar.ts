import * as THREE from 'three';
import { CharacterModel, AnimationInput } from './CharacterModel';

// ── Colour palette ──
const GOURD          = 0x9B7B2C;  // warm golden-orange gourd rind
const GOURD_DARK     = 0x7A5E1E;  // dark ridges and creases
const GOURD_LIGHT    = 0xB89438;  // lighter highlight patches
const GOURD_GREEN    = 0x5A7A2E;  // green unripe patches
const GOURD_BELLY    = 0xC4A848;  // pale underbelly
const VINE           = 0x3D6B22;  // stem/vine green
const VINE_DARK      = 0x2A4A15;  // dark vine shadow
const VINE_LIGHT     = 0x5A8A35;  // lighter vine tip
const LEAF           = 0x3A8A24;  // leaf armor green
const LEAF_DARK      = 0x2A6A18;  // dark leaf veins
const LEAF_DRY       = 0x7A6A2A;  // dried leaf edges
const WAR_PAINT      = 0x8B1A1A;  // blood-red war paint
const WAR_PAINT_DARK = 0x5A0E0E;  // darker war paint
const EYE_GLOW       = 0xFFAA00;  // fierce orange eye glow
const EYE_INNER      = 0xFF6600;  // inner eye fire
const MOUTH          = 0x1A0800;  // dark mouth cavity
const TEETH          = 0xD4C8A0;  // gourd-seed teeth
const SCAR           = 0x5A3A10;  // battle scar
const SEED           = 0xF5E6C8;  // cream-colored seeds
const ROOT           = 0x6B4226;  // root/leg brown
const ROOT_DARK      = 0x4A2E1A;  // darker root
const ROOT_TIP       = 0x8B7355;  // root tips (toes)
const WART           = 0x6B5A22;  // warty bumps

export class GourdOfWar extends CharacterModel {
  // Stem whip segments (nested chain for wave animation)
  private declare stemSegments: THREE.Group[];
  private stemPhase = 0;

  // Idle sway
  private swayPhase = 0;

  constructor() {
    super('gourd-of-war');
  }

  protected buildModel(): void {
    this.stemSegments = [];

    // Gourd is wide and squat — adjust skeleton pivots
    this.leftLegGroup.position.set(-0.18, 0.55, 0);
    this.rightLegGroup.position.set(0.18, 0.55, 0);
    this.leftArmGroup.position.set(-0.40, 1.05, 0);
    this.rightArmGroup.position.set(0.40, 1.05, 0);
    this.headGroup.position.set(0, 1.5, 0);

    this.buildBody();
    this.buildFace();
    this.buildRidges();
    this.buildWarts();
    this.buildWarPaint();
    this.buildScars();
    this.buildLegs();
    this.buildArms();
    this.buildStemWhip();
    this.buildLeafArmor();
    this.buildStemCap();
    this.buildVineDetails();
  }

  // ── BODY (gourd shape — large lower bulb, narrow neck, smaller upper bulb) ──

  private buildBody(): void {
    // Lower bulb — the biggest, roundest part
    const lowerBulb = this.createMesh(
      new THREE.SphereGeometry(0.38, 14, 12),
      GOURD,
    );
    lowerBulb.position.set(0, 0.72, 0);
    lowerBulb.scale.set(1.0, 0.85, 0.9);
    this.bodyGroup.add(lowerBulb);

    // Pale underbelly
    const belly = this.createMesh(
      new THREE.SphereGeometry(0.32, 12, 10),
      GOURD_BELLY,
    );
    belly.position.set(0, 0.62, -0.05);
    belly.scale.set(0.9, 0.6, 0.8);
    this.bodyGroup.add(belly);

    // Green patch (unripe spot)
    const greenPatch = this.createMesh(
      new THREE.SphereGeometry(0.12, 8, 6),
      GOURD_GREEN, { roughness: 0.9 },
    );
    greenPatch.position.set(0.22, 0.68, 0.2);
    greenPatch.scale.set(1.0, 0.8, 0.6);
    this.bodyGroup.add(greenPatch);

    // Neck taper between bulbs
    const neck = this.createMesh(
      new THREE.CylinderGeometry(0.2, 0.32, 0.25, 12),
      GOURD,
    );
    neck.position.set(0, 1.0, 0);
    this.bodyGroup.add(neck);

    // Upper bulb (the "head" area, where the face is carved)
    const upperBulb = this.createMesh(
      new THREE.SphereGeometry(0.26, 14, 12),
      GOURD,
    );
    upperBulb.position.set(0, 1.22, 0);
    upperBulb.scale.set(1.0, 0.9, 0.9);
    this.bodyGroup.add(upperBulb);

    // Crown taper toward the stem cap
    const crown = this.createMesh(
      new THREE.CylinderGeometry(0.1, 0.22, 0.18, 10),
      GOURD_DARK,
    );
    crown.position.set(0, 1.42, 0);
    this.bodyGroup.add(crown);
  }

  // ── FACE (carved into upper bulb — angry jack-o-lantern warrior) ──

  private buildFace(): void {
    const eyeSocketGeo = new THREE.SphereGeometry(0.06, 8, 6);
    for (const side of [-1, 1]) {
      // Dark carved socket
      const socket = this.createMesh(eyeSocketGeo, MOUTH);
      socket.position.set(side * 0.1, 1.26, -0.22);
      socket.scale.set(1.2, 0.7, 0.5);
      this.bodyGroup.add(socket);

      // Glowing eye (emissive orange fire)
      const eye = new THREE.Mesh(
        new THREE.SphereGeometry(0.04, 8, 6),
        new THREE.MeshStandardMaterial({
          color: EYE_GLOW,
          emissive: EYE_GLOW,
          emissiveIntensity: 0.8,
          roughness: 0.3,
        }),
      );
      eye.position.set(side * 0.1, 1.26, -0.22);
      eye.scale.set(0.9, 0.55, 0.4);
      this.bodyGroup.add(eye);

      // Inner bright pupil
      const pupil = new THREE.Mesh(
        new THREE.SphereGeometry(0.02, 6, 4),
        new THREE.MeshStandardMaterial({
          color: EYE_INNER,
          emissive: EYE_INNER,
          emissiveIntensity: 1.2,
          roughness: 0.2,
        }),
      );
      pupil.position.set(side * 0.1, 1.26, -0.245);
      pupil.scale.set(0.8, 0.5, 0.3);
      this.bodyGroup.add(pupil);

      // Angry brow ridge — thick gourd flesh forming a deep scowl
      const brow = this.createMesh(
        new THREE.CapsuleGeometry(0.025, 0.07, 5, 6),
        GOURD_DARK,
      );
      brow.position.set(side * 0.1, 1.31, -0.2);
      brow.rotation.z = side * -0.4;
      brow.scale.set(1, 1, 0.7);
      this.bodyGroup.add(brow);

      // Under-eye crease (battle-hardened expression)
      const crease = this.createMesh(
        new THREE.CapsuleGeometry(0.008, 0.04, 3, 4),
        GOURD_DARK,
      );
      crease.position.set(side * 0.1, 1.21, -0.24);
      crease.rotation.z = side * 0.15;
      crease.scale.set(1, 1, 0.4);
      this.bodyGroup.add(crease);
    }

    // Mouth — wide carved gash
    const mouthCavity = this.createMesh(
      new THREE.CapsuleGeometry(0.03, 0.12, 5, 8),
      MOUTH,
    );
    mouthCavity.position.set(0, 1.14, -0.245);
    mouthCavity.rotation.z = Math.PI / 2;
    mouthCavity.scale.set(1, 1, 0.5);
    this.bodyGroup.add(mouthCavity);

    // Jagged teeth (gourd seeds turned into fangs)
    const toothGeo = new THREE.ConeGeometry(0.012, 0.03, 4);
    const teethLayout = [
      { x: -0.06, top: true }, { x: -0.02, top: true },
      { x: 0.02, top: true },  { x: 0.06, top: true },
      { x: -0.04, top: false }, { x: 0, top: false },
      { x: 0.04, top: false },
    ];
    for (const tp of teethLayout) {
      const tooth = this.createMesh(toothGeo, TEETH, { roughness: 0.6 });
      if (tp.top) {
        tooth.position.set(tp.x, 1.165, -0.245);
        tooth.rotation.x = Math.PI;
      } else {
        tooth.position.set(tp.x, 1.115, -0.245);
      }
      this.bodyGroup.add(tooth);
    }

    // Nose ridge — subtle bump between eyes
    const nose = this.createMesh(
      new THREE.SphereGeometry(0.03, 6, 5),
      GOURD_LIGHT, { roughness: 0.8 },
    );
    nose.position.set(0, 1.22, -0.24);
    nose.scale.set(0.8, 0.7, 0.6);
    this.bodyGroup.add(nose);
  }

  // ── RIDGES (vertical lines running down the gourd) ─────────

  private buildRidges(): void {
    const ridgeGeo = new THREE.CapsuleGeometry(0.015, 0.5, 4, 6);
    const ridgeCount = 10;
    for (let i = 0; i < ridgeCount; i++) {
      const angle = (i / ridgeCount) * Math.PI * 2;
      // Skip ridges that would cover the face
      if (Math.abs(angle - Math.PI) < 0.5) continue;

      const ridge = this.createMesh(ridgeGeo, GOURD_DARK, { roughness: 0.9 });
      const r = 0.33;
      ridge.position.set(Math.sin(angle) * r, 0.9, Math.cos(angle) * r);
      ridge.scale.set(0.6, 1.0, 0.8);
      this.bodyGroup.add(ridge);
    }
  }

  // ── WARTS (bumpy texture scattered across the surface) ─────

  private buildWarts(): void {
    const wartGeo = new THREE.SphereGeometry(0.025, 5, 4);
    const wartPositions = [
      { x: 0.25, y: 0.85, z: -0.15 },
      { x: -0.28, y: 0.75, z: 0.1 },
      { x: 0.15, y: 0.65, z: 0.28 },
      { x: -0.2, y: 0.95, z: -0.2 },
      { x: 0.3, y: 0.7, z: -0.05 },
      { x: -0.1, y: 0.6, z: -0.3 },
      { x: 0.08, y: 1.32, z: 0.2 },
      { x: -0.18, y: 1.15, z: 0.18 },
      { x: 0.2, y: 1.22, z: 0.15 },
      { x: -0.22, y: 0.8, z: -0.22 },
    ];
    for (const p of wartPositions) {
      const wart = this.createMesh(wartGeo, WART, { roughness: 0.95 });
      const s = 0.6 + Math.random() * 0.8;
      wart.position.set(p.x, p.y, p.z);
      wart.scale.setScalar(s);
      this.bodyGroup.add(wart);
    }
  }

  // ── WAR PAINT (blood-red tribal markings) ──────────────────

  private buildWarPaint(): void {
    // Horizontal stripe across the eyes
    const stripe1 = this.createMesh(
      new THREE.CapsuleGeometry(0.018, 0.18, 4, 6),
      WAR_PAINT, { roughness: 0.85 },
    );
    stripe1.position.set(0, 1.25, -0.245);
    stripe1.rotation.z = Math.PI / 2;
    stripe1.scale.set(1, 1, 0.4);
    this.bodyGroup.add(stripe1);

    // Diagonal war stripe on body
    const stripe2 = this.createMesh(
      new THREE.CapsuleGeometry(0.015, 0.2, 4, 6),
      WAR_PAINT_DARK, { roughness: 0.85 },
    );
    stripe2.position.set(-0.22, 0.85, -0.2);
    stripe2.rotation.z = 0.6;
    stripe2.scale.set(1, 1, 0.4);
    this.bodyGroup.add(stripe2);

    const stripe3 = this.createMesh(
      new THREE.CapsuleGeometry(0.012, 0.15, 4, 6),
      WAR_PAINT, { roughness: 0.85 },
    );
    stripe3.position.set(0.2, 0.9, -0.18);
    stripe3.rotation.z = -0.4;
    stripe3.scale.set(1, 1, 0.4);
    this.bodyGroup.add(stripe3);

    // Tear marks under the eyes
    for (const side of [-1, 1]) {
      const mark = this.createMesh(
        new THREE.CapsuleGeometry(0.008, 0.06, 3, 5),
        WAR_PAINT, { roughness: 0.8 },
      );
      mark.position.set(side * 0.1, 1.2, -0.255);
      mark.rotation.z = side * 0.3;
      mark.scale.set(1, 1, 0.3);
      this.bodyGroup.add(mark);
    }
  }

  // ── BATTLE SCARS (slashes with seeds spilling out) ─────────

  private buildScars(): void {
    const scarGeo = new THREE.CapsuleGeometry(0.01, 0.12, 3, 5);

    const scar1 = this.createMesh(scarGeo, SCAR, { roughness: 0.9 });
    scar1.position.set(0.15, 0.75, -0.28);
    scar1.rotation.z = 0.8;
    scar1.scale.set(1, 1, 0.3);
    this.bodyGroup.add(scar1);

    const scar2 = this.createMesh(scarGeo, SCAR, { roughness: 0.9 });
    scar2.position.set(-0.25, 0.9, -0.15);
    scar2.rotation.z = -0.5;
    scar2.scale.set(1, 1, 0.3);
    this.bodyGroup.add(scar2);

    // Seeds spilling from the wound
    const seedGeo = new THREE.SphereGeometry(0.015, 5, 4);
    for (let i = 0; i < 4; i++) {
      const seed = this.createMesh(seedGeo, SEED, { roughness: 0.5 });
      seed.position.set(0.16 + i * 0.015, 0.7 - i * 0.02, -0.3);
      seed.scale.set(0.8, 1.2, 0.5);
      seed.rotation.z = i * 0.4;
      this.bodyGroup.add(seed);
    }
  }

  // ── LEGS (thick gnarly root stumps) ────────────────────────

  private buildLegs(): void {
    for (const side of [-1, 1]) {
      const legGroup = side < 0 ? this.leftLegGroup : this.rightLegGroup;

      // Upper leg — thick root
      const upperLeg = this.createMesh(
        new THREE.CapsuleGeometry(0.09, 0.15, 7, 8),
        ROOT, { roughness: 0.9 },
      );
      upperLeg.position.set(0, -0.12, 0);
      upperLeg.scale.set(1.1, 1.0, 1.0);
      legGroup.add(upperLeg);

      // Knee bulge
      const knee = this.createMesh(
        new THREE.SphereGeometry(0.08, 7, 6),
        ROOT_DARK, { roughness: 0.95 },
      );
      knee.position.set(0, -0.22, -0.02);
      knee.scale.set(1.0, 0.6, 1.0);
      legGroup.add(knee);

      // Lower leg
      const lowerLeg = this.createMesh(
        new THREE.CapsuleGeometry(0.07, 0.15, 7, 8),
        ROOT, { roughness: 0.9 },
      );
      lowerLeg.position.set(0, -0.37, 0);
      lowerLeg.scale.set(0.95, 1.0, 0.95);
      legGroup.add(lowerLeg);

      // Root foot — flat, gripping the ground
      const foot = this.createMesh(
        new THREE.SphereGeometry(0.08, 7, 6),
        ROOT_DARK, { roughness: 0.9 },
      );
      foot.position.set(0, -0.5, -0.03);
      foot.scale.set(1.1, 0.5, 1.4);
      legGroup.add(foot);

      // Three thick root toes
      const toeGeo = new THREE.CapsuleGeometry(0.02, 0.04, 4, 5);
      for (let t = 0; t < 3; t++) {
        const toe = this.createMesh(toeGeo, ROOT_TIP, { roughness: 0.8 });
        toe.position.set((t - 1) * 0.03, -0.53, -0.08);
        toe.rotation.x = 0.4;
        legGroup.add(toe);
      }

      // Small root tendril wrapping around the leg
      const tendril = this.createMesh(
        new THREE.CylinderGeometry(0.008, 0.005, 0.12, 4),
        VINE_DARK, { roughness: 0.85 },
      );
      tendril.position.set(side * 0.06, -0.25, 0.04);
      tendril.rotation.z = side * 0.4;
      tendril.rotation.x = 0.3;
      legGroup.add(tendril);

      // Bark-like rings on the roots
      const ring = this.createMesh(
        new THREE.TorusGeometry(0.075, 0.01, 5, 8),
        ROOT_DARK, { roughness: 0.95 },
      );
      ring.position.set(0, -0.3, 0);
      ring.rotation.x = Math.PI / 2;
      legGroup.add(ring);
    }
  }

  // ── ARMS (vine appendages — left fist, right holds whip base) ──

  private buildArms(): void {
    for (const armSide of [-1, 1]) {
      const armGroup = armSide < 0 ? this.leftArmGroup : this.rightArmGroup;

      // Upper arm vine
      const upperArm = this.createMesh(
        new THREE.CapsuleGeometry(0.055, 0.14, 6, 8),
        VINE, { roughness: 0.8 },
      );
      upperArm.position.set(0, -0.1, 0);
      armGroup.add(upperArm);

      // Elbow knot joint
      const elbow = this.createMesh(
        new THREE.SphereGeometry(0.05, 6, 6),
        VINE_DARK, { roughness: 0.85 },
      );
      elbow.position.set(0, -0.2, 0);
      armGroup.add(elbow);

      // Forearm
      const forearm = this.createMesh(
        new THREE.CapsuleGeometry(0.04, 0.14, 6, 8),
        VINE, { roughness: 0.8 },
      );
      forearm.position.set(0, -0.32, 0);
      armGroup.add(forearm);

      if (armSide < 0) {
        // Left hand — balled vine fist
        const fist = this.createMesh(
          new THREE.SphereGeometry(0.045, 7, 6),
          VINE_DARK, { roughness: 0.8 },
        );
        fist.position.set(0, -0.44, 0);
        fist.scale.set(0.9, 1.0, 0.8);
        armGroup.add(fist);

        // Knuckle bumps
        for (let i = 0; i < 3; i++) {
          const knuckle = this.createMesh(
            new THREE.SphereGeometry(0.012, 4, 4),
            VINE, { roughness: 0.9 },
          );
          knuckle.position.set((i - 1) * 0.02, -0.42, -0.035);
          armGroup.add(knuckle);
        }
      } else {
        // Right hand — grip for the stem whip
        const grip = this.createMesh(
          new THREE.CylinderGeometry(0.035, 0.04, 0.06, 6),
          VINE_DARK, { roughness: 0.75 },
        );
        grip.position.set(0, -0.43, 0);
        armGroup.add(grip);
      }

      // Small leaf at elbow joint
      const leaf = this.createMesh(
        new THREE.PlaneGeometry(0.06, 0.04),
        LEAF, { roughness: 0.8, side: THREE.DoubleSide },
      );
      leaf.position.set(armSide * 0.04, -0.18, 0.03);
      leaf.rotation.x = -0.5;
      leaf.rotation.z = armSide * 0.3;
      armGroup.add(leaf);
    }
  }

  // ── STEM WHIP (nested chain of segments on right arm) ──────

  private buildStemWhip(): void {
    const segmentCount = 7;
    let parent: THREE.Object3D = this.rightArmGroup;

    for (let i = 0; i < segmentCount; i++) {
      const segGroup = new THREE.Group();

      // Each segment gets thinner toward the tip
      const topRadius = Math.max(0.035 - i * 0.004, 0.008);
      const botRadius = Math.max(0.03 - i * 0.004, 0.005);
      const length = 0.14 - i * 0.005;
      const color = i < 3 ? VINE_DARK : (i < 5 ? VINE : VINE_LIGHT);

      const segment = this.createMesh(
        new THREE.CylinderGeometry(topRadius, botRadius, length, 6),
        color, { roughness: 0.75 },
      );
      segment.position.set(0, -length / 2, 0);
      segGroup.add(segment);

      // Knots at some joints
      if (i === 2 || i === 4) {
        const knot = this.createMesh(
          new THREE.SphereGeometry(topRadius + 0.008, 5, 5),
          VINE_DARK, { roughness: 0.9 },
        );
        segGroup.add(knot);
      }

      // Small thorns
      if (i === 1 || i === 3 || i === 5) {
        const thorn = this.createMesh(
          new THREE.ConeGeometry(0.006, 0.025, 4),
          VINE_DARK, { roughness: 0.7 },
        );
        thorn.position.set(0.02, -length * 0.4, 0);
        thorn.rotation.z = -Math.PI / 3;
        segGroup.add(thorn);
      }

      // Position: first segment at the hand, subsequent link to previous segment tip
      if (i === 0) {
        segGroup.position.set(0, -0.47, -0.02);
      } else {
        const prevLength = 0.14 - (i - 1) * 0.005;
        segGroup.position.set(0, -prevLength, 0);
      }

      parent.add(segGroup);
      parent = segGroup;
      this.stemSegments.push(segGroup);
    }

    // Whip tip — leaf-shaped barb
    const tipGeo = new THREE.ConeGeometry(0.014, 0.05, 5);
    const tip = this.createMesh(tipGeo, LEAF, { roughness: 0.5, metalness: 0.15 });
    const lastSegLength = 0.14 - (segmentCount - 1) * 0.005;
    tip.position.set(0, -lastSegLength - 0.02, 0);
    parent.add(tip);

    // Tiny leaf fins at the tip
    for (const side of [-1, 1]) {
      const fin = this.createMesh(
        new THREE.PlaneGeometry(0.025, 0.015),
        LEAF_DARK, { roughness: 0.7, side: THREE.DoubleSide },
      );
      fin.position.set(side * 0.012, -lastSegLength - 0.01, 0);
      fin.rotation.z = side * 0.6;
      parent.add(fin);
    }
  }

  // ── LEAF ARMOR (shoulder guards and chest plate) ───────────

  private buildLeafArmor(): void {
    for (const side of [-1, 1]) {
      // Large shoulder leaf
      const shoulderLeaf = this.createMesh(
        new THREE.PlaneGeometry(0.18, 0.12, 2, 1),
        LEAF, { roughness: 0.7, side: THREE.DoubleSide },
      );
      shoulderLeaf.position.set(side * 0.36, 1.12, 0);
      shoulderLeaf.rotation.z = side * 0.8;
      shoulderLeaf.rotation.x = -0.2;
      this.bodyGroup.add(shoulderLeaf);

      // Leaf vein center line
      const vein = this.createMesh(
        new THREE.CylinderGeometry(0.004, 0.002, 0.1, 4),
        LEAF_DARK,
      );
      vein.position.set(side * 0.36, 1.12, -0.005);
      vein.rotation.z = side * 0.8 + Math.PI / 2;
      this.bodyGroup.add(vein);

      // Dried curling edge
      const edge = this.createMesh(
        new THREE.CapsuleGeometry(0.005, 0.12, 3, 5),
        LEAF_DRY,
      );
      edge.position.set(side * 0.42, 1.08, 0.01);
      edge.rotation.z = side * 1.0;
      this.bodyGroup.add(edge);

      // Secondary smaller leaf layer
      const innerLeaf = this.createMesh(
        new THREE.PlaneGeometry(0.1, 0.08, 1, 1),
        LEAF_DARK, { roughness: 0.75, side: THREE.DoubleSide },
      );
      innerLeaf.position.set(side * 0.34, 1.1, -0.008);
      innerLeaf.rotation.z = side * 0.6;
      innerLeaf.rotation.x = -0.15;
      this.bodyGroup.add(innerLeaf);
    }

    // Chest leaf plate (battle-worn)
    const chestLeaf = this.createMesh(
      new THREE.PlaneGeometry(0.14, 0.16, 2, 2),
      LEAF_DARK, { roughness: 0.8, side: THREE.DoubleSide },
    );
    chestLeaf.position.set(0.05, 0.85, -0.33);
    chestLeaf.rotation.x = 0.1;
    this.bodyGroup.add(chestLeaf);

    // Chest leaf vein
    const chestVein = this.createMesh(
      new THREE.CylinderGeometry(0.003, 0.002, 0.12, 4),
      LEAF,
    );
    chestVein.position.set(0.05, 0.85, -0.335);
    this.bodyGroup.add(chestVein);
  }

  // ── STEM CAP (top of the gourd — headGroup) ────────────────

  private buildStemCap(): void {
    // Calyx (five-pointed star remnant)
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2;
      const petal = this.createMesh(
        new THREE.ConeGeometry(0.025, 0.06, 4),
        GOURD_GREEN, { roughness: 0.8 },
      );
      petal.position.set(Math.sin(angle) * 0.04, 0.02, Math.cos(angle) * 0.04);
      petal.rotation.x = Math.cos(angle) * 0.5;
      petal.rotation.z = Math.sin(angle) * 0.5;
      this.headGroup.add(petal);
    }

    // Main stem stump
    const stem = this.createMesh(
      new THREE.CylinderGeometry(0.03, 0.05, 0.08, 6),
      VINE_DARK, { roughness: 0.85 },
    );
    stem.position.set(0, 0.06, 0);
    this.headGroup.add(stem);

    // Broken stem tip (ripped off to use as a weapon!)
    const brokenTip = this.createMesh(
      new THREE.CylinderGeometry(0.015, 0.03, 0.03, 6),
      VINE, { roughness: 0.7 },
    );
    brokenTip.position.set(0, 0.11, 0);
    brokenTip.rotation.x = 0.3;
    brokenTip.rotation.z = 0.2;
    this.headGroup.add(brokenTip);

    // Tiny leaf still clinging to the cap
    const capLeaf = this.createMesh(
      new THREE.PlaneGeometry(0.04, 0.03),
      LEAF, { roughness: 0.75, side: THREE.DoubleSide },
    );
    capLeaf.position.set(0.03, 0.08, 0.03);
    capLeaf.rotation.x = -0.8;
    capLeaf.rotation.z = 0.4;
    this.headGroup.add(capLeaf);
  }

  // ── VINE DETAILS (belt, bandolier, tendrils) ───────────────

  private buildVineDetails(): void {
    // Vine belt wrapping the waist
    const belt = this.createMesh(
      new THREE.TorusGeometry(0.34, 0.015, 6, 16),
      VINE_DARK, { roughness: 0.8 },
    );
    belt.position.set(0, 0.82, 0);
    belt.rotation.x = Math.PI / 2;
    this.bodyGroup.add(belt);

    // Bandolier vine across the chest
    const bandolier = this.createMesh(
      new THREE.TorusGeometry(0.28, 0.012, 6, 14, Math.PI * 1.2),
      VINE, { roughness: 0.8 },
    );
    bandolier.position.set(-0.05, 1.05, 0);
    bandolier.rotation.x = Math.PI / 2;
    bandolier.rotation.z = 0.6;
    this.bodyGroup.add(bandolier);

    // Small hanging tendrils from belt
    const tendrilGeo = new THREE.CylinderGeometry(0.006, 0.003, 0.1, 4);
    const tendrilData = [
      { x: 0.3, y: 0.78, z: -0.1, rz: 0.3 },
      { x: -0.28, y: 0.8, z: 0.12, rz: -0.4 },
      { x: 0.1, y: 0.76, z: -0.3, rz: 0.2 },
      { x: -0.15, y: 0.77, z: 0.28, rz: -0.2 },
    ];
    for (const td of tendrilData) {
      const tendril = this.createMesh(tendrilGeo, VINE, { roughness: 0.85 });
      tendril.position.set(td.x, td.y, td.z);
      tendril.rotation.z = td.rz;
      this.bodyGroup.add(tendril);
    }

    // Curling vine on the upper body
    const curl = this.createMesh(
      new THREE.TorusGeometry(0.04, 0.006, 5, 8, Math.PI * 1.5),
      VINE, { roughness: 0.8 },
    );
    curl.position.set(0.18, 1.15, -0.15);
    curl.rotation.x = 0.3;
    curl.rotation.y = 0.5;
    this.bodyGroup.add(curl);
  }

  // ── ANIMATION OVERRIDES ───────────────────────────────────

  protected override onAnimate(dt: number, input: AnimationInput): void {
    this.stemPhase += dt;

    // Splay arms outward so they clear the rotund gourd body
    this.leftArmGroup.rotation.z -= 0.2;
    this.rightArmGroup.rotation.z += 0.2;

    // Idle sway — gourd wobbles gently with menace
    if (!input.isMoving && input.isGrounded && !this.isAutoAttacking
      && !this.stunActive && !this.restingActive) {
      this.swayPhase += dt * 0.5;
      const sway = Math.sin(this.swayPhase * Math.PI * 2);

      // Gentle body rock
      this.bodyGroup.rotation.z += sway * 0.025;
      this.bodyGroup.position.y += Math.sin(this.swayPhase * Math.PI * 3) * 0.01;

      // Stem cap bobs opposite
      this.headGroup.rotation.z -= sway * 0.015;
      this.headGroup.rotation.x += Math.sin(this.swayPhase * Math.PI * 1.5) * 0.02;
    }

    // Stem whip idle sway (gentle dangling wave when not swinging)
    if (this.stemSegments.length > 0 && this.attackAnimTime < 0) {
      const swayMult = input.isMoving ? 1.5 : 1.0;
      for (let i = 0; i < this.stemSegments.length; i++) {
        const seg = this.stemSegments[i];
        const phase = this.stemPhase * 2 + i * 0.4;
        seg.rotation.x = Math.sin(phase) * 0.05 * (i * 0.3 + 0.1) * swayMult;
        seg.rotation.z = Math.cos(phase * 0.7) * 0.03 * (i * 0.2) * swayMult;
      }
    }
  }

  // ── Combat stance — whip pulled back, menacing crouch ──

  protected override animateCombatStance(weight: number): void {
    // Right arm pulled back, whip ready
    this.rightArmGroup.rotation.x += 0.3 * weight;
    this.rightArmGroup.rotation.z -= 0.15 * weight;

    // Left fist forward guard
    this.leftArmGroup.rotation.x += 0.5 * weight;
    this.leftArmGroup.rotation.z += 0.2 * weight;

    // Aggressive forward hunch
    this.bodyGroup.rotation.x += 0.08 * weight;

    // Wider root stance
    this.leftLegGroup.rotation.z -= 0.05 * weight;
    this.rightLegGroup.rotation.z += 0.05 * weight;
  }

  // ── Attack swing — stem whip crack ──

  protected override animateAttackSwing(t: number, alternateArm: boolean): void {
    if (!alternateArm) {
      // Overhead whip crack
      if (t < 0.2) {
        // Wind-up — arm goes back, whip trails behind
        const p = t / 0.2;
        this.rightArmGroup.rotation.x -= 1.0 * p;
        this.bodyGroup.rotation.x -= 0.1 * p;
        for (let i = 0; i < this.stemSegments.length; i++) {
          this.stemSegments[i].rotation.x = -0.15 * p * (i + 1) * 0.3;
          this.stemSegments[i].rotation.z = 0;
        }
      } else if (t < 0.5) {
        // CRACK — arm swings forward, wave propagates through whip
        const p = (t - 0.2) / 0.3;
        const ease = p * p * (3 - 2 * p);
        this.rightArmGroup.rotation.x = -1.0 + 2.6 * ease;
        this.bodyGroup.rotation.x = -0.1 + 0.2 * ease;
        this.bodyGroup.position.z -= 0.02 * ease;
        for (let i = 0; i < this.stemSegments.length; i++) {
          const delay = i * 0.15;
          const localT = Math.max(0, Math.min(1, (p - delay) * 2.5));
          const wave = Math.sin(localT * Math.PI);
          this.stemSegments[i].rotation.x = -0.15 * (1 - localT) + 0.6 * wave;
          this.stemSegments[i].rotation.z = 0;
        }
      } else {
        // Recovery — ease back to neutral
        const p = (t - 0.5) / 0.5;
        const fade = 1 - p * p;
        this.rightArmGroup.rotation.x = 1.6 * fade;
        this.bodyGroup.rotation.x = 0.1 * fade;
        this.bodyGroup.position.z -= 0.02 * fade;
        for (let i = 0; i < this.stemSegments.length; i++) {
          this.stemSegments[i].rotation.x = 0.2 * fade * Math.sin((1 - p) * Math.PI + i);
          this.stemSegments[i].rotation.z = 0;
        }
      }
    } else {
      // Side whip slash
      if (t < 0.2) {
        const p = t / 0.2;
        this.rightArmGroup.rotation.y -= 0.6 * p;
        this.rightArmGroup.rotation.x += 0.5 * p;
        this.bodyGroup.rotation.y -= 0.15 * p;
        for (let i = 0; i < this.stemSegments.length; i++) {
          this.stemSegments[i].rotation.z = -0.1 * p * (i + 1) * 0.3;
          this.stemSegments[i].rotation.x = 0;
        }
      } else if (t < 0.5) {
        const p = (t - 0.2) / 0.3;
        const ease = p * p;
        this.rightArmGroup.rotation.y = -0.6 + 1.4 * ease;
        this.rightArmGroup.rotation.x = 0.5;
        this.bodyGroup.rotation.y = -0.15 + 0.4 * ease;
        for (let i = 0; i < this.stemSegments.length; i++) {
          const delay = i * 0.12;
          const localT = Math.max(0, Math.min(1, (p - delay) * 2.5));
          const wave = Math.sin(localT * Math.PI);
          this.stemSegments[i].rotation.z = -0.1 * (1 - localT) + 0.5 * wave;
          this.stemSegments[i].rotation.x = 0;
        }
      } else {
        const p = (t - 0.5) / 0.5;
        const fade = 1 - p;
        this.rightArmGroup.rotation.y = 0.8 * fade;
        this.rightArmGroup.rotation.x = 0.5 * fade;
        this.bodyGroup.rotation.y = 0.25 * fade;
        for (let i = 0; i < this.stemSegments.length; i++) {
          this.stemSegments[i].rotation.z = 0.15 * fade * Math.sin((1 - p) * Math.PI + i * 0.5);
          this.stemSegments[i].rotation.x = 0;
        }
      }
    }
  }

  protected override getSwingDuration(): number {
    return 0.5; // whip has wind-up
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
