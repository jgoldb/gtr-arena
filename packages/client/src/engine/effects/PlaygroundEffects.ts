/**
 * PlaygroundEffects — manages all visual effects and sound loops for the
 * Playground (single-player) engine.  This is the Playground counterpart
 * of `ClientEffects` (which does the same job for multiplayer).
 *
 * Responsibilities:
 *   - Gas cloud / chem pool / full-retard aura visuals
 *   - Crotch-rot cloud, discombobulate bubbles
 *   - Channel beam, NPC channel beams, bandage heal sparkles
 *   - Kaboom gust particles
 *   - Looping SFX (OD, full-retard, bandage, cast-spell, NPC casts)
 *
 * The parent `Engine` drives game-logic updates (shared systems) and calls
 * `effects.update(dt)` once per frame to sync visuals to the latest state.
 */

import * as THREE from 'three';
import type { ActiveGasCloud, ActiveChemicalPool, FullRetardAuraSystem } from '@gtr/shared';
import { getCharacterStats, getCharacterSfx, getSharedSfx, KABOOM_CONE_HALF_ANGLE } from '@gtr/shared';
import type { Targetable } from '../types';
import type { PlayerController } from '../player/PlayerController';
import type { NpcController } from '../npc/NpcController';
import type { CastingSystem } from '../combat/CastingSystem';
import type { BuffSystem } from '../combat/BuffSystem';
import {
  type GasCloudVisual, type ChemPoolVisual, type FullRetardAuraVisual, type CrotchRotVisual,
  type BandageHealVisual, type GrenadeProjectileVisual, type GrenadeExplosionVisual,
  createGasCloud, updateGasCloud,
  createChemPool, updateChemPool,
  createFullRetardAura, updateFullRetardAura as updateFullRetardAuraVisual,
  createCrotchRotCloud, updateCrotchRotCloud,
  createChannelBeam, updateChannelBeam as updateChannelBeamVisual, removeChannelBeam,
  createBandageHealEffect, updateBandageHealEffect, removeBandageHealEffect,
  createGrenadeProjectile, updateGrenadeProjectile,
  createGrenadeExplosion, updateGrenadeExplosion,
  disposeGroup,
} from './VisualEffects';
import { soundEffects, type LoopHandle } from '../../ui/SoundEffects';

// ── Types ────────────��───────────────────────────────────────────────

interface DiscombobBubbles {
  target: Targetable;
  group: THREE.Group;
  bubbles: THREE.Mesh[];
}

export interface PlaygroundEffectsDeps {
  scene: THREE.Scene;
  clock: THREE.Clock;
  playerController: PlayerController;
  getNpcs: () => readonly NpcController[];
  castingSystem: CastingSystem;
  buffSystem: BuffSystem;
  fullRetardAuraSystem: FullRetardAuraSystem<Targetable>;
  sfxPan: (pos: THREE.Vector3) => number;
}

// ── PlaygroundEffects ─────────��──────────────────────────────────────

export class PlaygroundEffects {
  private readonly scene: THREE.Scene;
  private readonly clock: THREE.Clock;
  private readonly deps: PlaygroundEffectsDeps;

  // Gas cloud visuals
  private readonly gasCloudVisuals = new Map<ActiveGasCloud<Targetable>, GasCloudVisual>();

  // Chemical pool visuals
  private readonly chemPoolVisuals = new Map<ActiveChemicalPool<Targetable>, ChemPoolVisual & { consumeElapsed: number }>();

  // Discombobulate bubbles
  private readonly discombobEffects: DiscombobBubbles[] = [];

  // Full Retard aura visual + SFX
  private fullRetardAuraVisual: FullRetardAuraVisual | null = null;
  private fullRetardLoopHandle: LoopHandle | null = null;

  // Crotch Rot cloud visuals
  private crotchRotVisuals = new Map<Targetable, CrotchRotVisual & { elapsed: number }>();

  // Channel beam (player)
  private channelBeam: THREE.Mesh | null = null;
  private channelBeamTarget: Targetable | null = null;

