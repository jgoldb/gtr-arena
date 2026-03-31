import { audioSettings } from './AudioSettings';
import { CHARACTERS, getCharacterSfx, getSharedSfx } from '@gtr/shared';
import type { CharacterId } from '@gtr/shared';

// Distance-based volume falloff (world units, 1 yard = 0.6 units)
const SFX_FULL_VOLUME_DIST = 3;   // ~5 yards — full volume within melee range
const SFX_SILENT_DIST = 18;       // ~30 yards — inaudible beyond this

/** Handle returned by playLoop() — call stop() to end the loop. */
export interface LoopHandle {
  stop(): void;
}

/** An active sound being tracked for continuous spatial updates. */
interface ActiveSpatialSound {
  gain: GainNode;
  panner: StereoPannerNode | null;
  volumeMultiplier: number;
}

class SoundEffectsManager {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  /** Active spatial sounds keyed by source identifier (e.g. entity ID). */
  private activeSpatial = new Map<string, ActiveSpatialSound[]>();

  private getContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  async load(url: string): Promise<void> {
    if (this.buffers.has(url)) return;
    try {
      const ctx = this.getContext();
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      this.buffers.set(url, audioBuffer);
    } catch { /* failed to load — play() will silently no-op */ }
  }

  private proximityScale(distance: number | undefined): number {
    if (distance === undefined || distance <= SFX_FULL_VOLUME_DIST) return 1;
    if (distance >= SFX_SILENT_DIST) return 0;
    return 1 - (distance - SFX_FULL_VOLUME_DIST) / (SFX_SILENT_DIST - SFX_FULL_VOLUME_DIST);
  }

  private trackSound(sourceKey: string, entry: ActiveSpatialSound): void {
    let list = this.activeSpatial.get(sourceKey);
    if (!list) { list = []; this.activeSpatial.set(sourceKey, list); }
    list.push(entry);
  }

  private untrackSound(sourceKey: string, entry: ActiveSpatialSound): void {
    const arr = this.activeSpatial.get(sourceKey);
    if (arr) {
      const idx = arr.indexOf(entry);
      if (idx !== -1) arr.splice(idx, 1);
      if (arr.length === 0) this.activeSpatial.delete(sourceKey);
    }
  }

  /**
   * Play a sound effect. Pass distance (world units) and pan (-1 left, +1 right) for spatial audio.
   * volumeMultiplier scales the final gain (default 1).
   * sourceKey ties this sound to an entity for continuous spatial updates via updateSpatialPositions().
   */
  play(url: string, distance?: number, pan?: number, volumeMultiplier = 1, sourceKey?: string): void {
    if (!audioSettings.enableSfx || !audioSettings.windowFocused) return;
    const buffer = this.buffers.get(url);
    if (!buffer) return;

    const proxScale = this.proximityScale(distance);
    if (proxScale <= 0) return; // too far — skip entirely

    const ctx = this.getContext();
    if (ctx.state === 'suspended') ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = audioSettings.masterVolume * audioSettings.sfxVolume * proxScale * volumeMultiplier;
    source.connect(gain);
    // Always create a panner for tracked sounds (position may change),
    // otherwise only when initial pan is non-zero
    let pannerNode: StereoPannerNode | null = null;
    if (sourceKey || (pan !== undefined && pan !== 0)) {
      pannerNode = ctx.createStereoPanner();
      pannerNode.pan.value = Math.max(-1, Math.min(1, pan ?? 0));
      gain.connect(pannerNode);
      pannerNode.connect(ctx.destination);
    } else {
      gain.connect(ctx.destination);
    }
    // Track spatial sounds for continuous position updates
    if (sourceKey) {
      const entry: ActiveSpatialSound = { gain, panner: pannerNode, volumeMultiplier };
      this.trackSound(sourceKey, entry);
      source.onended = () => this.untrackSound(sourceKey, entry);
    }
    source.start();
  }

  /** Play a looping sound effect. Returns a handle whose stop() method ends the loop. */
  playLoop(url: string, distance?: number, pan?: number, volumeMultiplier = 1, sourceKey?: string): LoopHandle | null {
    if (!audioSettings.enableSfx || !audioSettings.windowFocused) return null;
    const buffer = this.buffers.get(url);
    if (!buffer) return null;

    const proxScale = this.proximityScale(distance);
    if (proxScale <= 0) return null;

    const ctx = this.getContext();
    if (ctx.state === 'suspended') ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = audioSettings.masterVolume * audioSettings.sfxVolume * proxScale * volumeMultiplier;
    source.connect(gain);
    let pannerNode: StereoPannerNode | null = null;
    if (sourceKey || (pan !== undefined && pan !== 0)) {
      pannerNode = ctx.createStereoPanner();
      pannerNode.pan.value = Math.max(-1, Math.min(1, pan ?? 0));
      gain.connect(pannerNode);
      pannerNode.connect(ctx.destination);
    } else {
      gain.connect(ctx.destination);
    }
    let entry: ActiveSpatialSound | null = null;
    if (sourceKey) {
      entry = { gain, panner: pannerNode, volumeMultiplier };
      this.trackSound(sourceKey, entry);
    }
    source.start();
    return {
      stop: () => {
        try { source.stop(); } catch { /* already stopped */ }
        if (sourceKey && entry) this.untrackSound(sourceKey, entry);
      },
    };
  }

  /**
   * Update all tracked spatial sounds with current positions.
   * Call each frame from the game loop.
   * The callback should return distance/pan for the given source key, or null for local-player sounds.
   */
  updateSpatialPositions(getSpatial: (key: string) => { distance: number; pan: number } | null): void {
    for (const [key, sounds] of this.activeSpatial) {
      const pos = getSpatial(key);
      if (!pos) continue;
      const proxScale = this.proximityScale(pos.distance);
      for (const s of sounds) {
        s.gain.gain.value = audioSettings.masterVolume * audioSettings.sfxVolume * proxScale * s.volumeMultiplier;
        if (s.panner) {
          s.panner.pan.value = Math.max(-1, Math.min(1, pos.pan));
        }
      }
    }
  }

  /** Preload all game sound effects. Safe to call multiple times. */
  init(): void {
    for (const char of Object.values(CHARACTERS)) {
      const sfx = getCharacterSfx(char.id as CharacterId);
      if (!sfx) continue;
      for (const entry of Object.values(sfx)) {
        if (entry) this.load(entry.url);
      }
    }
    // Shared ability SFX (pvp trinket, etc.)
    for (const entry of Object.values(getSharedSfx())) {
      if (entry) this.load(entry.url);
    }
  }
}

export const soundEffects = new SoundEffectsManager();
