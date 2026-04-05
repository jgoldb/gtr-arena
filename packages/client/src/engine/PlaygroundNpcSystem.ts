/**
 * PlaygroundNpcSystem — manages NPC spawning, AI wiring, and NPC ability
 * execution for the Playground (single-player) engine.
 *
 * Extracted from Engine.ts to reduce its size.  The parent Engine drives
 * per-frame updates and owns the shared game-logic systems; this module
 * handles everything NPC-specific.
 */

import * as THREE from 'three';
import { getCharacterStats, getCharacterSfx, getSharedSfx, KABOOM_CONE_RANGE } from '@gtr/shared';
import type { Ability, GasCloudSystem, DotSystem, ChemicalPoolSystem, ChargeSystem } from '@gtr/shared';
import { yardsToUnits, Sweep, TweakerSprint, FartBombDebuff, ChemicalSpillSpeedBuff, ChemicalSpillDot, CrotchRotDot, ParanoidDebuff } from './combat/Ability';
import type { BuffDefinition, BuffSystem } from './combat/BuffSystem';
import type { CombatSystem } from './combat/CombatSystem';
import type { AutoAttackSystem } from './combat/AutoAttackSystem';
import type { CastingSystem } from './combat/CastingSystem';
import { NpcController } from './npc/NpcController';
import { NpcAiBrain, type AiEngineInterface } from './npc/ai/NpcAiBrain';
import { createCharacterBehavior } from './npc/ai/behaviors';
import { NeuralBehavior } from './npc/ai/behaviors/NeuralBehavior';
import { DIFFICULTY_PRESETS, type DifficultyLevel } from './npc/ai/DifficultyProfile';
import type { HazardInfo } from './npc/ai/WorldState';
import type { TargetingSystem } from './targeting/TargetingSystem';
import type { PlayerController } from './player/PlayerController';
import type { MapManager } from './map/MapManager';
import type { PlaygroundEffects } from './effects/PlaygroundEffects';
import type { Targetable, PendingAoeImpact } from './types';
import { soundEffects } from '../ui/SoundEffects';

// ── Host interface ──────────────────────────────────────────────────

/** The parent Engine implements this to provide shared state and actions. */
export interface PlaygroundNpcSystemHost {
  readonly scene: THREE.Scene;
  readonly playerController: PlayerController;
  readonly mapManager: MapManager;
  readonly buffSystem: BuffSystem;
  readonly combatSystem: CombatSystem;
  readonly castingSystem: CastingSystem;
  readonly autoAttackSystem: AutoAttackSystem;
  readonly chargeSystem: ChargeSystem<Targetable>;
  readonly gasCloudSystem: GasCloudSystem<Targetable>;
  readonly chemPoolSystem: ChemicalPoolSystem<Targetable>;
  readonly dotSystem: DotSystem<Targetable>;
  readonly effects: PlaygroundEffects;
  readonly targetingSystem: TargetingSystem;

  isGodMode(): boolean;
  isSpectatorMode(): boolean;
  isArenaPreparationActive(): boolean;
  sfxPan(sourcePos: THREE.Vector3): number;
  handleEntityDeath(victim: Targetable, killer: Targetable | null): void;
  addPendingAoeImpact(impact: PendingAoeImpact): void;
  spawnGasCloud(position: THREE.Vector3, radius: number, duration: number, debuff: BuffDefinition, totalDamage: number, tickInterval: number, owner: Targetable): void;
  spawnChemicalPool(position: THREE.Vector3, radius: number, duration: number, speedBuff: BuffDefinition, dot: BuffDefinition, initialDamageMin: number, initialDamageMax: number, dotTotalDamage: number, dotTickInterval: number, dotDuration: number, owner: Targetable, activationDelay?: number): void;
  spawnDot(target: Targetable, debuff: BuffDefinition, totalDuration: number, tickInterval: number, totalDamage: number, owner: Targetable): void;
}

// ── PlaygroundNpcSystem ─────────────────────────────────────────────

// Delay from ability activation to projectile impact (animation wind-up + flight time)
const BOTTLE_CHUCK_IMPACT_DELAY = 0.825; // ~0.275s launch + 0.55s flight

