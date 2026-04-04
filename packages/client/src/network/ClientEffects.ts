import * as THREE from 'three';
import type { CharacterId } from '@gtr/shared';
import type { S2C_GasCloudSpawn, S2C_ChemPoolSpawn } from '@gtr/shared';
import { yardsToUnits, getCharacterSfx, Bandage } from '@gtr/shared';
import {
  type GasCloudVisual, type ChemPoolVisual, type FullRetardAuraVisual, type CrotchRotVisual,
  type BandageHealVisual,
  createGasCloud, updateGasCloud,
  createChemPool, updateChemPool,
  createFullRetardAura, updateFullRetardAura as updateFullRetardAuraVisual,
  createCrotchRotCloud, updateCrotchRotCloud,
  createChannelBeam, updateChannelBeam as updateChannelBeamVisual, removeChannelBeam,
  createBandageHealEffect, updateBandageHealEffect, removeBandageHealEffect,
  disposeGroup,
} from '../engine/effects/VisualEffects';
import type { CharacterModel } from '../engine/player/characters';
import { soundEffects, type LoopHandle } from '../ui/SoundEffects';

// ── Host interface ────────────────────────────────────────────────────

/** Read-only view of a remote entity, as needed by the effects system. */
export interface EffectEntityView {
  readonly id: string;
  readonly mesh: THREE.Group;
  readonly characterId: string;
  readonly buffs: ReadonlyArray<{ id: string }>;
  readonly castingAbilityId: string | null;
  readonly castingIsChannel: boolean;
  readonly targetEntityId: string | null;
}

/** Host interface — ClientEngine implements this to provide state to the effects system. */
export interface ClientEffectsHost {
  readonly localEntityId: string;
  readonly remoteEntities: ReadonlyMap<string, EffectEntityView>;
  getLocalBuffs(): ReadonlyArray<{ id: string }>;
  getLocalCastingAbilityId(): string | null;
  isLocalCastingChannel(): boolean;
  getLocalTargetEntityId(): string | null;
  getPlayerMesh(): THREE.Group;
  getPlayerCharacterId(): CharacterId;
  getPlayerAutoAttackRange(): number;
  getEntityMesh(entityId: string): THREE.Group | undefined;
  distToEntity(entityId: string): number;
  panToEntity(entityId: string): number;
  distToPosition(pos: THREE.Vector3): number;
  panToPosition(pos: THREE.Vector3): number;
}

// ── ClientEffects ─────────────────────────────────────────────────────

export class ClientEffects {
  private readonly scene: THREE.Scene;
  private readonly host: ClientEffectsHost;

  // Gas cloud visuals
  private gasClouds = new Map<string, GasCloudVisual & { elapsed: number; duration: number }>();

  // Chemical pool visuals
  private chemPools = new Map<string, ChemPoolVisual & {
    elapsed: number; duration: number;
    activationDelay: number; consumed: boolean; consumeElapsed: number;
  }>();

  // Channel beam
  private channelBeam: THREE.Mesh | null = null;
  private channelBeamElapsed = 0;

  // Bandage heal
  private bandageHealVisual: BandageHealVisual | null = null;
  private bandageHealElapsed = 0;

  // Full Retard aura visuals + looping SFX
  private fullRetardAuras = new Map<string, FullRetardAuraVisual & { elapsed: number }>();
  private fullRetardLoops = new Map<string, LoopHandle>();

  // Crotch Rot cloud visuals
  private crotchRotVisuals = new Map<string, CrotchRotVisual & { elapsed: number }>();

  // OD looping SFX
  private odLoops = new Map<string, LoopHandle>();

  // Entities fading out before removal
  private static readonly ENTITY_FADE_DURATION = 1.5;
  private fadingEntities = new Map<string, { model: CharacterModel; mesh: THREE.Group; elapsed: number }>();

  constructor(scene: THREE.Scene, host: ClientEffectsHost) {
    this.scene = scene;
    this.host = host;
  }

  // ── Spawn handlers ──────────────────────────────────────────────────

  handleGasCloudSpawn(msg: S2C_GasCloudSpawn): void {
    const visual = createGasCloud(this.scene, msg.x, msg.z, msg.radius, msg.y);
    this.gasClouds.set(msg.id, { ...visual, elapsed: 0, duration: msg.duration });
  }

