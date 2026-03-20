import * as THREE from 'three';
import { Renderer } from './renderer/Renderer';
import { InputManager } from './input/InputManager';
import { MapManager } from './map/MapManager';
import { PlayerController } from './player/PlayerController';
import { CharacterId } from './player/characters';
import { ThirdPersonCamera } from './camera/ThirdPersonCamera';
import { NpcController } from './npc/NpcController';
import { TargetingSystem } from './targeting/TargetingSystem';
import { CombatSystem } from './combat/CombatSystem';
import { RegenSystem } from './combat/RegenSystem';
import type { Targetable } from './types';

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
  readonly regenSystem: RegenSystem;
  readonly combatSystem: CombatSystem;
  private readonly npcs: NpcController[] = [];
  private autoAttacking = false;
  private autoAttackTimer = 0;
  private autoAttackTarget: Targetable | null = null;

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
    this.regenSystem = new RegenSystem(() => [this.playerController, ...this.npcs]);
    this.combatSystem = new CombatSystem(this.regenSystem);
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
      if (this.autoAttackTarget === npc) {
        this.stopAutoAttack();
      }
      this.npcs.splice(idx, 1);
      this.scene.remove(npc.mesh);
      npc.dispose();
    }
  }

  clearNpcs(): void {
    this.stopAutoAttack();
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

  startAutoAttack(target: Targetable): void {
    if (target === this.autoAttackTarget && this.autoAttacking) return;
    this.autoAttacking = true;
    this.autoAttackTarget = target;
    this.autoAttackTimer = this.playerController.autoAttackSpeed; // immediate first swing
    this.playerController.setAutoAttacking(true);
  }

  stopAutoAttack(): void {
    this.autoAttacking = false;
    this.autoAttackTimer = 0;
    this.autoAttackTarget = null;
    this.playerController.setAutoAttacking(false);
  }

  resetAutoAttackTimer(): void {
    this.autoAttackTimer = 0;
  }

  private updateAutoAttack(dt: number): void {
    if (!this.autoAttacking) return;

    // Keep model in sync (handles character swap mid-combat)
    this.playerController.setAutoAttacking(true);

    const player = this.playerController;
    const target = this.targetingSystem.currentTarget;

    // Stop conditions
    if (player.dead || !target || target.dead || !target.hostile || target !== this.autoAttackTarget) {
      this.stopAutoAttack();
      return;
    }

    this.autoAttackTimer += dt;

    if (this.autoAttackTimer >= player.autoAttackSpeed) {
      // Check range
      const dx = player.mesh.position.x - target.mesh.position.x;
      const dz = player.mesh.position.z - target.mesh.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > player.autoAttackRange) {
        this.autoAttackTimer = player.autoAttackSpeed;
        return;
      }

      // Check facing (120° cone)
      const toTarget = new THREE.Vector3(
        target.mesh.position.x - player.mesh.position.x,
        0,
        target.mesh.position.z - player.mesh.position.z
      ).normalize();
      const rotY = player.mesh.rotation.y;
      const forward = new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY));
      if (forward.dot(toTarget) <= 0.5) {
        this.autoAttackTimer = player.autoAttackSpeed;
        return;
      }

      // Swing!
      this.autoAttackTimer = 0;
      player.triggerSwing();
      this.combatSystem.applyAutoAttackDamage(player, target, player.autoAttackDamage);
    }
  }

  private loop = (): void => {
    this.animationFrameId = requestAnimationFrame(this.loop);

    const deltaTime = Math.min(this.clock.getDelta(), 0.1); // Cap at 100ms to prevent huge jumps

    // Process targeting clicks before movement updates
    const click = this.input.getLeftClick();
    if (click) {
      this.targetingSystem.processClick(click.x, click.y);
    }

    // Process right-click for auto-attack
    const rightClick = this.input.getRightClick();
    if (rightClick) {
      const target = this.targetingSystem.processRightClick(rightClick.x, rightClick.y);
      if (target && target.hostile && !target.dead) {
        this.startAutoAttack(target);
      }
    }

    this.updateAutoAttack(deltaTime);
    this.playerController.update(deltaTime);
    for (const npc of this.npcs) npc.update(deltaTime);
    // Despawn dead NPCs after their timer expires
    for (let i = this.npcs.length - 1; i >= 0; i--) {
      if (this.npcs[i].shouldDespawn) {
        this.removeNpc(this.npcs[i]);
      }
    }
    this.combatSystem.update(deltaTime);
    this.regenSystem.update(deltaTime);
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
