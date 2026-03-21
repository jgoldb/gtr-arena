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

interface ActiveChemicalPool {
  group: THREE.Group;
  ripples: THREE.Mesh[];
  center: THREE.Vector3;
  radius: number;
  duration: number;
  elapsed: number;
  speedBuff: BuffDefinition;
  dot: BuffDefinition;
  initialDamage: number;
  dotDamagePerTick: number;
  dotTickInterval: number;
  dotDuration: number;
  owner: Targetable;
  activationDelay: number; // seconds before pool becomes active
  consumed: boolean;       // true once triggered by a player
  consumeElapsed: number;  // fade-out timer after consumption
}

interface ActiveDot {
  target: Targetable;
  debuff: BuffDefinition;
  totalDuration: number;
  elapsed: number;
  tickInterval: number;
  nextTickAt: number;
  damagePerTick: number;
  owner: Targetable;
}

interface DiscombobBubbles {
  target: Targetable;
  group: THREE.Group;
  bubbles: THREE.Mesh[];
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
  private readonly chemicalPools: ActiveChemicalPool[] = [];
  private readonly activeDots: ActiveDot[] = [];
  private readonly discombobEffects: DiscombobBubbles[] = [];
  private channelBeam: THREE.Mesh | null = null;
  private channelBeamTarget: Targetable | null = null;
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

  // Casting system (also used for channels)
  private casting: {
    ability: Ability;
    target: Targetable | null;
    elapsed: number;
    totalTime: number;
    originalCastTime: number;
    isChannel: boolean;
    tickInterval: number;
    ticksDelivered: number;
  } | null = null;
  private static readonly CAST_PUSHBACK = 0.5;
  onCastComplete?: (ability: Ability, target: Targetable | null) => void;
  onCastFailed?: (message: string) => void;

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

