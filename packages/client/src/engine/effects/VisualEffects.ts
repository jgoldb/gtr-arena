import * as THREE from 'three';

// ── Types ────────────────────────────────────────────────────────────────

export interface GasCloudVisual {
  group: THREE.Group;
  puffs: THREE.Mesh[];
}

export interface ChemPoolVisual {
  group: THREE.Group;
  ripples: THREE.Mesh[];
}

export interface FullRetardAuraVisual {
  group: THREE.Group;
  puffs: THREE.Mesh[];
}

export interface CrotchRotVisual {
  group: THREE.Group;
  puffs: THREE.Mesh[];
}

export const POOL_CONSUME_DURATION = 0.6;

// ── Disposal ─────────────────────────────────────────────────────────────

export function disposeGroup(scene: THREE.Scene, group: THREE.Group): void {
  group.traverse(child => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
  });
  scene.remove(group);
}

// ── Gas Cloud ────────────────────────────────────────────────────────────

export function createGasCloud(scene: THREE.Scene, x: number, z: number, radius: number, y = 0): GasCloudVisual {
  const group = new THREE.Group();
  group.position.set(x, y + 0.02, z);

  // Base ground disc
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x556b2f, transparent: true, opacity: 0.2,
    roughness: 1.0, depthWrite: false,
  });
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, 0.04, 24), baseMat
  );
  base.position.y = 0.02;
  base.renderOrder = 1;
  group.add(base);

  // Gas puff spheres
  const puffs: THREE.Mesh[] = [];
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const r = radius * (0.25 + Math.random() * 0.6);
    const size = 0.3 + Math.random() * 0.5;
    const puffMat = new THREE.MeshStandardMaterial({
      color: 0x7a8b3a, transparent: true,
      opacity: 0.18 + Math.random() * 0.12,
      roughness: 1.0, depthWrite: false,
      emissive: 0x2a3b0a, emissiveIntensity: 0.3,
    });
    const puff = new THREE.Mesh(new THREE.SphereGeometry(size, 8, 6), puffMat);
    puff.position.set(Math.cos(angle) * r, 0.15 + Math.random() * 0.35, Math.sin(angle) * r);
    puff.renderOrder = 2;
    puff.userData.orbitAngle = angle;
    puff.userData.orbitRadius = r;
    puff.userData.orbitSpeed = 0.3 + Math.random() * 0.4;
    puff.userData.baseY = puff.position.y;
    puff.userData.baseOpacity = puffMat.opacity;
    puff.userData.baseScale = 0.8 + Math.random() * 0.4;
    puff.scale.setScalar(puff.userData.baseScale);
    group.add(puff);
    puffs.push(puff);
  }

  scene.add(group);
  return { group, puffs };
}

/** Animate gas cloud. Returns true when expired (caller should dispose). */
export function updateGasCloud(visual: GasCloudVisual, elapsed: number, duration: number, dt: number): boolean {
  visual.group.rotation.y += dt * 0.3;

  const fadeStart = duration - 1.5;
  const fade = elapsed > fadeStart
    ? Math.max(0, 1 - (elapsed - fadeStart) / 1.5)
    : Math.min(1, elapsed / 0.5);

  for (const puff of visual.puffs) {
    const a = puff.userData.orbitAngle + elapsed * puff.userData.orbitSpeed;
    const r = puff.userData.orbitRadius;
    puff.position.x = Math.cos(a) * r;
    puff.position.z = Math.sin(a) * r;
    puff.position.y = puff.userData.baseY + Math.sin(elapsed * 1.5 + a) * 0.1;
    const pulse = 1 + Math.sin(elapsed * 1.8 + a * 2) * 0.15;
    puff.scale.setScalar(puff.userData.baseScale * pulse);
    (puff.material as THREE.MeshStandardMaterial).opacity = puff.userData.baseOpacity * fade;
  }

  // Fade base disc
  const baseMesh = visual.group.children[0] as THREE.Mesh;
  (baseMesh.material as THREE.MeshStandardMaterial).opacity = 0.2 * fade;

  return elapsed >= duration;
}

// ── Chemical Pool ────────────────────────────────────────────────────────

