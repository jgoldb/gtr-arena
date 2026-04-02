import * as THREE from 'three';
import { CHARACTER_LIST, CHARACTERS, MAP_LIST, type CharacterId } from '@gtr/shared';
import type { DifficultyLevel } from '../engine/npc/ai/DifficultyProfile';
import { createCharacter } from '../engine/player/characters';
import type { CharacterModel, AnimationInput } from '../engine/player/characters';

/** Map character IDs to a short role tag. */
function getCharacterRole(id: string): string {
  switch (id) {
    case 'janitor': return 'Brawler';
    case 'crackhead': return 'Scrapper';
    case 'dr-retardo': return 'Caster';
    case 'rabbi-zehnwirth': return 'Healer';
    case 'brad-clemons': return 'Marksman';
    case 'gourd-of-war': return 'Tank';
    default: return 'Fighter';
  }
}

/** Map character IDs to a role accent color. */
function getRoleColor(id: string): string {
  switch (id) {
    case 'janitor': return '#e8a84c';
    case 'crackhead': return '#c45c5c';
    case 'dr-retardo': return '#7c6ce8';
    case 'rabbi-zehnwirth': return '#5cc4a8';
    case 'brad-clemons': return '#5ca8e8';
    case 'gourd-of-war': return '#8cc45c';
    default: return '#8888aa';
  }
}

const DIFFICULTY_LABELS: Record<DifficultyLevel, { name: string; color: string; desc: string }> = {
  easy:   { name: 'Easy',   color: '#4caf50', desc: 'Slow reactions, sloppy ability usage' },
  medium: { name: 'Medium', color: '#ff9800', desc: 'Balanced play, moderate reactions' },
  hard:   { name: 'Hard',   color: '#f44336', desc: 'Fast reactions, smart ability combos' },
  expert: { name: 'Expert', color: '#e040fb', desc: 'Near-perfect play, punishes every mistake' },
  master: { name: 'Master', color: '#448aff', desc: 'Perfect play, instant reactions, zero mistakes' },
};

/** Only characters with full ability sets can be AI opponents */
const AI_CHARACTERS = CHARACTER_LIST.filter(c => !c.playgroundOnly);

export interface SinglePlayerConfig {
  playerCharId: CharacterId;
  opponentCharId: CharacterId;
  difficulty: DifficultyLevel;
  mapId: string;
}

export class SinglePlayerScreen {
  readonly element: HTMLDivElement;
  private animFrameId = 0;
  private previewAnimId = 0;

  // Selections
  private playerCharId: CharacterId = 'janitor';
  private opponentCharId: CharacterId = AI_CHARACTERS.length > 1 ? AI_CHARACTERS[1].id as CharacterId : AI_CHARACTERS[0].id as CharacterId;
  private difficulty: DifficultyLevel = 'medium';
  private mapId: string = MAP_LIST[0]?.id ?? 'cage';

  // Selection mode: which side are we picking for?
  private selectingFor: 'player' | 'opponent' = 'player';

  // UI elements
  private charGridEl!: HTMLDivElement;
  private playerCardEl!: HTMLDivElement;
  private opponentCardEl!: HTMLDivElement;
  private diffBtns: HTMLButtonElement[] = [];
  private mapBtns: HTMLButtonElement[] = [];
  private diffDescEl!: HTMLDivElement;
  private fightBtn!: HTMLButtonElement;
  private playgroundWarningEl!: HTMLDivElement;
  private charStatsEl!: HTMLDivElement;

  // 3D preview
  private previewCanvas!: HTMLCanvasElement;
  private previewRenderer!: THREE.WebGLRenderer;
  private previewScene!: THREE.Scene;
  private previewCamera!: THREE.PerspectiveCamera;
  private previewModel: CharacterModel | null = null;
  private previewCharId: CharacterId | null = null;
  private previewRotY = 0;
  private lastPreviewTime = 0;
  private dragging = false;
  private dragLastX = 0;

