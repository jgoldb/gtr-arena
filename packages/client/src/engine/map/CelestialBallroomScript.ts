import * as THREE from 'three';
import { ArenaScript } from './ArenaScript';
import type { Collider, BoxCollider } from '../physics/CollisionSystem';
import { audioSettings } from '../../ui/AudioSettings';

export class CelestialBallroomScript extends ArenaScript {
  // Oval arena dimensions
  private readonly SEMI_MAJOR = 56; // X axis
  private readonly SEMI_MINOR = 44; // Z axis
  private readonly WALL_HEIGHT = 12;

  // Starting zone bubbles
  private readonly BUBBLE_RADIUS = 7;
  private readonly BUBBLE_SPAWN_Z = 32; // ±Z for the two starting zones

  // Visual references
  private plasmaWallMaterial: THREE.ShaderMaterial | null = null;
  private bubbleMaterials: THREE.ShaderMaterial[] = [];
  private bubbleMeshes: THREE.Mesh[] = [];
  private bubbleColliders: Collider[] = [];
  private archShaderMaterials: THREE.ShaderMaterial[] = [];
  private glassPlatformGroup: THREE.Group | null = null;
  private glassPlatformCollider: BoxCollider | null = null;
  private lastPlatformY = 0.2;
  private platformJumped = false;

  // One-shot ambient sounds
  private ambientAudioCtx: AudioContext | null = null;
  private doorsOpenBuffer: AudioBuffer | null = null;

  protected override readonly OPEN_ANIM_DURATION = 1.5;

  constructor() {
    super({
      title: 'CELESTIAL BALLROOM',
      titleColor: '#aa66ff',
      subtitle: 'Containment field collapses in',
      urgentColor: '#ff44ff',
      fightColor: '#cc66ff',
      flashColor: 0xcc88ff,
      flashIntensity: 8,
    });
  }

  // ---------------------------------------------------------------------------
  // ArenaScript hooks
  // ---------------------------------------------------------------------------
  protected initArena(scene: THREE.Scene): void {
    this.preloadAmbientSounds();
    this.createSkybox(scene);
    this.createAsteroidGround();
    this.createPlasmaWall();
    this.createOvalCollision();
    this.createStartingBubbles();
    this.createBubbleCollision();
    this.createArenaLighting();
    this.createDiamondArchways();
    this.createGlassPlatform();
  }

  protected updateArena(): void {
    // Update plasma shader time uniforms
    if (this.plasmaWallMaterial) {
      this.plasmaWallMaterial.uniforms.uTime.value = this.elapsed;
    }
    for (const mat of this.bubbleMaterials) {
      mat.uniforms.uTime.value = this.elapsed;
    }
    for (const mat of this.archShaderMaterials) {
      mat.uniforms.uTime.value = this.elapsed;
    }
    this.updatePlatform();
  }

  protected disposeArena(): void {
    this.plasmaWallMaterial = null;
    this.bubbleMaterials = [];
    this.bubbleMeshes = [];
    this.bubbleColliders = [];
    this.archShaderMaterials = [];
    this.glassPlatformGroup = null;
    this.glassPlatformCollider = null;
    if (this.ambientAudioCtx) {
      this.ambientAudioCtx.close();
      this.ambientAudioCtx = null;
    }
    this.doorsOpenBuffer = null;
  }

  protected onOpen(): void {
    this.playDoorsOpenSound();
    for (const collider of this.bubbleColliders) {
      this.collision.removeCollider(collider);
    }
  }

  private async preloadAmbientSounds(): Promise<void> {
    try {
      const ctx = new AudioContext();
      this.ambientAudioCtx = ctx;
      const resp = await fetch('/audio/ambient/maps/celestial-ballroom/doors_open.ogg');
      const buf = await resp.arrayBuffer();
      this.doorsOpenBuffer = await ctx.decodeAudioData(buf);
    } catch (e) {
      console.warn('Failed to preload ambient sounds:', e);
    }
  }

  private playDoorsOpenSound(): void {
    if (!this.ambientAudioCtx || !this.doorsOpenBuffer) return;
    if (!audioSettings.enableAmbient || !audioSettings.windowFocused) return;

    const ctx = this.ambientAudioCtx;
    if (ctx.state === 'suspended') ctx.resume();

    const gain = ctx.createGain();
    gain.gain.value = audioSettings.masterVolume * audioSettings.ambientVolume * 3;
    gain.connect(ctx.destination);

    const source = ctx.createBufferSource();
    source.buffer = this.doorsOpenBuffer;
    source.loop = false;
    source.connect(gain);
    source.start();
  }

  protected animateOpen(t: number): void {
    for (let i = 0; i < this.bubbleMeshes.length; i++) {
      const mesh = this.bubbleMeshes[i];
      const mat = this.bubbleMaterials[i];

      // Expand and fade
      const scale = 1 + t * 2.5;
      mesh.scale.set(scale, scale, scale);
      mat.uniforms.uOpacity.value = 1 - t;

      if (t >= 1) {
        this.group.remove(mesh);
      }
    }

    if (t >= 1) {
      this.bubbleMeshes = [];
      this.bubbleMaterials = [];
    }
  }