export function createChemPool(scene: THREE.Scene, x: number, z: number, radius: number, y = 0): ChemPoolVisual {
  const group = new THREE.Group();
  group.position.set(x, y + 0.02, z);

  // Base pool disc — mixed green/purple chemical liquid
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x44aa66, transparent: true, opacity: 0.35,
    roughness: 0.2, metalness: 0.1, depthWrite: false,
    emissive: 0x228844, emissiveIntensity: 0.3,
  });
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, 0.02, 24), baseMat
  );
  base.position.y = 0.01;
  base.renderOrder = 1;
  group.add(base);

  // Secondary purple layer — slightly smaller, offset
  const purpleMat = new THREE.MeshStandardMaterial({
    color: 0x8844cc, transparent: true, opacity: 0.25,
    roughness: 0.2, depthWrite: false,
    emissive: 0x6633aa, emissiveIntensity: 0.4,
  });
  const purpleLayer = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.75, radius * 0.8, 0.02, 24), purpleMat
  );
  purpleLayer.position.y = 0.02;
  purpleLayer.renderOrder = 2;
  group.add(purpleLayer);

  // Ripple rings — concentric circles that pulse outward
  const ripples: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const rippleRadius = radius * (0.3 + i * 0.2);
    const rippleMat = new THREE.MeshStandardMaterial({
      color: i % 2 === 0 ? 0x55dd77 : 0xaa55dd,
      transparent: true, opacity: 0.15, roughness: 0.1, depthWrite: false,
      emissive: i % 2 === 0 ? 0x33bb55 : 0x8833bb, emissiveIntensity: 0.5,
    });
    const ripple = new THREE.Mesh(
      new THREE.TorusGeometry(rippleRadius, 0.03, 4, 24), rippleMat
    );
    ripple.rotation.x = -Math.PI / 2;
    ripple.position.y = 0.03;
    ripple.renderOrder = 3;
    ripple.userData.baseRadius = rippleRadius;
    ripple.userData.phase = i * Math.PI * 0.5;
    group.add(ripple);
    ripples.push(ripple);
  }

  // Small bubble spheres sitting on the surface
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const r = radius * (0.2 + Math.random() * 0.6);
    const size = 0.04 + Math.random() * 0.06;
    const bubbleMat = new THREE.MeshStandardMaterial({
      color: i % 2 === 0 ? 0x66ff88 : 0xcc88ff,
      transparent: true, opacity: 0.4 + Math.random() * 0.2,
      roughness: 0.1, depthWrite: false,
      emissive: i % 2 === 0 ? 0x33dd55 : 0x9955cc, emissiveIntensity: 0.6,
    });
    const bubble = new THREE.Mesh(new THREE.SphereGeometry(size, 6, 6), bubbleMat);
    bubble.position.set(Math.cos(angle) * r, 0.03 + Math.random() * 0.04, Math.sin(angle) * r);
    bubble.renderOrder = 4;
    group.add(bubble);
  }

  scene.add(group);
  return { group, ripples };
}

/**
 * Animate chemical pool through its lifecycle phases.
 * Returns true when the pool should be removed (caller should dispose).
 */
export function updateChemPool(
  visual: ChemPoolVisual,
  elapsed: number,
  duration: number,
  activationDelay: number,
  consumed: boolean,
  consumeElapsed: number,
  dt: number,
): boolean {
  // Phase 1: Consumed — fade out and shrink
  if (consumed) {
    const fade = Math.max(0, 1 - consumeElapsed / POOL_CONSUME_DURATION);
    applyFadeToGroup(visual.group, fade);
    visual.group.scale.setScalar(fade);
    return consumeElapsed >= POOL_CONSUME_DURATION;
  }

  // Phase 2: Arming — dimmed ripples
  if (elapsed < activationDelay) {
    for (const ripple of visual.ripples) {
      const phase = ripple.userData.phase as number;
      const pulse = 1 + Math.sin(elapsed * 2.5 + phase) * 0.15;
      ripple.scale.setScalar(pulse);
      (ripple.material as THREE.MeshStandardMaterial).opacity =
        0.08 * (0.6 + Math.sin(elapsed * 3 + phase) * 0.4);
    }
    visual.group.rotation.y += dt * 0.15;
    const fade = Math.min(1, elapsed / 0.4) * 0.5;
    applyFadeToGroup(visual.group, fade);
    return false;
  }

  // Phase 3: Active — bright ripples
  for (const ripple of visual.ripples) {
    const phase = ripple.userData.phase as number;
    const pulse = 1 + Math.sin(elapsed * 2.5 + phase) * 0.15;
    ripple.scale.setScalar(pulse);
    (ripple.material as THREE.MeshStandardMaterial).opacity =
      0.15 * (0.6 + Math.sin(elapsed * 3 + phase) * 0.4);
  }
  visual.group.rotation.y += dt * 0.15;

  // Fade in / natural expiry fade out
  const fadeStart = duration - 1.5;
  const fade = elapsed > fadeStart
    ? Math.max(0, 1 - (elapsed - fadeStart) / 1.5)
    : Math.min(1, elapsed / 0.4);
  applyFadeToGroup(visual.group, fade);

  return elapsed >= duration;
}