  handleChemPoolSpawn(msg: S2C_ChemPoolSpawn): void {
    const visual = createChemPool(this.scene, msg.x, msg.z, msg.radius, msg.y);
    this.chemPools.set(msg.id, {
      ...visual, elapsed: 0, duration: msg.duration,
      activationDelay: msg.activationDelay, consumed: false, consumeElapsed: 0,
    });
  }

  /** Sync chem pool consumed state from server snapshots/deltas. */
  syncChemPoolState(pools: ReadonlyArray<{ id: string; consumed: boolean }>): void {
    for (const cpSnap of pools) {
      const pool = this.chemPools.get(cpSnap.id);
      if (pool && cpSnap.consumed && !pool.consumed) {
        pool.consumed = true;
        const triggerSfx = getCharacterSfx('dr-retardo')?.chemicalSpillTrigger;
        if (triggerSfx) {
          soundEffects.play(
            triggerSfx.url,
            this.host.distToPosition(pool.group.position),
            this.host.panToPosition(pool.group.position),
            triggerSfx.volume,
          );
        }
      }
    }
  }

  /** Add an entity that's fading out (disconnected, grace period expired). */
  addFadingEntity(id: string, model: CharacterModel, mesh: THREE.Group): void {
    this.fadingEntities.set(id, { model, mesh, elapsed: 0 });
  }