  // Callbacks
  onFight?: (config: SinglePlayerConfig) => void;
  onBack?: () => void;
  onMenu?: () => void;

  constructor() {
    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed; inset: 0; z-index: 1000;
      display: flex; background: #05050a;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #ccc;
      overflow: hidden;
    `;

    // ── Inject animations ───────────────────────────────────────────
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      @keyframes sp-fade-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes sp-slide-left { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
      @keyframes sp-slide-right { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
      @keyframes sp-glow-pulse { 0%,100% { box-shadow: 0 0 15px rgba(200,140,60,0.1), 0 0 30px rgba(200,140,60,0.05); } 50% { box-shadow: 0 0 20px rgba(200,140,60,0.25), 0 0 40px rgba(200,140,60,0.1); } }
      .sp-btn { transition: all 0.15s ease; }
      .sp-btn:hover { filter: brightness(1.3); transform: translateY(-1px); }
      .sp-btn:active { transform: translateY(0); }
      .sp-char-card { transition: all 0.2s ease; position: relative; }
      .sp-char-card:hover { transform: translateY(-3px); background: rgba(30,40,65,0.95) !important; border-color: rgba(100,140,220,0.4) !important; box-shadow: 0 8px 24px rgba(0,0,0,0.4), 0 0 20px rgba(80,120,220,0.1) !important; }
      .sp-scrollbar::-webkit-scrollbar { width: 5px; }
      .sp-scrollbar::-webkit-scrollbar-track { background: transparent; }
      .sp-scrollbar::-webkit-scrollbar-thumb { background: rgba(100,120,200,0.2); border-radius: 3px; }
      .sp-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(100,120,200,0.35); }
      .sp-pick-card { transition: all 0.2s ease; cursor: pointer; }
      .sp-pick-card:hover { filter: brightness(1.15); transform: translateY(-2px); }
    `;
    this.element.appendChild(styleEl);

    // ── Background canvas ───────────────────────────────────────────
    const bgCanvas = document.createElement('canvas');
    bgCanvas.style.cssText = 'position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none;';
    this.element.appendChild(bgCanvas);
    this.initBackground(bgCanvas);

    // ── Main 3-column layout ────────────────────────────────────────
    const layout = document.createElement('div');
    layout.style.cssText = 'position: relative; z-index: 1; display: flex; flex: 1; min-height: 0;';

    // ═══════════ LEFT PANEL: Character Grid ═══════════
    const leftPanel = this.buildLeftPanel();
    layout.appendChild(leftPanel);

    // ═══════════ CENTER PANEL: Preview + Settings ═══════════
    const centerPanel = this.buildCenterPanel();
    layout.appendChild(centerPanel);

    // ═══════════ RIGHT PANEL: Match Setup ═══════════
    const rightPanel = this.buildRightPanel();
    layout.appendChild(rightPanel);

    this.element.appendChild(layout);

    // Initial state
    this.refreshCharGrid();
    this.refreshPickCards();
    this.refreshDiffButtons();
    this.refreshMapButtons();
    this.refreshFightButton();
    this.refreshCharStats();
    this.setPreviewCharacter(this.playerCharId);
  }

  // ── Left Panel: Character Selection Grid ──────────────────────────

