import GUI from 'lil-gui';
import { Engine } from '../engine/Engine';

export class DebugPanel {
  private gui: GUI;

  constructor(engine: Engine, container: HTMLElement) {
    this.gui = new GUI({ container, title: 'Debug' });
    this.gui.close();

    this.setupCameraControls(engine);
    this.setupPlayerControls(engine);
    this.setupRenderingControls(engine);
  }

  private setupCameraControls(engine: Engine): void {
    const cam = engine.thirdPersonCamera;
    const folder = this.gui.addFolder('Camera');

    folder.add(cam, 'distance', cam.minDistance, cam.maxDistance).name('Distance');
    folder.add(cam, 'elevation', cam.minElevation, cam.maxElevation).name('Elevation');
    folder.add(cam, 'mouseSensitivity', 0.001, 0.01).name('Mouse Sensitivity');
    folder.add(cam, 'scrollSensitivity', 0.001, 0.02).name('Scroll Sensitivity');
    folder.add(cam, 'followSmoothing', 0.01, 0.3).name('Follow Smoothing');
    folder.add(cam.targetOffset, 'y', 0, 4).name('Vertical Offset');
  }

  private setupPlayerControls(engine: Engine): void {
    const player = engine.playerController;
    const folder = this.gui.addFolder('Player');

    folder.add(player, 'speed', 1, 25).name('Move Speed');

    const body = player.mesh.children[0] as THREE.Mesh;
    if (body?.material && 'color' in body.material) {
      folder.addColor({ color: '#4488cc' }, 'color').name('Color').onChange((val: string) => {
        (body.material as THREE.MeshStandardMaterial).color.set(val);
      });
    }
  }

  private setupRenderingControls(engine: Engine): void {
    const folder = this.gui.addFolder('Rendering');
    const renderer = engine.renderer.renderer;

    folder.add(renderer.shadowMap, 'enabled').name('Shadows');
    folder.add(renderer, 'toneMappingExposure', 0.1, 3).name('Exposure');

    const fogProxy = {
      get enabled() {
        return engine.scene.fog !== null;
      },
      set enabled(val: boolean) {
        if (val) {
          const config = engine.mapManager.getCurrentConfig();
          if (config) {
            engine.scene.fog = new THREE.Fog(config.fogColor, config.fogNear, config.fogFar);
          }
        } else {
          engine.scene.fog = null;
        }
      },
    };
    folder.add(fogProxy, 'enabled').name('Fog');
  }

  dispose(): void {
    this.gui.destroy();
  }
}

// Import THREE for the fog creation
import * as THREE from 'three';
