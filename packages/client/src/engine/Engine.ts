import * as THREE from 'three';
import { Renderer } from './renderer/Renderer';
import { InputManager } from './input/InputManager';
import { MapManager } from './map/MapManager';
import { PlayerController } from './player/PlayerController';
import { GLOBAL_COOLDOWN, yardsToUnits, ArenaPreparationBuff, RestingBuff, Sweep, RottenCrotchStun, KaboomStun, TweakerSprint, TweakerSprintSlow, ODStunDebuff, ParanoidDebuff, type Ability } from './combat/Ability';
import type { BuffDefinition } from './combat/BuffSystem';
import { CharacterId } from './player/characters';
import { getCharacterStats } from '@gtr/shared';
import { ThirdPersonCamera } from './camera/ThirdPersonCamera';
import { NpcController } from './npc/NpcController';
import { TargetingSystem } from './targeting/TargetingSystem';
import { CombatSystem } from './combat/CombatSystem';
import { RegenSystem } from './combat/RegenSystem';
import { BuffSystem } from './combat/BuffSystem';
import type { Targetable } from './types';
import {
  type GasCloudVisual, type ChemPoolVisual, type FullRetardAuraVisual, type CrotchRotVisual,
  POOL_CONSUME_DURATION,
  createGasCloud, updateGasCloud,
  createChemPool, updateChemPool,
  createFullRetardAura, updateFullRetardAura as updateFullRetardAuraVisual,
  createCrotchRotCloud, updateCrotchRotCloud,
  createChannelBeam, updateChannelBeam as updateChannelBeamVisual, removeChannelBeam,
  disposeGroup,
} from './effects/VisualEffects';
import { BlindEffect } from './effects/BlindEffect';
import { keybindManager } from '../ui/KeybindManager';

interface ActiveGasCloud extends GasCloudVisual {
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

interface ActiveChemicalPool extends ChemPoolVisual {
  center: THREE.Vector3;
  radius: number;
  duration: number;
  elapsed: number;
  speedBuff: BuffDefinition;
  dot: BuffDefinition;
  initialDamageMin: number;
  initialDamageMax: number;
  dotDamagePerTick: number;
  dotTickInterval: number;
  dotDuration: number;
  owner: Targetable;
  activationDelay: number;
  consumed: boolean;
  consumeElapsed: number;
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

interface ActiveFullRetardAura extends FullRetardAuraVisual {
  elapsed: number;
  nextTickAt: number;
}

interface PendingAoeImpact {
  ability: Ability;
  groundPos: THREE.Vector3;
  delay: number;
  elapsed: number;
  owner: Targetable;
}

interface ActiveKnockback {
  target: Targetable;
  dirX: number;
  dirZ: number;
  distance: number;
  duration: number;
  elapsed: number;
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
  private readonly pendingAoeImpacts: PendingAoeImpact[] = [];
  private readonly activeKnockbacks: ActiveKnockback[] = [];
  private fullRetardAura: ActiveFullRetardAura | null = null;
  private crotchRotVisuals = new Map<Targetable, CrotchRotVisual & { elapsed: number }>();
  private channelBeam: THREE.Mesh | null = null;
  private channelBeamTarget: Targetable | null = null;
  private readonly blindEffect = new BlindEffect();
  private autoAttacking = false;
  private autoAttackTimer = 0;
  private autoAttackTarget: Targetable | null = null;
  private dumpsterDiveAutoTarget: Targetable | null = null;
  private sweepCharge: {
    elapsed: number;
    duration: number;
    direction: THREE.Vector3;
    speed: number;
    hitTargets: Set<Targetable>;
    maxDamage: number;
    savedAutoAttackTarget: Targetable | null;
  } | null = null;
  private tweakerSprintCharge: {
    elapsed: number;
    duration: number;
    direction: THREE.Vector3;
    speed: number;
    hitTargets: Set<Targetable>;
    damage: number;
    savedAutoAttackTarget: Targetable | null;
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
    damageMultiplier: number; // snapshotted at channel start for buff consistency
  } | null = null;
  private static readonly CAST_PUSHBACK = 0.5;
  onCastComplete?: (ability: Ability, target: Targetable | null) => void;
  onCastFailed?: (message: string) => void;
  onGroundTargetConfirmed?: () => void;
  pendingNpcSpawn: { characterId: CharacterId; team?: number } | null = null;

  arenaPreparationActive = false;
  private resting = false;
  private rKeyWasDown = false;
  private tabKeyWasDown = false;
  private fKeyWasDown = false;
  private gKeyWasDown = false;
  isAdmin = false;
  godMode = false;
  onRestError?: (message: string) => void;
  onCharacterChange?: (abilities: readonly (Ability | null)[]) => void;
  onAutoAttackError?: (message: string) => void;
  onGodModeToggle?: (active: boolean) => void;
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
      () => this.thirdPersonCamera.getAzimuth(),
      () => this.thirdPersonCamera.getElevation()
    );

    this.targetingSystem = new TargetingSystem(
      this.camera, this.scene, canvas, () => this.playerController
    );
    this.regenSystem = new RegenSystem(() => [this.playerController, ...this.npcs]);
    this.buffSystem = new BuffSystem();
    this.regenSystem.setBuffSystem(this.buffSystem);
    this.combatSystem = new CombatSystem(this.regenSystem, this.buffSystem, this.mapManager.collision);