  private buildLeftPanel(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.style.cssText = `
      width: 320px; display: flex; flex-direction: column; padding: 24px;
      border-right: 1px solid rgba(100,120,200,0.08);
      background: linear-gradient(to bottom, rgba(8,10,20,0.7), rgba(5,5,12,0.9));
      animation: sp-slide-left 0.4s ease both;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 20px;';
    const icon = document.createElement('div');
    icon.style.cssText = 'width: 8px; height: 8px; border-radius: 50%; background: #cc8844; box-shadow: 0 0 6px rgba(200,130,60,0.5);';
    const title = document.createElement('div');
    title.textContent = 'SELECT CHARACTER';
    title.style.cssText = 'font-size: 11px; font-weight: 700; letter-spacing: 2px; color: rgba(200,160,100,0.8);';
    header.append(icon, title);
    panel.appendChild(header);

    // Grid
    this.charGridEl = document.createElement('div');
    this.charGridEl.className = 'sp-scrollbar';
    this.charGridEl.style.cssText = `
      flex: 1; overflow-y: auto; overflow-x: hidden;
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 10px; align-content: start; padding: 4px 4px 4px 0;
    `;
    panel.appendChild(this.charGridEl);

    // Back button at bottom
    const backBtn = document.createElement('button');
    backBtn.className = 'sp-btn';
    backBtn.textContent = 'Back to Lobby';
    backBtn.style.cssText = `
      margin-top: 16px; padding: 10px 20px; font-size: 13px; font-weight: 600;
      background: rgba(60,60,80,0.6); color: #aaa; border: 1px solid rgba(100,100,140,0.2);
      border-radius: 6px; cursor: pointer; outline: none;
    `;
    backBtn.addEventListener('click', () => this.onBack?.());
    panel.appendChild(backBtn);

    return panel;
  }

  private refreshCharGrid(): void {
    this.charGridEl.innerHTML = '';

    // Only show non-playgroundOnly characters (ones that have abilities)
    const chars = this.selectingFor === 'opponent' ? AI_CHARACTERS : CHARACTER_LIST;

    for (const char of chars) {
      const isDisabled = !!char.playgroundOnly;
      const card = document.createElement('div');
      card.className = 'sp-char-card';
      card.style.cssText = `
        padding: 14px 12px; border-radius: 8px; cursor: pointer; text-align: center;
        background: rgba(12,15,28,0.85);
        border: 2px solid rgba(100,120,200,0.08);
        display: flex; flex-direction: column; align-items: center; justify-content: center;
      `;

      // Role accent bar
      const roleColor = getRoleColor(char.id);
      const accent = document.createElement('div');
      accent.style.cssText = `
        position: absolute; top: 0; left: 0; right: 0; height: 3px;
        background: linear-gradient(90deg, transparent, ${roleColor}, transparent);
        opacity: 0.6;
      `;
      card.appendChild(accent);

      const nameEl = document.createElement('div');
      nameEl.textContent = char.name;
      nameEl.style.cssText = 'font-weight: 600; font-size: 13px; color: #bbc4dd; margin-bottom: 4px; margin-top: 2px;';

      const roleEl = document.createElement('div');
      roleEl.textContent = getCharacterRole(char.id);
      roleEl.style.cssText = `font-size: 10px; color: ${roleColor}; letter-spacing: 0.5px; font-weight: 500;`;

      card.append(nameEl, roleEl);

      if (isDisabled) {
        const devLabel = document.createElement('div');
        devLabel.textContent = 'In Development';
        devLabel.style.cssText = 'font-size: 9px; font-weight: 600; color: #e05050; letter-spacing: 0.5px; margin-top: 6px;';
        card.appendChild(devLabel);
      }

      // Highlight selected
      const selectedId = this.selectingFor === 'player' ? this.playerCharId : this.opponentCharId;
      if (char.id === selectedId) {
        card.style.borderColor = 'rgba(200,160,60,0.5)';
        card.style.background = 'rgba(40,30,15,0.85)';
        card.style.boxShadow = '0 0 15px rgba(200,160,60,0.1), inset 0 0 20px rgba(200,160,60,0.05)';
      }

      card.addEventListener('click', () => {
        if (isDisabled && this.selectingFor === 'opponent') return;
        if (this.selectingFor === 'player') {
          this.playerCharId = char.id as CharacterId;
          this.setPreviewCharacter(this.playerCharId);
          this.refreshFightButton();
        } else {
          this.opponentCharId = char.id as CharacterId;
          this.setPreviewCharacter(this.opponentCharId);
        }
        this.refreshCharGrid();
        this.refreshPickCards();
        this.refreshCharStats();
      });

      this.charGridEl.appendChild(card);
    }
  }

  // ── Center Panel: 3D Preview ──────────────────────────────────────

  private buildCenterPanel(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.style.cssText = `
      flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 32px 24px; animation: sp-fade-in 0.5s ease both; min-width: 0;
    `;

    // VS header with pick cards
    const vsRow = document.createElement('div');
    vsRow.style.cssText = 'display: flex; align-items: center; gap: 24px; margin-bottom: 16px;';

    this.playerCardEl = document.createElement('div');
    this.playerCardEl.className = 'sp-pick-card';
    vsRow.appendChild(this.playerCardEl);

    const vsLabel = document.createElement('div');
    vsLabel.textContent = 'VS';
    vsLabel.style.cssText = 'font-size: 28px; font-weight: 900; color: rgba(200,160,60,0.7); letter-spacing: 4px;';
    vsRow.appendChild(vsLabel);

    this.opponentCardEl = document.createElement('div');
    this.opponentCardEl.className = 'sp-pick-card';
    vsRow.appendChild(this.opponentCardEl);

    panel.appendChild(vsRow);

    // 3D Preview
    const previewWrapper = document.createElement('div');
    previewWrapper.style.cssText = `
      position: relative; display: flex; flex-direction: column; align-items: center;
      flex: 1; max-height: 450px; min-height: 250px;
    `;

    const previewGlow = document.createElement('div');
    previewGlow.style.cssText = `
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: 280px; height: 280px; border-radius: 50%;
      background: radial-gradient(circle, rgba(160,100,40,0.12) 0%, transparent 70%);
      pointer-events: none;
    `;
    previewWrapper.appendChild(previewGlow);

    const platform = document.createElement('div');
    platform.style.cssText = `
      position: absolute; bottom: 32px; left: 50%; transform: translateX(-50%);
      width: 200px; height: 40px; border-radius: 50%;
      background: radial-gradient(ellipse, rgba(160,100,40,0.15) 0%, transparent 70%);
      pointer-events: none;
    `;
    previewWrapper.appendChild(platform);

    this.previewCanvas = document.createElement('canvas');
    this.previewCanvas.width = 400;
    this.previewCanvas.height = 440;
    this.previewCanvas.style.cssText = 'border-radius: 8px; max-width: 100%; max-height: 100%; object-fit: contain; cursor: grab;';
    previewWrapper.appendChild(this.previewCanvas);

    // Drag-to-rotate
    const dragStyle = document.createElement('style');
    dragStyle.textContent = 'body.sp-dragging, body.sp-dragging * { cursor: grabbing !important; }';
    this.element.appendChild(dragStyle);

    this.previewCanvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !this.previewModel) return;
      this.dragging = true;
      this.dragLastX = e.clientX;
      document.body.classList.add('sp-dragging');
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.dragLastX;
      this.dragLastX = e.clientX;
      this.previewRotY += dx * 0.01;
    });
    window.addEventListener('mouseup', () => {
      if (!this.dragging) return;
      this.dragging = false;
      document.body.classList.remove('sp-dragging');
    });

    panel.appendChild(previewWrapper);

    // Character stats (HP / Mana)
    this.charStatsEl = document.createElement('div');
    this.charStatsEl.style.cssText = `
      display: flex; gap: 20px; justify-content: center; margin-top: 12px;
      min-height: 18px;
    `;
    panel.appendChild(this.charStatsEl);

    // Setup Three.js
    this.previewRenderer = new THREE.WebGLRenderer({ canvas: this.previewCanvas, alpha: true, antialias: true });
    this.previewRenderer.setSize(400, 440);
    this.previewRenderer.setClearColor(0x000000, 0);
    this.previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.previewScene = new THREE.Scene();
    this.previewScene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(1, 2, 2);
    this.previewScene.add(dirLight);
    const rimLight = new THREE.DirectionalLight(0x4466aa, 0.4);
    rimLight.position.set(-1, 1, -2);
    this.previewScene.add(rimLight);

    this.previewCamera = new THREE.PerspectiveCamera(30, 400 / 440, 0.1, 20);
    this.previewCamera.position.set(0, 1.0, 4.6);
    this.previewCamera.lookAt(0, 0.9, 0);

    this.lastPreviewTime = performance.now();
    this.startPreviewLoop();

    return panel;
  }

  private refreshPickCards(): void {
    // Player card
    this.renderPickCard(this.playerCardEl, this.playerCharId, 'YOU', this.selectingFor === 'player');
    this.playerCardEl.onclick = () => {
      this.selectingFor = 'player';
      this.setPreviewCharacter(this.playerCharId);
      this.refreshCharGrid();
      this.refreshPickCards();
      this.refreshCharStats();
    };

    // Opponent card
    this.renderPickCard(this.opponentCardEl, this.opponentCharId, 'OPPONENT', this.selectingFor === 'opponent');
    this.opponentCardEl.onclick = () => {
      this.selectingFor = 'opponent';
      this.setPreviewCharacter(this.opponentCharId);
      this.refreshCharGrid();
      this.refreshPickCards();
      this.refreshCharStats();
    };
  }

  private renderPickCard(el: HTMLDivElement, charId: CharacterId, label: string, isActive: boolean): void {
    const stats = CHARACTERS[charId];
    const roleColor = getRoleColor(charId);
    const borderColor = isActive ? 'rgba(200,160,60,0.6)' : 'rgba(100,120,200,0.15)';
    const bgColor = isActive ? 'rgba(40,30,15,0.9)' : 'rgba(12,15,28,0.85)';

    el.style.cssText = `
      padding: 12px 20px; border-radius: 8px; cursor: pointer; text-align: center;
      background: ${bgColor}; border: 2px solid ${borderColor};
      min-width: 120px; transition: all 0.2s ease;
      ${isActive ? 'box-shadow: 0 0 15px rgba(200,160,60,0.15);' : ''}
    `;
    el.innerHTML = `
      <div style="font-size: 9px; font-weight: 700; letter-spacing: 2px; color: rgba(200,160,100,0.6); margin-bottom: 6px;">${label}</div>
      <div style="font-weight: 700; font-size: 15px; color: #dde2f0; margin-bottom: 3px;">${stats.displayName}</div>
      <div style="font-size: 10px; color: ${roleColor}; letter-spacing: 0.5px; font-weight: 500;">${getCharacterRole(charId)}</div>
    `;
  }

  // ── Right Panel: Difficulty, Map, Fight ────────────────────────────

  private buildRightPanel(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.style.cssText = `
      width: 320px; display: flex; flex-direction: column; padding: 24px;
      border-left: 1px solid rgba(100,120,200,0.08);
      background: linear-gradient(to bottom, rgba(8,10,20,0.7), rgba(5,5,12,0.9));
      animation: sp-slide-right 0.4s ease both;
    `;

    // ── Difficulty Section ──
    const diffHeader = document.createElement('div');
    diffHeader.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 16px;';
    const diffIcon = document.createElement('div');
    diffIcon.style.cssText = 'width: 8px; height: 8px; border-radius: 50%; background: #cc6644; box-shadow: 0 0 6px rgba(200,100,60,0.5);';
    const diffTitle = document.createElement('div');
    diffTitle.textContent = 'DIFFICULTY';
    diffTitle.style.cssText = 'font-size: 11px; font-weight: 700; letter-spacing: 2px; color: rgba(200,130,100,0.8);';
    diffHeader.append(diffIcon, diffTitle);
    panel.appendChild(diffHeader);

    const diffGrid = document.createElement('div');
    diffGrid.style.cssText = 'display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px;';

    for (const [key, info] of Object.entries(DIFFICULTY_LABELS) as [DifficultyLevel, typeof DIFFICULTY_LABELS[DifficultyLevel]][]) {
      const btn = document.createElement('button');
      btn.className = 'sp-btn';
      btn.dataset.diff = key;
      btn.textContent = info.name;
      btn.style.cssText = `
        padding: 10px 16px; font-size: 13px; font-weight: 700; letter-spacing: 1px;
        border-radius: 6px; cursor: pointer; outline: none; text-align: left;
        border: 1px solid rgba(100,120,200,0.1);
        background: rgba(20,25,40,0.6); color: rgba(150,160,180,0.6);
      `;
      btn.addEventListener('click', () => {
        this.difficulty = key;
        this.refreshDiffButtons();
      });
      this.diffBtns.push(btn);
      diffGrid.appendChild(btn);
    }
    panel.appendChild(diffGrid);

    this.diffDescEl = document.createElement('div');
    this.diffDescEl.style.cssText = 'font-size: 11px; color: rgba(180,170,150,0.6); margin-bottom: 28px; min-height: 16px; padding: 0 4px;';
    panel.appendChild(this.diffDescEl);

    // ── Map Section ──
    const mapHeader = document.createElement('div');
    mapHeader.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 16px;';
    const mapIcon = document.createElement('div');
    mapIcon.style.cssText = 'width: 8px; height: 8px; border-radius: 50%; background: #4488cc; box-shadow: 0 0 6px rgba(60,130,200,0.5);';
    const mapTitle = document.createElement('div');
    mapTitle.textContent = 'ARENA';
    mapTitle.style.cssText = 'font-size: 11px; font-weight: 700; letter-spacing: 2px; color: rgba(100,160,200,0.8);';
    mapHeader.append(mapIcon, mapTitle);
    panel.appendChild(mapHeader);

    const mapGrid = document.createElement('div');
    mapGrid.style.cssText = 'display: flex; flex-direction: column; gap: 6px; margin-bottom: 28px;';

    for (const map of MAP_LIST) {
      const disabled = map.playableInSinglePlayer === false;
      const btn = document.createElement('button');
      btn.className = 'sp-btn';
      btn.dataset.mapId = map.id;
      btn.textContent = map.name;
      btn.disabled = disabled;
      if (disabled) btn.title = 'This map is not playable yet';
      btn.style.cssText = `
        padding: 10px 16px; font-size: 13px; font-weight: 600;
        border-radius: 6px; cursor: ${disabled ? 'not-allowed' : 'pointer'}; outline: none; text-align: left;
        border: 1px solid rgba(100,120,200,0.1);
        background: rgba(20,25,40,0.6); color: rgba(150,160,180,${disabled ? '0.25' : '0.6'});
        ${disabled ? 'opacity: 0.5;' : ''}
      `;
      if (!disabled) {
        btn.addEventListener('click', () => {
          this.mapId = map.id;
          this.refreshMapButtons();
        });
      }
      this.mapBtns.push(btn);
      mapGrid.appendChild(btn);
    }
    panel.appendChild(mapGrid);

    // Spacer
    const spacer = document.createElement('div');
    spacer.style.cssText = 'flex: 1;';
    panel.appendChild(spacer);

    // ── Playground-only warning ──
    this.playgroundWarningEl = document.createElement('div');
    this.playgroundWarningEl.textContent = 'This character is not playable yet.';
    this.playgroundWarningEl.style.cssText = `
      display: none; text-align: center; font-size: 11px; font-weight: 500;
      color: #e05050; margin-bottom: 12px; padding: 6px 10px;
      background: rgba(224,80,80,0.08); border-radius: 5px;
      border: 1px solid rgba(224,80,80,0.15);
    `;
    panel.appendChild(this.playgroundWarningEl);

    // ── FIGHT Button ──
    this.fightBtn = document.createElement('button');
    this.fightBtn.className = 'sp-btn';
    this.fightBtn.textContent = 'FIGHT';
    this.fightBtn.style.cssText = `
      padding: 16px 32px; font-size: 20px; font-weight: 900; letter-spacing: 4px;
      border-radius: 8px; cursor: pointer; outline: none;
      background: linear-gradient(135deg, rgba(200,120,30,0.8), rgba(180,80,20,0.9));
      color: #fff; border: 2px solid rgba(255,180,60,0.4);
      box-shadow: 0 4px 20px rgba(200,120,30,0.3);
      animation: sp-glow-pulse 3s ease-in-out infinite;
    `;
    this.fightBtn.addEventListener('click', () => {
      this.onFight?.({
        playerCharId: this.playerCharId,
        opponentCharId: this.opponentCharId,
        difficulty: this.difficulty,
        mapId: this.mapId,
      });
    });
    panel.appendChild(this.fightBtn);

    return panel;
  }

  private refreshDiffButtons(): void {
    for (const btn of this.diffBtns) {
      const key = btn.dataset.diff as DifficultyLevel;
      const info = DIFFICULTY_LABELS[key];
      const isActive = key === this.difficulty;
      if (isActive) {
        btn.style.background = `rgba(${this.hexToRgb(info.color)}, 0.2)`;
        btn.style.borderColor = info.color;
        btn.style.color = info.color;
      } else {
        btn.style.background = 'rgba(20,25,40,0.6)';
        btn.style.borderColor = 'rgba(100,120,200,0.1)';
        btn.style.color = 'rgba(150,160,180,0.6)';
      }
    }
    this.diffDescEl.textContent = DIFFICULTY_LABELS[this.difficulty].desc;
    this.diffDescEl.style.color = DIFFICULTY_LABELS[this.difficulty].color;
  }

  private refreshMapButtons(): void {
    for (const btn of this.mapBtns) {
      if (btn.disabled) continue;
      const isActive = btn.dataset.mapId === this.mapId;
      if (isActive) {
        btn.style.background = 'rgba(50,70,140,0.6)';
        btn.style.borderColor = 'rgba(100,140,255,0.5)';
        btn.style.color = '#aac0ff';
      } else {
        btn.style.background = 'rgba(20,25,40,0.6)';
        btn.style.borderColor = 'rgba(100,120,200,0.1)';
        btn.style.color = 'rgba(150,160,180,0.6)';
      }
    }
  }

  private refreshCharStats(): void {
    this.charStatsEl.innerHTML = '';
    const charId = this.selectingFor === 'player' ? this.playerCharId : this.opponentCharId;
    const stats = CHARACTERS[charId];
    if (!stats) return;
    const statItems: [string, string][] = [
      ['HP', String(stats.baseMaxHp)],
      ['Mana', String(stats.baseMaxMana)],
    ];
    for (const [label, value] of statItems) {
      const stat = document.createElement('div');
      stat.style.cssText = 'text-align: center;';
      const valEl = document.createElement('div');
      valEl.textContent = value;
      valEl.style.cssText = 'font-size: 15px; font-weight: 700; color: rgba(200,210,240,0.9);';
      const labelEl = document.createElement('div');
      labelEl.textContent = label;
      labelEl.style.cssText = 'font-size: 9px; color: rgba(120,130,160,0.5); letter-spacing: 1px; font-weight: 600; margin-top: 2px;';
      stat.appendChild(valEl);
      stat.appendChild(labelEl);
      this.charStatsEl.appendChild(stat);
    }
  }

  private refreshFightButton(): void {
    const isPlaygroundOnly = !!CHARACTER_LIST.find(c => c.id === this.playerCharId)?.playgroundOnly;
    this.playgroundWarningEl.style.display = isPlaygroundOnly ? 'block' : 'none';
    this.fightBtn.disabled = isPlaygroundOnly;
    this.fightBtn.style.opacity = isPlaygroundOnly ? '0.4' : '1';
    this.fightBtn.style.pointerEvents = isPlaygroundOnly ? 'none' : 'auto';
    this.fightBtn.style.animation = isPlaygroundOnly ? 'none' : 'sp-glow-pulse 3s ease-in-out infinite';
  }

  // ── 3D Preview ────────────────────────────────────────────────────

  private setPreviewCharacter(charId: CharacterId | null): void {
    if (charId === this.previewCharId) return;
    this.previewCharId = charId;
    this.previewRotY = 0;

    if (this.previewModel) {
      this.previewScene.remove(this.previewModel.group);
      this.previewModel.dispose();
      this.previewModel = null;
    }

    if (!charId) {
      this.previewRenderer.render(this.previewScene, this.previewCamera);
      return;
    }

    const model = createCharacter(charId);
    if (charId === 'rabbi-zehnwirth') model.group.position.y = -0.25;
    this.previewScene.add(model.group);
    this.previewModel = model;
  }

  private startPreviewLoop(): void {
    const idleInput: AnimationInput = {
      isMoving: false, isGrounded: true, velocityY: 0,
      turnSpeed: 0, speedMultiplier: 1, strafeDirection: 0,
    };

    const loop = (now: number) => {
      this.previewAnimId = requestAnimationFrame(loop);
      if (document.hidden) return;

      const dt = Math.min((now - this.lastPreviewTime) / 1000, 0.1);
      this.lastPreviewTime = now;

      if (this.previewModel) {
        this.previewModel.group.rotation.y = Math.PI + this.previewRotY;
        this.previewModel.update(dt, idleInput);
        this.previewRenderer.render(this.previewScene, this.previewCamera);
      }
    };

    this.previewAnimId = requestAnimationFrame(loop);
  }

  // ── Background ────────────────────────────────────────────────────

  private initBackground(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d')!;
    const orbs: { x: number; y: number; r: number; dx: number; dy: number; color: string; alpha: number }[] = [];

    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    window.addEventListener('resize', resize);

    for (let i = 0; i < 7; i++) {
      orbs.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: 120 + Math.random() * 250,
        dx: (Math.random() - 0.5) * 0.25,
        dy: (Math.random() - 0.5) * 0.25,
        color: ['#2a1a10', '#1a1520', '#201510', '#1a2010', '#251510', '#1a1008', '#201a10'][i],
        alpha: 0.25 + Math.random() * 0.15,
      });
    }

    let lastDrawTime = 0;
    const draw = (now: number) => {
      this.animFrameId = requestAnimationFrame(draw);
      if (document.hidden) return;
      if (now - lastDrawTime < 66) return;
      lastDrawTime = now;

      ctx.fillStyle = '#05050a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (const o of orbs) {
        o.x += o.dx; o.y += o.dy;
        if (o.x < -o.r) o.x = canvas.width + o.r;
        if (o.x > canvas.width + o.r) o.x = -o.r;
        if (o.y < -o.r) o.y = canvas.height + o.r;
        if (o.y > canvas.height + o.r) o.y = -o.r;

        const grad = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r);
        grad.addColorStop(0, o.color);
        grad.addColorStop(1, 'transparent');
        ctx.globalAlpha = o.alpha;
        ctx.fillStyle = grad;
        ctx.fillRect(o.x - o.r, o.y - o.r, o.r * 2, o.r * 2);
      }
      ctx.globalAlpha = 1;
    };
    this.animFrameId = requestAnimationFrame(draw);
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private hexToRgb(hex: string): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${r},${g},${b}`;
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  destroy(): void {
    cancelAnimationFrame(this.animFrameId);
    cancelAnimationFrame(this.previewAnimId);
    if (this.previewModel) {
      this.previewScene.remove(this.previewModel.group);
      this.previewModel.dispose();
      this.previewModel = null;
    }
    this.previewRenderer.dispose();
    this.element.remove();
  }
}