// ── Full Retard Aura ─────────────────────────────────────────────────────

export function createFullRetardAura(scene: THREE.Scene, x: number, z: number, meleeRange: number): FullRetardAuraVisual {
  const group = new THREE.Group();

  // Subtle ground disc showing aura radius
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x8b7a00, transparent: true, opacity: 0.12,
    roughness: 1.0, depthWrite: false,
  });
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(meleeRange, meleeRange, 0.04, 24), baseMat
  );
  base.position.y = 0.02;
  base.renderOrder = 1;
  group.add(base);

  // Noxious fume puffs orbiting within melee range
  const puffs: THREE.Mesh[] = [];
  for (let i = 0; i < 18; i++) {
    const angle = (i / 18) * Math.PI * 2;
    const r = meleeRange * (0.2 + Math.random() * 0.7);
    const size = 0.15 + Math.random() * 0.35;
    const colorVariant = Math.random();
    const color = colorVariant < 0.33 ? 0x8b7a00 : colorVariant < 0.66 ? 0x6b5a00 : 0x9b8b10;
    const puffMat = new THREE.MeshStandardMaterial({
      color, transparent: true, opacity: 0.12 + Math.random() * 0.08,
      roughness: 1.0, depthWrite: false,
      emissive: 0x4a3b00, emissiveIntensity: 0.4,
    });
    const puff = new THREE.Mesh(new THREE.SphereGeometry(size, 8, 6), puffMat);
    puff.position.set(Math.cos(angle) * r, 0.08 + Math.random() * 0.5, Math.sin(angle) * r);
    puff.renderOrder = 2;
    puff.userData.orbitAngle = angle;
    puff.userData.orbitRadius = r;
    puff.userData.orbitSpeed = 0.3 + Math.random() * 0.5;
    puff.userData.baseY = puff.position.y;
    puff.userData.baseOpacity = puffMat.opacity;
    puff.userData.baseScale = 0.7 + Math.random() * 0.5;
    puff.scale.setScalar(puff.userData.baseScale);
    group.add(puff);
    puffs.push(puff);
  }

  group.position.set(x, 0, z);
  scene.add(group);
  return { group, puffs };
}

/** Animate Full Retard aura puffs. */
export function updateFullRetardAura(visual: FullRetardAuraVisual, elapsed: number, dt: number, followX: number, followZ: number): void {
  visual.group.position.set(followX, 0, followZ);

  const fadeIn = Math.min(1, elapsed / 0.5);
  visual.group.rotation.y += dt * 0.4;
  for (const puff of visual.puffs) {
    const a = puff.userData.orbitAngle + elapsed * puff.userData.orbitSpeed;
    const r = puff.userData.orbitRadius;
    puff.position.x = Math.cos(a) * r;
    puff.position.z = Math.sin(a) * r;
    puff.position.y = puff.userData.baseY + Math.sin(elapsed * 2 + a) * 0.15;
    const pulse = 1 + Math.sin(elapsed * 2.5 + a * 2) * 0.2;
    puff.scale.setScalar(puff.userData.baseScale * pulse);
    (puff.material as THREE.MeshStandardMaterial).opacity = puff.userData.baseOpacity * fadeIn;
  }
}

// ── Channel Beam ─────────────────────────────────────────────────────────

export function createChannelBeam(scene: THREE.Scene): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(0.04, 0.04, 1, 6, 1, true);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xeeeeff, emissive: 0xaabbff, emissiveIntensity: 1.5,
    transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(geo, mat);
  beam.renderOrder = 3;
  scene.add(beam);
  return beam;
}

/** Position and animate channel beam between caster and target. */
export function updateChannelBeam(beam: THREE.Mesh, casterPos: THREE.Vector3, targetPos: THREE.Vector3, elapsed: number): void {
  const start = new THREE.Vector3(casterPos.x, casterPos.y + 1.6, casterPos.z);
  const end = new THREE.Vector3(targetPos.x, targetPos.y + 1.0, targetPos.z);
  const midPoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  if (length < 0.01) return;

  beam.position.copy(midPoint);
  beam.scale.set(1, length, 1);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  (beam.material as THREE.MeshStandardMaterial).opacity = 0.55 + Math.sin(elapsed * 6) * 0.15;
}