  // NPC channel beams
  private npcChannelBeams = new Map<NpcController, { beam: THREE.Mesh; target: Targetable }>();

  // Bandage heal visual
  private bandageHealVisual: BandageHealVisual | null = null;

  // Active grenade projectiles in flight (with explosion radius for the impact VFX)
  private grenadeProjectiles: { visual: GrenadeProjectileVisual; radius: number }[] = [];
  // Active grenade explosion visuals
  private grenadeExplosions: GrenadeExplosionVisual[] = [];

  // Sound loops
  private bandageLoopHandle: LoopHandle | null = null;
  private castSpellLoopHandle: LoopHandle | null = null;
  private castGrenadeLoopHandle: LoopHandle | null = null;
  private odLoopHandle: LoopHandle | null = null;
  private npcCastLoops = new Map<NpcController, { handle: LoopHandle; type: 'castSpell' | 'bandage' | 'castGrenade' }>();

  constructor(deps: PlaygroundEffectsDeps) {
    this.scene = deps.scene;
    this.clock = deps.clock;
    this.deps = deps;
  }

  // ── Per-frame update ──────────────────────────────────────────────

  update(dt: number): void {
    this.updateGasCloudVisuals();
    this.updateChemPoolVisuals(dt);
    this.updateFullRetardAuraVisuals(dt);
    this.updateODLoop();
    this.updateCrotchRotVisuals(dt);
    this.updateDiscombobEffects();
    this.updateChannelBeam();
    this.updateNpcChannelBeams();
    this.updateBandageHeal();
    this.updateNpcCastLoops();
    this.updateGrenadeProjectiles(dt);
    this.updateGrenadeExplosions(dt);
  }

  // ── Grenade projectiles + explosions ─────────────────────────────

  /** Launch a grenade visual: arcing projectile from start → ground, explosion at impact. */
  launchGrenadeProjectile(start: THREE.Vector3, ground: THREE.Vector3, flightDuration: number, aoeRadius: number): void {
    const visual = createGrenadeProjectile(this.scene, start, ground, flightDuration);
    this.grenadeProjectiles.push({ visual, radius: aoeRadius });
  }

  private updateGrenadeProjectiles(dt: number): void {
    for (let i = this.grenadeProjectiles.length - 1; i >= 0; i--) {
      const entry = this.grenadeProjectiles[i];
      const done = updateGrenadeProjectile(entry.visual, dt);
      if (done) {
        const impactPos = entry.visual.end.clone();
        disposeGroup(this.scene, entry.visual.group);
        this.grenadeProjectiles.splice(i, 1);
        // Spawn explosion at impact site
        const explosion = createGrenadeExplosion(this.scene, impactPos, entry.radius);
        this.grenadeExplosions.push(explosion);
        // Play explosion SFX at the impact location
        const explodeSfx = getSharedSfx().grenadeExplode;
        if (explodeSfx) {
          const playerPos = this.deps.playerController.mesh.position;
          soundEffects.play(explodeSfx.url, playerPos.distanceTo(impactPos), this.deps.sfxPan(impactPos), explodeSfx.volume);
        }
      }
    }
  }

  private updateGrenadeExplosions(dt: number): void {
    for (let i = this.grenadeExplosions.length - 1; i >= 0; i--) {
      const explosion = this.grenadeExplosions[i];
      const done = updateGrenadeExplosion(explosion, dt);
      if (done) {
        disposeGroup(this.scene, explosion.group);
        this.grenadeExplosions.splice(i, 1);
      }
    }
  }

  // ── Gas cloud visuals ─────────────────────────────────────────────

  createGasCloudVisual(cloud: ActiveGasCloud<Targetable>, x: number, z: number, radius: number, y: number): void {
    const visual = createGasCloud(this.scene, x, z, radius, y);
    this.gasCloudVisuals.set(cloud, visual);
  }

  onGasCloudExpired(cloud: ActiveGasCloud<Targetable>): void {
    const visual = this.gasCloudVisuals.get(cloud);
    if (visual) {
      disposeGroup(this.scene, visual.group);
      this.gasCloudVisuals.delete(cloud);
    }
  }