    // Direct damage pushback for casting/channeling (DoT damage bypasses CombatSystem, so no pushback)
    // Also cancels resting on the first hit taken
    this.combatSystem.onDirectDamageDealt = (target) => {
      if (this.buffSystem.isSleeping(target)) {
        this.buffSystem.removeSleepEffects(target);
      }
      if (target === this.playerController && this.resting) {
        this.stopResting();
      }
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

    this.combatSystem.onSleepApplied = (_attacker, target) => {
      if (target === this.autoAttackTarget && this.autoAttacking) {
        this.stopAutoAttack();
      }
    };

    this.combatSystem.onBlindApplied = (_attacker, target) => {
      // Blinded player loses target and stops auto-attacking
      if (target === this.playerController) {
        this.targetingSystem.currentTarget = null;
        if (this.autoAttacking) this.stopAutoAttack();
      }
    };

    // Flinch animation on direct damage (not DoT/channel ticks)
    this.combatSystem.onFlinchDamage = (target) => {
      if (target === this.playerController) {
        this.playerController.triggerFlinch();
      } else {
        for (const npc of this.npcs) {
          if (npc === target) { npc.triggerFlinch(); break; }
        }
      }
    };

    // Auto-target attacker when player has no target (not while blinded)
    this.combatSystem.onHostileAction = (attacker, target, ability) => {
      if (target === this.playerController && !this.targetingSystem.currentTarget && !this.buffSystem.isBlinded(this.playerController) && !ability?.suppressAutoTarget) {
        this.targetingSystem.currentTarget = attacker;
      }
      // NPC auto-targets its attacker when it has no target
      if (target instanceof NpcController && !target.autoAttackTarget && !target.dead) {
        target.autoAttackTarget = attacker;
      }
    };

    // Fall damage (WoW-style: no damage below threshold, then scales with distance)
    this.playerController.onFallDamage = (fallDistance: number) => {
      if (this.godMode || this.playerController.dead) return;
      const SAFE_FALL = 8;   // ~13 yards — no damage below this
      const FATAL_FALL = 28; // ~47 yards — 100% HP damage
      if (fallDistance <= SAFE_FALL) return;
      const pct = Math.min(1, (fallDistance - SAFE_FALL) / (FATAL_FALL - SAFE_FALL));
      const damage = Math.round(this.playerController.maxHp * pct);
      if (damage <= 0) return;
      this.playerController.hp = Math.max(0, this.playerController.hp - damage);
      this.combatSystem.onCombatText?.(this.playerController, damage, 'damage');
      if (this.playerController.hp <= 0 && !this.playerController.dead) {
        this.playerController.die();
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
    this.cleanupFullRetardFumes();
    this.clearNpcs();
    this.mapManager.loadMap(id);
    this.playerController.respawn();
    this.applyArenaPreparation();
  }

  applyArenaPreparation(): void {
    this.arenaPreparationActive = true;
    this.buffSystem.apply(this.playerController, ArenaPreparationBuff);
    this.applyStartingBuffs();
    const script = this.mapManager.getScript();
    if (script) {
      script.onDoorsOpen = () => {
        this.arenaPreparationActive = false;
        this.buffSystem.remove(this.playerController, ArenaPreparationBuff.id);
      };
    }
  }

  private applyStartingBuffs(): void {
    const stats = getCharacterStats(this.playerController.characterId);
    if (stats.startingBuffs) {
      for (const buff of stats.startingBuffs) {
        this.buffSystem.apply(this.playerController, buff);
      }
    }
  }

  respawnPlayer(): void {
    this.playerController.respawn();
    this.applyStartingBuffs();
  }

  setCharacter(id: CharacterId): void {
    this.stopResting();
    this.stopAutoAttack();
    this.cancelCasting();
    this.buffSystem.clearEntity(this.playerController);
    this.combatSystem.leaveCombat(this.playerController);
    this.combatSystem.clearCooldowns();
    this.playerController.setCharacter(id);
    this.playerController.dead = false;
    if (this.arenaPreparationActive) {
      this.buffSystem.apply(this.playerController, ArenaPreparationBuff);
    }
    this.applyStartingBuffs();
    this.onCharacterChange?.(this.playerController.abilities);
  }

  spawnNpc(characterId: CharacterId, position: THREE.Vector3, team?: number, name?: string): NpcController {
    const npc = new NpcController(characterId, position, team, name);
    npc.onAutoAttackHit = (attacker, target, damage) => {
      this.combatSystem.applyAutoAttackDamage(attacker, target, damage);
    };
    npc.checkLineOfSight = (a, b) => this.combatSystem.hasLineOfSight(a, b);
    npc.resolveGround = (x, z, y) => this.mapManager.collision.resolve(x, z, y, 0.5).groundY;
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
      this.cleanupCrotchRotVisual(npc);
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
      this.cleanupCrotchRotVisual(npc);
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
    if (this.playerController.isMoving) {
      return { success: false, error: 'moving', errorMessage: 'Cannot cast while moving' };
    }
    const validation = this.combatSystem.validateAbility(
      ability, this.playerController, attackerRotY, target
    );
    if (!validation.success) return validation;

    // Trigger GCD at cast/channel start
    if (!this.godMode) {
      this.combatSystem.triggerGcd(GLOBAL_COOLDOWN);
    }

    const isChannel = ability.isChannel ?? false;

    if (isChannel) {
      // Channels consume mana and start cooldown immediately
      if (!this.godMode) {
        const effectiveCost = Math.round(ability.manaCost * this.buffSystem.getManaCostMultiplier(this.playerController));
        this.playerController.mana -= effectiveCost;
        if (effectiveCost > 0) {
          this.regenSystem.notifyManaUsed(this.playerController);
        }
        this.combatSystem.setCooldown(ability.id, ability.cooldown);
      }
      // Enter combat for hostile channel targets
      if (target && target.isHostileTo(this.playerController)) {
        this.combatSystem.onHostileAction?.(this.playerController, target);
        this.combatSystem.enterCombat(this.playerController);
        this.combatSystem.enterCombat(target);
        // Channel start can miss on hostile targets (entire channel fails)
        if (this.combatSystem.rollMiss()) {
          this.combatSystem.onCombatText?.(target, 0, 'miss');
          return { success: true };
        }
      }
    }

    // Non-channels: start a short interrupt cooldown; on success useAbility overwrites with the real one
    if (!isChannel && !this.godMode) {
      this.combatSystem.setCooldown(ability.id, Engine.INTERRUPT_COOLDOWN);
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
      damageMultiplier: isChannel ? this.buffSystem.getDamageDealtMultiplier(this.playerController) : 1,
    };

    // Apply channel aura to target
    if (isChannel && target) {
      const isFriendly = !target.isHostileTo(this.playerController);
      this.buffSystem.apply(target, {
        id: `channel-${ability.id}`,
        name: ability.name,
        icon: ability.icon,
        duration: ability.castTime!, // remaining managed manually via updateChannelAuraRemaining
        type: isFriendly ? 'buff' : 'debuff',
        description: ability.description,
        effects: [],
        unremovable: true,
      });
      // Set initial remaining to channel duration
      this.updateChannelAuraRemaining();
    }

    return { success: true };
  }

  private static readonly INTERRUPT_COOLDOWN = 1; // seconds

  cancelCasting(): void {
    if (!this.casting) return;
    this.removeChannelAura();
    this.casting = null;
  }

  // Delay from ability activation to projectile impact (animation wind-up + flight time)
  private static readonly BOTTLE_CHUCK_IMPACT_DELAY = 0.825; // ~0.275s launch + 0.55s flight

  /** Execute a ground-targeted AoE ability at a world position. Consumes resources immediately, delays damage until impact. */
  useGroundTargetAbility(
    ability: Ability,
    groundPos: THREE.Vector3
  ): import('./combat/CombatSystem').CombatResult {
    const attacker = this.playerController;
    if (attacker.dead) return { success: false, error: 'dead', errorMessage: 'You are dead' };
    if (this.buffSystem.isStunned(attacker) || this.buffSystem.isSleeping(attacker)) return { success: false, error: 'stunned', errorMessage: 'You are stunned' };
    if (!this.godMode && this.combatSystem.getCooldownRemaining(ability.id) > 0) {
      return { success: false, error: 'on-cooldown', errorMessage: 'Ability is not ready yet' };
    }
    if (!this.godMode && this.combatSystem.getGcdRemaining() > 0) {
      return { success: false, error: 'on-cooldown', errorMessage: 'Ability is not ready yet' };
    }
    if (!this.godMode) {
      const effectiveCost = Math.round(ability.manaCost * this.buffSystem.getManaCostMultiplier(attacker));
      if (attacker.mana < effectiveCost) return { success: false, error: 'not-enough-mana', errorMessage: 'Not enough mana' };
      attacker.mana -= effectiveCost;
      if (effectiveCost > 0) this.regenSystem.notifyManaUsed(attacker);
    }

    if (!this.godMode) {
      this.combatSystem.setCooldown(ability.id, ability.cooldown);
      this.combatSystem.triggerGcd(GLOBAL_COOLDOWN);
    }

    // Schedule damage for when the projectile lands
    this.pendingAoeImpacts.push({
      ability,
      groundPos: groundPos.clone(),
      delay: Engine.BOTTLE_CHUCK_IMPACT_DELAY,
      elapsed: 0,
      owner: attacker,
    });

    return { success: true };
  }

  private updatePendingAoeImpacts(dt: number): void {
    for (let i = this.pendingAoeImpacts.length - 1; i >= 0; i--) {
      const impact = this.pendingAoeImpacts[i];
      impact.elapsed += dt;
      if (impact.elapsed < impact.delay) continue;

      // Impact! Damage all hostiles in radius
      const radius = impact.ability.aoeRadius ?? 0;
      for (const target of this.npcs) {
        if (target.dead || !target.isHostileTo(impact.owner) || this.buffSystem.isUntargetable(target)) continue;
        const dx = target.mesh.position.x - impact.groundPos.x;
        const dz = target.mesh.position.z - impact.groundPos.z;
        if (dx * dx + dz * dz > radius * radius) continue;
        this.combatSystem.applyAoeDamage(impact.owner, target, impact.ability);
      }

      this.pendingAoeImpacts.splice(i, 1);
    }
  }

  private completeCasting(): void {
    if (!this.casting) return;
    const { ability, target } = this.casting;
    this.casting = null;

    // Clear the interrupt cooldown so useAbility's validation passes
    this.combatSystem.clearCooldown(ability.id);

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
      const healPerTick = Math.round(ability.healAmount / ability.channelTicks! * this.casting!.damageMultiplier);
      this.combatSystem.applyHeal(target, healPerTick);
      // Healing someone in combat puts the healer in combat
      if (target.inCombat) {
        this.combatSystem.enterCombat(this.playerController);
      }
    } else if (!isFriendly && ability.damage > 0) {
      const damagePerTick = Math.round(ability.damage / ability.channelTicks!);
      this.combatSystem.applyChannelTickDamage(this.playerController, target, damagePerTick, this.casting!.damageMultiplier);
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
    this.buffSystem.remove(this.casting.target, `channel-${this.casting.ability.id}`, true);
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

  // ── Resting ──────────────────────────────────────────

  startResting(): boolean {
    if (this.playerController.dead) return false;
    if (this.playerController.inCombat) {
      this.onRestError?.('You are in combat');
      return false;
    }
    if (this.playerController.isMoving) return false;
    if (this.casting) return false;
    if (this.buffSystem.isStunned(this.playerController) || this.buffSystem.isSleeping(this.playerController)) return false;

    this.resting = true;
    this.stopAutoAttack();
    this.buffSystem.apply(this.playerController, RestingBuff);
    this.playerController.setResting(true);
    return true;
  }

  stopResting(): void {
    if (!this.resting) return;
    this.resting = false;
    this.buffSystem.remove(this.playerController, RestingBuff.id);
    this.playerController.setResting(false);
  }

  isResting(): boolean {
    return this.resting;
  }

  startAutoAttack(target: Targetable): void {
    if (target === this.autoAttackTarget && this.autoAttacking) return;
    if (this.resting) this.stopResting();
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
    const visual = createGasCloud(this.scene, position.x, position.z, radius);

    this.gasClouds.push({
      ...visual,
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
    initialDamageMin: number,
    initialDamageMax: number,
    dotTotalDamage: number,
    dotTickInterval: number,
    dotDuration: number,
    owner: Targetable,
    activationDelay: number = 0
  ): void {
    const dotTickCount = Math.floor(dotDuration / dotTickInterval);
    const dotDamagePerTick = Math.round(dotTotalDamage / dotTickCount);
    const visual = createChemPool(this.scene, position.x, position.z, radius);

    this.chemicalPools.push({
      ...visual,
      center: new THREE.Vector3(position.x, 0, position.z),
      radius,
      duration,
      elapsed: 0,
      speedBuff,
      dot,
      initialDamageMin,
      initialDamageMax,
      dotDamagePerTick,
      dotTickInterval,
      dotDuration,
      owner,
      activationDelay,
      consumed: false,
      consumeElapsed: 0,
    });
  }

  private updateChemicalPools(dt: number): void {
    for (let i = this.chemicalPools.length - 1; i >= 0; i--) {
      const pool = this.chemicalPools[i];
      pool.elapsed += dt;
      if (pool.consumed) pool.consumeElapsed += dt;

      // Game logic: check for targets stepping in (only when armed and not consumed)
      if (!pool.consumed && pool.elapsed >= pool.activationDelay) {
        const allTargets: Targetable[] = [];
        allTargets.push(this.playerController);
        for (const npc of this.npcs) {
          allTargets.push(npc);
        }

        for (const target of allTargets) {
          if (target.dead || this.buffSystem.isUntargetable(target)) continue;
          const dx = target.mesh.position.x - pool.center.x;
          const dz = target.mesh.position.z - pool.center.z;
          if (dx * dx + dz * dz > pool.radius * pool.radius) continue;

          if (target.isHostileTo(pool.owner)) {
            this.combatSystem.onHostileAction?.(pool.owner, target);
            const poolGodImmune = this.godMode && target === this.playerController;
            const rolledDmg = pool.initialDamageMin + Math.floor(Math.random() * (pool.initialDamageMax - pool.initialDamageMin + 1));
            const actualPoolDmg = poolGodImmune ? 0 : this.combatSystem.processDamageAbsorb(target, rolledDmg, pool.owner);
            target.hp = Math.max(0, target.hp - actualPoolDmg);
            if (actualPoolDmg > 0) this.combatSystem.onCombatText?.(target, actualPoolDmg, 'damage');
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
            this.buffSystem.apply(target, pool.speedBuff);
          }

          pool.consumed = true;
          break;
        }

        if (pool.consumed) continue;
      }

      // Visual update (shared with ClientEngine)
      if (updateChemPool(pool, pool.elapsed, pool.duration, pool.activationDelay, pool.consumed, pool.consumeElapsed, dt)) {
        disposeGroup(this.scene, pool.group);
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
          this.combatSystem.onHostileAction?.(dot.owner, dot.target);
          const dotGodImmune = this.godMode && dot.target === this.playerController;
          const actualDotDmg = dotGodImmune ? 0 : this.combatSystem.processDamageAbsorb(dot.target, dot.damagePerTick, dot.owner);
          dot.target.hp = Math.max(0, dot.target.hp - actualDotDmg);
          if (actualDotDmg > 0) this.combatSystem.onCombatText?.(dot.target, actualDotDmg, 'damage');
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

  saveDumpsterDiveAutoTarget(): void {
    if (this.autoAttacking && this.autoAttackTarget) {
      this.dumpsterDiveAutoTarget = this.autoAttackTarget;
    }
  }

  handleBuffExpired(target: Targetable, definition: BuffDefinition): void {
    if (definition.id === 'paranoid') {
      this.buffSystem.removeStacks(target, 'tweaking', 100);
    }
    if (definition.id === 'crotch-rot') {
      this.buffSystem.apply(target, RottenCrotchStun);
    }
    if (definition.id === 'overdosing') {
      this.buffSystem.apply(target, ODStunDebuff);
    }
    if (definition.id === 'od-stun') {
      // Set Tweaking to 100 stacks
      this.buffSystem.removeStacks(target, 'tweaking', 100);
      this.buffSystem.addStacks(target, 'tweaking', 100);
      if (!this.buffSystem.hasDebuff(target, 'paranoid')) {
        this.buffSystem.apply(target, ParanoidDebuff);
      }
    }
    if (definition.id === 'dumpster-diving' && target === this.playerController) {
      // AoE damage on emerge: 150 damage to nearby enemies within 5 yards
      const radius = yardsToUnits(5);
      for (const npc of this.npcs) {
        if (npc.dead || !npc.isHostileTo(this.playerController)) continue;
        const dx = this.playerController.mesh.position.x - npc.mesh.position.x;
        const dz = this.playerController.mesh.position.z - npc.mesh.position.z;
        if (dx * dx + dz * dz <= radius * radius) {
          const dmg = this.godMode ? 0 : this.combatSystem.processDamageAbsorb(npc, 150, this.playerController);
          npc.hp = Math.max(0, npc.hp - dmg);
          if (dmg > 0) this.combatSystem.onCombatText?.(npc, dmg, 'damage');
          this.combatSystem.enterCombat(this.playerController);
          this.combatSystem.enterCombat(npc);
          if (npc.hp <= 0 && !npc.dead) npc.die();
        }
      }
      // Re-engage auto-attack if target is still valid
      const saved = this.dumpsterDiveAutoTarget;
      this.dumpsterDiveAutoTarget = null;
      if (saved && !saved.dead && saved.isHostileTo(this.playerController)
        && this.targetingSystem.currentTarget === saved && !this.buffSystem.isUntargetable(saved)) {
        this.startAutoAttack(saved);
      }
    }
  }

  spawnDot(target: Targetable, debuff: BuffDefinition, totalDuration: number, tickInterval: number, totalDamage: number, owner: Targetable): void {
    const tickCount = Math.floor(totalDuration / tickInterval);
    this.buffSystem.apply(target, debuff);
    this.activeDots.push({
      target, debuff,
      totalDuration, elapsed: 0,
      tickInterval, nextTickAt: tickInterval,
      damagePerTick: Math.round(totalDamage / tickCount),
      owner,
    });
  }

  private clearChemicalPools(): void {
    for (const pool of this.chemicalPools) disposeGroup(this.scene, pool.group);
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
        if (target.dead || this.buffSystem.isUntargetable(target)) continue;
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
          this.combatSystem.onHostileAction?.(cloud.owner, target);
          const cloudGodImmune = this.godMode && target === this.playerController;
          const actualCloudDmg = cloudGodImmune ? 0 : this.combatSystem.processDamageAbsorb(target, cloud.damagePerTick, cloud.owner);
          target.hp = Math.max(0, target.hp - actualCloudDmg);
          if (actualCloudDmg > 0) this.combatSystem.onCombatText?.(target, actualCloudDmg, 'damage');
          this.combatSystem.enterCombat(target);
          if (target.hp <= 0 && !target.dead) {
            target.die();
          }
        }
        cloud.nextTickAt += cloud.tickInterval;
      }

      // Animate visuals (shared with ClientEngine)
      if (updateGasCloud(cloud, cloud.elapsed, cloud.duration, dt)) {
        for (const target of cloud.affectedTargets) {
          this.buffSystem.remove(target, cloud.debuff.id);
        }
        disposeGroup(this.scene, cloud.group);
        this.gasClouds.splice(i, 1);
      }
    }
  }

  private clearGasClouds(): void {
    for (const cloud of this.gasClouds) {
      for (const target of cloud.affectedTargets) {
        this.buffSystem.remove(target, cloud.debuff.id);
      }
      disposeGroup(this.scene, cloud.group);
    }
    this.gasClouds.length = 0;
  }

  // ── Full Retard aura (AoE damage + heal while buff active) ──

  private spawnFullRetardFumes(): void {
    const meleeRange = this.playerController.autoAttackRange;
    const pos = this.playerController.mesh.position;
    const visual = createFullRetardAura(this.scene, pos.x, pos.z, meleeRange);

    this.fullRetardAura = {
      ...visual,
      elapsed: 0,
      nextTickAt: 1,
    };
  }

  private cleanupFullRetardFumes(): void {
    if (!this.fullRetardAura) return;
    disposeGroup(this.scene, this.fullRetardAura.group);
    this.fullRetardAura = null;
  }

  private updateFullRetardAura(dt: number): void {
    const hasBuff = this.buffSystem.hasBuff(this.playerController, 'full-retard');

    if (hasBuff && !this.fullRetardAura) {
      this.spawnFullRetardFumes();
    } else if (!hasBuff && this.fullRetardAura) {
      this.cleanupFullRetardFumes();
    }

    if (!this.fullRetardAura) return;

    const aura = this.fullRetardAura;
    aura.elapsed += dt;

    // Follow player
    aura.group.position.set(
      this.playerController.mesh.position.x,
      0,
      this.playerController.mesh.position.z
    );

    const meleeRange = this.playerController.autoAttackRange;

    // Tick every 1 second: 200 damage to hostiles, 300 heal to friendlies in melee range
    while (aura.elapsed >= aura.nextTickAt) {
      // Damage hostiles
      for (const npc of this.npcs) {
        if (npc.dead || !npc.isHostileTo(this.playerController) || this.buffSystem.isUntargetable(npc)) continue;
        const dx = this.playerController.mesh.position.x - npc.mesh.position.x;
        const dz = this.playerController.mesh.position.z - npc.mesh.position.z;
        if (dx * dx + dz * dz <= meleeRange * meleeRange) {
          const dmg = this.combatSystem.processDamageAbsorb(npc, 200, this.playerController);
          npc.hp = Math.max(0, npc.hp - dmg);
          if (dmg > 0) this.combatSystem.onCombatText?.(npc, dmg, 'damage');
          this.combatSystem.enterCombat(this.playerController);
          this.combatSystem.enterCombat(npc);
          if (npc.hp <= 0 && !npc.dead) npc.die();
        }
      }

      // Heal friendlies (including self — self heals for 125, allies for 300)
      const allTargets: Targetable[] = [this.playerController, ...this.npcs];
      for (const target of allTargets) {
        if (target.dead || target.isHostileTo(this.playerController)) continue;
        const dx = this.playerController.mesh.position.x - target.mesh.position.x;
        const dz = this.playerController.mesh.position.z - target.mesh.position.z;
        if (dx * dx + dz * dz <= meleeRange * meleeRange) {
          const heal = target === this.playerController ? 125 : 300;
          this.combatSystem.applyHeal(target, heal);
        }
      }

      aura.nextTickAt += 1;
    }

    // Animate puffs (shared with ClientEngine)
    const pos = this.playerController.mesh.position;
    updateFullRetardAuraVisual(aura, aura.elapsed, dt, pos.x, pos.z);
  }

  // ── Crotch Rot visuals ────────────────────────────────

  private cleanupCrotchRotVisual(target: Targetable): void {
    const visual = this.crotchRotVisuals.get(target);
    if (!visual) return;
    target.mesh.remove(visual.group);
    visual.group.traverse(child => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    });
    this.crotchRotVisuals.delete(target);
  }

  private updateCrotchRotVisuals(dt: number): void {
    const allTargets: Targetable[] = [this.playerController, ...this.npcs];

    // Spawn visuals for targets that have the debuff but no visual yet
    for (const target of allTargets) {
      if (target.dead) continue;
      const hasDebuff = this.buffSystem.hasDebuff(target, 'crotch-rot');
      if (hasDebuff && !this.crotchRotVisuals.has(target)) {
        const visual = createCrotchRotCloud();
        target.mesh.add(visual.group);
        this.crotchRotVisuals.set(target, { ...visual, elapsed: 0 });
      }
    }

    // Update existing visuals and remove expired ones
    for (const [target, visual] of this.crotchRotVisuals) {
      const hasDebuff = this.buffSystem.hasDebuff(target, 'crotch-rot');
      if (!hasDebuff || target.dead) {
        this.cleanupCrotchRotVisual(target);
        continue;
      }

      visual.elapsed += dt;
      // Group is parented to mesh, so pass 0,0,0 for follow position
      updateCrotchRotCloud(visual, visual.elapsed, 0, 0, 0);
    }
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
        disposeGroup(this.scene, effect.group);
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
      if (this.channelBeam) {
        removeChannelBeam(this.scene, this.channelBeam);
        this.channelBeam = null;
        this.channelBeamTarget = null;
      }
      return;
    }

    if (!this.channelBeam) {
      this.channelBeam = createChannelBeam(this.scene);
    }

    updateChannelBeamVisual(
      this.channelBeam,
      this.playerController.mesh.position,
      this.casting.target.mesh.position,
      this.clock.elapsedTime,
    );
    this.channelBeamTarget = this.casting.target;
  }

  startSweepCharge(): void {
    const player = this.playerController;
    const rotY = player.mesh.rotation.y;
    const direction = new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY));

    const savedAutoAttackTarget = this.autoAttackTarget;
    this.stopAutoAttack();
    player.charging = true;
    this.sweepCharge = {
      elapsed: 0,
      duration: Sweep.chargeDuration!,
      direction,
      speed: Sweep.chargeSpeed!,
      hitTargets: new Set(),
      maxDamage: Sweep.chargeMaxDamage!,
      savedAutoAttackTarget,
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
      if (npc.dead || charge.hitTargets.has(npc) || !npc.isHostileTo(this.playerController) || this.buffSystem.isUntargetable(npc)) continue;
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
        if (npc.dead || !npc.isHostileTo(this.playerController) || this.buffSystem.isUntargetable(npc)) continue;
        const dx = this.playerController.mesh.position.x - npc.mesh.position.x;
        const dz = this.playerController.mesh.position.z - npc.mesh.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist <= meleeRange) {
          this.combatSystem.applySweepDamage(this.playerController, npc, charge.maxDamage);
        }
      }

      // Re-engage auto-attack if we were auto-attacking before sweep
      const savedTarget = charge.savedAutoAttackTarget;
      if (savedTarget && !savedTarget.dead && savedTarget.isHostileTo(this.playerController)) {
        this.startAutoAttack(savedTarget);
      }

      this.playerController.charging = false;
      this.sweepCharge = null;
    }
  }

