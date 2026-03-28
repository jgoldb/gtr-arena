const STORAGE_KEY = 'gtr_audio_settings';

export interface AudioSettingsData {
  masterVolume: number;   // 0–1
  enableMusic: boolean;
}

const defaults: AudioSettingsData = {
  masterVolume: 0.25,
  enableMusic: true,
};

type Listener = (settings: AudioSettingsData) => void;

class AudioSettingsStore {
  private data: AudioSettingsData;
  private listeners: Listener[] = [];

  constructor() {
    this.data = { ...defaults };
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.masterVolume === 'number') this.data.masterVolume = Math.max(0, Math.min(1, parsed.masterVolume));
        if (typeof parsed.enableMusic === 'boolean') this.data.enableMusic = parsed.enableMusic;
      }
    } catch { /* corrupt data — use defaults */ }
  }

  get masterVolume(): number { return this.data.masterVolume; }
  get enableMusic(): boolean { return this.data.enableMusic; }

  update(partial: Partial<AudioSettingsData>): void {
    Object.assign(this.data, partial);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data)); } catch { /* quota */ }
    for (const fn of this.listeners) fn(this.data);
  }

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }

  removeListener(fn: Listener): void {
    this.listeners = this.listeners.filter(l => l !== fn);
  }
}

export const audioSettings = new AudioSettingsStore();