  /** Spawn a kaboom wind gust particle effect. */
  spawnKaboomGust(origin: THREE.Vector3, rotY: number): void {
    const halfAngle = Math.PI / 6;
    const range = yardsToUnits(8);
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
      particles.push({ mesh, vx: Math.sin(angle), vz: Math.cos(angle), speed, life: 0 });
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

  // ── Per-frame update ────────────────────────────────────────────────

  update(dt: number): void {
    this.updateGasClouds(dt);
    this.updateChemPools(dt);
    this.updateFadingEntities(dt);
    this.updateChannelBeam(dt);
    this.updateBandageHeal(dt);
    this.updateFullRetardAuras(dt);
    this.updateODLoops();
    this.updateCrotchRotVisuals(dt);
  }

  private updateGasClouds(dt: number): void {
    for (const [id, cloud] of this.gasClouds) {
      cloud.elapsed += dt;
      if (updateGasCloud(cloud, cloud.elapsed, cloud.duration, dt)) {
        disposeGroup(this.scene, cloud.group);
        this.gasClouds.delete(id);
      }
    }
  }

  private updateChemPools(dt: number): void {
    for (const [id, pool] of this.chemPools) {
      pool.elapsed += dt;
      if (pool.consumed) pool.consumeElapsed += dt;
      if (updateChemPool(pool, pool.elapsed, pool.duration, pool.activationDelay, pool.consumed, pool.consumeElapsed, dt)) {
        disposeGroup(this.scene, pool.group);
        this.chemPools.delete(id);
      }
    }
  }

  private updateFadingEntities(dt: number): void {
    for (const [id, fading] of this.fadingEntities) {
      fading.elapsed += dt;
      const t = fading.elapsed / ClientEffects.ENTITY_FADE_DURATION;
      if (t >= 1) {
        this.scene.remove(fading.mesh);
        this.fadingEntities.delete(id);
      } else {
        fading.model.setOpacity(1 - t);
      }
    }
  }

  private updateChannelBeam(dt: number): void {
    let casterPos: THREE.Vector3 | null = null;
    let targetPos: THREE.Vector3 | null = null;

    // Check local player — use server-authoritative target, not current UI selection
    // Skip beam for friendly-only channels (e.g., Bandage)
    const localCastId = this.host.getLocalCastingAbilityId();
    const localTargetId = this.host.getLocalTargetEntityId();
    if (localCastId && this.host.isLocalCastingChannel() && localTargetId
        && localCastId !== Bandage.id) {
      casterPos = this.host.getPlayerMesh().position;
      const targetMesh = this.host.getEntityMesh(localTargetId);
      if (targetMesh) targetPos = targetMesh.position;
    }

    // Check remote entities (find first channeling remote)
    if (!casterPos) {
      for (const entity of this.host.remoteEntities.values()) {
        if (entity.castingAbilityId && entity.castingIsChannel && entity.targetEntityId
            && entity.castingAbilityId !== Bandage.id) {
          casterPos = entity.mesh.position;
          const targetMesh = this.host.getEntityMesh(entity.targetEntityId);
          if (targetMesh) targetPos = targetMesh.position;
          break;
        }
      }
    }

    if (!casterPos || !targetPos) {
      if (this.channelBeam) {
        removeChannelBeam(this.scene, this.channelBeam);
        this.channelBeam = null;
      }
      this.channelBeamElapsed = 0;
      return;
    }

    this.channelBeamElapsed += dt;
    if (!this.channelBeam) {
      this.channelBeam = createChannelBeam(this.scene);
    }
    updateChannelBeamVisual(this.channelBeam, casterPos, targetPos, this.channelBeamElapsed);
  }

  private updateBandageHeal(dt: number): void {
    // Find the target position of any entity channeling bandage
    let targetPos: THREE.Vector3 | null = null;

    // Check local player
    if (this.host.getLocalCastingAbilityId() === Bandage.id
        && this.host.isLocalCastingChannel() && this.host.getLocalTargetEntityId()) {
      const targetMesh = this.host.getEntityMesh(this.host.getLocalTargetEntityId()!);
      if (targetMesh) targetPos = targetMesh.position;
    }

    // Check remote entities
    if (!targetPos) {
      for (const entity of this.host.remoteEntities.values()) {
        if (entity.castingAbilityId === Bandage.id && entity.castingIsChannel && entity.targetEntityId) {
          const targetMesh = this.host.getEntityMesh(entity.targetEntityId);
          if (targetMesh) targetPos = targetMesh.position;
          break;
        }
      }
    }

    if (!targetPos) {
      if (this.bandageHealVisual) {
        removeBandageHealEffect(this.scene, this.bandageHealVisual);
        this.bandageHealVisual = null;
      }
      this.bandageHealElapsed = 0;
      return;
    }

    this.bandageHealElapsed += dt;
    if (!this.bandageHealVisual) {
      this.bandageHealVisual = createBandageHealEffect(this.scene);
    }
    updateBandageHealEffect(this.bandageHealVisual, targetPos, this.bandageHealElapsed);
  }

  private updateFullRetardAuras(dt: number): void {
    const activeIds = new Set<string>();

    // Local player
    if (this.host.getLocalBuffs().some(b => b.id === 'full-retard')) {
      const entityId = this.host.localEntityId;
      activeIds.add(entityId);
      if (!this.fullRetardAuras.has(entityId)) {
        const pos = this.host.getPlayerMesh().position;
        const visual = createFullRetardAura(this.scene, pos.x, pos.z, this.host.getPlayerAutoAttackRange());
        this.fullRetardAuras.set(entityId, { ...visual, elapsed: 0 });
        // Start looping SFX
        const frSfx = getCharacterSfx(this.host.getPlayerCharacterId())?.fullRetard;
        if (frSfx) {
          const handle = soundEffects.playLoop(frSfx.url, undefined, undefined, frSfx.volume, entityId);
          if (handle) this.fullRetardLoops.set(entityId, handle);
        }
      }
    }

    // Remote entities
    for (const entity of this.host.remoteEntities.values()) {
      if (entity.buffs.some(b => b.id === 'full-retard')) {
        activeIds.add(entity.id);
        if (!this.fullRetardAuras.has(entity.id)) {
          const visual = createFullRetardAura(this.scene, entity.mesh.position.x, entity.mesh.position.z, 1.5);
          this.fullRetardAuras.set(entity.id, { ...visual, elapsed: 0 });
          // Start looping SFX
          const frSfx = getCharacterSfx(entity.characterId as CharacterId)?.fullRetard;
          if (frSfx) {
            const handle = soundEffects.playLoop(frSfx.url, this.host.distToEntity(entity.id), this.host.panToEntity(entity.id), frSfx.volume, entity.id);
            if (handle) this.fullRetardLoops.set(entity.id, handle);
          }
        }
      }
    }

    // Update existing auras
    for (const [entityId, aura] of this.fullRetardAuras) {
      if (!activeIds.has(entityId)) {
        disposeGroup(this.scene, aura.group);
        this.fullRetardAuras.delete(entityId);
        // Stop looping SFX
        const loop = this.fullRetardLoops.get(entityId);
        if (loop) { loop.stop(); this.fullRetardLoops.delete(entityId); }
        continue;
      }

      aura.elapsed += dt;
      const mesh = this.host.getEntityMesh(entityId);
      const followX = mesh ? mesh.position.x : aura.group.position.x;
      const followZ = mesh ? mesh.position.z : aura.group.position.z;
      updateFullRetardAuraVisual(aura, aura.elapsed, dt, followX, followZ);
    }
  }

  private updateODLoops(): void {
    const activeIds = new Set<string>();

    // Local player
    if (this.host.getLocalBuffs().some(b => b.id === 'overdosing')) {
      const entityId = this.host.localEntityId;
      activeIds.add(entityId);
      if (!this.odLoops.has(entityId)) {
        const odSfx = getCharacterSfx(this.host.getPlayerCharacterId())?.od;
        if (odSfx) {
          const handle = soundEffects.playLoop(odSfx.url, undefined, undefined, odSfx.volume, entityId);
          if (handle) this.odLoops.set(entityId, handle);
        }
      }
    }

    // Remote entities
    for (const entity of this.host.remoteEntities.values()) {
      if (entity.buffs.some(b => b.id === 'overdosing')) {
        activeIds.add(entity.id);
        if (!this.odLoops.has(entity.id)) {
          const odSfx = getCharacterSfx(entity.characterId as CharacterId)?.od;
          if (odSfx) {
            const handle = soundEffects.playLoop(odSfx.url, this.host.distToEntity(entity.id), this.host.panToEntity(entity.id), odSfx.volume, entity.id);
            if (handle) this.odLoops.set(entity.id, handle);
          }
        }
      }
    }

    // Stop loops for entities that no longer have the buff
    for (const [entityId, loop] of this.odLoops) {
      if (!activeIds.has(entityId)) {
        loop.stop();
        this.odLoops.delete(entityId);
      }
    }
  }

  private updateCrotchRotVisuals(dt: number): void {
    const activeIds = new Set<string>();

    // Local player
    if (this.host.getLocalBuffs().some(b => b.id === 'crotch-rot')) {
      const entityId = this.host.localEntityId;
      activeIds.add(entityId);
      if (!this.crotchRotVisuals.has(entityId)) {
        const visual = createCrotchRotCloud();
        this.host.getPlayerMesh().add(visual.group);
        this.crotchRotVisuals.set(entityId, { ...visual, elapsed: 0 });
      }
    }

    // Remote entities
    for (const entity of this.host.remoteEntities.values()) {
      if (entity.buffs.some(b => b.id === 'crotch-rot')) {
        activeIds.add(entity.id);
        if (!this.crotchRotVisuals.has(entity.id)) {
          const visual = createCrotchRotCloud();
          entity.mesh.add(visual.group);
          this.crotchRotVisuals.set(entity.id, { ...visual, elapsed: 0 });
        }
      }
    }

    // Update existing visuals and remove expired ones
    for (const [entityId, visual] of this.crotchRotVisuals) {
      if (!activeIds.has(entityId)) {
        const mesh = this.host.getEntityMesh(entityId);
        if (mesh) mesh.remove(visual.group);
        visual.group.traverse(child => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            (child.material as THREE.Material).dispose();
          }
        });
        this.crotchRotVisuals.delete(entityId);
        continue;
      }

      visual.elapsed += dt;
      // Group is parented to entity mesh, so pass 0,0,0 for follow position
      updateCrotchRotCloud(visual, visual.elapsed, 0, 0, 0);
    }
  }

  // ── Fast-forward (tab restore) ──────────────────────────────────────

  fastForward(gap: number): void {
    for (const cloud of this.gasClouds.values()) cloud.elapsed += gap;
    for (const pool of this.chemPools.values()) {
      pool.elapsed += gap;
      if (pool.consumed) pool.consumeElapsed += gap;
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────

  destroy(): void {
    for (const cloud of this.gasClouds.values()) disposeGroup(this.scene, cloud.group);
    this.gasClouds.clear();
    for (const pool of this.chemPools.values()) disposeGroup(this.scene, pool.group);
    this.chemPools.clear();
    if (this.channelBeam) removeChannelBeam(this.scene, this.channelBeam);
    if (this.bandageHealVisual) removeBandageHealEffect(this.scene, this.bandageHealVisual);
    for (const aura of this.fullRetardAuras.values()) disposeGroup(this.scene, aura.group);
    this.fullRetardAuras.clear();
    for (const handle of this.fullRetardLoops.values()) handle.stop();
    this.fullRetardLoops.clear();
    for (const handle of this.odLoops.values()) handle.stop();
    this.odLoops.clear();
    for (const visual of this.crotchRotVisuals.values()) {
      visual.group.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
    }
    this.crotchRotVisuals.clear();
    for (const fading of this.fadingEntities.values()) this.scene.remove(fading.mesh);
    this.fadingEntities.clear();
  }
}