export function removeChannelBeam(scene: THREE.Scene, beam: THREE.Mesh): void {
  beam.geometry.dispose();
  (beam.material as THREE.Material).dispose();
  scene.remove(beam);
}

// ── Bandage Heal Effect ──────────────────────────────────────────────────

export interface BandageHealVisual {
  group: THREE.Group;
  particles: THREE.Mesh[];
  glow: THREE.Mesh;
}

export function createBandageHealEffect(scene: THREE.Scene): BandageHealVisual {
  const group = new THREE.Group();

  // Ground glow ring
  const glowGeo = new THREE.RingGeometry(0.25, 0.6, 24);
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0x66ff88, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.03;
  group.add(glow);

  // Rising heal particles — small plus-shaped crosses
  const particles: THREE.Mesh[] = [];
  for (let i = 0; i < 10; i++) {
    const geo = new THREE.PlaneGeometry(0.08, 0.08);
    const mat = new THREE.MeshBasicMaterial({
      color: i % 3 === 0 ? 0xffffff : 0x88ffaa,
      transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide,
    });
    const particle = new THREE.Mesh(geo, mat);
    particle.userData.phase = (i / 10) * Math.PI * 2;
    particle.userData.speed = 0.4 + Math.random() * 0.3;
    particle.userData.radius = 0.2 + Math.random() * 0.35;
    group.add(particle);
    particles.push(particle);
  }

  scene.add(group);
  return { group, particles, glow };
}

export function updateBandageHealEffect(visual: BandageHealVisual, targetPos: THREE.Vector3, elapsed: number): void {
  visual.group.position.set(targetPos.x, targetPos.y, targetPos.z);

  // Pulse ground glow
  (visual.glow.material as THREE.MeshBasicMaterial).opacity = 0.2 + Math.sin(elapsed * 4) * 0.1;
  visual.glow.scale.setScalar(1 + Math.sin(elapsed * 3) * 0.08);

  // Animate particles: rise in a gentle spiral, fade and reset
  for (const p of visual.particles) {
    const phase = p.userData.phase;
    const speed = p.userData.speed;
    const r = p.userData.radius;
    // Each particle loops on its own cycle (rises then resets)
    const cycle = ((elapsed * speed + phase) % 1.5);
    const yPos = cycle * 1.4; // rise up to ~2 units
    const fade = cycle < 0.2 ? cycle / 0.2 : Math.max(0, 1 - (cycle - 0.8) / 0.7);

    p.position.x = Math.cos(phase + elapsed * 1.2) * r;
    p.position.z = Math.sin(phase + elapsed * 1.2) * r;
    p.position.y = yPos;
    p.rotation.z = elapsed * 2 + phase;
    (p.material as THREE.MeshBasicMaterial).opacity = 0.7 * fade;
  }
}

export function removeBandageHealEffect(scene: THREE.Scene, visual: BandageHealVisual): void {
  visual.group.traverse(child => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
  });
  scene.remove(visual.group);
}

// ── Crotch Rot Cloud ─────────────────────────────────────────────────────

/** Create dense black cloud puffs that cling to a character's midsection. */
export function createCrotchRotCloud(): CrotchRotVisual {
  const group = new THREE.Group();

  const puffs: THREE.Mesh[] = [];
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2;
    const r = 0.1 + Math.random() * 0.22;
    const size = 0.1 + Math.random() * 0.12;
    // Mix of dark black-green tones
    const colorVariant = Math.random();
    const color = colorVariant < 0.4 ? 0x0a0a0a : colorVariant < 0.7 ? 0x0d1a0a : 0x151505;
    const puffMat = new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity: 0.55 + Math.random() * 0.2,
      roughness: 1.0,
      depthWrite: false,
      emissive: 0x0a1a05,
      emissiveIntensity: 0.4,
    });
    const puff = new THREE.Mesh(new THREE.SphereGeometry(size, 7, 5), puffMat);
    puff.position.set(
      Math.cos(angle) * r,
      (Math.random() - 0.5) * 0.15,
      Math.sin(angle) * r,
    );
    puff.renderOrder = 5;
    puff.userData.orbitAngle = angle;
    puff.userData.orbitRadius = r;
    puff.userData.orbitSpeed = 0.5 + Math.random() * 0.7;
    puff.userData.baseY = puff.position.y;
    puff.userData.baseOpacity = puffMat.opacity;
    puff.userData.baseScale = 0.9 + Math.random() * 0.5;
    puff.userData.riseSpeed = 0.04 + Math.random() * 0.05;
    puff.scale.setScalar(puff.userData.baseScale);
    group.add(puff);
    puffs.push(puff);
  }

  return { group, puffs };
}