  private updateGasCloudVisuals(): void {
    // gasCloudSystem.update was already called by Engine before effects.update;
    // here we just sync visuals to the current cloud state.
    for (const [cloud, visual] of this.gasCloudVisuals) {
      if (updateGasCloud(visual, cloud.elapsed, cloud.duration, 0)) {
        disposeGroup(this.scene, visual.group);
        this.gasCloudVisuals.delete(cloud);
      }
    }
  }

  clearGasCloudVisuals(): void {
    for (const visual of this.gasCloudVisuals.values()) disposeGroup(this.scene, visual.group);
    this.gasCloudVisuals.clear();
  }

  // ── Chemical pool visuals ────────────────────���────────────────────

  createChemPoolVisual(pool: ActiveChemicalPool<Targetable>, x: number, z: number, radius: number, y: number): void {
    const visual = createChemPool(this.scene, x, z, radius, y);
    this.chemPoolVisuals.set(pool, { ...visual, consumeElapsed: 0 });
  }

  onChemPoolExpired(pool: ActiveChemicalPool<Targetable>): void {
    const visual = this.chemPoolVisuals.get(pool);
    if (visual) {
      disposeGroup(this.scene, visual.group);
      this.chemPoolVisuals.delete(pool);
    }
  }

  onChemPoolConsumed(pool: ActiveChemicalPool<Targetable>): void {
    const triggerSfx = getCharacterSfx(pool.owner.characterId)?.chemicalSpillTrigger;
    if (triggerSfx) {
      const poolPos = new THREE.Vector3(pool.centerX, pool.centerY, pool.centerZ);
      const playerPos = this.deps.playerController.mesh.position;
      soundEffects.play(triggerSfx.url, playerPos.distanceTo(poolPos), this.deps.sfxPan(poolPos), triggerSfx.volume);
    }
  }

  private updateChemPoolVisuals(dt: number): void {
    for (const [pool, visual] of this.chemPoolVisuals) {
      if (pool.consumed) visual.consumeElapsed += dt;
      updateChemPool(visual, pool.elapsed, pool.duration, pool.activationDelay, pool.consumed, visual.consumeElapsed, dt);
    }
  }

  clearChemPoolVisuals(): void {
    for (const visual of this.chemPoolVisuals.values()) disposeGroup(this.scene, visual.group);
    this.chemPoolVisuals.clear();
  }

  // ���─ Full Retard aura visual ─────────────��─────────────────────────

  onFullRetardAuraStarted(entity: Targetable): void {
    const player = this.deps.playerController;
    if (entity !== player) return;
    const pos = player.mesh.position;
    this.fullRetardAuraVisual = createFullRetardAura(this.scene, pos.x, pos.z, player.autoAttackRange);
    const frSfx = getCharacterSfx(player.characterId)?.fullRetard;
    if (frSfx) this.fullRetardLoopHandle = soundEffects.playLoop(frSfx.url, undefined, undefined, frSfx.volume);
  }

  onFullRetardAuraStopped(entity: Targetable): void {
    if (entity !== this.deps.playerController) return;
    this.cleanupFullRetardFumes();
  }

  private cleanupFullRetardFumes(): void {
    if (this.fullRetardAuraVisual) {
      disposeGroup(this.scene, this.fullRetardAuraVisual.group);
      this.fullRetardAuraVisual = null;
    }
    if (this.fullRetardLoopHandle) {
      this.fullRetardLoopHandle.stop();
      this.fullRetardLoopHandle = null;
    }
  }

  private updateFullRetardAuraVisuals(dt: number): void {
    if (!this.fullRetardAuraVisual) return;
    const pos = this.deps.playerController.mesh.position;
    this.fullRetardAuraVisual.group.position.set(pos.x, 0, pos.z);
    const aura = this.deps.fullRetardAuraSystem.auras.get(this.deps.playerController as Targetable);
    if (aura) {
      updateFullRetardAuraVisual(this.fullRetardAuraVisual, aura.elapsed, dt, pos.x, pos.z);
    }
  }