export class PlaygroundNpcSystem {
  private readonly host: PlaygroundNpcSystemHost;
  private readonly npcs: NpcController[] = [];
  private aiEngineInterface: AiEngineInterface | null = null;

  constructor(host: PlaygroundNpcSystemHost) {
    this.host = host;
  }

  // ── NPC Management ──────────────────────────────────────────────

  getNpcs(): readonly NpcController[] {
    return this.npcs;
  }

  /** Mutable access for the game loop (despawn checks, iteration). */
  getNpcsMut(): NpcController[] {
    return this.npcs;
  }

  spawnNpc(characterId: import('@gtr/shared').CharacterId, position: THREE.Vector3, team?: number, name?: string): NpcController {
    const { host } = this;
    const npc = new NpcController(characterId, position, team, name);
    npc.resolveGround = (x, z, y) => host.mapManager.collision.resolve(x, z, y, 0.5).groundY;
    // Wire up dumpster-dive sfx for NPC crackheads
    if ('onDumpsterEmerge' in npc.model) {
      (npc.model as any).onDumpsterEmerge = (phase: 1 | 2) => {
        const sfx = getCharacterSfx(npc.characterId);
        const entry = phase === 1 ? sfx?.dumpsterDive1 : sfx?.dumpsterDive2;
        if (entry) soundEffects.play(entry.url, host.playerController.mesh.position.distanceTo(npc.mesh.position), host.sfxPan(npc.mesh.position), entry.volume);
      };
    }
    this.npcs.push(npc);
    host.scene.add(npc.mesh);
    return npc;
  }

  removeNpc(npc: NpcController): void {
    const { host } = this;
    const idx = this.npcs.indexOf(npc);
    if (idx !== -1) {
      if (host.targetingSystem.currentTarget === npc) {
        host.targetingSystem.currentTarget = null;
      }
      host.autoAttackSystem.removeEntity(npc);
      host.chargeSystem.removeEntity(npc);
      // Remove from any active gas clouds
      for (const cloud of host.gasCloudSystem.clouds) {
        cloud.affectedTargets.delete(npc);
      }
      // Remove from active dots
      host.dotSystem.removeByTarget(npc);
      host.buffSystem.clearEntity(npc);
      host.effects.cleanupNpc(npc);
      this.npcs.splice(idx, 1);
      host.scene.remove(npc.mesh);
      npc.dispose();
    }
  }

  clearNpcs(): void {
    const { host } = this;
    host.autoAttackSystem.stop(host.playerController);
    for (const npc of this.npcs) {
      if (host.targetingSystem.currentTarget === npc) {
        host.targetingSystem.currentTarget = null;
      }
      host.buffSystem.clearEntity(npc);
      host.effects.cleanupNpc(npc);
      host.scene.remove(npc.mesh);
      npc.dispose();
    }
    this.npcs.length = 0;
  }

  // ── AI NPC Spawning ─────────────────────────────────────────────

  spawnAiNpc(
    characterId: import('@gtr/shared').CharacterId,
    position: THREE.Vector3,
    team: number,
    name: string,
    difficulty: DifficultyLevel = 'medium'
  ): NpcController {
    const { host } = this;
    const npc = this.spawnNpc(characterId, position, team, name);
    const aiEngine = this.getAiEngineInterface();
    const profile = DIFFICULTY_PRESETS[difficulty];

    let behavior;
    if (difficulty === 'neural') {
      const neuralBehavior = new NeuralBehavior(characterId, npc, aiEngine);
      neuralBehavior.loadModel('models/agent.onnx').catch(err => {
        console.warn('Failed to load neural model, falling back to rule-based AI:', err);
      });
      behavior = neuralBehavior;
    } else {
      behavior = createCharacterBehavior(characterId);
    }

    npc.aiBrain = new NpcAiBrain(npc, aiEngine, behavior, profile);

    // Fall damage for AI NPCs (same formula as player)
    npc.aiBrain.movement.onFallDamage = (fallDistance: number) => {
      if (npc.dead) return;
      const SAFE_FALL = 8;   // ~13 yards — no damage below this
      const FATAL_FALL = 40; // ~67 yards — 100% HP damage
      if (fallDistance <= SAFE_FALL) return;
      const pct = Math.min(1, (fallDistance - SAFE_FALL) / (FATAL_FALL - SAFE_FALL));
      const damage = Math.round(npc.maxHp * pct);
      if (damage <= 0) return;
      npc.hp = Math.max(0, npc.hp - damage);
      host.combatSystem.onCombatText?.(npc, damage, 'damage');
      if (npc.hp <= 0 && !npc.dead) {
        npc.die();
        host.handleEntityDeath(npc, null);
      }
    };

    return npc;
  }