/** Animate crotch rot cloud puffs — swirl and ooze upward from the midsection. */
export function updateCrotchRotCloud(
  visual: CrotchRotVisual,
  elapsed: number,
  followX: number,
  followY: number,
  followZ: number,
): void {
  // Attach to character midsection (hip height ~0.78)
  visual.group.position.set(followX, followY + 0.78, followZ);
  visual.group.rotation.y += 0.008;

  const fadeIn = Math.min(1, elapsed / 0.4);

  for (const puff of visual.puffs) {
    const a = puff.userData.orbitAngle + elapsed * puff.userData.orbitSpeed;
    const r = puff.userData.orbitRadius;
    puff.position.x = Math.cos(a) * r;
    puff.position.z = Math.sin(a) * r;

    // Rise and resettle in a cycle — oozing upward effect
    const risePhase = (elapsed * puff.userData.riseSpeed * 8 + puff.userData.orbitAngle) % (Math.PI * 2);
    puff.position.y = puff.userData.baseY + Math.max(0, Math.sin(risePhase)) * 0.25;

    // Pulse scale for organic churning feel
    const pulse = 1 + Math.sin(elapsed * 2.5 + a * 2) * 0.25;
    puff.scale.setScalar(puff.userData.baseScale * pulse);

    (puff.material as THREE.MeshStandardMaterial).opacity =
      puff.userData.baseOpacity * fadeIn;
  }
}

// ── Grenade ───────────────────────────────────────────────────────────────

export interface GrenadeProjectileVisual {
  group: THREE.Group;
  body: THREE.Mesh;
  start: THREE.Vector3;
  end: THREE.Vector3;
  duration: number;
  elapsed: number;
}

/** Create the in-flight grenade projectile mesh and add it to the scene. */
export function createGrenadeProjectile(scene: THREE.Scene, start: THREE.Vector3, end: THREE.Vector3, duration: number): GrenadeProjectileVisual {
  const group = new THREE.Group();
  // Body
  const bodyGeo = new THREE.SphereGeometry(0.09, 12, 10);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x2d3a1f, roughness: 0.8, metalness: 0.2,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.castShadow = true;
  group.add(body);
  // Top cap
  const capGeo = new THREE.CylinderGeometry(0.045, 0.05, 0.05, 8);
  const capMat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.5, metalness: 0.6 });
  const cap = new THREE.Mesh(capGeo, capMat);
  cap.position.y = 0.095;
  group.add(cap);

  group.position.copy(start);
  scene.add(group);

  return { group, body, start: start.clone(), end: end.clone(), duration, elapsed: 0 };
}

/** Update the grenade projectile in flight. Returns true when impact is reached. */
export function updateGrenadeProjectile(visual: GrenadeProjectileVisual, dt: number): boolean {
  visual.elapsed += dt;
  const t = Math.min(1, visual.elapsed / visual.duration);
  // Linear XZ interpolation, parabolic Y arc
  const x = visual.start.x + (visual.end.x - visual.start.x) * t;
  const z = visual.start.z + (visual.end.z - visual.start.z) * t;
  // Arc height — peak at midpoint. Scale with horizontal distance so longer throws arc higher.
  const dx = visual.end.x - visual.start.x;
  const dz = visual.end.z - visual.start.z;
  const horiz = Math.sqrt(dx * dx + dz * dz);
  const peak = Math.max(1.6, horiz * 0.45);
  const baseY = visual.start.y + (visual.end.y - visual.start.y) * t;
  const arc = 4 * peak * t * (1 - t); // parabola: 0 → peak → 0
  const y = baseY + arc;
  visual.group.position.set(x, y, z);
  // Tumble in flight
  visual.group.rotation.x += dt * 9;
  visual.group.rotation.z += dt * 4;
  return t >= 1;
}

