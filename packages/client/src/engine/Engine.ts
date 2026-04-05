import * as THREE from 'three';
import { Renderer } from './renderer/Renderer';
import { InputManager } from './input/InputManager';
import { MapManager } from './map/MapManager';
import { PlayerController } from './player/PlayerController';
import { GLOBAL_COOLDOWN, yardsToUnits, ArenaPreparationBuff, RestingBuff, Sweep, RottenCrotchStun, KaboomStun, TweakerSprint, TweakerSprintSlow, ODStunDebuff, ParanoidDebuff, type Ability } from './combat/Ability';
import type { BuffDefinition } from './combat/BuffSystem';
import { CastingSystem } from './combat/CastingSystem';
import { AutoAttackSystem } from './combat/AutoAttackSystem';
import { CharacterId } from './player/characters';
import { getCharacterStats, getCharacterSfx, isRangedAutoAttack, GasCloudSystem, DotSystem, ChemicalPoolSystem, FullRetardAuraSystem, ChargeSystem, KABOOM_CONE_RANGE } from '@gtr/shared';
import { ThirdPersonCamera } from './camera/ThirdPersonCamera';
import { NpcController } from './npc/NpcController';
import { TargetingSystem } from './targeting/TargetingSystem';
import { CombatSystem } from './combat/CombatSystem';
import { RegenSystem } from './combat/RegenSystem';
import { BuffSystem } from './combat/BuffSystem';
import type { Targetable, PendingAoeImpact } from './types';
import { PlaygroundEffects } from './effects/PlaygroundEffects';
import { PlaygroundNpcSystem, type PlaygroundNpcSystemHost } from './PlaygroundNpcSystem';
import { PlaygroundLoop, type PlaygroundLoopHost } from './PlaygroundLoop';
import { BlindEffect } from './effects/BlindEffect';
import { soundEffects } from '../ui/SoundEffects';
import type { DifficultyLevel } from './npc/ai/DifficultyProfile';

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
  readonly npcSystem: PlaygroundNpcSystem;
  gasCloudSystem!: GasCloudSystem<Targetable>;
  dotSystem!: DotSystem<Targetable>;
  chemPoolSystem!: ChemicalPoolSystem<Targetable>;
  private readonly pendingAoeImpacts: PendingAoeImpact[] = [];
  chargeSystem!: ChargeSystem<Targetable>;
  fullRetardAuraSystem!: FullRetardAuraSystem<Targetable>;
  readonly blindEffect = new BlindEffect();
  readonly effects: PlaygroundEffects;
  autoAttackSystem!: AutoAttackSystem;
  private aaSfxToggle = new Map<Targetable, boolean>(); // per-entity toggle for alternating auto-attack SFX
  private dumpsterDiveAutoTarget: Targetable | null = null;
  private static readonly KABOOM_KNOCKBACK_HEIGHT = 3.0; // world units peak height (client-only visual)

  readonly castingSystem: CastingSystem;
  private readonly gameLoop: PlaygroundLoop;
  onCastComplete?: (ability: Ability, target: Targetable | null) => void;
  onCastFailed?: (message: string) => void;
  onGroundTargetConfirmed?: () => void;
  pendingNpcSpawn: { characterId: CharacterId; team?: number } | null = null;

  arenaPreparationActive = false;
  resting = false;
  isAdmin = false;
  godMode = false;
  /** Spectator mode: player is invisible ghost, camera follows NPCs. */
  spectatorMode = false;
  private spectatorTarget: NpcController | null = null;
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
      (a: number) => this.thirdPersonCamera.setAzimuth(a),
      () => this.thirdPersonCamera.getElevation()
    );

    this.targetingSystem = new TargetingSystem(
      this.camera, this.scene, canvas, () => this.playerController
    );
    this.targetingSystem.isUntargetable = (target) => this.buffSystem.isUntargetable(target);
    this.regenSystem = new RegenSystem(() => [this.playerController, ...this.npcSystem.getNpcs()]);
    this.buffSystem = new BuffSystem();
    this.regenSystem.setBuffSystem(this.buffSystem);
    this.combatSystem = new CombatSystem(this.regenSystem, this.buffSystem, this.mapManager.collision);

    this.castingSystem = new CastingSystem({
      isGodMode: () => this.godMode,
      shouldCancel: (entity) =>
        entity.dead
        || this.buffSystem.isStunned(entity) || this.buffSystem.isSleeping(entity)
        || this.playerController.isMoving || !this.playerController.grounded,
      getPosition: (entity) => ({ x: entity.mesh.position.x, z: entity.mesh.position.z }),
      getManaCostMultiplier: (entity) => this.buffSystem.getManaCostMultiplier(entity),
      getDamageDealtMultiplier: (entity) => this.buffSystem.getDamageDealtMultiplier(entity),
      applyBuff: (target, def) => this.buffSystem.apply(target, def),
      removeBuff: (target, id, silent) => this.buffSystem.remove(target, id, silent),
      setBuffRemaining: (target, id, remaining) => this.buffSystem.setRemaining(target, id, remaining),
      consumeMana: (entity, amount) => { entity.mana -= amount; },
      notifyManaUsed: (entity) => this.regenSystem.notifyManaUsed(entity),
      triggerGcd: () => { if (!this.godMode) this.combatSystem.triggerGcd(GLOBAL_COOLDOWN); },
      setCooldown: (_entity, abilityId, duration) => { if (!this.godMode) this.combatSystem.setCooldown(abilityId, duration); },
      clearCooldown: (_entity, abilityId) => this.combatSystem.clearCooldown(abilityId),
      rollMiss: () => this.combatSystem.rollMiss(),
      enterCombat: (entity) => this.combatSystem.enterCombat(entity),
      applyHeal: (_healer, target, amount) => this.combatSystem.applyHeal(target, amount),
      applyChannelTickDamage: (attacker, target, damage, multiplier) =>
        this.combatSystem.applyChannelTickDamage(attacker, target, damage, multiplier),
      useAbility: (_entity, ability, target) =>
        this.combatSystem.useAbility(ability, this.playerController, this.playerController.mesh.rotation.y, target),
      onHostileAction: (_attacker, target) => {
        this.combatSystem.onHostileAction?.(this.playerController, target);
      },
      onChannelMiss: (_attacker, target) => {
        this.combatSystem.onCombatText?.(target, 0, 'miss');
      },
      onCastCompleted: (_entity, ability, target, result) => {
        if (result.success) {
          this.onCastComplete?.(ability, target);
        } else if (result.errorMessage) {
          this.onCastFailed?.(result.errorMessage);
        }
      },
      onCastEnded: () => {
        this.effects.stopBandageLoop();
        this.effects.stopCastSpellLoop();
      },
    });

    this.autoAttackSystem = new AutoAttackSystem({
      getPosition: (e) => ({ x: e.mesh.position.x, y: e.mesh.position.y, z: e.mesh.position.z }),
      getRotationY: (e) => e.mesh.rotation.y,
      isMoving: (e) => e === this.playerController ? this.playerController.isMoving : (e as NpcController).isMoving,
      isCasting: (e) => this.castingSystem.isCasting(e),
      isUntargetable: (e) => this.buffSystem.isUntargetable(e),
      isRanged: (e) => isRangedAutoAttack(getCharacterStats(e.characterId)),
      getAutoAttackSpeed: (e) => e === this.playerController
        ? this.playerController.autoAttackSpeed
        : (e as NpcController).model.autoAttackSpeed,
      getAttackSpeedMultiplier: (e) => this.buffSystem.getAutoAttackSpeedMultiplier(e)
        * (e === this.playerController && this.godMode ? 6 : 1),
      rollDamage: (e) => e === this.playerController
        ? this.playerController.rollAutoAttackDamage()
        : (e as NpcController).model.rollAutoAttackDamage(),
      hasLineOfSight: (a, t) => this.combatSystem.hasLineOfSight(a.mesh.position, t.mesh.position),
      applyMeleeDamage: (a, t, dmg) => this.combatSystem.applyAutoAttackDamage(a, t, dmg),
      applyProjectileDamage: (a, t, dmg) => this.combatSystem.applyAutoAttackDamage(a, t, dmg, false),
      onSwing: (attacker, target, isRanged, isCrit) => {
        if (attacker === this.playerController) {
          if (isRanged) this.playerController.model.swingTargetWorldPos = target.mesh.position.clone();
          this.playerController.triggerSwing(isCrit);
        } else {
          const npc = attacker as NpcController;
          if (isRanged) npc.model.swingTargetWorldPos = target.mesh.position.clone();
          npc.model.triggerSwing(isCrit);
        }
      },
      onAutoAttackError: (entity, msg) => {
        if (entity === this.playerController) this.onAutoAttackError?.(msg);
      },
      onStopped: (entity) => {
        if (entity === this.playerController) {
          this.playerController.setAutoAttacking(false);
        } else {
          (entity as NpcController).model.setAutoAttacking(false);
        }
      },
    });

    // Direct damage pushback for casting/channeling (DoT damage bypasses CombatSystem, so no pushback)
    // Also cancels resting on the first hit taken
    this.combatSystem.onDirectDamageDealt = (target) => {
      if (this.buffSystem.isSleeping(target)) {
        this.buffSystem.removeSleepEffects(target);
      }
      if (target === this.playerController && this.resting) {
        this.stopResting();
      }
      if (target === this.playerController) {
        this.castingSystem.applyPushback(this.playerController);
      }
      // NPC spell pushback
      for (const npc of this.npcSystem.getNpcs()) {
        if (npc === target && npc.aiBrain) {
          npc.aiBrain.applyPushback();
          break;
        }
      }
    };

    this.combatSystem.onSleepApplied = (_attacker, target) => {
      if (target === this.autoAttackSystem.getTarget(this.playerController)) {
        this.stopAutoAttack();
      }
    };

    this.combatSystem.onBlindApplied = (_attacker, target) => {
      // Blinded player loses target and stops auto-attacking
      if (target === this.playerController) {
        this.targetingSystem.currentTarget = null;
        if (this.autoAttackSystem.isAttacking(this.playerController)) this.stopAutoAttack();
      }
    };

    // Flinch animation on direct damage (not DoT/channel ticks)
    this.combatSystem.onFlinchDamage = (target) => {
      if (target === this.playerController) {
        this.playerController.triggerFlinch();
      } else {
        for (const npc of this.npcSystem.getNpcs()) {
          if (npc === target) { npc.triggerFlinch(); break; }
        }
      }
      const struckSfx = getCharacterSfx(target.characterId)?.struck;
      if (struckSfx) soundEffects.play(struckSfx.url, this.playerController.mesh.position.distanceTo(target.mesh.position), this.sfxPan(target.mesh.position), struckSfx.volume, target.mesh.uuid);
    };

    // Dodge animation
    this.combatSystem.onDodge = (target) => {
      if (target === this.playerController) {
        this.playerController.triggerDodge();
      } else {
        for (const npc of this.npcSystem.getNpcs()) {
          if (npc === target) { npc.triggerDodge(); break; }
        }
      }
      const dodgeSfx = getCharacterSfx(target.characterId)?.dodge;
      if (dodgeSfx) soundEffects.play(dodgeSfx.url, this.playerController.mesh.position.distanceTo(target.mesh.position), this.sfxPan(target.mesh.position), dodgeSfx.volume, target.mesh.uuid);
    };

    this.combatSystem.onAutoAttackDamageDealt = (attacker, isCrit) => {
      const sfx = getCharacterSfx(attacker.characterId);
      let aaSfx = (isCrit && sfx?.autoAttackCrit) || sfx?.autoAttackHit;
      // Alternate between two auto-attack sounds when available (e.g. Dr. Retardo's flask/test tube)
      if (!isCrit && sfx?.autoAttackHit2) {
        const toggle = this.aaSfxToggle.get(attacker) ?? false;
        aaSfx = toggle ? sfx.autoAttackHit2 : sfx.autoAttackHit;
        this.aaSfxToggle.set(attacker, !toggle);
      }
      if (aaSfx) soundEffects.play(aaSfx.url, this.playerController.mesh.position.distanceTo(attacker.mesh.position), this.sfxPan(attacker.mesh.position), aaSfx.volume, attacker.mesh.uuid);
    };

    this.combatSystem.onAbilityDamageDealt = (attacker, abilityId) => {
      if (abilityId === 'mop') {
        const mopSfx = getCharacterSfx(attacker.characterId)?.mop;
        if (mopSfx) soundEffects.play(mopSfx.url, this.playerController.mesh.position.distanceTo(attacker.mesh.position), this.sfxPan(attacker.mesh.position), mopSfx.volume, attacker.mesh.uuid);
      }
      if (abilityId === 'big-boot') {
        const bigBootSfx = getCharacterSfx(attacker.characterId)?.bigBoot;
        if (bigBootSfx) soundEffects.play(bigBootSfx.url, this.playerController.mesh.position.distanceTo(attacker.mesh.position), this.sfxPan(attacker.mesh.position), bigBootSfx.volume, attacker.mesh.uuid);
      }
      if (abilityId === 'jimmy-legs') {
        const jimmyLegsSfx = getCharacterSfx(attacker.characterId)?.jimmyLegs;
        if (jimmyLegsSfx) soundEffects.play(jimmyLegsSfx.url, this.playerController.mesh.position.distanceTo(attacker.mesh.position), this.sfxPan(attacker.mesh.position), jimmyLegsSfx.volume, attacker.mesh.uuid);
      }
      if (abilityId === 'shank') {
        const shankSfx = getCharacterSfx(attacker.characterId)?.shank;
        if (shankSfx) soundEffects.play(shankSfx.url, this.playerController.mesh.position.distanceTo(attacker.mesh.position), this.sfxPan(attacker.mesh.position), shankSfx.volume, attacker.mesh.uuid);
      }
      if (abilityId === 'gank') {
        const gankSfx = getCharacterSfx(attacker.characterId)?.gank;
        if (gankSfx) soundEffects.play(gankSfx.url, this.playerController.mesh.position.distanceTo(attacker.mesh.position), this.sfxPan(attacker.mesh.position), gankSfx.volume, attacker.mesh.uuid);
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

    // Notify map script when an entity dies (cheering, jumbotron, banners)
    this.combatSystem.onDeath = (victim, killer) => this.handleEntityDeath(victim, killer);

    this.gasCloudSystem = new GasCloudSystem<Targetable>(this.buffSystem, {
      getPosition: (e) => {
        const p = e.mesh.position;
        return { x: p.x, y: p.y, z: p.z };
      },
      getHostileEntities: (owner) => {
        if (owner === this.playerController) {
          return this.npcSystem.getNpcs().filter(n => n.isHostileTo(this.playerController));
        }
        return [this.playerController];
      },
      isGodModeImmune: (e) => this.godMode && e === this.playerController,
      processDamageAbsorb: (target, amount, source) => this.combatSystem.processDamageAbsorb(target, amount, source),
      enterCombat: (e) => this.combatSystem.enterCombat(e),
      onDamageDealt: (source, target, amount) => {
        this.combatSystem.onHostileAction?.(source, target);
        if (amount > 0) this.combatSystem.onCombatText?.(target, amount, 'damage');
      },
      onEntityDied: (target, killer) => {
        this.handleEntityDeath(target, killer);
      },
      onCloudExpired: (cloud) => {
        this.effects.onGasCloudExpired(cloud);
      },
    });

    const clientDamageCallbacks = {
      isGodModeImmune: (e: Targetable) => this.godMode && e === this.playerController,
      processDamageAbsorb: (target: Targetable, amount: number, source: Targetable) => this.combatSystem.processDamageAbsorb(target, amount, source),
      enterCombat: (e: Targetable) => this.combatSystem.enterCombat(e),
      onDamageDealt: (source: Targetable, target: Targetable, amount: number) => {
        this.combatSystem.onHostileAction?.(source, target);
        if (amount > 0) this.combatSystem.onCombatText?.(target, amount, 'damage');
      },
      onEntityDied: (target: Targetable, killer: Targetable) => {
        this.handleEntityDeath(target, killer);
      },
    };

    this.dotSystem = new DotSystem<Targetable>(clientDamageCallbacks);

    this.chemPoolSystem = new ChemicalPoolSystem<Targetable>(this.buffSystem, this.dotSystem, {
      getPosition: (e) => {
        const p = e.mesh.position;
        return { x: p.x, y: p.y, z: p.z };
      },
      getAllEntities: () => [this.playerController as Targetable, ...this.npcSystem.getNpcs()],
      ...clientDamageCallbacks,
      onPoolConsumed: (pool) => {
        this.effects.onChemPoolConsumed(pool);
      },
      onPoolExpired: (pool) => {
        this.effects.onChemPoolExpired(pool);
      },
    });

    this.fullRetardAuraSystem = new FullRetardAuraSystem<Targetable>(this.buffSystem, {
      getPosition: (e) => {
        const p = e.mesh.position;
        return { x: p.x, y: p.y, z: p.z };
      },
      getAllEntities: () => [this.playerController as Targetable, ...this.npcSystem.getNpcs()],
      ...clientDamageCallbacks,
      applyHeal: (_source, target, amount) => this.combatSystem.applyHeal(target, amount),
      onAuraStarted: (entity) => {
        this.effects.onFullRetardAuraStarted(entity);
      },
      onAuraStopped: (entity) => {
        this.effects.onFullRetardAuraStopped(entity);
      },
    });

    this.chargeSystem = new ChargeSystem<Targetable>({
      getPosition: (e) => ({ x: e.mesh.position.x, z: e.mesh.position.z }),
      moveEntity: (e, dx, dz) => {
        e.mesh.position.x += dx;
        e.mesh.position.z += dz;
        // Resolve collision for NPCs (player collision is handled by PlayerController)
        if (e !== this.playerController) {
          const resolved = this.mapManager.collision.resolve(
            e.mesh.position.x, e.mesh.position.z, e.mesh.position.y, 0.4
          );
          e.mesh.position.x = resolved.x;
          e.mesh.position.z = resolved.z;
          // Clamp to arena bounds
          const bounds = this.mapManager.getNpcSpawnBounds();
          const margin = 0.4;
          e.mesh.position.x = Math.max(bounds.minX + margin, Math.min(bounds.maxX - margin, e.mesh.position.x));
          e.mesh.position.z = Math.max(bounds.minZ + margin, Math.min(bounds.maxZ - margin, e.mesh.position.z));
        }
      },
      getHostileEntities: (e) => {
        const all: Targetable[] = [this.playerController, ...this.npcSystem.getNpcs()];
        return all.filter(o => o !== e && o.isHostileTo(e));
      },
      isUntargetable: (e) => this.buffSystem.isUntargetable(e),
      isDead: (e) => e.dead,
      getAutoAttackRange: (e) => e.autoAttackRange,
      applySweepDamage: (source, target, damage) => this.combatSystem.applySweepDamage(source, target, damage),
      applyTweakerSprintSlow: (target) => this.buffSystem.apply(target, TweakerSprintSlow),
      enterCombat: (e) => this.combatSystem.enterCombat(e),
      applyKnockbackStun: (target) => this.buffSystem.apply(target, KaboomStun),
      onSweepChargeEnd: (entity, savedTarget) => {
        if (entity === this.playerController) {
          this.playerController.triggerAbilityAnimation('sweep-finish');
          const sweepSpinSfx = getCharacterSfx(this.playerController.characterId)?.sweepSpin;
          if (sweepSpinSfx) soundEffects.play(sweepSpinSfx.url, undefined, undefined, sweepSpinSfx.volume);
          if (savedTarget && !savedTarget.dead && savedTarget.isHostileTo(this.playerController)) {
            this.startAutoAttack(savedTarget);
          }
          this.playerController.charging = false;
        } else {
          const npc = entity as NpcController;
          npc.model.triggerAbilityAnimation('sweep-finish');
          const sweepSpinSfx = getCharacterSfx(npc.characterId)?.sweepSpin;
          if (sweepSpinSfx) soundEffects.play(sweepSpinSfx.url, this.playerController.mesh.position.distanceTo(npc.mesh.position), this.sfxPan(npc.mesh.position), sweepSpinSfx.volume);
          if (npc.aiBrain?.currentTargetEntity && !npc.aiBrain.currentTargetEntity.dead) {
            npc.autoAttackTarget = npc.aiBrain.currentTargetEntity;
          }
        }
      },
      onTweakerSprintChargeEnd: (entity, savedTarget) => {
        if (entity === this.playerController) {
          if (savedTarget && !savedTarget.dead && savedTarget.isHostileTo(this.playerController)) {
            this.startAutoAttack(savedTarget);
          }
          this.playerController.charging = false;
          this.playerController.chargeAnimSpeed = 1;
        } else {
          const npc = entity as NpcController;
          if (npc.aiBrain?.currentTargetEntity && !npc.aiBrain.currentTargetEntity.dead) {
            npc.autoAttackTarget = npc.aiBrain.currentTargetEntity;
          }
        }
      },
      moveKnockbackTarget: (target, dirX, dirZ, speed, dt, t) => {
        if (target.mesh) {
          target.mesh.position.x += dirX * speed * dt;
          target.mesh.position.z += dirZ * speed * dt;
          // Parabolic arc for Y (knocked up into air) — client-only visual
          target.mesh.position.y = Engine.KABOOM_KNOCKBACK_HEIGHT * 4 * t * (1 - t);
        }
      },
      onKnockbackEnd: (target) => {
        if (target.mesh) {
          target.mesh.position.y = 0;
        }
      },
    });

    // Preload combat sound effects
    soundEffects.init();

    // Visual effects + looping SFX manager
    this.effects = new PlaygroundEffects({
      scene: this.scene,
      clock: this.clock,
      playerController: this.playerController,
      getNpcs: () => this.npcSystem.getNpcs(),
      castingSystem: this.castingSystem,
      buffSystem: this.buffSystem,
      fullRetardAuraSystem: this.fullRetardAuraSystem,
      sfxPan: (pos) => this.sfxPan(pos),
    });

    this.setupDumpsterDiveSfx();

    // NPC subsystem (spawning, AI wiring, NPC ability execution)
    this.npcSystem = new PlaygroundNpcSystem(this as PlaygroundNpcSystemHost);

    // Game loop (input processing, state sync, system ticks)
    this.gameLoop = new PlaygroundLoop(this as unknown as PlaygroundLoopHost);

    // Fall damage (WoW-style: no damage below threshold, then scales with distance)
    this.playerController.onFallDamage = (fallDistance: number) => {
      if (this.godMode || this.playerController.dead) return;
      const SAFE_FALL = 8;   // ~13 yards — no damage below this
      const FATAL_FALL = 40; // ~67 yards — 100% HP damage
      if (fallDistance <= SAFE_FALL) return;
      const pct = Math.min(1, (fallDistance - SAFE_FALL) / (FATAL_FALL - SAFE_FALL));
      const damage = Math.round(this.playerController.maxHp * pct);
      if (damage <= 0) return;
      this.playerController.hp = Math.max(0, this.playerController.hp - damage);
      this.combatSystem.onCombatText?.(this.playerController, damage, 'damage');
      if (this.playerController.hp <= 0 && !this.playerController.dead) {
        this.playerController.die();
        this.handleEntityDeath(this.playerController, null);
      }
    };

  }

  /** Notify the map script of a killing blow and check for game-over. */
  handleEntityDeath(victim: Targetable, killer: Targetable | null): void {
    const victimTeam = victim.team;
    const killerTeam = killer ? killer.team : (victimTeam === 0 ? 1 : 0);
    this.mapManager.onKillingBlow(killerTeam, victimTeam);

    // Check for game over: if all entities on the victim's team are dead
    const allEntities: Targetable[] = [this.playerController, ...this.npcSystem.getNpcs()];
    const teamAlive = allEntities.some(e => e.team === victimTeam && !e.dead);
    if (!teamAlive) {
      const winningTeam = killerTeam;
      this.mapManager.onGameOver(winningTeam);
    }
  }

  // ── PlaygroundNpcSystemHost methods ──────────────────────────────

  isGodMode(): boolean { return this.godMode; }
  isSpectatorMode(): boolean { return this.spectatorMode; }
  isArenaPreparationActive(): boolean { return this.arenaPreparationActive; }
  addPendingAoeImpact(impact: PendingAoeImpact): void { this.pendingAoeImpacts.push(impact); }

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
    this.gasCloudSystem.clear();
    this.effects.clearGasCloudVisuals();
    this.chemPoolSystem.clear();
    this.dotSystem.clear();
    this.effects.clearChemPoolVisuals();
    this.fullRetardAuraSystem.clear();
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
      // In single player, clicking "Open Gates" immediately opens the doors
      if ('onVoteOpenGates' in script) {
        (script as any).onVoteOpenGates = () => {
          script.forceOpenDoors?.();
        };
      }
    }
  }

  /** Stereo pan (-1 left, +1 right) for a world position relative to the player's facing. */
  sfxPan(sourcePos: THREE.Vector3): number {
    const pos = this.playerController.mesh.position;
    const rotY = this.playerController.mesh.rotation.y;
    const dx = sourcePos.x - pos.x;
    const dz = sourcePos.z - pos.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.001) return 0;
    return (Math.cos(rotY) * dx - Math.sin(rotY) * dz) / len;
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

  private setupDumpsterDiveSfx(): void {
    if ('onDumpsterEmerge' in this.playerController.model) {
      (this.playerController.model as any).onDumpsterEmerge = (phase: 1 | 2) => {
        const sfx = getCharacterSfx(this.playerController.characterId);
        const entry = phase === 1 ? sfx?.dumpsterDive1 : sfx?.dumpsterDive2;
        if (entry) soundEffects.play(entry.url, 0, 0, entry.volume);
      };
    }
  }

  setCharacter(id: CharacterId): void {
    this.stopResting();
    this.stopAutoAttack();
    this.cancelCasting();
    this.buffSystem.clearEntity(this.playerController);
    this.combatSystem.leaveCombat(this.playerController);
    this.combatSystem.clearCooldowns();
    this.playerController.setCharacter(id);
    this.setupDumpsterDiveSfx();
    this.playerController.dead = false;
    if (this.arenaPreparationActive) {
      this.buffSystem.apply(this.playerController, ArenaPreparationBuff);
    }
    this.applyStartingBuffs();
    this.onCharacterChange?.(this.playerController.abilities);
  }

  spawnNpc(characterId: CharacterId, position: THREE.Vector3, team?: number, name?: string): NpcController {
    return this.npcSystem.spawnNpc(characterId, position, team, name);
  }

  removeNpc(npc: NpcController): void {
    this.npcSystem.removeNpc(npc);
  }

  clearNpcs(): void {
    this.npcSystem.clearNpcs();
  }

  getNpcs(): readonly NpcController[] {
    return this.npcSystem.getNpcs();
  }

  spawnAiNpc(
    characterId: CharacterId,
    position: THREE.Vector3,
    team: number,
    name: string,
    difficulty: DifficultyLevel = 'medium'
  ): NpcController {
    return this.npcSystem.spawnAiNpc(characterId, position, team, name, difficulty);
  }

  npcUseAbility(npc: NpcController, abilityId: string, target: Targetable | null, groundPos?: THREE.Vector3): boolean {
    return this.npcSystem.npcUseAbility(npc, abilityId, target, groundPos);
  }

  // ── Spectator Mode ─────────────────────────────────

  /** Activate spectator mode: player becomes invisible ghost, camera follows NPCs. */
  enableSpectatorMode(): void {
    this.spectatorMode = true;
    this.godMode = true;
    // Hide the player model
    this.playerController.mesh.visible = false;
    // Move player out of the arena so it doesn't collide with anything
    this.playerController.mesh.position.set(0, -100, 0);
    // Override camera target to follow the spectated NPC
    this.thirdPersonCamera.targetGetter = () => {
      if (this.spectatorTarget && !this.spectatorTarget.dead) {
        return this.spectatorTarget.mesh.position;
      }
      // Fallback: find any living NPC
      const npcs = this.npcSystem.getNpcs();
      for (const npc of npcs) {
        if (!npc.dead) return npc.mesh.position;
      }
      return new THREE.Vector3(0, 0, 0);
    };
  }

  /** Set which NPC the spectator camera follows. */
  setSpectatorTarget(npc: NpcController): void {
    this.spectatorTarget = npc;
  }

  /** Cycle spectator camera to the next NPC. */
  cycleSpectatorTarget(): void {
    const npcs = this.npcSystem.getNpcs().filter(n => !n.dead);
    if (npcs.length === 0) return;
    const currentIdx = this.spectatorTarget ? npcs.indexOf(this.spectatorTarget) : -1;
    const nextIdx = (currentIdx + 1) % npcs.length;
    this.spectatorTarget = npcs[nextIdx];
  }

  // ── Casting ─────────────────────────────────────────

  startCasting(
    ability: Ability,
    attackerRotY: number,
    target: Targetable | null
  ): import('./combat/CombatSystem').CombatResult {
    if (this.castingSystem.isCasting(this.playerController)) {
      return { success: false, error: 'casting', errorMessage: 'Already casting' };
    }
    if (this.playerController.isMoving || !this.playerController.grounded) {
      return { success: false, error: 'moving', errorMessage: 'Cannot cast while moving' };
    }
    const validation = this.combatSystem.validateAbility(
      ability, this.playerController, attackerRotY, target
    );
    if (!validation.success) return validation;

    const result = this.castingSystem.start(this.playerController, ability, target);
    if (!result.started) {
      return { success: false, error: 'casting', errorMessage: result.errorMessage };
    }

    // SFX: Dr. Retardo cast-spell loop (any cast/channel except bandage)
    if (this.playerController.characterId === 'dr-retardo' && ability.id !== 'bandage') {
      this.effects.startCastSpellLoop();
    }

    // SFX: Bandage loop
    if ((ability.isChannel ?? false) && target && ability.id === 'bandage') {
      this.effects.startBandageLoop();
    }

    return { success: true };
  }

  cancelCasting(): void {
    this.castingSystem.cancel(this.playerController);
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

  updatePendingAoeImpacts(dt: number): void {
    for (let i = this.pendingAoeImpacts.length - 1; i >= 0; i--) {
      const impact = this.pendingAoeImpacts[i];
      impact.elapsed += dt;
      if (impact.elapsed < impact.delay) continue;

      // Impact! Damage all hostiles in radius
      const radius = impact.ability.aoeRadius ?? 0;
      const aoeTargets: Targetable[] = [this.playerController, ...this.npcSystem.getNpcs()];
      for (const target of aoeTargets) {
        if (target === impact.owner || target.dead || !target.isHostileTo(impact.owner) || this.buffSystem.isUntargetable(target)) continue;
        const dx = target.mesh.position.x - impact.groundPos.x;
        const dy = target.mesh.position.y - impact.groundPos.y;
        const dz = target.mesh.position.z - impact.groundPos.z;
        if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
        this.combatSystem.applyAoeDamage(impact.owner, target, impact.ability);
      }

      // Play impact sound effect
      if (impact.ability.id === 'bottle-chuck') {
        const bcSfx = getCharacterSfx(impact.owner.characterId)?.bottleChuck;
        if (bcSfx) soundEffects.play(bcSfx.url, this.playerController.mesh.position.distanceTo(impact.groundPos), this.sfxPan(impact.groundPos), bcSfx.volume);
      }

      this.pendingAoeImpacts.splice(i, 1);
    }
  }

  isCasting(): boolean {
    return this.castingSystem.isCasting(this.playerController);
  }

  isChanneling(): boolean {
    return this.castingSystem.isChanneling(this.playerController);
  }

  getCastingState(): {
    abilityName: string;
    elapsed: number;
    totalTime: number;
    isChannel: boolean;
    originalCastTime: number;
  } | null {
    const state = this.castingSystem.getState(this.playerController);
    if (!state) return null;
    return {
      abilityName: state.ability.name,
      elapsed: state.elapsed,
      totalTime: state.totalTime,
      isChannel: state.isChannel,
      originalCastTime: state.originalCastTime,
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
    if (this.castingSystem.isCasting(this.playerController)) return false;
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
    if (this.resting) this.stopResting();
    this.autoAttackSystem.start(this.playerController, target);
    this.playerController.setAutoAttacking(true);
  }

  stopAutoAttack(): void {
    this.autoAttackSystem.stop(this.playerController);
    // onStopped callback handles setAutoAttacking(false)
  }

  isAutoAttackActive(): boolean {
    return this.autoAttackSystem.isAttacking(this.playerController);
  }

  get autoAttackTarget(): Targetable | null {
    return this.autoAttackSystem.getTarget(this.playerController);
  }

  resetAutoAttackTimer(): void {
    this.autoAttackSystem.resetSwingTimer(this.playerController);
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
    const cloud = this.gasCloudSystem.spawn(owner, position.x, position.y, position.z, radius, duration, debuff, totalDamage, tickInterval);
    this.effects.createGasCloudVisual(cloud, position.x, position.z, radius, position.y);
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
    const pool = this.chemPoolSystem.spawn(
      owner, position.x, position.y, position.z,
      radius, duration, speedBuff, dot,
      initialDamageMin, initialDamageMax,
      dotTotalDamage, dotTickInterval, dotDuration,
      activationDelay,
    );
    this.effects.createChemPoolVisual(pool, position.x, position.z, radius, position.y);
  }

  updateActiveDots(dt: number): void {
    this.dotSystem.update(dt);
  }

  saveDumpsterDiveAutoTarget(): void {
    const target = this.autoAttackTarget;
    if (target) {
      this.dumpsterDiveAutoTarget = target;
    }
  }

  handleBuffExpired(target: Targetable, definition: BuffDefinition): void {
    if (definition.id === 'paranoid') {
      this.buffSystem.removeStacks(target, 'tweaking', 100);
    }
    if (definition.id === 'crotch-rot') {
      this.buffSystem.apply(target, RottenCrotchStun);
      const struckSfx = getCharacterSfx(target.characterId)?.struck;
      if (struckSfx) soundEffects.play(struckSfx.url, this.playerController.mesh.position.distanceTo(target.mesh.position), this.sfxPan(target.mesh.position), struckSfx.volume, target.mesh.uuid);
    }
    if (definition.id === 'overdosing') {
      this.buffSystem.apply(target, ODStunDebuff);
      this.effects.stopODLoop();
      const struckSfx = getCharacterSfx(target.characterId)?.struck;
      if (struckSfx) soundEffects.play(struckSfx.url, this.playerController.mesh.position.distanceTo(target.mesh.position), this.sfxPan(target.mesh.position), struckSfx.volume, target.mesh.uuid);
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
      for (const npc of this.npcSystem.getNpcs()) {
        if (npc.dead || !npc.isHostileTo(this.playerController)) continue;
        const dx = this.playerController.mesh.position.x - npc.mesh.position.x;
        const dz = this.playerController.mesh.position.z - npc.mesh.position.z;
        if (dx * dx + dz * dz <= radius * radius) {
          const dmg = this.godMode ? 0 : this.combatSystem.processDamageAbsorb(npc, 150, this.playerController);
          npc.hp = Math.max(0, npc.hp - dmg);
          if (dmg > 0) this.combatSystem.onCombatText?.(npc, dmg, 'damage');
          this.combatSystem.enterCombat(this.playerController);
          this.combatSystem.enterCombat(npc);
          if (npc.hp <= 0 && !npc.dead) { npc.die(); this.handleEntityDeath(npc, this.playerController); }
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
    this.dotSystem.add({
      target, debuff,
      totalDuration, elapsed: 0,
      tickInterval, nextTickAt: tickInterval,
      damagePerTick: Math.round(totalDamage / tickCount),
      owner,
    });
  }

  startSweepCharge(): void {
    const player = this.playerController;
    const rotY = player.mesh.rotation.y;
    const savedTarget = this.autoAttackTarget;
    this.stopAutoAttack();
    player.charging = true;
    this.chargeSystem.startSweepCharge(
      player,
      Math.sin(rotY), Math.cos(rotY),
      Sweep.chargeSpeed!, Sweep.chargeDuration!, Sweep.chargeMaxDamage!,
      savedTarget,
    );
  }

  startTweakerSprintCharge(target: Targetable): void {
    const player = this.playerController;
    const dx = target.mesh.position.x - player.mesh.position.x;
    const dz = target.mesh.position.z - player.mesh.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01) return;

    const dirX = dx / dist;
    const dirZ = dz / dist;
    player.mesh.rotation.y = Math.atan2(dirX, dirZ);

    const speed = TweakerSprint.chargeSpeed!;
    const chargeDist = Math.max(0, dist - yardsToUnits(1));
    const duration = chargeDist / speed;

    const savedTarget = this.autoAttackTarget;
    this.stopAutoAttack();
    player.charging = true;
    player.chargeAnimSpeed = 3;
    this.chargeSystem.startTweakerSprintCharge(
      player, dirX, dirZ, speed, duration,
      TweakerSprint.chargeMaxDamage!, savedTarget,
    );
  }

  // ── Kaboom cone AoE with knockback ──────────────────────────────────

  executeKaboom(): void {
    const player = this.playerController;
    const rotY = player.mesh.rotation.y;
    this.effects.spawnKaboomGust(player.mesh.position, rotY, KABOOM_CONE_RANGE);
    this.chargeSystem.executeKaboom(player, rotY);
  }

  private lastLoopTime = 0;

  private loop = (): void => {
    this.animationFrameId = requestAnimationFrame(this.loop);

    // Throttle to ~30 FPS when tab is visible but not focused
    const now = performance.now();
    const focused = document.hasFocus();
    if (!focused && now - this.lastLoopTime < 33) return;
    this.lastLoopTime = now;

    const deltaTime = Math.min(this.clock.getDelta(), focused ? 0.1 : 0.2);
    this.gameLoop.update(deltaTime);
  };

  dispose(): void {
    this.stop();
    this.blindEffect.deactivate();
    this.gasCloudSystem.clear();
    this.chemPoolSystem.clear();
    this.dotSystem.clear();
    this.fullRetardAuraSystem.clear();
    this.clearNpcs();
    this.effects.dispose();
    this.mapManager.dispose();
    this.playerController.dispose();
    this.renderer.dispose();
    this.input.dispose();
  }
}
