import { audioSettings } from './AudioSettings';

export class MusicController {
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private fadingOut = false;
  private _startId = 0;
  private _onVisibilityChange: (() => void) | null = null;
  private _onUserGesture: (() => void) | null = null;

  constructor(private readonly audioUrl: string) {}

  get volume(): number {
    return audioSettings.windowFocused ? audioSettings.masterVolume * audioSettings.musicVolume : 0;
  }

  get isPlaying(): boolean {
    return this.audioCtx !== null && !this.fadingOut;
  }

  private onVisibilityChange(): void {
    if (this.fadingOut || !this.audioCtx || !this.gainNode) return;
    const ctx = this.audioCtx;
    const gain = this.gainNode;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    if (!audioSettings.windowFocused) {
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
    } else {
      gain.gain.linearRampToValueAtTime(this.volume, ctx.currentTime + 0.5);
    }
  }

  private resumeAudioCtx(): void {
    if (!this.audioCtx || this.fadingOut) return;
    this.audioCtx.resume().then(() => {
      const handler = this._onUserGesture;
      if (handler) for (const evt of ['pointerdown', 'keydown'] as const) {
        document.removeEventListener(evt, handler);
      }
      if (!this.fadingOut && this.gainNode && this.audioCtx && !document.hidden) {
        this.gainNode.gain.linearRampToValueAtTime(this.volume, this.audioCtx.currentTime + 2);
      }
    });
  }

  async start(): Promise<void> {
    if (!audioSettings.enableMusic) return;
    // Already playing — nothing to do
    if (this.audioCtx && !this.fadingOut) return;
    const id = ++this._startId;
    // Was fading out — wait for cleanup then restart
    if (this.fadingOut) {
      await new Promise<void>(r => setTimeout(r, 1700));
    }
    // If fadeOut() or another start() was called during the wait, abort
    if (id !== this._startId) return;
    this.fadingOut = false;
    try {
      const ctx = new AudioContext();
      this.audioCtx = ctx;
      const gain = ctx.createGain();
      this.gainNode = gain;
      gain.gain.value = 0;
      gain.connect(ctx.destination);

      const resp = await fetch(this.audioUrl);
      const buf = await resp.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(buf);

      if (this.fadingOut || id !== this._startId) {
        ctx.close();
        this.audioCtx = null;
        this.gainNode = null;
        return;
      }

      const source = ctx.createBufferSource();
      this.sourceNode = source;
      source.buffer = audioBuf;
      source.loop = true;
      source.connect(gain);
      source.start();

      this._onVisibilityChange = () => this.onVisibilityChange();
      this._onUserGesture = () => this.resumeAudioCtx();
      document.addEventListener('visibilitychange', this._onVisibilityChange);

      if (ctx.state === 'suspended') {
        for (const evt of ['pointerdown', 'keydown'] as const) {
          document.addEventListener(evt, this._onUserGesture, { once: false });
        }
      } else if (!document.hidden) {
        gain.gain.linearRampToValueAtTime(this.volume, ctx.currentTime + 2);
      }
    } catch {
      // Audio playback not available — silent fail
    }
  }

  fadeOut(): void {
    this._startId++;  // Cancel any in-progress start()
    this.fadingOut = true;
    if (this._onVisibilityChange) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }
    if (this._onUserGesture) {
      const handler = this._onUserGesture;
      for (const evt of ['pointerdown', 'keydown'] as const) {
        document.removeEventListener(evt, handler);
      }
    }
    if (!this.audioCtx || !this.gainNode) return;
    const ctx = this.audioCtx;
    const gain = this.gainNode;
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

  applyVolume(): void {
    if (!this.audioCtx || !this.gainNode || this.fadingOut) return;
    const ctx = this.audioCtx;
    const gain = this.gainNode;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(this.volume, ctx.currentTime + 0.15);
  }
}