  private getAiEngineInterface(): AiEngineInterface {
    if (!this.aiEngineInterface) {
      const { host } = this;
      this.aiEngineInterface = {
        buffSystem: host.buffSystem,
        combatSystem: host.combatSystem,
        getCollisionSystem: () => host.mapManager.collision,
        getArenaBounds: () => host.isArenaPreparationActive()
          ? host.mapManager.getNpcSpawnBounds()
          : host.mapManager.getBounds(),
        getNpcSpawnBounds: () => host.mapManager.getNpcSpawnBounds(),
        getAllTargetables: () => host.isSpectatorMode()
          ? [...this.npcs]
          : [host.playerController as Targetable, ...this.npcs],
        getHazards: () => {
          const hazards: HazardInfo[] = [];
          for (const cloud of host.gasCloudSystem.clouds) {
            hazards.push({ center: new THREE.Vector3(cloud.centerX, cloud.centerY, cloud.centerZ), radius: cloud.radius, owner: cloud.owner });
          }
          for (const pool of host.chemPoolSystem.pools) {
            if (!pool.consumed) {
              hazards.push({ center: new THREE.Vector3(pool.centerX, pool.centerY, pool.centerZ), radius: pool.radius, owner: pool.owner });
            }
          }
          return hazards;
        },
        npcUseAbility: (npc, abilityId, target, groundPos) => {
          return this.npcUseAbility(npc, abilityId, target, groundPos);
        },
        npcApplyChannelTick: (npc, target, tickDamage, healAmount, damageMultiplier) => {
          if (target.isHostileTo(npc) && tickDamage > 0) {
            host.combatSystem.applyChannelTickDamage(npc, target, tickDamage, damageMultiplier);
          }
          if (!target.isHostileTo(npc) && healAmount > 0) {
            host.combatSystem.applyHeal(target, healAmount);
          }
        },
        isNpcCharging: (npc) => host.chargeSystem.isCharging(npc),
        isArenaPreparationActive: () => host.isArenaPreparationActive(),
        getPillarState: () => {
          const script = host.mapManager.getScript();
          return script?.getPillarState?.() ?? { ewPillarUp: 0, nsPillarUp: 0, pillarPhasePct: 0 };
        },
      };
    }
    return this.aiEngineInterface;
  }

  // ── NPC Ability Execution ───────────────────────────────────────

