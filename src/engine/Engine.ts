import * as THREE from 'three';
import { Renderer } from './renderer/Renderer';
import { InputManager } from './input/InputManager';
import { MapManager } from './map/MapManager';
import { PlayerController } from './player/PlayerController';
import { yardsToUnits, type Ability } from './combat/Ability';
import type { BuffDefinition } from './combat/BuffSystem';
import { CharacterId } from './player/characters';
import { ThirdPersonCamera } from './camera/ThirdPersonCamera';
import { NpcController } from './npc/NpcController';
import { TargetingSystem } from './targeting/TargetingSystem';
import { CombatSystem } from './combat/CombatSystem';
import { RegenSystem } from './combat/RegenSystem';
import { BuffSystem } from './combat/BuffSystem';
import type { Targetable } from './types';

interface ActiveGasCloud {
  group: THREE.Group;
  puffs: THREE.Mesh[];
  center: THREE.Vector3;
  radius: number;
  duration: number;
  elapsed: number;
  debuff: BuffDefinition;
  damagePerTick: number;
  tickInterval: number;
  nextTickAt: number;
  owner: Targetable;
  affectedTargets: Set<Targetable>;
}

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
  readonly buffSystem: BuffSystem;
  readonly combatSystem: CombatSystem;
  private readonly npcs: NpcController[] = [];
  private readonly gasClouds: ActiveGasCloud[] = [];
  private autoAttacking = false;
  private autoAttackTimer = 0;
  private autoAttackTarget: Targetable | null = null;
  private sweepCharge: {
    elapsed: number;
    duration: number;
    direction: THREE.Vector3;
    speed: number;
    hitTargets: Set<Targetable>;
    maxDamage: number;
  } | null = null;

  onCharacterChange?: (abilities: readonly Ability[]) => void;
  onAutoAttackError?: (message: string) => void;
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
    this.mapManager.loadMap('cage');

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

    this.targetingSystem = new TargetingSystem(
      this.camera, this.scene, canvas, () => this.playerController
    );
    this.regenSystem = new RegenSystem(() => [this.playerController, ...this.npcs]);
    this.buffSystem = new BuffSystem();
    this.combatSystem = new CombatSystem(this.regenSystem, this.buffSystem, this.mapManager.collision);
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
    this.clearGasClouds();
    this.clearNpcs();
    this.mapManager.loadMap(id);
    this.playerController.respawn();
  }

  setCharacter(id: CharacterId): void {
    this.stopAutoAttack();
    this.buffSystem.clearEntity(this.playerController);
    this.combatSystem.leaveCombat(this.playerController);
    this.combatSystem.clearCooldowns();
    this.playerController.setCharacter(id);
    this.playerController.dead = false;
    this.onCharacterChange?.(this.playerController.abilities);
  }

  spawnNpc(characterId: CharacterId, position: THREE.Vector3): NpcController {
    const npc = new NpcController(characterId, position);
    npc.autoAttackTarget = this.playerController;
    npc.onAutoAttackHit = (attacker, target, damage) => {
      this.combatSystem.applyAutoAttackDamage(attacker, target, damage);
    };
    npc.checkLineOfSight = (a, b) => this.combatSystem.hasLineOfSight(a, b);
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
      // Remove from any active gas clouds
      for (const cloud of this.gasClouds) {
        cloud.affectedTargets.delete(npc);
      }
      this.buffSystem.clearEntity(npc);
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
      this.buffSystem.clearEntity(npc);
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

  spawnGasCloud(
    position: THREE.Vector3,
    radius: number,
    duration: number,
    debuff: BuffDefinition,
    totalDamage: number,
    tickInterval: number,
    owner: Targetable
  ): void {
    const tickCount = Math.floor(duration / tickInterval);
    const damagePerTick = Math.round(totalDamage / tickCount);

    const group = new THREE.Group();
    group.position.set(position.x, 0.02, position.z);

    // Base disc
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x556b2f,
      transparent: true,
      opacity: 0.2,
      roughness: 1.0,
      depthWrite: false,
    });
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, 0.04, 24),
      baseMat
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
        color: 0x7a8b3a,
        transparent: true,
        opacity: 0.18 + Math.random() * 0.12,
        roughness: 1.0,
        depthWrite: false,
        emissive: 0x2a3b0a,
        emissiveIntensity: 0.3,
      });
      const puff = new THREE.Mesh(
        new THREE.SphereGeometry(size, 8, 6),
        puffMat
      );
      puff.position.set(
        Math.cos(angle) * r,
        0.15 + Math.random() * 0.35,
        Math.sin(angle) * r
      );
      puff.renderOrder = 2;
      // Store animation data
      puff.userData.orbitAngle = angle;
      puff.userData.orbitRadius = r;
      puff.userData.orbitSpeed = 0.3 + Math.random() * 0.4;
      puff.userData.baseY = puff.position.y;
      puff.userData.baseOpacity = (puff.material as THREE.MeshStandardMaterial).opacity;
      puff.userData.baseScale = 0.8 + Math.random() * 0.4;
      puff.scale.setScalar(puff.userData.baseScale);
      group.add(puff);
      puffs.push(puff);
    }

    this.scene.add(group);

    this.gasClouds.push({
      group,
      puffs,
      center: new THREE.Vector3(position.x, 0, position.z),
      radius,
      duration,
      elapsed: 0,
      debuff,
      damagePerTick,
      tickInterval,
      nextTickAt: tickInterval,
      owner,
      affectedTargets: new Set(),
    });
  }

  private updateGasClouds(dt: number): void {
    for (let i = this.gasClouds.length - 1; i >= 0; i--) {
      const cloud = this.gasClouds[i];
      cloud.elapsed += dt;

      // Collect all hostile targets
      const targets: Targetable[] = [];
      if (cloud.owner === this.playerController) {
        for (const npc of this.npcs) targets.push(npc);
      } else {
        targets.push(this.playerController);
      }

      // Determine who is currently in the cloud
      const inCloud = new Set<Targetable>();
      for (const target of targets) {
        if (target.dead) continue;
        const dx = target.mesh.position.x - cloud.center.x;
        const dz = target.mesh.position.z - cloud.center.z;
        if (dx * dx + dz * dz <= cloud.radius * cloud.radius) {
          inCloud.add(target);
          const isNew = !cloud.affectedTargets.has(target);
          this.buffSystem.apply(target, cloud.debuff);
          cloud.affectedTargets.add(target);
          // Applying a hostile debuff enters both parties into combat
          if (isNew) {
            this.combatSystem.enterCombat(cloud.owner);
            this.combatSystem.enterCombat(target);
          }
        }
      }

      // Remove debuff from targets that left
      for (const target of cloud.affectedTargets) {
        if (!inCloud.has(target) || target.dead) {
          this.buffSystem.remove(target, cloud.debuff.id);
          cloud.affectedTargets.delete(target);
        }
      }

      // Damage ticks
      while (cloud.elapsed >= cloud.nextTickAt && cloud.nextTickAt <= cloud.duration) {
        for (const target of cloud.affectedTargets) {
          if (target.dead) continue;
          target.hp = Math.max(0, target.hp - cloud.damagePerTick);
          this.combatSystem.onCombatText?.(target, cloud.damagePerTick, 'damage');
          this.combatSystem.enterCombat(target);
          if (target.hp <= 0 && !target.dead) {
            target.die();
          }
        }
        cloud.nextTickAt += cloud.tickInterval;
      }

      // Animate visuals
      cloud.group.rotation.y += dt * 0.3;
      const fadeStart = cloud.duration - 1.5;
      const fade = cloud.elapsed > fadeStart
        ? Math.max(0, 1 - (cloud.elapsed - fadeStart) / 1.5)
        : Math.min(1, cloud.elapsed / 0.5); // fade in over 0.5s
      for (const puff of cloud.puffs) {
        const a = puff.userData.orbitAngle + cloud.elapsed * puff.userData.orbitSpeed;
        const r = puff.userData.orbitRadius;
        puff.position.x = Math.cos(a) * r;
        puff.position.z = Math.sin(a) * r;
        puff.position.y = puff.userData.baseY + Math.sin(cloud.elapsed * 1.5 + a) * 0.1;
        const pulse = 1 + Math.sin(cloud.elapsed * 1.8 + a * 2) * 0.15;
        puff.scale.setScalar(puff.userData.baseScale * pulse);
        (puff.material as THREE.MeshStandardMaterial).opacity =
          puff.userData.baseOpacity * fade;
      }
      // Fade base disc too
      const baseMesh = cloud.group.children[0] as THREE.Mesh;
      (baseMesh.material as THREE.MeshStandardMaterial).opacity = 0.2 * fade;

      // Expire
      if (cloud.elapsed >= cloud.duration) {
        for (const target of cloud.affectedTargets) {
          this.buffSystem.remove(target, cloud.debuff.id);
        }
        cloud.group.traverse(child => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            (child.material as THREE.Material).dispose();
          }
        });
        this.scene.remove(cloud.group);
        this.gasClouds.splice(i, 1);
      }
    }
  }

  private clearGasClouds(): void {
    for (const cloud of this.gasClouds) {
      for (const target of cloud.affectedTargets) {
        this.buffSystem.remove(target, cloud.debuff.id);
      }
      cloud.group.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
      this.scene.remove(cloud.group);
    }
    this.gasClouds.length = 0;
  }

  startSweepCharge(): void {
    const player = this.playerController;
    const rotY = player.mesh.rotation.y;
    const direction = new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY));

    this.stopAutoAttack();
    player.charging = true;
    this.sweepCharge = {
      elapsed: 0,
      duration: 1.0,
      direction,
      speed: yardsToUnits(20), // 20 yards/sec = 12 world units/sec
      hitTargets: new Set(),
      maxDamage: 80,
    };
  }

  private updateSweepCharge(dt: number): void {
    if (!this.sweepCharge) return;

    const charge = this.sweepCharge;
    charge.elapsed += dt;

    // Move player forward
    this.playerController.mesh.position.addScaledVector(charge.direction, charge.speed * dt);

    // Hit detection: check all hostile NPCs
    const hitRadius = 1.0; // world units (~1.67 yards)
    for (const npc of this.npcs) {
      if (npc.dead || charge.hitTargets.has(npc)) continue;
      const dx = this.playerController.mesh.position.x - npc.mesh.position.x;
      const dz = this.playerController.mesh.position.z - npc.mesh.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist <= hitRadius) {
        charge.hitTargets.add(npc);
        // Damage scales linearly: 0% at t=0, 100% at t=duration
        const damagePercent = Math.min(1, charge.elapsed / charge.duration);
        const baseDamage = Math.round(charge.maxDamage * damagePercent);
        if (baseDamage > 0) {
          this.combatSystem.applySweepDamage(this.playerController, npc, baseDamage);
        }
      }
    }

    // End charge
    if (charge.elapsed >= charge.duration) {
      // AoE burst at end: full damage to all hostiles in melee range
      const meleeRange = this.playerController.autoAttackRange;
      for (const npc of this.npcs) {
        if (npc.dead) continue;
        const dx = this.playerController.mesh.position.x - npc.mesh.position.x;
        const dz = this.playerController.mesh.position.z - npc.mesh.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist <= meleeRange) {
          this.combatSystem.applySweepDamage(this.playerController, npc, charge.maxDamage);
        }
      }

      this.playerController.charging = false;
      this.sweepCharge = null;
    }
  }

  private updateAutoAttack(dt: number): void {
    if (!this.autoAttacking) return;

    // Keep model in sync (handles character swap mid-combat)
    this.playerController.setAutoAttacking(true);

    const player = this.playerController;
    const target = this.targetingSystem.currentTarget;

    // Stop conditions
    if (player.dead || !target || target.dead || !target.isHostileTo(player) || target !== this.autoAttackTarget) {
      this.stopAutoAttack();
      return;
    }

    this.autoAttackTimer += dt;

    const atkSpeedMult = this.buffSystem.getAutoAttackSpeedMultiplier(player);
    if (this.autoAttackTimer >= player.autoAttackSpeed / atkSpeedMult) {
      // Check range
      const dx = player.mesh.position.x - target.mesh.position.x;
      const dz = player.mesh.position.z - target.mesh.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > player.autoAttackRange) {
        this.autoAttackTimer = player.autoAttackSpeed;
        return;
      }

      // Check line of sight
      if (!this.combatSystem.hasLineOfSight(player.mesh.position, target.mesh.position)) {
        this.autoAttackTimer = player.autoAttackSpeed;
        this.onAutoAttackError?.('Not in line of sight');
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
        this.autoAttackTimer = 0;
        this.onAutoAttackError?.('Not facing target');
        return;
      }

      // Swing!
      this.autoAttackTimer = 0;
      player.triggerSwing();
      this.combatSystem.applyAutoAttackDamage(player, target, player.rollAutoAttackDamage());
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
      if (target && target.isHostileTo(this.playerController) && !target.dead) {
        this.startAutoAttack(target);
      }
    }

    this.updateAutoAttack(deltaTime);

    // Update buff-driven modifiers before player update
    this.playerController.movementSpeedModifier = this.buffSystem.getMovementSpeedMultiplier(this.playerController);
    this.playerController.setAbilityBuffActive('crash-out', this.buffSystem.hasBuff(this.playerController, 'crash-out'));

    // Stun state — player
    const playerStunned = this.buffSystem.isStunned(this.playerController);
    this.playerController.setStunned(playerStunned);
    if (playerStunned && this.autoAttacking) {
      this.stopAutoAttack();
    }

    // Stun state — NPCs
    for (const npc of this.npcs) {
      npc.setStunned(this.buffSystem.isStunned(npc));
    }

    // Sweep charge: move player before collision resolution in player update
    this.updateSweepCharge(deltaTime);

    // Cancel sweep if stunned
    if (playerStunned && this.sweepCharge) {
      this.playerController.charging = false;
      this.sweepCharge = null;
    }

    this.mapManager.update(deltaTime);
    this.playerController.update(deltaTime);
    for (const npc of this.npcs) npc.update(deltaTime);
    // Despawn dead NPCs after their timer expires
    for (let i = this.npcs.length - 1; i >= 0; i--) {
      if (this.npcs[i].shouldDespawn) {
        this.removeNpc(this.npcs[i]);
      }
    }
    this.updateGasClouds(deltaTime);
    this.combatSystem.update(deltaTime);
    this.buffSystem.update(deltaTime);
    this.regenSystem.update(deltaTime);
    this.targetingSystem.update(deltaTime);
    this.thirdPersonCamera.update(deltaTime);
    this.renderer.render(this.scene, this.camera);
    this.input.resetDeltas();
  };

  dispose(): void {
    this.stop();
    this.clearGasClouds();
    this.clearNpcs();
    this.playerController.dispose();
    this.renderer.dispose();
    this.input.dispose();
  }
}