  protected getFlashPositions(): { x: number; y: number; z: number }[] {
    return [
      { x: 0, y: 6, z: this.BUBBLE_SPAWN_Z },
      { x: 0, y: 6, z: -this.BUBBLE_SPAWN_Z },
    ];
  }

  // ---------------------------------------------------------------------------
  // Space skybox with milky way
  // ---------------------------------------------------------------------------
  private createSkybox(scene: THREE.Scene): void {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d')!;

    // Seeded random for deterministic sky
    let seed = 7777;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    // Base: deep space
    ctx.fillStyle = '#000005';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Milky way band (horizontal band across the sky)
    const bandCenterY = canvas.height * 0.45;
    const bandWidth = canvas.height * 0.22;

    // Dense star cluster for milky way
    for (let i = 0; i < 18000; i++) {
      const x = random() * canvas.width;
      // Central limit approximation for gaussian distribution
      const spread = (random() + random() + random()) / 3;
      const y = bandCenterY + (spread - 0.5) * bandWidth * 2.5
        + Math.sin(x / canvas.width * Math.PI * 1.5) * 30;

      const brightness = 80 + random() * 175;
      const size = random() * 1.5;

      const r = brightness * (0.7 + random() * 0.3);
      const g = brightness * (0.7 + random() * 0.3);
      const b = brightness * (0.85 + random() * 0.15);

      ctx.fillStyle = `rgba(${Math.floor(r)},${Math.floor(g)},${Math.floor(b)},${0.3 + random() * 0.7})`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }

    // Nebula glow across milky way
    const gradient = ctx.createRadialGradient(
      canvas.width * 0.5, bandCenterY, 0,
      canvas.width * 0.5, bandCenterY, canvas.width * 0.45,
    );
    gradient.addColorStop(0, 'rgba(100, 80, 140, 0.12)');
    gradient.addColorStop(0.3, 'rgba(60, 50, 100, 0.08)');
    gradient.addColorStop(0.6, 'rgba(40, 30, 80, 0.04)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Nebula clouds along the band
    for (let i = 0; i < 25; i++) {
      const cx = random() * canvas.width;
      const cy = bandCenterY + (random() - 0.5) * bandWidth;
      const r = 30 + random() * 100;
      const nebGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      const hue = 200 + random() * 120; // blue to purple
      nebGrad.addColorStop(0, `hsla(${hue}, 40%, 40%, 0.08)`);
      nebGrad.addColorStop(0.5, `hsla(${hue}, 30%, 30%, 0.04)`);
      nebGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = nebGrad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Background stars across entire sky
    for (let i = 0; i < 4000; i++) {
      const x = random() * canvas.width;
      const y = random() * canvas.height;
      const brightness = 100 + random() * 155;
      const size = random() < 0.05 ? 1.2 + random() * 0.8 : random() * 1;

      ctx.fillStyle = `rgba(${Math.floor(brightness)},${Math.floor(brightness)},${Math.floor(brightness + random() * 30)},${0.5 + random() * 0.5})`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }

    // Bright stars with glow halos
    for (let i = 0; i < 35; i++) {
      const x = random() * canvas.width;
      const y = random() * canvas.height;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, 4 + random() * 6);
      const hue = random() < 0.3 ? 30 + random() * 30 : 200 + random() * 60;
      glow.addColorStop(0, `hsla(${hue}, 60%, 95%, 0.9)`);
      glow.addColorStop(0.3, `hsla(${hue}, 50%, 70%, 0.3)`);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = texture;
  }

  // ---------------------------------------------------------------------------
  // Asteroid ground surface
  // ---------------------------------------------------------------------------
  private createAsteroidGround(): void {
    // Remove the default ground and grid
    for (let i = this.group.children.length - 1; i >= 0; i--) {
      const child = this.group.children[i];
      if (child.name === 'ground' || child instanceof THREE.GridHelper) {
        this.group.remove(child);
        if ((child as THREE.Mesh).geometry) {
          (child as THREE.Mesh).geometry.dispose();
          const mat = (child as THREE.Mesh).material;
          if (Array.isArray(mat)) mat.forEach(m => m.dispose());
          else if (mat) (mat as THREE.Material).dispose();
        }
      }
    }

    // Create asteroid surface texture
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d')!;

    let seed = 4242;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    // Base dark gray
    ctx.fillStyle = '#2a2a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Rocky texture noise
    for (let i = 0; i < 50000; i++) {
      const x = random() * canvas.width;
      const y = random() * canvas.height;
      const v = 30 + random() * 25;
      ctx.fillStyle = `rgb(${v},${v},${Math.floor(v + random() * 5)})`;
      ctx.fillRect(x, y, 1 + random() * 3, 1 + random() * 3);
    }

    // Craters
    for (let i = 0; i < 40; i++) {
      const cx = random() * canvas.width;
      const cy = random() * canvas.height;
      const r = 10 + random() * 40;

      // Crater rim
      ctx.strokeStyle = `rgba(70, 65, 60, ${0.3 + random() * 0.3})`;
      ctx.lineWidth = 2 + random() * 3;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      // Crater interior
      const craterGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.9);
      craterGrad.addColorStop(0, `rgba(15, 15, 18, ${0.3 + random() * 0.3})`);
      craterGrad.addColorStop(0.7, `rgba(20, 20, 24, ${0.15 + random() * 0.15})`);
      craterGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = craterGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(4, 4);

    const groundSize = 200;
    const geo = new THREE.PlaneGeometry(groundSize, groundSize, 64, 64);

    // Vertex displacement for asteroid bumpiness
    const positions = geo.attributes.position;
    let bumpSeed = 999;
    const bumpRandom = () => {
      bumpSeed = (bumpSeed * 1103515245 + 12345) & 0x7fffffff;
      return bumpSeed / 0x7fffffff;
    };
    for (let i = 0; i < positions.count; i++) {
      const z = positions.getZ(i);
      positions.setZ(i, z + (bumpRandom() - 0.5) * 0.15);
    }
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      map: texture,
      color: 0x3a3a40,
      roughness: 0.95,
      metalness: 0.1,
    });

    const ground = new THREE.Mesh(geo, mat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = 'asteroidGround';
    this.group.add(ground);
  }

  // ---------------------------------------------------------------------------
  // Plasma wall (oval perimeter) — single merged BufferGeometry
  // ---------------------------------------------------------------------------
  private createPlasmaWall(): void {
    const shaderMat = this.createPlasmaShaderMaterial(1.0);
    this.plasmaWallMaterial = shaderMat;

    const wallSegments = 96;
    const wallH = this.WALL_HEIGHT;
    const vertCount = wallSegments * 6;

    const positions = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);

    for (let i = 0; i < wallSegments; i++) {
      const a1 = (i / wallSegments) * Math.PI * 2;
      const a2 = ((i + 1) / wallSegments) * Math.PI * 2;

      const x1 = this.SEMI_MAJOR * Math.cos(a1);
      const z1 = this.SEMI_MINOR * Math.sin(a1);
      const x2 = this.SEMI_MAJOR * Math.cos(a2);
      const z2 = this.SEMI_MINOR * Math.sin(a2);

      const u1 = i / wallSegments;
      const u2 = (i + 1) / wallSegments;

      const base = i * 18;
      const uvBase = i * 12;

      // Triangle 1
      positions[base]      = x1; positions[base + 1]  = 0;    positions[base + 2]  = z1;
      positions[base + 3]  = x2; positions[base + 4]  = 0;    positions[base + 5]  = z2;
      positions[base + 6]  = x2; positions[base + 7]  = wallH; positions[base + 8]  = z2;
      // Triangle 2
      positions[base + 9]  = x1; positions[base + 10] = 0;    positions[base + 11] = z1;
      positions[base + 12] = x2; positions[base + 13] = wallH; positions[base + 14] = z2;
      positions[base + 15] = x1; positions[base + 16] = wallH; positions[base + 17] = z1;

      uvs[uvBase]      = u1; uvs[uvBase + 1]  = 0;
      uvs[uvBase + 2]  = u2; uvs[uvBase + 3]  = 0;
      uvs[uvBase + 4]  = u2; uvs[uvBase + 5]  = 1;
      uvs[uvBase + 6]  = u1; uvs[uvBase + 7]  = 0;
      uvs[uvBase + 8]  = u2; uvs[uvBase + 9]  = 1;
      uvs[uvBase + 10] = u1; uvs[uvBase + 11] = 1;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, shaderMat);
    mesh.name = 'plasmaWall';
    this.group.add(mesh);

    // Ambient glow lights around the perimeter
    const glowCount = 8;
    for (let i = 0; i < glowCount; i++) {
      const angle = (i / glowCount) * Math.PI * 2;
      const x = this.SEMI_MAJOR * Math.cos(angle) * 0.92;
      const z = this.SEMI_MINOR * Math.sin(angle) * 0.92;
      const light = new THREE.PointLight(0x8844ff, 0.8, 35);
      light.position.set(x, 4, z);
      this.group.add(light);
    }
  }

