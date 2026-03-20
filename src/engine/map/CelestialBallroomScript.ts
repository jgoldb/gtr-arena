import * as THREE from 'three';
import { ArenaScript } from './ArenaScript';
import type { Collider, BoxCollider } from '../physics/CollisionSystem';

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
    this.createSkybox(scene);
    this.createAsteroidGround();
    this.createPlasmaWall();
    this.createOvalCollision();
    this.createStartingBubbles();
    this.createBubbleCollision();
    this.createArenaLighting();
  }

  protected updateArena(): void {
    // Update plasma shader time uniforms
    if (this.plasmaWallMaterial) {
      this.plasmaWallMaterial.uniforms.uTime.value = this.elapsed;
    }
    for (const mat of this.bubbleMaterials) {
      mat.uniforms.uTime.value = this.elapsed;
    }
  }

  protected disposeArena(): void {
    this.plasmaWallMaterial = null;
    this.bubbleMaterials = [];
    this.bubbleMeshes = [];
    this.bubbleColliders = [];
  }

  protected onOpen(): void {
    for (const collider of this.bubbleColliders) {
      this.collision.removeCollider(collider);
    }
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