  // ── OD loop SFX ───────────────────────��───────────────────────────

  private startODLoop(): void {
    if (this.odLoopHandle) return;
    const odSfx = getCharacterSfx(this.deps.playerController.characterId)?.od;
    if (odSfx) this.odLoopHandle = soundEffects.playLoop(odSfx.url, undefined, undefined, odSfx.volume);
  }

  stopODLoop(): void {
    if (this.odLoopHandle) {
      this.odLoopHandle.stop();
      this.odLoopHandle = null;
    }
  }

  private updateODLoop(): void {
    const hasBuff = this.deps.buffSystem.hasBuff(this.deps.playerController, 'overdosing');
    if (hasBuff && !this.odLoopHandle) {
      this.startODLoop();
    } else if (!hasBuff && this.odLoopHandle) {
      this.stopODLoop();
    }
  }

  // ── Crotch Rot visuals ────────────────────────────────────────────

  cleanupCrotchRotVisual(target: Targetable): void {
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
    const allTargets: Targetable[] = [this.deps.playerController, ...this.deps.getNpcs()];

    // Spawn visuals for targets that have the debuff but no visual yet
    for (const target of allTargets) {
      if (target.dead) continue;
      const hasDebuff = this.deps.buffSystem.hasDebuff(target, 'crotch-rot');
      if (hasDebuff && !this.crotchRotVisuals.has(target)) {
        const visual = createCrotchRotCloud();
        target.mesh.add(visual.group);
        this.crotchRotVisuals.set(target, { ...visual, elapsed: 0 });
      }
    }

    // Update existing visuals and remove expired ones
    for (const [target, visual] of this.crotchRotVisuals) {
      const hasDebuff = this.deps.buffSystem.hasDebuff(target, 'crotch-rot');
      if (!hasDebuff || target.dead) {
        this.cleanupCrotchRotVisual(target);
        continue;
      }

      visual.elapsed += dt;
      // Group is parented to mesh, so pass 0,0,0 for follow position
      updateCrotchRotCloud(visual, visual.elapsed, 0, 0, 0);
    }
  }

  // ── Discombobulate shadow bubbles ─────────��───────────────────────