  /**
   * Execute an ability for an AI NPC. Handles validation, damage, and post-success effects.
   * Returns true if the ability was successfully used.
   */
  npcUseAbility(npc: NpcController, abilityId: string, target: Targetable | null, groundPos?: THREE.Vector3): boolean {
    const { host } = this;
    const stats = getCharacterStats(npc.characterId);
    const ability = stats.abilities.find(a => a?.id === abilityId);
    if (!ability) return false;

    // Skip auto-attack toggle
    if (ability.isAutoAttack) return false;

    // Check NPC's own cooldown tracker (if AI-controlled)
    if (npc.aiBrain && !npc.aiBrain.cooldowns.isReady(abilityId)) return false;

    // Ground-targeted abilities (Bottle Chuck)
    if (ability.groundTargeted && groundPos) {
      return this.npcUseGroundTargetAbility(npc, ability, groundPos);
    }

    // Use the combat system for validation and damage — skip global cooldown tracking
    const result = host.combatSystem.useAbility(ability, npc, npc.mesh.rotation.y, target, /* skipGlobalCooldown */ true);
    if (!result.success) return false;

    // Trigger animation
    const targetPos = target?.mesh.position.clone();
    npc.model.triggerAbilityAnimation(ability.id, targetPos);

    // Play ability sound effect with spatial audio
    {
      const sfxDist = host.playerController.mesh.position.distanceTo(npc.mesh.position);
      const sfxPan = host.sfxPan(npc.mesh.position);
      // Character-specific sounds
      const npcSfx = getCharacterSfx(npc.characterId);
      if (npcSfx) {
        const sfxMap: Record<string, { url: string; volume: number } | undefined> = {
          'crash-out': npcSfx.crashOut,
          'bucket-splash': npcSfx.bucketSplash,
          'fart-bomb': npcSfx.fartBomb,
          'janitors-helper': npcSfx.janitorsHelper,
          'pocket-sand': npcSfx.pocketSand,
          'sweep': npcSfx.sweepStart,
          'discombobulate': npcSfx.discombobulate,
          'kaboom': npcSfx.kaboom,
          'chemical-spill': npcSfx.chemicalSpill,
          'retard-strength': npcSfx.retardStrength,
          'full-retard': npcSfx.fullRetard,
          'crotch-rot': npcSfx.crotchRot,
          'sticky-fingers': npcSfx.stickyFingers,
          'tweaker-sprint': npcSfx.tweakerSprint,
          'crack-rock': npcSfx.crackRock,
          'od': npcSfx.od,
          'dumpster-dive': npcSfx.dumpsterDive1,
        };
        const entry = sfxMap[ability.id];
        if (entry) soundEffects.play(entry.url, sfxDist, sfxPan, entry.volume);
      }
      // Shared sounds
      if (ability.id === 'pvp-trinket') {
        const trinketSfx = getSharedSfx().pvpTrinket;
        if (trinketSfx) soundEffects.play(trinketSfx.url, sfxDist, sfxPan, trinketSfx.volume);
      }
    }

    // Set cooldown on the NPC's own tracker
    if (npc.aiBrain) {
      npc.aiBrain.cooldowns.setCooldown(ability.id, ability.cooldown);
      npc.aiBrain.cooldowns.triggerGcd();
    }

    // ── Post-success side effects ──

    if (ability.id === 'pvp-trinket') {
      host.buffSystem.removeAllCCEffects(npc);
    }

    if (ability.id === 'fart-bomb') {
      host.spawnGasCloud(npc.mesh.position.clone(), yardsToUnits(5), 8, FartBombDebuff, 592, 2, npc);
    }

    if (ability.id === 'chemical-spill') {
      host.spawnChemicalPool(npc.mesh.position.clone(), yardsToUnits(3), 30, ChemicalSpillSpeedBuff, ChemicalSpillDot, 297, 349, 600, 2, 6, npc, 2);
    }

    if (ability.id === 'crotch-rot' && target && !target.dead) {
      host.spawnDot(target, CrotchRotDot, 12, 3, 720, npc);
    }

    if (ability.id === 'sweep') {
      this.startNpcSweepCharge(npc);
    }

    if (ability.id === 'tweaker-sprint' && target) {
      this.startNpcTweakerSprintCharge(npc, target);
    }

    if (ability.id === 'kaboom') {
      this.npcExecuteKaboom(npc);
    }

    // Crackhead tweaking stacks
    if (['shank', 'pocket-sand', 'sticky-fingers', 'dumpster-dive', 'tweaker-sprint', 'gank'].includes(ability.id)) {
      host.buffSystem.addStacks(npc, 'tweaking', 15);
      if (host.buffSystem.getStacks(npc, 'tweaking') >= 100 && !host.buffSystem.hasDebuff(npc, 'paranoid')) {
        host.buffSystem.apply(npc, ParanoidDebuff);
      }
    }

    if (ability.id === 'crack-rock') {
      host.combatSystem.applyHeal(npc, 400);
      host.buffSystem.addStacks(npc, 'tweaking', 25);
      if (host.buffSystem.getStacks(npc, 'tweaking') >= 100 && !host.buffSystem.hasDebuff(npc, 'paranoid')) {
        host.buffSystem.apply(npc, ParanoidDebuff);
      }
    }

    if (ability.id === 'gank' && target) {
      if (target.dead || target.hp / target.maxHp < 0.30) {
        npc.aiBrain?.cooldowns.clearCooldown('gank');
      }
    }

    if (ability.id === 'sticky-fingers' && target) {
      const stealable = host.buffSystem.getBuffs(target).filter(b => !b.definition.unremovable);
      if (stealable.length > 0) {
        const stolen = stealable[Math.floor(Math.random() * stealable.length)];
        const remainingTime = stolen.remaining;
        host.buffSystem.remove(target, stolen.definition.id);
        host.buffSystem.apply(npc, stolen.definition);
        host.buffSystem.setRemaining(npc, stolen.definition.id, remainingTime);
      } else {
        const drain = Math.min(150, target.mana);
        target.mana -= drain;
        npc.mana = Math.min(npc.mana + 150, npc.maxMana);
      }
    }

    // Melee abilities should engage auto-attack
    if (ability.isMelee && target && target.isHostileTo(npc) && !target.dead) {
      npc.autoAttackTarget = target;
    }

    return true;
  }

