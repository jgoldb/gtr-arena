import * as THREE from 'three';
import { Renderer } from './renderer/Renderer';
import { InputManager } from './input/InputManager';
import { MapManager } from './map/MapManager';
import { PlayerController } from './player/PlayerController';
import { CharacterId } from './player/characters';
import { ThirdPersonCamera } from './camera/ThirdPersonCamera';
import { NpcController } from './npc/NpcController';
import { TargetingSystem } from './targeting/TargetingSystem';

export class Engine {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly clock: THREE.Clock;
  readonly renderer: Renderer;
  readonly input: InputManager;
  readonly mapManager: MapManager;
  readonly playerController: PlayerController;
  readonly thirdPersonCamera: ThirdPersonCamera;
  readonly targetingSystem: TargetingSystem;
  private readonly npcs: NpcController[] = [];

  private animationFrameId: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.scene = new THREE.Scene();
    this.clock = new THREE.Clock();

    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      200
    );

    this.renderer = new Renderer(canvas);
    this.input = new InputManager(canvas);
    this.mapManager = new MapManager(this.scene);

    // Load default map
    this.mapManager.loadMap('bladestorm');

    // Camera needs player target, player needs camera azimuth.
    // Create camera first with a temporary getter, then wire up.
    this.thirdPersonCamera = new ThirdPersonCamera(
      this.camera,
      this.input,
      () => this.playerController.getPosition(),
      this.scene
    );

    this.playerController = new PlayerController(
      this.scene,
      this.input,
      this.mapManager,
      () => this.thirdPersonCamera.getAzimuth()
    );

    this.targetingSystem = new TargetingSystem(this.camera, this.scene, canvas);
  }

  start(): void {
    this.clock.start();
    this.loop();
  }

  stop(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.resize(width, height);
  }

  loadMap(id: string): void {
    this.clearNpcs();
    this.mapManager.loadMap(id);
    this.playerController.respawn();
  }

  setCharacter(id: CharacterId): void {
    this.playerController.setCharacter(id);
  }

  spawnNpc(characterId: CharacterId, position: THREE.Vector3): NpcController {
    const npc = new NpcController(characterId, position);
    this.npcs.push(npc);
    this.scene.add(npc.mesh);
    return npc;
  }

  removeNpc(npc: NpcController): void {
    const idx = this.npcs.indexOf(npc);
    if (idx !== -1) {
      if (this.targetingSystem.currentTarget === npc) {
        this.targetingSystem.currentTarget = null;
      }
      this.npcs.splice(idx, 1);
      this.scene.remove(npc.mesh);
      npc.dispose();
    }
  }

  clearNpcs(): void {
    for (const npc of this.npcs) {
      if (this.targetingSystem.currentTarget === npc) {
        this.targetingSystem.currentTarget = null;
      }
      this.scene.remove(npc.mesh);
      npc.dispose();
    }
    this.npcs.length = 0;
  }

  getNpcs(): readonly NpcController[] {
    return this.npcs;
  }

  private loop = (): void => {
    this.animationFrameId = requestAnimationFrame(this.loop);

    const deltaTime = Math.min(this.clock.getDelta(), 0.1); // Cap at 100ms to prevent huge jumps

    // Process targeting clicks before movement updates
    const click = this.input.getLeftClick();
    if (click) {
      this.targetingSystem.processClick(click.x, click.y);
    }

    this.playerController.update(deltaTime);
    for (const npc of this.npcs) npc.update(deltaTime);
    this.targetingSystem.update(deltaTime);
    this.thirdPersonCamera.update(deltaTime);
    this.renderer.render(this.scene, this.camera);
    this.input.resetDeltas();
  };

  dispose(): void {
    this.stop();
    this.clearNpcs();
    this.playerController.dispose();
    this.renderer.dispose();
    this.input.dispose();
  }
}
