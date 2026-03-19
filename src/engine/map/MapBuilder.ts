import * as THREE from 'three';
import { MapConfig, ObstacleConfig } from './MapConfig';

export interface BuiltMap {
  group: THREE.Group;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export class MapBuilder {
  static build(config: MapConfig, scene: THREE.Scene): BuiltMap {
    const group = new THREE.Group();
    group.name = 'map';

    this.buildGround(config, group);
    this.buildLighting(config, scene, group);
    this.buildFog(config, scene);
    this.buildSky(config, scene);
    this.buildObstacles(config, group);

    scene.add(group);

    const halfW = config.size.width / 2;
    const halfD = config.size.depth / 2;

    return {
      group,
      bounds: { minX: -halfW, maxX: halfW, minZ: -halfD, maxZ: halfD },
    };
  }

  private static buildGround(config: MapConfig, group: THREE.Group): void {
    const groundSize = Math.max(config.size.width, config.size.depth) * 2;
    const geometry = new THREE.PlaneGeometry(groundSize, groundSize, 32, 32);
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(config.groundColor),
      roughness: 0.9,
      metalness: 0.0,
    });

    const ground = new THREE.Mesh(geometry, material);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = 'ground';
    group.add(ground);

    // Subtle grid overlay for spatial reference
    const gridHelper = new THREE.GridHelper(
      groundSize,
      groundSize / 2,
      0x000000,
      0x000000
    );
    gridHelper.material.opacity = 0.06;
    gridHelper.material.transparent = true;
    gridHelper.position.y = 0.01;
    group.add(gridHelper);
  }

  private static buildLighting(config: MapConfig, scene: THREE.Scene, group: THREE.Group): void {
    const ambient = new THREE.AmbientLight(0xffffff, config.ambientIntensity);
    ambient.name = 'ambientLight';
    group.add(ambient);

    const hemiLight = new THREE.HemisphereLight(
      new THREE.Color(config.skyColor),
      new THREE.Color(config.groundColor),
      0.3
    );
    hemiLight.name = 'hemisphereLight';
    group.add(hemiLight);

    const sun = new THREE.DirectionalLight(0xffffff, config.sunIntensity);
    sun.position.set(config.sunDirection.x, config.sunDirection.y, config.sunDirection.z);
    sun.castShadow = true;
    sun.name = 'sunLight';

    const shadowSize = Math.max(config.size.width, config.size.depth) / 2 + 5;
    sun.shadow.camera.left = -shadowSize;
    sun.shadow.camera.right = shadowSize;
    sun.shadow.camera.top = shadowSize;
    sun.shadow.camera.bottom = -shadowSize;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 50;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.bias = -0.001;

    group.add(sun);
  }

  private static buildFog(config: MapConfig, scene: THREE.Scene): void {
    scene.fog = new THREE.Fog(
      new THREE.Color(config.fogColor),
      config.fogNear,
      config.fogFar
    );
  }

  private static buildSky(config: MapConfig, scene: THREE.Scene): void {
    scene.background = new THREE.Color(config.skyColor);
  }

  private static buildObstacles(config: MapConfig, group: THREE.Group): void {
    for (const obstacle of config.obstacles) {
      if (obstacle.type === 'water') {
        this.buildWater(obstacle, group);
        continue;
      }

      const mesh = this.createObstacleMesh(obstacle);
      mesh.position.set(obstacle.position.x, obstacle.position.y, obstacle.position.z);

      if (obstacle.rotation) {
        mesh.rotation.set(obstacle.rotation.x, obstacle.rotation.y, obstacle.rotation.z);
      }

      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  private static buildWater(obstacle: ObstacleConfig, group: THREE.Group): void {
    const { position: pos, scale, color } = obstacle;
    const surfaceY = pos.y + scale.y / 2;

    // Pool basin (walls + floor visible from inside)
    const basinGeometry = new THREE.BoxGeometry(scale.x, scale.y, scale.z);
    const basinMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).multiplyScalar(0.3),
      roughness: 0.9,
      metalness: 0.0,
      side: THREE.BackSide,
    });
    const basin = new THREE.Mesh(basinGeometry, basinMaterial);
    basin.position.set(pos.x, pos.y, pos.z);
    basin.receiveShadow = true;
    group.add(basin);

    // Water surface (semi-transparent plane)
    const surfaceGeometry = new THREE.PlaneGeometry(scale.x, scale.z);
    const surfaceMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      transparent: true,
      opacity: 0.5,
      roughness: 0.1,
      metalness: 0.3,
      side: THREE.DoubleSide,
    });
    const surface = new THREE.Mesh(surfaceGeometry, surfaceMaterial);
    surface.rotation.x = -Math.PI / 2;
    surface.position.set(pos.x, surfaceY + 0.02, pos.z);
    surface.receiveShadow = true;
    group.add(surface);
  }

  private static createObstacleMesh(obstacle: ObstacleConfig): THREE.Mesh {
    let geometry: THREE.BufferGeometry;

    switch (obstacle.type) {
      case 'box':
      case 'wall':
      case 'ramp':
        geometry = new THREE.BoxGeometry(
          obstacle.scale.x,
          obstacle.scale.y,
          obstacle.scale.z
        );
        break;
      case 'cylinder':
        geometry = new THREE.CylinderGeometry(
          obstacle.scale.x,
          obstacle.scale.x,
          obstacle.scale.y,
          16
        );
        break;
      default:
        geometry = new THREE.BoxGeometry(1, 1, 1);
    }

    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(obstacle.color),
      roughness: 0.8,
      metalness: 0.1,
    });

    return new THREE.Mesh(geometry, material);
  }
}