    // Direct damage pushback for casting/channeling (DoT damage bypasses CombatSystem, so no pushback)
    this.combatSystem.onDirectDamageDealt = (target) => {
      if (target === this.playerController && this.casting) {
        if (this.casting.isChannel) {
          // Channel pushback: reduce remaining time (loses ticks)
          this.casting.totalTime = Math.max(0, this.casting.totalTime - Engine.CAST_PUSHBACK);
        } else {
          // Cast pushback: increase cast time (capped at 2x original)
          const maxTime = this.casting.originalCastTime * 2;
          this.casting.totalTime = Math.min(
            this.casting.totalTime + Engine.CAST_PUSHBACK,
            maxTime
          );
        }
      }
    };
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
    this.clearChemicalPools();
    this.clearNpcs();
    this.mapManager.loadMap(id);
    this.playerController.respawn();
  }

  setCharacter(id: CharacterId): void {
    this.stopAutoAttack();
    this.cancelCasting();
    this.buffSystem.clearEntity(this.playerController);
    this.combatSystem.leaveCombat(this.playerController);
    this.combatSystem.clearCooldowns();
    this.playerController.setCharacter(id);
    this.playerController.dead = false;
    this.onCharacterChange?.(this.playerController.abilities);
  }

  spawnNpc(characterId: CharacterId, position: THREE.Vector3, team?: number): NpcController {
    const npc = new NpcController(characterId, position, team);
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
      // Remove from active dots
      for (let j = this.activeDots.length - 1; j >= 0; j--) {
        if (this.activeDots[j].target === npc) {
          this.activeDots.splice(j, 1);
        }
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

  // ── Casting ─────────────────────────────────────────

  startCasting(
    ability: Ability,
    attackerRotY: number,
    target: Targetable | null
  ): import('./combat/CombatSystem').CombatResult {
    if (this.casting) {
      return { success: false, error: 'casting', errorMessage: 'Already casting' };
    }
    const validation = this.combatSystem.validateAbility(
      ability, this.playerController, attackerRotY, target
    );
    if (!validation.success) return validation;

    const isChannel = ability.isChannel ?? false;

    if (isChannel) {
      // Channels consume mana and start cooldown immediately
      this.playerController.mana -= ability.manaCost;
      if (ability.manaCost > 0) {
        this.regenSystem.notifyManaUsed(this.playerController);
      }
      this.combatSystem.setCooldown(ability.id, ability.cooldown);
      // Enter combat for hostile channel targets
      if (target && target.isHostileTo(this.playerController)) {
        this.combatSystem.enterCombat(this.playerController);
        this.combatSystem.enterCombat(target);
        // Channel start can miss on hostile targets (entire channel fails)
        if (this.combatSystem.rollMiss()) {
          this.combatSystem.onCombatText?.(target, 0, 'miss');
          return { success: true };
        }
      }
    }

    this.casting = {
      ability,
      target,
      elapsed: 0,
      totalTime: ability.castTime!,
      originalCastTime: ability.castTime!,
      isChannel,
      tickInterval: isChannel ? ability.castTime! / ability.channelTicks! : 0,
      ticksDelivered: 0,
    };

    // Apply channel aura to target
    if (isChannel && target) {
      const isFriendly = !target.isHostileTo(this.playerController);
      this.buffSystem.apply(target, {
        id: `channel-${ability.id}`,
        name: ability.name,
        icon: ability.icon,
        duration: Infinity, // managed manually
        type: isFriendly ? 'buff' : 'debuff',
        description: ability.description,
        effects: [],
      });
      // Set initial remaining to channel duration
      this.updateChannelAuraRemaining();
    }

    return { success: true };
  }

  cancelCasting(): void {
    if (!this.casting) return;
    this.removeChannelAura();
    this.casting = null;
  }

  private completeCasting(): void {
    if (!this.casting) return;
    const { ability, target } = this.casting;
    this.casting = null;

    const result = this.combatSystem.useAbility(
      ability,
      this.playerController,
      this.playerController.mesh.rotation.y,
      target
    );
    if (result.success) {
      this.onCastComplete?.(ability, target);
    } else if (result.errorMessage) {
      this.onCastFailed?.(result.errorMessage);
    }
  }

  private deliverChannelTick(): void {
    if (!this.casting || !this.casting.target) return;
    const { ability, target } = this.casting;
    if (target.dead) return;

    const isFriendly = !target.isHostileTo(this.playerController);

    if (isFriendly && ability.healAmount) {
      const healPerTick = Math.round(ability.healAmount / ability.channelTicks!);
      this.combatSystem.applyHeal(target, healPerTick);
      // Healing someone in combat puts the healer in combat
      if (target.inCombat) {
        this.combatSystem.enterCombat(this.playerController);
      }
    } else if (!isFriendly && ability.damage > 0) {
      const damagePerTick = Math.round(ability.damage / ability.channelTicks!);
      this.combatSystem.applyChannelTickDamage(this.playerController, target, damagePerTick);
    }
  }

  private updateChannelAuraRemaining(): void {
    if (!this.casting || !this.casting.isChannel || !this.casting.target) return;
    const buffId = `channel-${this.casting.ability.id}`;
    const remaining = Math.max(0, this.casting.totalTime - this.casting.elapsed);
    this.buffSystem.setRemaining(this.casting.target, buffId, remaining);
  }

  private removeChannelAura(): void {
    if (!this.casting || !this.casting.isChannel || !this.casting.target) return;
    this.buffSystem.remove(this.casting.target, `channel-${this.casting.ability.id}`);
  }

  isCasting(): boolean {
    return this.casting !== null;
  }

  isChanneling(): boolean {
    return this.casting !== null && this.casting.isChannel;
  }

  getCastingState(): {
    abilityName: string;
    elapsed: number;
    totalTime: number;
    isChannel: boolean;
    originalCastTime: number;
  } | null {
    if (!this.casting) return null;
    return {
      abilityName: this.casting.ability.name,
      elapsed: this.casting.elapsed,
      totalTime: this.casting.totalTime,
      isChannel: this.casting.isChannel,
      originalCastTime: this.casting.originalCastTime,
    };
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

  spawnChemicalPool(
    position: THREE.Vector3,
    radius: number,
    duration: number,
    speedBuff: BuffDefinition,
    dot: BuffDefinition,
    initialDamage: number,
    dotTotalDamage: number,
    dotTickInterval: number,
    dotDuration: number,
    owner: Targetable,
    activationDelay: number = 0
  ): void {
    const dotTickCount = Math.floor(dotDuration / dotTickInterval);
    const dotDamagePerTick = Math.round(dotTotalDamage / dotTickCount);

    const group = new THREE.Group();
    group.position.set(position.x, 0.02, position.z);

    // Base pool disc — mixed green/purple chemical liquid
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x44aa66,
      transparent: true,
      opacity: 0.35,
      roughness: 0.2,
      metalness: 0.1,
      depthWrite: false,
      emissive: 0x228844,
      emissiveIntensity: 0.3,
    });
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, 0.02, 24),
      baseMat
    );
    base.position.y = 0.01;
    base.renderOrder = 1;
    group.add(base);

    // Secondary purple layer — slightly smaller, offset
    const purpleMat = new THREE.MeshStandardMaterial({
      color: 0x8844cc,
      transparent: true,
      opacity: 0.25,
      roughness: 0.2,
      depthWrite: false,
      emissive: 0x6633aa,
      emissiveIntensity: 0.4,
    });
    const purpleLayer = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.75, radius * 0.8, 0.02, 24),
      purpleMat
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
        transparent: true,
        opacity: 0.15,
        roughness: 0.1,
        depthWrite: false,
        emissive: i % 2 === 0 ? 0x33bb55 : 0x8833bb,
        emissiveIntensity: 0.5,
      });
      const ripple = new THREE.Mesh(
        new THREE.TorusGeometry(rippleRadius, 0.03, 4, 24),
        rippleMat
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
        transparent: true,
        opacity: 0.4 + Math.random() * 0.2,
        roughness: 0.1,
        depthWrite: false,
        emissive: i % 2 === 0 ? 0x33dd55 : 0x9955cc,
        emissiveIntensity: 0.6,
      });
      const bubble = new THREE.Mesh(
        new THREE.SphereGeometry(size, 6, 6),
        bubbleMat
      );
      bubble.position.set(
        Math.cos(angle) * r,
        0.03 + Math.random() * 0.04,
        Math.sin(angle) * r
      );
      bubble.renderOrder = 4;
      group.add(bubble);
    }

    this.scene.add(group);

    this.chemicalPools.push({
      group,
      ripples,
      center: new THREE.Vector3(position.x, 0, position.z),
      radius,
      duration,
      elapsed: 0,
      speedBuff,
      dot,
      initialDamage,
      dotDamagePerTick,
      dotTickInterval,
      dotDuration,
      owner,
      activationDelay,
      consumed: false,
      consumeElapsed: 0,
    });
  }

  private static readonly POOL_CONSUME_DURATION = 0.6; // fast fade-out on trigger

  private updateChemicalPools(dt: number): void {
    for (let i = this.chemicalPools.length - 1; i >= 0; i--) {
      const pool = this.chemicalPools[i];
      pool.elapsed += dt;

      // If consumed, just fade out and expire
      if (pool.consumed) {
        pool.consumeElapsed += dt;
        const fade = Math.max(0, 1 - pool.consumeElapsed / Engine.POOL_CONSUME_DURATION);
        pool.group.traverse(child => {
          if (child instanceof THREE.Mesh) {
            const mat = child.material as THREE.MeshStandardMaterial;
            if (mat.userData.baseOpacity === undefined) {
              mat.userData.baseOpacity = mat.opacity;
            }
            mat.opacity = mat.userData.baseOpacity * fade;
          }
        });
        // Shrink as it's consumed
        pool.group.scale.setScalar(fade);

        if (pool.consumeElapsed >= Engine.POOL_CONSUME_DURATION) {
          pool.group.traverse(child => {
            if (child instanceof THREE.Mesh) {
              child.geometry.dispose();
              (child.material as THREE.Material).dispose();
            }
          });
          this.scene.remove(pool.group);
          this.chemicalPools.splice(i, 1);
        }
        continue;
      }

      // Pool must arm before it can be triggered
      if (pool.elapsed < pool.activationDelay) {
        // Animate ripples (dimmed while arming)
        for (const ripple of pool.ripples) {
          const phase = ripple.userData.phase as number;
          const pulse = 1 + Math.sin(pool.elapsed * 2.5 + phase) * 0.15;
          ripple.scale.setScalar(pulse);
          (ripple.material as THREE.MeshStandardMaterial).opacity =
            0.08 * (0.6 + Math.sin(pool.elapsed * 3 + phase) * 0.4);
        }
        pool.group.rotation.y += dt * 0.15;
        // Fade in during arming
        const fade = Math.min(1, pool.elapsed / 0.4) * 0.5;
        pool.group.traverse(child => {
          if (child instanceof THREE.Mesh) {
            const mat = child.material as THREE.MeshStandardMaterial;
            if (mat.userData.baseOpacity === undefined) {
              mat.userData.baseOpacity = mat.opacity;
            }
            mat.opacity = mat.userData.baseOpacity * fade;
          }
        });
        continue;
      }

      // Collect all potential targets (both friendly and hostile, including owner)
      const allTargets: Targetable[] = [];
      allTargets.push(this.playerController);
      for (const npc of this.npcs) {
        allTargets.push(npc);
      }

      // Check who is in the pool
      for (const target of allTargets) {
        if (target.dead) continue;
        const dx = target.mesh.position.x - pool.center.x;
        const dz = target.mesh.position.z - pool.center.z;
        if (dx * dx + dz * dz > pool.radius * pool.radius) continue;

        // Target stepped in — trigger effects and consume the pool
        if (target.isHostileTo(pool.owner)) {
          // Hostile: deal initial damage + apply DoT
          target.hp = Math.max(0, target.hp - pool.initialDamage);
          this.combatSystem.onCombatText?.(target, pool.initialDamage, 'damage');
          this.combatSystem.enterCombat(pool.owner);
          this.combatSystem.enterCombat(target);
          if (target.hp <= 0 && !target.dead) {
            target.die();
          } else {
            this.buffSystem.apply(target, pool.dot);
            this.activeDots.push({
              target,
              debuff: pool.dot,
              totalDuration: pool.dotDuration,
              elapsed: 0,
              tickInterval: pool.dotTickInterval,
              nextTickAt: pool.dotTickInterval,
              damagePerTick: pool.dotDamagePerTick,
              owner: pool.owner,
            });
          }
        } else {
          // Friendly: apply speed buff
          this.buffSystem.apply(target, pool.speedBuff);
        }

        // Consume the pool — one trigger only
        pool.consumed = true;
        break;
      }

      if (pool.consumed) continue;

      // Animate ripples
      for (const ripple of pool.ripples) {
        const phase = ripple.userData.phase as number;
        const pulse = 1 + Math.sin(pool.elapsed * 2.5 + phase) * 0.15;
        ripple.scale.setScalar(pulse);
        (ripple.material as THREE.MeshStandardMaterial).opacity =
          0.15 * (0.6 + Math.sin(pool.elapsed * 3 + phase) * 0.4);
      }

      // Rotate pool slowly
      pool.group.rotation.y += dt * 0.15;

      // Fade in/out (natural expiry)
      const fadeStart = pool.duration - 1.5;
      const fade = pool.elapsed > fadeStart
        ? Math.max(0, 1 - (pool.elapsed - fadeStart) / 1.5)
        : Math.min(1, pool.elapsed / 0.4);

      pool.group.traverse(child => {
        if (child instanceof THREE.Mesh) {
          const mat = child.material as THREE.MeshStandardMaterial;
          if (mat.userData.baseOpacity === undefined) {
            mat.userData.baseOpacity = mat.opacity;
          }
          mat.opacity = mat.userData.baseOpacity * fade;
        }
      });

      // Expire
      if (pool.elapsed >= pool.duration) {
        pool.group.traverse(child => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            (child.material as THREE.Material).dispose();
          }
        });
        this.scene.remove(pool.group);
        this.chemicalPools.splice(i, 1);
      }
    }
  }

  private updateActiveDots(dt: number): void {
    for (let i = this.activeDots.length - 1; i >= 0; i--) {
      const dot = this.activeDots[i];
      dot.elapsed += dt;

      // Tick damage
      while (dot.elapsed >= dot.nextTickAt && dot.nextTickAt <= dot.totalDuration) {
        if (!dot.target.dead) {
          dot.target.hp = Math.max(0, dot.target.hp - dot.damagePerTick);
          this.combatSystem.onCombatText?.(dot.target, dot.damagePerTick, 'damage');
          this.combatSystem.enterCombat(dot.target);
          if (dot.target.hp <= 0 && !dot.target.dead) {
            dot.target.die();
          }
        }
        dot.nextTickAt += dot.tickInterval;
      }

      // Expire
      if (dot.elapsed >= dot.totalDuration || dot.target.dead) {
        this.activeDots.splice(i, 1);
      }
    }
  }

  private clearChemicalPools(): void {
    for (const pool of this.chemicalPools) {
      pool.group.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
      this.scene.remove(pool.group);
    }
    this.chemicalPools.length = 0;
    this.activeDots.length = 0;
  }

  private updateGasClouds(dt: number): void {
    for (let i = this.gasClouds.length - 1; i >= 0; i--) {
      const cloud = this.gasClouds[i];
      cloud.elapsed += dt;

      // Collect all hostile targets
      const targets: Targetable[] = [];
      if (cloud.owner === this.playerController) {
        for (const npc of this.npcs) {
          if (npc.isHostileTo(this.playerController)) targets.push(npc);
        }
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

  // ── Discombobulate shadow bubbles ────────────────────
  private updateDiscombobEffects(dt: number): void {
    // Spawn effects for newly discombobulated targets
    const allTargets: Targetable[] = [this.playerController, ...this.npcs];
    for (const target of allTargets) {
      if (target.dead) continue;
      const hasDebuff = this.buffSystem.isDiscombobulated(target);
      const hasEffect = this.discombobEffects.some(e => e.target === target);
      if (hasDebuff && !hasEffect) {
        this.spawnDiscombobEffect(target);
      }
    }

    // Update and remove expired effects
    for (let i = this.discombobEffects.length - 1; i >= 0; i--) {
      const effect = this.discombobEffects[i];
      const hasDebuff = this.buffSystem.isDiscombobulated(effect.target);
      if (!hasDebuff || effect.target.dead) {
        // Clean up
        effect.group.traverse(child => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            (child.material as THREE.Material).dispose();
          }
        });
        this.scene.remove(effect.group);
        this.discombobEffects.splice(i, 1);
        continue;
      }

      // Follow target
      effect.group.position.set(
        effect.target.mesh.position.x,
        0,
        effect.target.mesh.position.z
      );

      // Animate bubbles — rise, wobble, fade, loop
      for (const bubble of effect.bubbles) {
        const speed = bubble.userData.speed as number;
        const period = 1.8 / speed;
        const phase = bubble.userData.phase as number;
        const t = ((this.clock.elapsedTime * speed + phase) % period) / period;

        const baseY = bubble.userData.baseY as number;
        bubble.position.y = baseY + t * 0.6;

        // Wobble sideways
        const xOff = bubble.userData.xOff as number;
        const zOff = bubble.userData.zOff as number;
        bubble.position.x = xOff + Math.sin(this.clock.elapsedTime * 3 + phase) * 0.08;
        bubble.position.z = zOff + Math.cos(this.clock.elapsedTime * 2.5 + phase * 1.3) * 0.08;

        // Scale pulse and fade
        const life = Math.sin(t * Math.PI);
        bubble.scale.setScalar(0.5 + life * 0.8);
        (bubble.material as THREE.MeshStandardMaterial).opacity = life * 0.55;
      }
    }
  }

  private spawnDiscombobEffect(target: Targetable): void {
    const group = new THREE.Group();
    const bubbles: THREE.Mesh[] = [];
    const bubbleCount = 10;

    for (let i = 0; i < bubbleCount; i++) {
      const size = 0.04 + Math.random() * 0.05;
      const mat = new THREE.MeshStandardMaterial({
        color: 0x222233,
        emissive: 0x111122,
        emissiveIntensity: 0.3,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(size, 6, 5), mat);
      const angle = (i / bubbleCount) * Math.PI * 2;
      const radius = 0.15 + Math.random() * 0.25;
      mesh.userData.xOff = Math.cos(angle) * radius;
      mesh.userData.zOff = Math.sin(angle) * radius;
      mesh.userData.baseY = 0.2 + Math.random() * 1.2;
      mesh.userData.speed = 0.6 + Math.random() * 0.8;
      mesh.userData.phase = Math.random() * 5;
      mesh.position.set(mesh.userData.xOff, mesh.userData.baseY, mesh.userData.zOff);
      mesh.renderOrder = 2;
      group.add(mesh);
      bubbles.push(mesh);
    }

    group.position.set(target.mesh.position.x, 0, target.mesh.position.z);
    this.scene.add(group);
    this.discombobEffects.push({ target, group, bubbles });
  }

  // ── Channel beam ───────────────────────────────────────
  private updateChannelBeam(): void {
    if (!this.casting || !this.casting.isChannel || !this.casting.target) {
      // Remove beam if channel ended
      if (this.channelBeam) {
        this.channelBeam.geometry.dispose();
        (this.channelBeam.material as THREE.Material).dispose();
        this.scene.remove(this.channelBeam);
        this.channelBeam = null;
        this.channelBeamTarget = null;
      }
      return;
    }

    const playerPos = this.playerController.mesh.position;
    const targetPos = this.casting.target.mesh.position;

    // Beam start slightly above player center, end at target center
    const startY = 1.6;
    const endY = 1.0;
    const start = new THREE.Vector3(playerPos.x, startY, playerPos.z);
    const end = new THREE.Vector3(targetPos.x, endY, targetPos.z);
    const midPoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    const direction = new THREE.Vector3().subVectors(end, start);
    const length = direction.length();

    if (length < 0.01) return;

    // Create or reuse beam mesh
    if (!this.channelBeam) {
      const geo = new THREE.CylinderGeometry(0.04, 0.04, 1, 6, 1, true);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xeeeeff,
        emissive: 0xaabbff,
        emissiveIntensity: 1.5,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this.channelBeam = new THREE.Mesh(geo, mat);
      this.channelBeam.renderOrder = 3;
      this.scene.add(this.channelBeam);
    }

    // Position and orient beam
    this.channelBeam.position.copy(midPoint);
    this.channelBeam.scale.set(1, length, 1);
    this.channelBeam.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.normalize()
    );

    // Pulse opacity
    const pulse = 0.55 + Math.sin(this.clock.elapsedTime * 6) * 0.15;
    (this.channelBeam.material as THREE.MeshStandardMaterial).opacity = pulse;

    this.channelBeamTarget = this.casting.target;
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
      if (npc.dead || charge.hitTargets.has(npc) || !npc.isHostileTo(this.playerController)) continue;
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
        if (npc.dead || !npc.isHostileTo(this.playerController)) continue;
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

    // Discombobulate state — player
    this.playerController.setDiscombobulated(
      this.buffSystem.isDiscombobulated(this.playerController)
    );

    // Stun state — NPCs
    for (const npc of this.npcs) {
      npc.setStunned(this.buffSystem.isStunned(npc));
    }

    // Update casting / channeling
    if (this.casting) {
      this.casting.elapsed += deltaTime;

      // Cancel if dead, stunned, or moving
      const castMoving =
        this.input.isKeyDown('KeyW') || this.input.isKeyDown('KeyS') ||
        this.input.isKeyDown('KeyA') || this.input.isKeyDown('KeyD') ||
        (this.input.isMouseButtonDown('left') && this.input.isMouseButtonDown('right'));

      if (this.playerController.dead || playerStunned || castMoving) {
        this.cancelCasting();
      }

      // Validate target mid-cast/channel
      if (this.casting && (this.casting.ability.requiresHostileTarget || this.casting.ability.requiresTarget)) {
        const ct = this.casting.target;
        if (!ct || ct.dead) {
          // Target died — always cancel
          this.cancelCasting();
        } else if (this.casting.isChannel) {
          // Channels: cancel on out-of-range, but continue through LOS break
          if (this.casting.ability.range) {
            const dx = this.playerController.mesh.position.x - ct.mesh.position.x;
            const dz = this.playerController.mesh.position.z - ct.mesh.position.z;
            if (Math.sqrt(dx * dx + dz * dz) > this.casting.ability.range) {
              this.cancelCasting();
            }
          }
        }
        // Regular casts: do NOT cancel mid-cast for range/LOS — checked at completion
      }

      // Channel tick delivery & completion
      if (this.casting && this.casting.isChannel) {
        const totalTicks = this.casting.ability.channelTicks!;
        while (
          this.casting &&
          this.casting.ticksDelivered < totalTicks &&
          this.casting.elapsed >= (this.casting.ticksDelivered + 1) * this.casting.tickInterval
        ) {
          const tickTime = (this.casting.ticksDelivered + 1) * this.casting.tickInterval;
          if (tickTime <= this.casting.totalTime && this.casting.target && !this.casting.target.dead) {
            this.deliverChannelTick();
          }
          this.casting.ticksDelivered++;
        }
        // Channel ends when elapsed reaches totalTime
        if (this.casting && this.casting.elapsed >= this.casting.totalTime) {
          this.removeChannelAura();
          this.casting = null;
        }
      }

      // Regular cast completion
      if (this.casting && !this.casting.isChannel && this.casting.elapsed >= this.casting.totalTime) {
        this.completeCasting();
      }
    }

    // Drive cast/channel animations on the player model
    if (this.casting) {
      const progress = Math.min(1, this.casting.elapsed / this.casting.totalTime);
      if (this.casting.isChannel) {
        this.playerController.setChannelAnimation(this.casting.ability.id, progress);
        this.playerController.setCastAnimation(null, 0);
      } else {
        this.playerController.setCastAnimation(this.casting.ability.id, progress);
        this.playerController.setChannelAnimation(null, 0);
      }
    } else {
      this.playerController.setCastAnimation(null, 0);
      this.playerController.setChannelAnimation(null, 0);
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
    this.updateChemicalPools(deltaTime);
    this.updateActiveDots(deltaTime);
    this.updateDiscombobEffects(deltaTime);
    this.updateChannelBeam();
    this.combatSystem.update(deltaTime);
    this.buffSystem.update(deltaTime);
    // Update channel aura remaining AFTER buff system tick (overrides its decrement)
    this.updateChannelAuraRemaining();
    this.regenSystem.update(deltaTime);
    this.targetingSystem.update(deltaTime);
    this.thirdPersonCamera.update(deltaTime);
    this.renderer.render(this.scene, this.camera);
    this.input.resetDeltas();
  };

  dispose(): void {
    this.stop();
    this.clearGasClouds();
    this.clearChemicalPools();
    this.clearNpcs();
    // Clean up discombob effects
    for (const effect of this.discombobEffects) {
      effect.group.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
      this.scene.remove(effect.group);
    }
    this.discombobEffects.length = 0;
    // Clean up channel beam
    if (this.channelBeam) {
      this.channelBeam.geometry.dispose();
      (this.channelBeam.material as THREE.Material).dispose();
      this.scene.remove(this.channelBeam);
      this.channelBeam = null;
    }
    this.playerController.dispose();
    this.renderer.dispose();
    this.input.dispose();
  }
}
