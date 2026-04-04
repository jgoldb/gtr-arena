import { audioSettings } from '../ui/AudioSettings';

export class AuthMusicController {
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private fadingOut = false;
  private readonly onVisibilityChange = () => this.handleVisibilityChange();
  private readonly onUserGesture = () => this.resumeAudioCtx();
  private readonly onAudioSettingsChange = (s: { masterVolume: number; enableMusic: boolean; musicVolume: number }) => this.handleAudioSettingsChange(s);

  constructor() {
    this.startMusic();
    audioSettings.onChange(this.onAudioSettingsChange);
  }

  private get authMusicVolume(): number {
    return audioSettings.windowFocused ? audioSettings.masterVolume * audioSettings.musicVolume * 2 : 0;
  }

  private handleAudioSettingsChange(s: { masterVolume: number; enableMusic: boolean; musicVolume: number }): void {
    if (!s.enableMusic) {
      this.fadeOutMusic();
    } else if (this.audioCtx && !this.fadingOut) {
      // Live volume update (also handles focus/blur)
      const ctx = this.audioCtx;
      const gain = this.gainNode!;
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(this.authMusicVolume, ctx.currentTime + 0.15);
    } else {
      // Music was off, re-enable
      this.startMusic();
    }
  }

  private async startMusic(): Promise<void> {
    if (!audioSettings.enableMusic) return;
    // Already playing
    if (this.audioCtx && !this.fadingOut) return;
    // Was fading out — wait for cleanup then restart
    if (this.fadingOut) {
      await new Promise<void>(r => setTimeout(r, 1700));
    }
    this.fadingOut = false;
    try {
      const ctx = new AudioContext();
      this.audioCtx = ctx;
      const gain = ctx.createGain();
      this.gainNode = gain;
      gain.gain.value = 0;
      gain.connect(ctx.destination);

      const resp = await fetch('/audio/music/login.ogg');
      const buf = await resp.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(buf);

      // Don't start if we were destroyed while loading
      if (this.fadingOut) return;

      const source = ctx.createBufferSource();
      this.sourceNode = source;
      source.buffer = audioBuf;
      source.loop = true;
      source.connect(gain);
      source.start();

      document.addEventListener('visibilitychange', this.onVisibilityChange);

      if (ctx.state === 'suspended') {
        for (const evt of ['pointerdown', 'keydown'] as const) {
          document.addEventListener(evt, this.onUserGesture, { once: false });
        }
      } else if (audioSettings.windowFocused) {
        gain.gain.linearRampToValueAtTime(this.authMusicVolume, ctx.currentTime + 2);
      }
    } catch {
      // Audio playback not available — silent fail
    }
  }

  private resumeAudioCtx(): void {
    if (!this.audioCtx || this.fadingOut) return;
    this.audioCtx.resume().then(() => {
      // Remove gesture listeners once resumed
      for (const evt of ['pointerdown', 'keydown'] as const) {
        document.removeEventListener(evt, this.onUserGesture);
      }
      if (!this.fadingOut && this.gainNode && this.audioCtx && audioSettings.windowFocused) {
        this.gainNode.gain.linearRampToValueAtTime(this.authMusicVolume, this.audioCtx.currentTime + 2);
      }
    });
  }

  private handleVisibilityChange(): void {
    if (this.fadingOut || !this.audioCtx || !this.gainNode) return;
    const ctx = this.audioCtx;
    const gain = this.gainNode;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    if (document.hidden) {
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
    } else {
      gain.gain.linearRampToValueAtTime(this.authMusicVolume, ctx.currentTime + 0.5);
    }
  }

  private fadeOutMusic(): void {
    this.fadingOut = true;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    for (const evt of ['pointerdown', 'keydown'] as const) {
      document.removeEventListener(evt, this.onUserGesture);
    }
    if (!this.audioCtx || !this.gainNode) return;
    const ctx = this.audioCtx;
    const gain = this.gainNode;
    // Fade out over 1.5 seconds, then stop and close
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.5);
    setTimeout(() => {
      this.sourceNode?.stop();
      ctx.close();
      this.audioCtx = null;
      this.gainNode = null;
      this.sourceNode = null;
    }, 1600);
  }

  destroy(): void {
    audioSettings.removeListener(this.onAudioSettingsChange);
    this.fadeOutMusic();
  }
}
