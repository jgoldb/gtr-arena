import { audioSettings } from './AudioSettings';
import { CHARACTERS, getCharacterSfx } from '@gtr/shared';
import type { CharacterId } from '@gtr/shared';

// Distance-based volume falloff (world units, 1 yard = 0.6 units)
const SFX_FULL_VOLUME_DIST = 3;   // ~5 yards — full volume within melee range
const SFX_SILENT_DIST = 18;       // ~30 yards — inaudible beyond this

class SoundEffectsManager {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();

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

  /** Play a sound effect. Pass distance (world units) and pan (-1 left, +1 right) for spatial audio. volumeMultiplier scales the final gain (default 1). */
  play(url: string, distance?: number, pan?: number, volumeMultiplier = 1): void {
    if (!audioSettings.enableSfx || !audioSettings.windowFocused) return;
    const buffer = this.buffers.get(url);
    if (!buffer) return;

    // Proximity volume: full at close range, silent beyond max range
    let proximityScale = 1;
    if (distance !== undefined && distance > SFX_FULL_VOLUME_DIST) {
      if (distance >= SFX_SILENT_DIST) return; // too far — skip entirely
      proximityScale = 1 - (distance - SFX_FULL_VOLUME_DIST) / (SFX_SILENT_DIST - SFX_FULL_VOLUME_DIST);
    }

    const ctx = this.getContext();
    if (ctx.state === 'suspended') ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = audioSettings.masterVolume * audioSettings.sfxVolume * proximityScale * volumeMultiplier;
    source.connect(gain);
    // Stereo panning: place sound in left/right channel based on direction
    if (pan !== undefined && pan !== 0) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      gain.connect(panner);
      panner.connect(ctx.destination);
    } else {
      gain.connect(ctx.destination);
    }
    source.start();
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
  }
}

export const soundEffects = new SoundEffectsManager();