  private updateDiscombobEffects(): void {
    const { buffSystem, playerController, getNpcs } = this.deps;
    // Spawn effects for newly discombobulated targets
    const allTargets: Targetable[] = [playerController, ...getNpcs()];
    for (const target of allTargets) {
      if (target.dead) continue;
      const hasDebuff = buffSystem.isDiscombobulated(target);
      const hasEffect = this.discombobEffects.some(e => e.target === target);
      if (hasDebuff && !hasEffect) {
        this.spawnDiscombobEffect(target);
      }
    }

    // Update and remove expired effects
    for (let i = this.discombobEffects.length - 1; i >= 0; i--) {
      const effect = this.discombobEffects[i];
      const hasDebuff = buffSystem.isDiscombobulated(effect.target);
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

  // ── Channel beam (player) ─────────────────────────────────────────

  private updateChannelBeam(): void {
    const cs = this.deps.castingSystem.getState(this.deps.playerController);
    if (!cs || !cs.isChannel || !cs.target || cs.ability.requiresFriendlyTarget) {
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
      this.deps.playerController.mesh.position,
      cs.target.mesh.position,
      this.clock.elapsedTime,
    );
    this.channelBeamTarget = cs.target;
  }

  // ── NPC channel beams ───────────���─────────────────────────────────

  private updateNpcChannelBeams(): void {
    const activeNpcs = new Set<NpcController>();
    for (const npc of this.deps.getNpcs()) {
      if (!npc.castingIsChannel || !npc.castingAbilityId || !npc.castingTarget) continue;
      // Look up the ability to check requiresFriendlyTarget
      const stats = getCharacterStats(npc.characterId);
      const ability = stats.abilities.find(a => a?.id === npc.castingAbilityId);
      if (!ability || ability.requiresFriendlyTarget) continue;

      activeNpcs.add(npc);
      let entry = this.npcChannelBeams.get(npc);
      if (!entry) {
        const beam = createChannelBeam(this.scene);
        entry = { beam, target: npc.castingTarget };
        this.npcChannelBeams.set(npc, entry);
      }
      entry.target = npc.castingTarget;
      updateChannelBeamVisual(entry.beam, npc.mesh.position, entry.target.mesh.position, this.clock.elapsedTime);
    }
    // Remove beams for NPCs that stopped channeling
    for (const [npc, entry] of this.npcChannelBeams) {
      if (!activeNpcs.has(npc)) {
        removeChannelBeam(this.scene, entry.beam);
        this.npcChannelBeams.delete(npc);
      }
    }
  }

  // ── Bandage heal visual ─────────��─────────────────────────────────

  private updateBandageHeal(): void {
    const cs = this.deps.castingSystem.getState(this.deps.playerController);
    if (!cs || !cs.isChannel || !cs.target || !cs.ability.requiresFriendlyTarget) {
      if (this.bandageHealVisual) {
        removeBandageHealEffect(this.scene, this.bandageHealVisual);
        this.bandageHealVisual = null;
      }
      return;
    }

    if (!this.bandageHealVisual) {
      this.bandageHealVisual = createBandageHealEffect(this.scene);
    }

    updateBandageHealEffect(
      this.bandageHealVisual,
      cs.target.mesh.position,
      cs.elapsed,
    );
  }

  // ── Kaboom gust particles ──────────────────���──────────────────────

  spawnKaboomGust(origin: THREE.Vector3, rotY: number, range: number): void {
    const halfAngle = KABOOM_CONE_HALF_ANGLE;
    const particleCount = 30;
    const group = new THREE.Group();
    group.position.set(origin.x, 0, origin.z);

    const particles: { mesh: THREE.Mesh; vx: number; vz: number; speed: number; life: number }[] = [];

    for (let i = 0; i < particleCount; i++) {
      const angle = rotY - halfAngle + Math.random() * 2 * halfAngle;
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
        p.life += 1 / 60;
        const dist = p.speed * p.life;
        p.mesh.position.x = p.vx * dist;
        p.mesh.position.z = p.vz * dist;
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * (0.5 + Math.random() * 0.1);
        p.mesh.position.y += 0.01;
        const scale = 1 + t * 1.5;
        p.mesh.scale.setScalar(scale);
      }

      requestAnimationFrame(animate);
    };

    requestAnimationFrame(animate);
  }

  // ── Cast/channel SFX loops ───────���────────────────────────────────

  startBandageLoop(): void {
    if (this.bandageLoopHandle) return;
    const bandageSfx = getSharedSfx().bandage;
    if (bandageSfx) this.bandageLoopHandle = soundEffects.playLoop(bandageSfx.url, undefined, undefined, bandageSfx.volume);
  }

  stopBandageLoop(): void {
    if (this.bandageLoopHandle) {
      this.bandageLoopHandle.stop();
      this.bandageLoopHandle = null;
    }
  }

  startCastSpellLoop(): void {
    if (this.castSpellLoopHandle) return;
    const castSpellSfx = getSharedSfx().castSpell;
    if (castSpellSfx) this.castSpellLoopHandle = soundEffects.playLoop(castSpellSfx.url, undefined, undefined, castSpellSfx.volume);
  }

  stopCastSpellLoop(): void {
    if (this.castSpellLoopHandle) {
      this.castSpellLoopHandle.stop();
      this.castSpellLoopHandle = null;
    }
  }

  startCastGrenadeLoop(): void {
    if (this.castGrenadeLoopHandle) return;
    const sfx = getSharedSfx().castGrenade;
    if (sfx) this.castGrenadeLoopHandle = soundEffects.playLoop(sfx.url, undefined, undefined, sfx.volume);
  }

  stopCastGrenadeLoop(): void {
    if (this.castGrenadeLoopHandle) {
      this.castGrenadeLoopHandle.stop();
      this.castGrenadeLoopHandle = null;
    }
  }

  /** Track NPC casting loops — start/stop cast-spell and bandage loop SFX as NPCs begin/end casts. */
  private updateNpcCastLoops(): void {
    const playerPos = this.deps.playerController.mesh.position;
    const activeCasters = new Set<NpcController>();
    for (const npc of this.deps.getNpcs()) {
      if (npc.castingAbilityId && npc.castingTotalTime > 0) {
        activeCasters.add(npc);
        // Start loop if not already playing
        if (!this.npcCastLoops.has(npc)) {
          const dist = playerPos.distanceTo(npc.mesh.position);
          const pan = this.deps.sfxPan(npc.mesh.position);
          if (npc.castingAbilityId === 'bandage') {
            const sfx = getSharedSfx().bandage;
            if (sfx) {
              const handle = soundEffects.playLoop(sfx.url, dist, pan, sfx.volume, npc.mesh.uuid);
              if (handle) this.npcCastLoops.set(npc, { handle, type: 'bandage' });
            }
          } else if (npc.castingAbilityId === 'grenade') {
            const sfx = getSharedSfx().castGrenade;
            if (sfx) {
              const handle = soundEffects.playLoop(sfx.url, dist, pan, sfx.volume, npc.mesh.uuid);
              if (handle) this.npcCastLoops.set(npc, { handle, type: 'castGrenade' });
            }
          } else if (npc.characterId === 'dr-retardo') {
            const sfx = getSharedSfx().castSpell;
            if (sfx) {
              const handle = soundEffects.playLoop(sfx.url, dist, pan, sfx.volume, npc.mesh.uuid);
              if (handle) this.npcCastLoops.set(npc, { handle, type: 'castSpell' });
            }
          }
        }
      }
    }
    // Stop loops for NPCs that stopped casting
    for (const [npc, loop] of this.npcCastLoops) {
      if (!activeCasters.has(npc)) {
        loop.handle.stop();
        this.npcCastLoops.delete(npc);
      }
    }
  }

  // ── NPC removal cleanup ──────────��────────────────────────────────

  /** Clean up any effects tied to an NPC that is being removed. */
  cleanupNpc(npc: NpcController): void {
    this.cleanupCrotchRotVisual(npc);
    const castLoop = this.npcCastLoops.get(npc);
    if (castLoop) { castLoop.handle.stop(); this.npcCastLoops.delete(npc); }
    const beamEntry = this.npcChannelBeams.get(npc);
    if (beamEntry) { removeChannelBeam(this.scene, beamEntry.beam); this.npcChannelBeams.delete(npc); }
  }

  // ── Dispose ─────────���─────────────────��───────────────────────────

  dispose(): void {
    this.clearGasCloudVisuals();
    this.clearChemPoolVisuals();
    this.cleanupFullRetardFumes();
    // Discombob effects
    for (const effect of this.discombobEffects) disposeGroup(this.scene, effect.group);
    this.discombobEffects.length = 0;
    // Crotch rot
    for (const [target] of this.crotchRotVisuals) this.cleanupCrotchRotVisual(target);
    this.crotchRotVisuals.clear();
    // Channel beam
    if (this.channelBeam) {
      removeChannelBeam(this.scene, this.channelBeam);
      this.channelBeam = null;
    }
    // Bandage heal visual
    if (this.bandageHealVisual) {
      removeBandageHealEffect(this.scene, this.bandageHealVisual);
      this.bandageHealVisual = null;
    }
    // Grenade projectiles + explosions
    for (const entry of this.grenadeProjectiles) disposeGroup(this.scene, entry.visual.group);
    this.grenadeProjectiles.length = 0;
    for (const explosion of this.grenadeExplosions) disposeGroup(this.scene, explosion.group);
    this.grenadeExplosions.length = 0;
    // Sound loops
    this.stopBandageLoop();
    this.stopCastSpellLoop();
    this.stopCastGrenadeLoop();
    this.stopODLoop();
    for (const [, loop] of this.npcCastLoops) loop.handle.stop();
    this.npcCastLoops.clear();
  }
}