  private npcUseGroundTargetAbility(npc: NpcController, ability: Ability, groundPos: THREE.Vector3): boolean {
    const { host } = this;
    if (npc.dead) return false;
    if (host.buffSystem.isStunned(npc)) return false;

    // Range check to ground position
    const dx = groundPos.x - npc.mesh.position.x;
    const dz = groundPos.z - npc.mesh.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (ability.range && dist > ability.range + yardsToUnits(2)) return false;

    // Mana check
    const effectiveCost = Math.round(ability.manaCost * host.buffSystem.getManaCostMultiplier(npc));
    if (npc.mana < effectiveCost) return false;

    // Cooldown check
    if (npc.aiBrain && !npc.aiBrain.cooldowns.isReady(ability.id)) return false;

    // Deduct mana
    npc.mana -= effectiveCost;

    // Set cooldown
    if (npc.aiBrain) {
      npc.aiBrain.cooldowns.setCooldown(ability.id, ability.cooldown);
      npc.aiBrain.cooldowns.triggerGcd();
    }

    // Animation
    npc.model.triggerAbilityAnimation(ability.id, groundPos);

    // Schedule AoE impact with delay
    host.addPendingAoeImpact({
      ability,
      groundPos: groundPos.clone(),
      delay: BOTTLE_CHUCK_IMPACT_DELAY,
      elapsed: 0,
      owner: npc,
    });

    return true;
  }

  private npcExecuteKaboom(npc: NpcController): void {
    const rotY = npc.mesh.rotation.y;
    this.host.effects.spawnKaboomGust(npc.mesh.position, rotY, KABOOM_CONE_RANGE);
    this.host.chargeSystem.executeKaboom(npc, rotY);
  }

  // ── NPC Charges ─────────────────────────────────────────────────

  startNpcSweepCharge(npc: NpcController): void {
    const rotY = npc.mesh.rotation.y;
    this.host.chargeSystem.startSweepCharge(
      npc,
      Math.sin(rotY), Math.cos(rotY),
      Sweep.chargeSpeed!, Sweep.chargeDuration!, Sweep.chargeMaxDamage!,
      null,
    );
  }

  startNpcTweakerSprintCharge(npc: NpcController, target: Targetable): void {
    const dx = target.mesh.position.x - npc.mesh.position.x;
    const dz = target.mesh.position.z - npc.mesh.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.01) return;

    const dirX = dx / dist;
    const dirZ = dz / dist;
    npc.mesh.rotation.y = Math.atan2(dirX, dirZ);

    const speed = TweakerSprint.chargeSpeed!;
    const chargeDist = Math.max(0, dist - yardsToUnits(1));
    const duration = chargeDist / speed;

    this.host.chargeSystem.startTweakerSprintCharge(
      npc, dirX, dirZ, speed, duration,
      TweakerSprint.chargeMaxDamage!, null,
    );
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  dispose(): void {
    this.clearNpcs();
  }
}
