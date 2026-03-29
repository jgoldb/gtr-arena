const STORAGE_KEY = 'gtr_audio_settings';

export interface AudioSettingsData {
  masterVolume: number;   // 0–1
  enableMusic: boolean;
  musicVolume: number;    // 0–1
  enableSfx: boolean;
  sfxVolume: number;      // 0–1
}

const defaults: AudioSettingsData = {
  masterVolume: 0.25,
  enableMusic: true,
  musicVolume: 1.0,
  enableSfx: true,
  sfxVolume: 0.5,
};

type Listener = (settings: AudioSettingsData) => void;

class AudioSettingsStore {
  private data: AudioSettingsData;
  private listeners: Listener[] = [];
  private _windowFocused = document.hasFocus();

  constructor() {
    this.data = { ...defaults };
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.masterVolume === 'number') this.data.masterVolume = Math.max(0, Math.min(1, parsed.masterVolume));
        if (typeof parsed.enableMusic === 'boolean') this.data.enableMusic = parsed.enableMusic;
        if (typeof parsed.musicVolume === 'number') this.data.musicVolume = Math.max(0, Math.min(1, parsed.musicVolume));
        if (typeof parsed.enableSfx === 'boolean') this.data.enableSfx = parsed.enableSfx;
        if (typeof parsed.sfxVolume === 'number') this.data.sfxVolume = Math.max(0, Math.min(1, parsed.sfxVolume));
      }
    } catch { /* corrupt data — use defaults */ }

    // Track window focus so unfocused tabs are silent
    window.addEventListener('focus', () => {
      this._windowFocused = true;
      this.notify();
    });
    window.addEventListener('blur', () => {
      this._windowFocused = false;
      this.notify();
    });
    document.addEventListener('visibilitychange', () => {
      this._windowFocused = document.hasFocus();
      this.notify();
    });
  }

  private notify(): void {
    for (const fn of this.listeners) fn(this.data);
  }

  get masterVolume(): number { return this.data.masterVolume; }
  get enableMusic(): boolean { return this.data.enableMusic; }
  get musicVolume(): number { return this.data.musicVolume; }
  get enableSfx(): boolean { return this.data.enableSfx; }
  get sfxVolume(): number { return this.data.sfxVolume; }
  get windowFocused(): boolean { return this._windowFocused; }

  update(partial: Partial<AudioSettingsData>): void {
    Object.assign(this.data, partial);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data)); } catch { /* quota */ }
    this.notify();
  }

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }

  removeListener(fn: Listener): void {
    this.listeners = this.listeners.filter(l => l !== fn);
  }
}

export const audioSettings = new AudioSettingsStore();