  // ---------------------------------------------------------------------------
  // Oval perimeter collision (box segments around the ellipse)
  // ---------------------------------------------------------------------------
  private createOvalCollision(): void {
    const N = 48;
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2;
      const x = this.SEMI_MAJOR * Math.cos(angle);
      const z = this.SEMI_MINOR * Math.sin(angle);

      // Tangent direction at this point on the ellipse
      const tx = -this.SEMI_MAJOR * Math.sin(angle);
      const tz = this.SEMI_MINOR * Math.cos(angle);
      const yAngle = Math.atan2(tz, tx);

      // Wall width covers the arc length of this segment + overlap
      const tangentLen = Math.sqrt(tx * tx + tz * tz);
      const segLength = tangentLen * (2 * Math.PI / N);
      const halfW = segLength / 2 + 0.5;

      const collider: BoxCollider = {
        type: 'box',
        cx: x,
        cz: z,
        halfW,
        halfD: 0.5,
        cosY: Math.cos(yAngle),
        sinY: Math.sin(yAngle),
        centerY: this.WALL_HEIGHT / 2,
        halfH: this.WALL_HEIGHT / 2,
        rotZ: 0,
      };
      this.collision.addCollider(collider);
    }
  }

  // ---------------------------------------------------------------------------
  // Starting zone plasma bubbles
  // ---------------------------------------------------------------------------
  private createStartingBubbles(): void {
    const bubblePositions = [
      { x: 0, z: this.BUBBLE_SPAWN_Z },   // South (Team 1)
      { x: 0, z: -this.BUBBLE_SPAWN_Z },  // North (Team 2)
    ];

    const sphereGeo = new THREE.SphereGeometry(this.BUBBLE_RADIUS, 32, 24);

    for (const pos of bubblePositions) {
      const bubbleMat = this.createPlasmaShaderMaterial(1.0);
      this.bubbleMaterials.push(bubbleMat);

      const mesh = new THREE.Mesh(sphereGeo, bubbleMat);
      mesh.position.set(pos.x, this.BUBBLE_RADIUS * 0.8, pos.z);
      mesh.name = 'plasmaBubble';
      this.group.add(mesh);
      this.bubbleMeshes.push(mesh);
    }

    // Starting zone floor markings
    const southFloorGeo = new THREE.RingGeometry(0.5, this.BUBBLE_RADIUS - 0.5, 32);
    const southFloorMat = new THREE.MeshStandardMaterial({
      color: 0x331111,
      roughness: 0.9,
      emissive: 0x330000,
      emissiveIntensity: 0.15,
    });
    const southFloor = new THREE.Mesh(southFloorGeo, southFloorMat);
    southFloor.rotation.x = -Math.PI / 2;
    southFloor.position.set(0, 0.02, this.BUBBLE_SPAWN_Z);
    southFloor.receiveShadow = true;
    this.group.add(southFloor);

    const northFloorGeo = new THREE.RingGeometry(0.5, this.BUBBLE_RADIUS - 0.5, 32);
    const northFloorMat = new THREE.MeshStandardMaterial({
      color: 0x111133,
      roughness: 0.9,
      emissive: 0x000033,
      emissiveIntensity: 0.15,
    });
    const northFloor = new THREE.Mesh(northFloorGeo, northFloorMat);
    northFloor.rotation.x = -Math.PI / 2;
    northFloor.position.set(0, 0.02, -this.BUBBLE_SPAWN_Z);
    northFloor.receiveShadow = true;
    this.group.add(northFloor);
  }

  // ---------------------------------------------------------------------------
  // Bubble collision (box segments forming a circle around each bubble)
  // ---------------------------------------------------------------------------
  private createBubbleCollision(): void {
    const bubblePositions = [
      { x: 0, z: this.BUBBLE_SPAWN_Z },
      { x: 0, z: -this.BUBBLE_SPAWN_Z },
    ];

    const N = 12; // segments per bubble
    const R = this.BUBBLE_RADIUS;

    for (const center of bubblePositions) {
      for (let i = 0; i < N; i++) {
        const angle = (i / N) * Math.PI * 2;
        const x = center.x + R * Math.cos(angle);
        const z = center.z + R * Math.sin(angle);
        // Rotate +π/2 so halfW extends along the tangent, not the radius
        const yAngle = angle + Math.PI / 2;

        const halfW = R * Math.sin(Math.PI / N) + 0.3;

        const collider: BoxCollider = {
          type: 'box',
          cx: x,
          cz: z,
          halfW,
          halfD: 0.5,
          cosY: Math.cos(yAngle),
          sinY: Math.sin(yAngle),
          centerY: 3,
          halfH: 3,
          rotZ: 0,
        };
        this.collision.addCollider(collider);
        this.bubbleColliders.push(collider);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Arena lighting
  // ---------------------------------------------------------------------------
  private createArenaLighting(): void {
    // Central overhead flood light
    const centerLight = new THREE.PointLight(0xccccee, 2.0, 100);
    centerLight.position.set(0, 25, 0);
    this.group.add(centerLight);

    // Additional overhead lights spread across the arena
    const overheadPositions: [number, number, number][] = [
      [-20, 20, -12],
      [20, 20, -12],
      [-20, 20, 12],
      [20, 20, 12],
    ];
    for (const [x, y, z] of overheadPositions) {
      const light = new THREE.PointLight(0xbbbbdd, 1.2, 60);
      light.position.set(x, y, z);
      this.group.add(light);
    }

    // Colored accent lights at starting zones
    const redLight = new THREE.PointLight(0xff2200, 0.8, 25);
    redLight.position.set(0, 5, this.BUBBLE_SPAWN_Z);
    this.group.add(redLight);

    const blueLight = new THREE.PointLight(0x0044ff, 0.8, 25);
    blueLight.position.set(0, 5, -this.BUBBLE_SPAWN_Z);
    this.group.add(blueLight);
  }

  // ---------------------------------------------------------------------------
  // Diamond archways
  // ---------------------------------------------------------------------------
  private createDiamondArchways(): void {
    const diamondMat = this.createDiamondShaderMaterial();

    // Arch 1: Grand Celestial Sweep — wide, sweeping, western side
    // Curve starts/ends underground so the tube emerges naturally from the ground.
    // Lower sections are flattened for a gradual ramp-like incline.
    // Peak is spread out for a flat plateau easy to walk across.
    const arch1Curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-36, -4.5, 26),
      new THREE.Vector3(-33, -1.5, 22),
      new THREE.Vector3(-27, 1.5, 16),
      new THREE.Vector3(-20, 5, 10),
      new THREE.Vector3(-15, 8, 5),
      new THREE.Vector3(-10, 10, 2),
      new THREE.Vector3(-7, 11, 0),
      new THREE.Vector3(-10, 10, -2),
      new THREE.Vector3(-15, 8, -5),
      new THREE.Vector3(-20, 5, -8),
      new THREE.Vector3(-27, 1.5, -13),
      new THREE.Vector3(-33, -1.5, -18),
      new THREE.Vector3(-36, -4.5, -22),
    ]);
    this.buildArchway(arch1Curve, 4.5, 10, 1.5, diamondMat);

    // Arch 2: Crystal Spire — taller, eastern side
    // Flattened lower sections and spread peak for easy traversal.
    const arch2Curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(36, -4.0, -24),
      new THREE.Vector3(33, -1.0, -20),
      new THREE.Vector3(27, 2, -15),
      new THREE.Vector3(20, 5.5, -9),
      new THREE.Vector3(14, 9, -5),
      new THREE.Vector3(10, 11.5, -3),
      new THREE.Vector3(8, 12.5, -1),
      new THREE.Vector3(10, 11.5, 1),
      new THREE.Vector3(14, 8.5, 4),
      new THREE.Vector3(20, 5, 8),
      new THREE.Vector3(27, 1.5, 13),
      new THREE.Vector3(33, -1.0, 17),
      new THREE.Vector3(36, -4.0, 21),
    ]);
    this.buildArchway(arch2Curve, 4.0, 8, 1.2, diamondMat);

    // Floating sparkle particles around both arches
    this.createArchSparkles(arch1Curve, arch2Curve);
  }

  private buildArchway(
    curve: THREE.CatmullRomCurve3,
    radius: number,
    radialSegments: number,
    walkableHalfD: number,
    material: THREE.ShaderMaterial,
  ): void {
    // Faceted tube mesh along the arch curve
    const tubeGeo = new THREE.TubeGeometry(curve, 64, radius, radialSegments, false);
    const tubeMesh = new THREE.Mesh(tubeGeo, material);
    tubeMesh.name = 'diamondArch';
    this.group.add(tubeMesh);

    // End caps (faceted circles closing the tube openings)
    for (const t of [0, 1] as const) {
      const p = curve.getPointAt(t);
      const tangent = curve.getTangentAt(t);
      const capGeo = new THREE.CircleGeometry(radius, radialSegments);
      const cap = new THREE.Mesh(capGeo, material);
      cap.position.copy(p);
      cap.lookAt(p.clone().add(tangent));
      this.group.add(cap);
    }

    // Accent lights along the arch
    for (let i = 0; i <= 6; i++) {
      const p = curve.getPointAt(i / 6);
      if (p.y > 2) {
        const light = new THREE.PointLight(0xaaccff, 0.5, 18);
        light.position.set(p.x, p.y + radius + 1.5, p.z);
        this.group.add(light);
      }
    }

    // Walkable surface colliders along the arch top.
    // Uses 3 parallel strips (center + 2 sides) per segment to approximate
    // the tube's circular cross-section. Thin halfH keeps them as smooth ramps
    // instead of thick walls that block from the side.
    const segCount = 48;
    const points = curve.getPoints(segCount);
    const WALK_HALF_H = 0.5;

    // Cross-section strip layout
    const centerHalfD = radius * 0.35;
    const sideOffset = radius * 0.55;
    const sideHalfD = radius * 0.3;
    const sideDrop = radius - Math.sqrt(radius * radius - sideOffset * sideOffset);

    for (let i = 0; i < segCount; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const midX = (p1.x + p2.x) / 2;
      const midZ = (p1.z + p2.z) / 2;
      const sY1 = p1.y + radius;
      const sY2 = p2.y + radius;
      const midSY = (sY1 + sY2) / 2;

      const dx = p2.x - p1.x;
      const dz = p2.z - p1.z;
      const dy = sY2 - sY1;
      const hDist = Math.sqrt(dx * dx + dz * dz) || 0.001;
      const sDist = Math.sqrt(hDist * hDist + dy * dy);
      const yAngle = Math.atan2(dz, dx);
      const rotZ = Math.atan2(dy, hDist);
      const cosY = Math.cos(yAngle);
      const sinY = Math.sin(yAngle);
      const cosRZ = Math.cos(rotZ);
      const halfW = sDist / 2 + 0.15;

      // Perpendicular direction in XZ plane (across the tube width)
      const perpX = -dz / hDist;
      const perpZ = dx / hDist;

      // Center strip — at full tube-top height
      this.collision.addCollider({
        type: 'box',
        cx: midX,
        cz: midZ,
        halfW,
        halfD: centerHalfD,
        cosY, sinY,
        centerY: midSY - WALK_HALF_H * cosRZ,
        halfH: WALK_HALF_H,
        rotZ,
      });

      // Side strips — lowered to follow tube curvature
      const sideMidSY = midSY - sideDrop;
      for (const sign of [-1, 1]) {
        this.collision.addCollider({
          type: 'box',
          cx: midX + perpX * sideOffset * sign,
          cz: midZ + perpZ * sideOffset * sign,
          halfW,
          halfD: sideHalfD,
          cosY, sinY,
          centerY: sideMidSY - WALK_HALF_H * cosRZ,
          halfH: WALK_HALF_H,
          rotZ,
        });
      }
    }

    // Flattened mound bases — squished wider so you can walk up from any angle
    for (const p of points) {
      if (p.y >= 0) {
        this.addArchBaseMound(p, radius, material);
        break;
      }
    }
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].y >= 0) {
        this.addArchBaseMound(points[i], radius, material);
        break;
      }
    }

    // Register archway base positions as elevation access points for NPC pathfinding
    const startPt = points[0];
    const endPt = points[points.length - 1];
    this.collision.addElevationAccessPoint({ x: startPt.x, z: startPt.z });
    this.collision.addElevationAccessPoint({ x: endPt.x, z: endPt.z });

    // Register walkable-surface waypoint chain for NPC path-following navigation.
    // Includes approach waypoints at each end that sit BEYOND the arch extent so
    // NPCs approaching from the arena interior are guided around the tube base
    // (where the low-altitude tube colliders would block them from underneath).
    const navWaypoints: { x: number; y: number; z: number }[] = points
      .map(p => ({ x: p.x, y: p.y + radius, z: p.z }))
      .filter(wp => wp.y >= 0);

    if (navWaypoints.length >= 2) {
      const first = navWaypoints[0];
      const last = navWaypoints[navWaypoints.length - 1];

      // Approach direction at each end: away from the other end (extends past
      // where the tube goes underground, so there is nothing overhead to block)
      const dxSE = first.x - last.x;
      const dzSE = first.z - last.z;
      const lenSE = Math.sqrt(dxSE * dxSE + dzSE * dzSE) || 1;
      const APPROACH_DIST = 8;
      const dirX = dxSE / lenSE;
      const dirZ = dzSE / lenSE;

      // Insert intermediate ramp waypoints between approach (ground) and first
      // tube surface waypoint. The mound ramp rises from ground to ~tubeRadius
      // height over a spread of tubeRadius*1.5. Without these, NPCs loop at the
      // base unable to bridge the Y gap from approach (y=0) to tube surface.
      const RAMP_STEPS = 3;
      const moundSpread = radius * 1.5; // half the mound XZ extent
      const moundPeak = radius;         // mound peak height = tubeRadius

      // Start end: approach → ramp waypoints → first tube waypoint
      const startApproach = {
        x: first.x + dirX * APPROACH_DIST,
        y: 0,
        z: first.z + dirZ * APPROACH_DIST,
      };
      navWaypoints.unshift(startApproach);
      // Insert ramp waypoints between approach and first tube wp (now at index 1)
      for (let i = RAMP_STEPS; i >= 1; i--) {
        const t = i / (RAMP_STEPS + 1); // 0.75, 0.5, 0.25 (outer to inner)
        const frac = 1 - t; // fraction along ramp from approach to first tube wp
        navWaypoints.splice(1, 0, {
          x: startApproach.x + (first.x - startApproach.x) * frac,
          y: moundPeak * frac * frac, // quadratic ease — gentle start, steeper near top
          z: startApproach.z + (first.z - startApproach.z) * frac,
        });
      }

      // End: last tube waypoint → ramp waypoints → approach
      const endApproach = {
        x: last.x - dirX * APPROACH_DIST,
        y: 0,
        z: last.z - dirZ * APPROACH_DIST,
      };
      for (let i = 1; i <= RAMP_STEPS; i++) {
        const frac = i / (RAMP_STEPS + 1); // 0.25, 0.5, 0.75 (inner to outer)
        navWaypoints.push({
          x: last.x + (endApproach.x - last.x) * frac,
          y: moundPeak * (1 - frac) * (1 - frac), // quadratic ease down
          z: last.z + (endApproach.z - last.z) * frac,
        });
      }
      navWaypoints.push(endApproach);
    }

    this.collision.addNavigationPath({ waypoints: navWaypoints });
  }

  /** Smooth mound base at an archway foot — visual + radial ramp colliders */
  private addArchBaseMound(
    basePos: THREE.Vector3,
    tubeRadius: number,
    material: THREE.ShaderMaterial,
  ): void {
    const spread = tubeRadius * 3;           // XZ radius of the mound
    const moundHeight = tubeRadius;          // peak matches the tube top

    // Visual: low, wide cone — a subtle ramp collar around the tube base
    const visualRadius = tubeRadius * 3;
    const visualHeight = tubeRadius;
    const coneGeo = new THREE.ConeGeometry(visualRadius, visualHeight, 24, 1, true);
    const coneMesh = new THREE.Mesh(coneGeo, material);
    coneMesh.position.set(basePos.x, visualHeight / 2, basePos.z);
    coneMesh.name = 'archBaseMound';
    this.group.add(coneMesh);

    // Collision: radial ramp colliders (linear slope from ground at edge to peak).
    // 24 segments for full angular coverage, thin halfH for smooth surface.
    const numRamps = 24;
    const rampHalfW = spread / 2;
    const rampHalfD = (Math.PI * spread) / numRamps;
    const rotZ = Math.asin(moundHeight / (2 * rampHalfW));
    const sinRot = Math.sin(rotZ);
    const cosRot = Math.cos(rotZ);
    const halfH = 0.5;
    // From: 0 = centerY - rampHalfW * sinRot + halfH * cosRot  (outer edge at ground)
    const centerY = rampHalfW * sinRot - halfH * cosRot;

    for (let i = 0; i < numRamps; i++) {
      const theta = (i / numRamps) * Math.PI * 2;
      const inwardAngle = theta + Math.PI;
      const cx = basePos.x + Math.cos(theta) * rampHalfW;
      const cz = basePos.z + Math.sin(theta) * rampHalfW;

      this.collision.addCollider({
        type: 'box',
        cx,
        cz,
        halfW: rampHalfW,
        halfD: rampHalfD,
        cosY: Math.cos(inwardAngle),
        sinY: Math.sin(inwardAngle),
        centerY,
        halfH,
        rotZ,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Glass platform between the archways
  // ---------------------------------------------------------------------------
  private createGlassPlatform(): void {
    const w = 8, d = 8, h = 0.4;
    const px = 1, pz = -1;

    // Group holds mesh + edges + light so they move together
    const platformGroup = new THREE.Group();
    platformGroup.position.set(px, 0.2, pz); // starts at ground floor
    this.glassPlatformGroup = platformGroup;

    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xaaddff,
      transparent: true,
      opacity: 0.25,
      roughness: 0.05,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'glassPlatform';
    platformGroup.add(mesh);

    // Glowing edges
    const edges = new THREE.EdgesGeometry(geo);
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x88ccff, transparent: true, opacity: 0.6,
    });
    platformGroup.add(new THREE.LineSegments(edges, edgeMat));

    // Under-glow
    const light = new THREE.PointLight(0x88ccff, 0.8, 25);
    light.position.set(0, -1.5, 0);
    platformGroup.add(light);

    this.group.add(platformGroup);

    // Collider (reference stored so elevator can update centerY each frame)
    const collider: BoxCollider = {
      type: 'box',
      cx: px,
      cz: pz,
      halfW: w / 2,
      halfD: d / 2,
      cosY: 1,
      sinY: 0,
      centerY: 0.2,
      halfH: h / 2,
      rotZ: 0,
    };
    this.collision.addCollider(collider);
    this.glassPlatformCollider = collider;

    // Register as a moving platform so NPC AI can detect targets on the elevator
    this.collision.addMovingPlatform({
      cx: px,
      cz: pz,
      halfW: w / 2,
      halfD: d / 2,
      getY: () => this.glassPlatformCollider
        ? this.glassPlatformCollider.centerY + this.glassPlatformCollider.halfH
        : 0.2,
    });
  }

  /**
   * Elevator cycle: ground → mid → sky → mid → ground, idling at each stop
   * with a gentle hover bob, then smoothly traveling to the next floor.
   */
  private updatePlatform(): void {
    if (!this.glassPlatformGroup || !this.glassPlatformCollider) return;

    const FLOORS = [0.2, 13.5, 40];   // ground, mid (between arches), sky
    const STOPS  = [0, 1, 2, 1];      // ping-pong sequence through floors
    const IDLE   = 8;                  // seconds idling at each stop
    const TRAVEL = 3;                  // seconds traveling between stops
    const PHASE  = IDLE + TRAVEL;
    const CYCLE  = STOPS.length * PHASE;

    const t = this.elapsed % CYCLE;
    const stopIdx = Math.floor(t / PHASE);
    const phaseT  = t - stopIdx * PHASE;

    const fromY = FLOORS[STOPS[stopIdx]];
    const toY   = FLOORS[STOPS[(stopIdx + 1) % STOPS.length]];

    let y: number;
    if (phaseT < IDLE) {
      // Idling — gentle hover bob that fades in/out for smooth transitions
      // Skip the bob at ground level so the platform sits still
      const isGroundFloor = STOPS[stopIdx] === 0;
      const fadeIn  = Math.min(1, phaseT / 1.0);
      const fadeOut = Math.min(1, (IDLE - phaseT) / 1.0);
      y = fromY + (isGroundFloor ? 0 : Math.sin(this.elapsed * 1.5) * 0.4 * fadeIn * fadeOut);
    } else {
      // Traveling — ease-in-out cubic
      const p = (phaseT - IDLE) / TRAVEL;
      const eased = p < 0.5
        ? 4 * p * p * p
        : 1 - Math.pow(-2 * p + 2, 3) / 2;
      y = fromY + (toY - fromY) * eased;
    }

    // Detect if the platform jumped significantly (tab was backgrounded)
    this.platformJumped = Math.abs(y - this.lastPlatformY) > 2;
    this.lastPlatformY = y;

    this.glassPlatformGroup.position.y = y;
    this.glassPlatformCollider.centerY = y;
  }

  getMovingPlatformSnapY(px: number, pz: number): number | undefined {
    if (!this.platformJumped || !this.glassPlatformCollider) return undefined;
    const dx = px - 1;   // ELEVATOR_CX
    const dz = pz - (-1); // ELEVATOR_CZ
    if (Math.abs(dx) <= 4 && Math.abs(dz) <= 4) { // halfW, halfD
      return this.glassPlatformCollider.centerY + 0.2; // + halfH
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Sparkle particles floating near the diamond archways
  // ---------------------------------------------------------------------------
  private createArchSparkles(
    curve1: THREE.CatmullRomCurve3,
    curve2: THREE.CatmullRomCurve3,
  ): void {
    const count = 300;
    const positions = new Float32Array(count * 3);
    const phases = new Float32Array(count);

    let seed = 31337;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let i = 0; i < count; i++) {
      const curve = i < count / 2 ? curve1 : curve2;
      const p = curve.getPointAt(rng());
      positions[i * 3]     = p.x + (rng() - 0.5) * 8;
      positions[i * 3 + 1] = Math.max(0.5, p.y + (rng() - 0.5) * 5 + 2);
      positions[i * 3 + 2] = p.z + (rng() - 0.5) * 8;
      phases[i] = rng() * Math.PI * 2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        uniform float uTime;
        attribute float aPhase;
        varying float vAlpha;
        void main() {
          vAlpha = pow(sin(aPhase + uTime * 2.5) * 0.5 + 0.5, 4.0);
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPos;
          gl_PointSize = mix(1.0, 4.5, vAlpha) * (180.0 / -mvPos.z);
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d > 1.0) discard;
          gl_FragColor = vec4(0.85, 0.92, 1.0, (1.0 - d * d) * vAlpha * 0.9);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.archShaderMaterials.push(mat);

    const pts = new THREE.Points(geo, mat);
    pts.name = 'archSparkles';
    this.group.add(pts);
  }

  // ---------------------------------------------------------------------------
  // Diamond shader — mostly transparent with prismatic sparkle and fresnel edges
  // ---------------------------------------------------------------------------
  private createDiamondShaderMaterial(): THREE.ShaderMaterial {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        varying vec3 vWorldPosition;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          vViewPosition = -mvPos.xyz;
          vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        uniform float uTime;
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        varying vec3 vWorldPosition;

        float hash3(vec3 p) {
          return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
        }
        float noise3(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(hash3(i), hash3(i+vec3(1,0,0)), f.x),
                mix(hash3(i+vec3(0,1,0)), hash3(i+vec3(1,1,0)), f.x), f.y),
            mix(mix(hash3(i+vec3(0,0,1)), hash3(i+vec3(1,0,1)), f.x),
                mix(hash3(i+vec3(0,1,1)), hash3(i+vec3(1,1,1)), f.x), f.y),
            f.z);
        }

        void main() {
          vec3 V = normalize(vViewPosition);
          float fresnel = pow(1.0 - abs(dot(vNormal, V)), 3.0);

          // Prismatic rainbow dispersion based on view angle
          float ang = dot(vNormal, V) * 6.0 + uTime * 0.3;
          vec3 rainbow = vec3(
            sin(ang) * 0.5 + 0.5,
            sin(ang + 2.094) * 0.5 + 0.5,
            sin(ang + 4.189) * 0.5 + 0.5
          );

          // Animated sparkle highlights across the surface
          float sp = smoothstep(0.92, 0.96, noise3(vWorldPosition * 8.0 + uTime * 1.5))
                   + smoothstep(0.94, 0.97, noise3(vWorldPosition * 15.0 - uTime * 2.0)) * 0.7;

          // Clear diamond body with cool tint, prismatic edges
          vec3 color = mix(vec3(0.88, 0.93, 1.0), mix(vec3(1.0), rainbow, 0.6), fresnel * 0.8);
          color += sp * vec3(1.0, 0.98, 0.95) * 2.5 + rainbow * fresnel * 0.3;

          gl_FragColor = vec4(color, 0.12 + fresnel * 0.5 + sp * 0.6);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.archShaderMaterials.push(mat);
    return mat;
  }

  // ---------------------------------------------------------------------------
  // Plasma shader material (shared between walls and bubbles)
  // ---------------------------------------------------------------------------
  private createPlasmaShaderMaterial(opacity: number): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: opacity },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uOpacity;
        varying vec2 vUv;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
            mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
            f.y
          );
        }

        void main() {
          vec2 uv = vUv;

          float n1 = noise(uv * 5.0 + vec2(uTime * 0.3, uTime * 0.5));
          float n2 = noise(uv * 8.0 + vec2(-uTime * 0.4, uTime * 0.25));
          float n3 = noise(uv * 3.0 + vec2(uTime * 0.15, -uTime * 0.35));
          float n = n1 * 0.4 + n2 * 0.35 + n3 * 0.25;

          float hueShift = uTime * 0.2;
          float r = sin(hueShift + n * 4.0) * 0.5 + 0.5;
          float g = sin(hueShift + n * 4.0 + 2.094) * 0.5 + 0.5;
          float b = sin(hueShift + n * 4.0 + 4.189) * 0.5 + 0.5;

          vec3 color = vec3(r, g, b) * 1.3;

          float alpha = (0.4 + 0.4 * n) * uOpacity;

          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }
}