  // ── Tweaker Sprint charge ──────────────────────────────────────────

  startTweakerSprintCharge(target: Targetable): void {
    const player = this.playerController;
    const dx = target.mesh.position.x - player.mesh.position.x;
    const dz = target.mesh.position.z - player.mesh.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01) return;

    const direction = new THREE.Vector3(dx / dist, 0, dz / dist);
    // Face the target
    player.mesh.rotation.y = Math.atan2(direction.x, direction.z);

    const speed = TweakerSprint.chargeSpeed!;
    const chargeDist = Math.max(0, dist - yardsToUnits(1)); // stop 1 yard short
    const duration = chargeDist / speed;

    const savedAutoAttackTarget = this.autoAttackTarget;
    this.stopAutoAttack();
    player.charging = true;
    player.chargeAnimSpeed = 3; // fast frantic run
    this.tweakerSprintCharge = {
      elapsed: 0,
      duration,
      direction,
      speed,
      hitTargets: new Set(),
      damage: TweakerSprint.chargeMaxDamage!,
      savedAutoAttackTarget,
    };
  }

  private updateTweakerSprintCharge(dt: number): void {
    if (!this.tweakerSprintCharge) return;

    const charge = this.tweakerSprintCharge;
    charge.elapsed += dt;

    // Move player toward target
    this.playerController.mesh.position.addScaledVector(charge.direction, charge.speed * dt);

    // Hit detection: check all hostile NPCs (flat damage + slow debuff)
    const hitRadius = 1.0; // world units (~1.67 yards)
    for (const npc of this.npcs) {
      if (npc.dead || charge.hitTargets.has(npc) || !npc.isHostileTo(this.playerController) || this.buffSystem.isUntargetable(npc)) continue;
      const dx = this.playerController.mesh.position.x - npc.mesh.position.x;
      const dz = this.playerController.mesh.position.z - npc.mesh.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist <= hitRadius) {
        charge.hitTargets.add(npc);
        this.combatSystem.applySweepDamage(this.playerController, npc, charge.damage);
        this.buffSystem.apply(npc, TweakerSprintSlow);
      }
    }

    // End charge
    if (charge.elapsed >= charge.duration) {
      // Re-engage auto-attack
      const savedTarget = charge.savedAutoAttackTarget;
      if (savedTarget && !savedTarget.dead && savedTarget.isHostileTo(this.playerController)) {
        this.startAutoAttack(savedTarget);
      }

      this.playerController.charging = false;
      this.playerController.chargeAnimSpeed = 1;
      this.tweakerSprintCharge = null;
    }
  }

  // ── Kaboom cone AoE with knockback ──────────────────────────────────

  private static readonly KABOOM_CONE_RANGE = yardsToUnits(8);
  private static readonly KABOOM_CONE_HALF_ANGLE = Math.PI / 6; // 60° total cone (30° each side)
  private static readonly KABOOM_KNOCKBACK_DISTANCE = yardsToUnits(8);
  private static readonly KABOOM_KNOCKBACK_DURATION = 0.5; // seconds
  private static readonly KABOOM_KNOCKBACK_HEIGHT = 3.0; // world units peak height

  executeKaboom(): void {
    const player = this.playerController;
    const rotY = player.mesh.rotation.y;
    const forwardX = Math.sin(rotY);
    const forwardZ = Math.cos(rotY);
    const range = Engine.KABOOM_CONE_RANGE;
    const cosHalf = Math.cos(Engine.KABOOM_CONE_HALF_ANGLE);

    // Gust of air visual
    this.spawnKaboomGust(player.mesh.position, rotY, range);

    for (const npc of this.npcs) {
      if (npc.dead || !npc.isHostileTo(player) || this.buffSystem.isUntargetable(npc)) continue;
      const dx = npc.mesh.position.x - player.mesh.position.x;
      const dz = npc.mesh.position.z - player.mesh.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > range || dist < 0.01) continue;

      // Cone angle check
      const toTargetX = dx / dist;
      const toTargetZ = dz / dist;
      const dot = forwardX * toTargetX + forwardZ * toTargetZ;
      if (dot < cosHalf) continue;

      // Target is in cone — knock them back
      this.combatSystem.enterCombat(player);
      this.combatSystem.enterCombat(npc);
      this.activeKnockbacks.push({
        target: npc,
        dirX: toTargetX,
        dirZ: toTargetZ,
        distance: Engine.KABOOM_KNOCKBACK_DISTANCE,
        duration: Engine.KABOOM_KNOCKBACK_DURATION,
        elapsed: 0,
      });
    }
  }

  private spawnKaboomGust(origin: THREE.Vector3, rotY: number, range: number): void {
    const halfAngle = Engine.KABOOM_CONE_HALF_ANGLE;
    const particleCount = 30;
    const group = new THREE.Group();
    group.position.set(origin.x, 0, origin.z);

    const particles: { mesh: THREE.Mesh; vx: number; vz: number; speed: number; life: number }[] = [];

    for (let i = 0; i < particleCount; i++) {
      // Random angle within cone
      const angle = rotY - halfAngle + Math.random() * 2 * halfAngle;
      // Random distance along cone (bias toward mid-range)
      const dist = 0.3 + Math.random() * 0.7;
      const speed = range * (0.8 + Math.random() * 0.4);
      const size = 0.08 + Math.random() * 0.12;

      const geo = new THREE.SphereGeometry(size, 4, 4);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xccddee,
        transparent: true,
        opacity: 0.5 + Math.random() * 0.3,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, 0.3 + Math.random() * 1.0, 0);

      group.add(mesh);
      particles.push({
        mesh,
        vx: Math.sin(angle),
        vz: Math.cos(angle),
        speed,
        life: 0,
      });
    }

    this.scene.add(group);

    const duration = 0.4;
    const startTime = performance.now();

    const animate = () => {
      const elapsed = (performance.now() - startTime) / 1000;
      const t = elapsed / duration;

      if (t >= 1) {
        this.scene.remove(group);
        for (const p of particles) {
          (p.mesh.geometry as THREE.BufferGeometry).dispose();
          (p.mesh.material as THREE.Material).dispose();
        }
        return;
      }

      for (const p of particles) {
        p.life += 1 / 60; // approximate dt
        const dist = p.speed * p.life;
        p.mesh.position.x = p.vx * dist;
        p.mesh.position.z = p.vz * dist;
        // Fade out as they travel
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * (0.5 + Math.random() * 0.1);
        // Slight upward drift
        p.mesh.position.y += 0.01;
        // Scale up slightly as they spread
        const scale = 1 + t * 1.5;
        p.mesh.scale.setScalar(scale);
      }

      requestAnimationFrame(animate);
    };

    requestAnimationFrame(animate);
  }

  private updateKnockbacks(dt: number): void {
    for (let i = this.activeKnockbacks.length - 1; i >= 0; i--) {
      const kb = this.activeKnockbacks[i];
      kb.elapsed += dt;
      const t = Math.min(1, kb.elapsed / kb.duration);

      // Move target along knockback direction
      const speed = kb.distance / kb.duration;
      if (kb.target.mesh) {
        kb.target.mesh.position.x += kb.dirX * speed * dt;
        kb.target.mesh.position.z += kb.dirZ * speed * dt;
        // Parabolic arc for Y (knocked up into air)
        kb.target.mesh.position.y = Engine.KABOOM_KNOCKBACK_HEIGHT * 4 * t * (1 - t);
      }

      if (t >= 1) {
        // Land — reset Y and apply stun
        if (kb.target.mesh) {
          kb.target.mesh.position.y = 0;
        }
        this.buffSystem.apply(kb.target, KaboomStun);
        this.activeKnockbacks.splice(i, 1);
      }
    }
  }

  private updateAutoAttack(dt: number): void {
    if (!this.autoAttacking) return;

    // Keep model in sync (handles character swap mid-combat)
    this.playerController.setAutoAttacking(true);

    const player = this.playerController;
    const target = this.targetingSystem.currentTarget;

    // Stop conditions
    if (player.dead || !target || target.dead || !target.isHostileTo(player) || target !== this.autoAttackTarget
      || this.buffSystem.isUntargetable(target) || this.buffSystem.isUntargetable(player)) {
      this.stopAutoAttack();
      return;
    }

    this.autoAttackTimer += dt;

    const atkSpeedMult = this.buffSystem.getAutoAttackSpeedMultiplier(player) * (this.godMode ? 6 : 1);
    if (this.autoAttackTimer >= player.autoAttackSpeed / atkSpeedMult) {
      // Check range (3D distance including Y)
      const dx = player.mesh.position.x - target.mesh.position.x;
      const dy = player.mesh.position.y - target.mesh.position.y;
      const dz = player.mesh.position.z - target.mesh.position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
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
      if (this.targetingSystem.groundTargetActive) {
        if (!this.targetingSystem.groundTargetBlocked) {
          this.onGroundTargetConfirmed?.();
        }
      } else if (!this.input.isMouseButtonDown('right')) {
        // Only process target selection on normal left clicks — not while
        // right-click drag (pointer lock) is active, to avoid accidentally
        // clearing the current target.
        this.targetingSystem.processClick(click.x, click.y);
      }
    }

    // Process right-click for auto-attack
    const rightClick = this.input.getRightClick();
    if (rightClick) {
      const target = this.targetingSystem.processRightClick(rightClick.x, rightClick.y);
      if (target && target.isHostileTo(this.playerController) && !target.dead) {
        this.startAutoAttack(target);
      }
    }

    // Update cursor for hover detection (only when pointer is unlocked)
    this.targetingSystem.updateHoverCursor(this.input.getMouseScreenPos(), this.input.isMouseButtonDown('right'));

    this.updateAutoAttack(deltaTime);

    // Update buff-driven modifiers before player update
    this.playerController.movementSpeedModifier = this.buffSystem.getMovementSpeedMultiplier(this.playerController)
      * (this.godMode ? 4 : 1); // God mode: +300% movement speed
    this.playerController.setAbilityBuffActive('crash-out', this.buffSystem.hasBuff(this.playerController, 'crash-out'));
    this.playerController.setAbilityBuffActive('retard-strength', this.buffSystem.hasBuff(this.playerController, 'retard-strength'));
    this.playerController.setAbilityBuffActive('full-retard', this.buffSystem.hasBuff(this.playerController, 'full-retard'));
    this.playerController.setAbilityBuffActive('dumpster-diving', this.buffSystem.hasBuff(this.playerController, 'dumpster-diving'));
    this.playerController.setAbilityBuffActive('overdosing', this.buffSystem.hasBuff(this.playerController, 'overdosing'));

    // Resting toggle
    const rKeyDown = this.input.isBindDown(keybindManager.getCode('rest'));
    if (rKeyDown && !this.rKeyWasDown) {
      if (this.resting) {
        this.stopResting();
      } else {
        this.startResting();
      }
    }
    this.rKeyWasDown = rKeyDown;

    // Tab targeting — nearest hostile in front within 30 yards (blocked while blinded)
    const tabDown = this.input.isBindDown(keybindManager.getCode('target_nearest_enemy'));
    if (tabDown && !this.tabKeyWasDown && !this.buffSystem.isBlinded(this.playerController)) {
      this.targetingSystem.selectNearestHostileInFront(this.npcs, yardsToUnits(30));
    }
    this.tabKeyWasDown = tabDown;

    // Target of target key
    const fDown = this.input.isBindDown(keybindManager.getCode('target_of_target'));
    if (fDown && !this.fKeyWasDown) {
      const ct = this.targetingSystem.currentTarget;
      if (ct && 'autoAttackTarget' in ct) {
        const tot = (ct as any).autoAttackTarget as Targetable | null;
        if (tot && tot !== ct) {
          this.targetingSystem.currentTarget = tot;
        }
      }
    }
    this.fKeyWasDown = fDown;

    // God mode toggle — "G" key (admin only)
    const gKeyDown = this.input.isKeyDown('KeyG');
    if (gKeyDown && !this.gKeyWasDown && this.isAdmin) {
      this.godMode = !this.godMode;
      this.combatSystem.setGodMode(this.playerController, this.godMode);
      this.playerController.godMode = this.godMode;
      if (this.godMode) {
        // Restore HP/mana to full
        this.playerController.hp = this.playerController.maxHp;
        this.playerController.mana = this.playerController.maxMana;
      }
      this.onGodModeToggle?.(this.godMode);
    }
    this.gKeyWasDown = gKeyDown;

    // Cancel resting on movement
    if (this.resting) {
      const wDown = this.input.isBindDown(keybindManager.getCode('move_forward'));
      const sDown = this.input.isBindDown(keybindManager.getCode('move_backward'));
      const aDown = this.input.isBindDown(keybindManager.getCode('move_left'));
      const dDown = this.input.isBindDown(keybindManager.getCode('move_right'));
      const bothMouse = this.input.isMouseButtonDown('left') && this.input.isMouseButtonDown('right');
      const jumping = this.input.isBindDown(keybindManager.getCode('jump'));
      if (wDown || sDown || aDown || dDown || bothMouse || jumping) {
        this.stopResting();
      }
    }

    // Cancel resting on entering combat
    if (this.resting && this.playerController.inCombat) {
      this.stopResting();
    }

    // Stun/sleep state — player
    const playerStunned = this.buffSystem.isStunned(this.playerController) || this.buffSystem.isSleeping(this.playerController);
    this.playerController.setStunned(playerStunned);
    if (playerStunned && this.autoAttacking) {
      this.stopAutoAttack();
    }
    // Cancel ground targeting on stun or death
    if ((playerStunned || this.playerController.dead) && this.targetingSystem.groundTargetActive) {
      this.pendingNpcSpawn = null;
      this.targetingSystem.cancelGroundTarget();
    }

    // Cancel resting on stun
    if (playerStunned && this.resting) {
      this.stopResting();
    }

    // Discombobulate state — player
    this.playerController.setDiscombobulated(
      this.buffSystem.isDiscombobulated(this.playerController)
    );

    // Blind state — player (blur + sand specks + eyelid blinks + prevent targeting)
    const playerBlinded = this.buffSystem.isBlinded(this.playerController);
    if (playerBlinded) {
      if (!this.blindEffect.isActive()) {
        this.blindEffect.activate(this.renderer.getCanvas());
      }
      this.blindEffect.update(deltaTime);
    } else if (this.blindEffect.isActive()) {
      this.blindEffect.deactivate();
    }

    // Stun/sleep state — NPCs
    for (const npc of this.npcs) {
      npc.setStunned(this.buffSystem.isStunned(npc) || this.buffSystem.isSleeping(npc));
    }

    // Update casting / channeling
    if (this.casting) {
      this.casting.elapsed += deltaTime;

      // Cancel if dead, stunned, moving, or jumping
      const castMoving =
        this.input.isKeyDown('KeyW') || this.input.isKeyDown('KeyS') ||
        this.input.isKeyDown('KeyA') || this.input.isKeyDown('KeyD') ||
        (this.input.isMouseButtonDown('left') && this.input.isMouseButtonDown('right')) ||
        this.input.isBindDown(keybindManager.getCode('jump'));

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

    // Sync casting state to PlayerController so the target frame cast bar works when targeting self
    if (this.casting) {
      this.playerController.castingAbilityName = this.casting.ability.name;
      this.playerController.castingElapsed = this.casting.elapsed;
      this.playerController.castingTotalTime = this.casting.totalTime;
      this.playerController.castingIsChannel = this.casting.isChannel;
    } else {
      this.playerController.castingAbilityName = null;
      this.playerController.castingElapsed = 0;
      this.playerController.castingTotalTime = 0;
      this.playerController.castingIsChannel = false;
    }

    // Sweep charge: move player before collision resolution in player update
    this.updateSweepCharge(deltaTime);
    this.updateTweakerSprintCharge(deltaTime);

    // Cancel charges if stunned
    if (playerStunned && this.sweepCharge) {
      this.playerController.charging = false;
      this.sweepCharge = null;
    }
    if (playerStunned && this.tweakerSprintCharge) {
      this.playerController.charging = false;
      this.playerController.chargeAnimSpeed = 1;
      this.tweakerSprintCharge = null;
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
    this.updatePendingAoeImpacts(deltaTime);
    this.updateKnockbacks(deltaTime);
    this.updateFullRetardAura(deltaTime);
    this.updateCrotchRotVisuals(deltaTime);
    this.updateDiscombobEffects(deltaTime);
    this.updateChannelBeam();
    this.combatSystem.update(deltaTime);
    this.buffSystem.update(deltaTime);
    // Update channel aura remaining AFTER buff system tick (overrides its decrement)
    this.updateChannelAuraRemaining();
    this.regenSystem.update(deltaTime);
    this.targetingSystem.update(deltaTime);
    this.thirdPersonCamera.update(deltaTime);
    this.playerController.setOpacity(this.thirdPersonCamera.getPlayerModelOpacity());
    this.renderer.render(this.scene, this.camera);
    this.input.resetDeltas();
  };

  dispose(): void {
    this.stop();
    this.blindEffect.deactivate();
    this.clearGasClouds();
    this.clearChemicalPools();
    this.cleanupFullRetardFumes();
    this.clearNpcs();
    // Clean up discombob effects
    for (const effect of this.discombobEffects) disposeGroup(this.scene, effect.group);
    this.discombobEffects.length = 0;
    // Clean up channel beam
    if (this.channelBeam) {
      removeChannelBeam(this.scene, this.channelBeam);
      this.channelBeam = null;
    }
    this.mapManager.dispose();
    this.playerController.dispose();
    this.renderer.dispose();
    this.input.dispose();
  }
}
