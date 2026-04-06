import { CHARACTER_LIST, MAP_LIST, type CharacterId } from '@gtr/shared';
import type { DifficultyLevel } from '../engine/npc/ai/DifficultyProfile';
import type { NpcBehaviorMode } from '../engine/npc/ai/NpcAiBrain';

const DIFFICULTY_LABELS: Record<DifficultyLevel, { name: string; color: string }> = {
  easy:   { name: 'Easy',   color: '#4caf50' },
  medium: { name: 'Medium', color: '#ff9800' },
  hard:   { name: 'Hard',   color: '#f44336' },
  expert: { name: 'Expert', color: '#e040fb' },
  master: { name: 'Master', color: '#448aff' },
  neural: { name: 'Neural', color: '#00e5ff' },
};

const DIFFICULTY_ORDER: DifficultyLevel[] = ['easy', 'medium', 'hard', 'expert', 'master', 'neural'];

const BEHAVIOR_MODE_LABELS: Record<NpcBehaviorMode, { name: string; color: string }> = {
  aggressive: { name: 'Aggressive', color: '#f44336' },
  passive:    { name: 'Passive',    color: '#4caf50' },
  kiting:     { name: 'Kiting',     color: '#ff9800' },
};

const BEHAVIOR_MODE_ORDER: NpcBehaviorMode[] = ['aggressive', 'passive', 'kiting'];

/** Only characters with full ability sets can be AI opponents. */
const AI_CHARACTERS = CHARACTER_LIST.filter(c => !c.playgroundOnly);

export interface SpectatorConfig {
  char1: CharacterId;
  diff1: DifficultyLevel;
  mode1: NpcBehaviorMode;
  char2: CharacterId;
  diff2: DifficultyLevel;
  mode2: NpcBehaviorMode;
  mapId: string;
}

export class SpectatorScreen {
  readonly element: HTMLDivElement;

  private char1: CharacterId = AI_CHARACTERS[0]?.id as CharacterId ?? 'janitor';
  private diff1: DifficultyLevel = 'master';
  private mode1: NpcBehaviorMode = 'aggressive';
  private char2: CharacterId = AI_CHARACTERS.length > 1 ? AI_CHARACTERS[1].id as CharacterId : AI_CHARACTERS[0].id as CharacterId;
  private diff2: DifficultyLevel = 'master';
  private mode2: NpcBehaviorMode = 'aggressive';
  private mapId: string = MAP_LIST[0]?.id ?? 'cage';

  onWatch?: (config: SpectatorConfig) => void;
  onBack?: () => void;