export interface GrenadeExplosionVisual {
  group: THREE.Group;
  flash: THREE.Mesh;
  ring: THREE.Mesh;
  shards: { mesh: THREE.Mesh; vel: THREE.Vector3 }[];
  smokes: THREE.Mesh[];
  elapsed: number;
  duration: number;
  radius: number;
}

/** Spawn an explosion centered at `pos` with the given AoE radius. */
export function createGrenadeExplosion(scene: THREE.Scene, pos: THREE.Vector3, radius: number): GrenadeExplosionVisual {
  const group = new THREE.Group();
  group.position.copy(pos);
  group.position.y += 0.05;

  // Bright initial flash sphere
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xfff0a0, transparent: true, opacity: 1, depthWrite: false,
  });
  const flash = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.5, 16, 12), flashMat);
  flash.renderOrder = 5;
  group.add(flash);

  // Expanding shockwave ring on the ground
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffaa44, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.2, radius * 0.3, 32), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  ring.renderOrder = 4;
  group.add(ring);

  // Shrapnel shards flying outward
  const shards: { mesh: THREE.Mesh; vel: THREE.Vector3 }[] = [];
  const shardGeo = new THREE.SphereGeometry(0.05, 5, 4);
  for (let i = 0; i < 18; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffcc66, transparent: true, opacity: 1.0,
    });
    const mesh = new THREE.Mesh(shardGeo, mat);
    const angle = Math.random() * Math.PI * 2;
    const speed = 4 + Math.random() * 5;
    const vy = 2 + Math.random() * 3;
    const vel = new THREE.Vector3(Math.cos(angle) * speed, vy, Math.sin(angle) * speed);
    mesh.position.set(0, 0.2, 0);
    group.add(mesh);
    shards.push({ mesh, vel });
  }

  // Dark smoke puffs that linger
  const smokes: THREE.Mesh[] = [];
  for (let i = 0; i < 8; i++) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x404040, transparent: true, opacity: 0.7,
      roughness: 1.0, depthWrite: false,
      emissive: 0x202020, emissiveIntensity: 0.2,
    });
    const size = 0.35 + Math.random() * 0.4;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(size, 8, 6), mat);
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * radius * 0.6;
    mesh.position.set(Math.cos(angle) * r, 0.4 + Math.random() * 0.3, Math.sin(angle) * r);
    mesh.userData.driftY = 0.4 + Math.random() * 0.3;
    mesh.renderOrder = 3;
    group.add(mesh);
    smokes.push(mesh);
  }

  scene.add(group);
  return { group, flash, ring, shards, smokes, elapsed: 0, duration: 1.1, radius };
}

/** Returns true when the explosion has finished and should be removed. */
export function updateGrenadeExplosion(visual: GrenadeExplosionVisual, dt: number): boolean {
  visual.elapsed += dt;
  const t = Math.min(1, visual.elapsed / visual.duration);

  // Flash: rapid expand then fade
  const flashT = Math.min(1, visual.elapsed / 0.18);
  const flashScale = 1 + flashT * 1.6;
  visual.flash.scale.setScalar(flashScale);
  (visual.flash.material as THREE.MeshBasicMaterial).opacity = (1 - flashT) * (1 - flashT);

  // Ring: expand outward, fade
  const ringScale = 1 + t * 4;
  visual.ring.scale.setScalar(ringScale);
  (visual.ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t * t);

  // Shards: ballistic with gravity, fade in second half
  for (const s of visual.shards) {
    s.vel.y -= 14 * dt;
    s.mesh.position.addScaledVector(s.vel, dt);
    if (s.mesh.position.y < 0.05) {
      s.mesh.position.y = 0.05;
      s.vel.set(0, 0, 0);
    }
    const fade = t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5;
    (s.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, fade);
  }

  // Smoke: drift up and fade slowly
  for (const sm of visual.smokes) {
    sm.position.y += sm.userData.driftY * dt;
    const fade = 1 - t;
    (sm.material as THREE.MeshStandardMaterial).opacity = 0.7 * fade;
    sm.scale.setScalar(1 + t * 0.6);
  }

  return t >= 1;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function applyFadeToGroup(group: THREE.Group, fade: number): void {
  group.traverse(child => {
    if (child instanceof THREE.Mesh) {
      const mat = child.material as THREE.MeshStandardMaterial;
      if (mat.userData.baseOpacity === undefined) {
        mat.userData.baseOpacity = mat.opacity;
      }
      mat.opacity = mat.userData.baseOpacity * fade;
    }
  });
}