  constructor() {
    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed; inset: 0; z-index: 1000;
      display: flex; align-items: center; justify-content: center;
      background: #05050a;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #ccc;
    `;

    const styleEl = document.createElement('style');
    styleEl.textContent = `
      .spec-btn { transition: all 0.15s ease; cursor: pointer; outline: none; }
      .spec-btn:hover { filter: brightness(1.3); transform: translateY(-1px); }
      .spec-btn:active { transform: translateY(0); }
      .spec-select { background: rgba(20,22,40,0.9); color: #ccc; border: 1px solid rgba(100,120,200,0.2);
        border-radius: 6px; padding: 8px 12px; font-size: 14px; cursor: pointer; outline: none;
        font-family: inherit; }
      .spec-select:hover { border-color: rgba(100,120,200,0.4); }
      .spec-select option { background: #12142a; color: #ccc; }
    `;
    this.element.appendChild(styleEl);

    const panel = document.createElement('div');
    panel.style.cssText = `
      background: rgba(10,12,25,0.95); border: 1px solid rgba(100,120,200,0.1);
      border-radius: 12px; padding: 40px 48px; min-width: 500px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6);
    `;

    // Title
    const title = document.createElement('div');
    title.textContent = 'SPECTATOR MODE';
    title.style.cssText = `
      text-align: center; font-size: 13px; font-weight: 700; letter-spacing: 3px;
      color: rgba(200,160,100,0.8); margin-bottom: 32px;
    `;
    panel.appendChild(title);

    // Fighter rows
    const matchupRow = document.createElement('div');
    matchupRow.style.cssText = 'display: flex; align-items: center; gap: 24px; justify-content: center; margin-bottom: 28px;';

    matchupRow.appendChild(this.buildFighterColumn('Fighter 1', this.char1, this.diff1, this.mode1,
      (c, d, m) => { this.char1 = c; this.diff1 = d; this.mode1 = m; }));

    const vs = document.createElement('div');
    vs.textContent = 'VS';
    vs.style.cssText = 'font-size: 18px; font-weight: 800; color: rgba(200,140,60,0.6); letter-spacing: 2px;';
    matchupRow.appendChild(vs);

    matchupRow.appendChild(this.buildFighterColumn('Fighter 2', this.char2, this.diff2, this.mode2,
      (c, d, m) => { this.char2 = c; this.diff2 = d; this.mode2 = m; }));

    panel.appendChild(matchupRow);

    // Map selector
    const mapSection = document.createElement('div');
    mapSection.style.cssText = 'margin-bottom: 28px;';
    const mapLabel = document.createElement('div');
    mapLabel.textContent = 'MAP';
    mapLabel.style.cssText = 'font-size: 10px; font-weight: 700; letter-spacing: 2px; color: rgba(180,180,200,0.5); margin-bottom: 8px; text-align: center;';
    mapSection.appendChild(mapLabel);

    const mapRow = document.createElement('div');
    mapRow.style.cssText = 'display: flex; gap: 8px; justify-content: center;';
    for (const map of MAP_LIST) {
      const btn = document.createElement('button');
      btn.className = 'spec-btn';
      btn.textContent = map.name;
      const isActive = map.id === this.mapId;
      btn.style.cssText = `
        padding: 8px 18px; font-size: 13px; font-weight: 600; border-radius: 6px;
        border: 1px solid ${isActive ? 'rgba(200,140,60,0.5)' : 'rgba(100,100,140,0.2)'};
        background: ${isActive ? 'rgba(200,140,60,0.15)' : 'rgba(40,40,60,0.5)'};
        color: ${isActive ? '#e8a84c' : '#888'};
      `;
      btn.addEventListener('click', () => {
        this.mapId = map.id;
        // Refresh map buttons
        const btns = mapRow.querySelectorAll('button');
        btns.forEach(b => {
          const active = b.textContent === map.name;
          b.style.borderColor = active ? 'rgba(200,140,60,0.5)' : 'rgba(100,100,140,0.2)';
          b.style.background = active ? 'rgba(200,140,60,0.15)' : 'rgba(40,40,60,0.5)';
          b.style.color = active ? '#e8a84c' : '#888';
        });
      });
      mapRow.appendChild(btn);
    }
    mapSection.appendChild(mapRow);
    panel.appendChild(mapSection);

    // Buttons row
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 12px; justify-content: center;';

    const backBtn = document.createElement('button');
    backBtn.className = 'spec-btn';
    backBtn.textContent = 'Back';
    backBtn.style.cssText = `
      padding: 12px 28px; font-size: 14px; font-weight: 600;
      background: rgba(60,60,80,0.6); color: #aaa; border: 1px solid rgba(100,100,140,0.2);
      border-radius: 8px;
    `;
    backBtn.addEventListener('click', () => this.onBack?.());
    btnRow.appendChild(backBtn);

    const watchBtn = document.createElement('button');
    watchBtn.className = 'spec-btn';
    watchBtn.textContent = 'Watch';
    watchBtn.style.cssText = `
      padding: 12px 36px; font-size: 15px; font-weight: 700;
      background: linear-gradient(135deg, rgba(200,140,60,0.3), rgba(200,100,40,0.2));
      color: #e8a84c; border: 1px solid rgba(200,140,60,0.4);
      border-radius: 8px; letter-spacing: 1px;
    `;
    watchBtn.addEventListener('click', () => {
      this.onWatch?.({
        char1: this.char1,
        diff1: this.diff1,
        mode1: this.mode1,
        char2: this.char2,
        diff2: this.diff2,
        mode2: this.mode2,
        mapId: this.mapId,
      });
    });
    btnRow.appendChild(watchBtn);

    panel.appendChild(btnRow);
    this.element.appendChild(panel);
  }

  private buildFighterColumn(
    label: string,
    initialChar: CharacterId,
    initialDiff: DifficultyLevel,
    initialMode: NpcBehaviorMode,
    onChange: (char: CharacterId, diff: DifficultyLevel, mode: NpcBehaviorMode) => void,
  ): HTMLDivElement {
    let currentChar = initialChar;
    let currentDiff = initialDiff;
    let currentMode = initialMode;

    const col = document.createElement('div');
    col.style.cssText = 'display: flex; flex-direction: column; align-items: center; gap: 10px; min-width: 180px;';

    const labelEl = document.createElement('div');
    labelEl.textContent = label.toUpperCase();
    labelEl.style.cssText = 'font-size: 10px; font-weight: 700; letter-spacing: 2px; color: rgba(180,180,200,0.5);';
    col.appendChild(labelEl);

    // Character select
    const charSelect = document.createElement('select');
    charSelect.className = 'spec-select';
    charSelect.style.width = '100%';
    for (const c of AI_CHARACTERS) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      if (c.id === initialChar) opt.selected = true;
      charSelect.appendChild(opt);
    }
    charSelect.addEventListener('change', () => {
      currentChar = charSelect.value as CharacterId;
      onChange(currentChar, currentDiff, currentMode);
    });
    col.appendChild(charSelect);

    // Difficulty select
    const diffSelect = document.createElement('select');
    diffSelect.className = 'spec-select';
    diffSelect.style.width = '100%';
    for (const d of DIFFICULTY_ORDER) {
      const dl = DIFFICULTY_LABELS[d];
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = dl.name;
      opt.style.color = dl.color;
      if (d === initialDiff) opt.selected = true;
      diffSelect.appendChild(opt);
    }
    diffSelect.addEventListener('change', () => {
      currentDiff = diffSelect.value as DifficultyLevel;
      // Hide behavior mode for neural (it uses its own movement)
      modeSelect.style.display = currentDiff === 'neural' ? 'none' : '';
      onChange(currentChar, currentDiff, currentMode);
    });
    col.appendChild(diffSelect);

    // Behavior mode select (hidden for neural difficulty)
    const modeSelect = document.createElement('select');
    modeSelect.className = 'spec-select';
    modeSelect.style.width = '100%';
    if (initialDiff === 'neural') modeSelect.style.display = 'none';
    for (const m of BEHAVIOR_MODE_ORDER) {
      const ml = BEHAVIOR_MODE_LABELS[m];
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = ml.name;
      opt.style.color = ml.color;
      if (m === initialMode) opt.selected = true;
      modeSelect.appendChild(opt);
    }
    modeSelect.addEventListener('change', () => {
      currentMode = modeSelect.value as NpcBehaviorMode;
      onChange(currentChar, currentDiff, currentMode);
    });
    col.appendChild(modeSelect);

    return col;
  }

  show(): void {
    if (!this.element.parentElement) {
      document.body.appendChild(this.element);
    }
  }

  hide(): void {
    this.element.remove();
  }

  dispose(): void {
    this.hide();
  }
}
