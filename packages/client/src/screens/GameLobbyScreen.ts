import type { NetworkManager } from '../network/NetworkManager';
import type { GameLobbyPlayer, GameFormat, CharacterId } from '@gtr/shared';
import { CHARACTER_LIST, CHARACTERS, MAP_LIST, getMaxPlayers } from '@gtr/shared';
import { CharacterPreview } from './CharacterPreview';

/** Map character IDs to a short role tag for the card subtitle. */
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

export class GameLobbyScreen {
  readonly element: HTMLDivElement;
  private network: NetworkManager;
  private localUserId: string;
  private getPortrait: (modelName: string) => string | undefined;
  private playersEl: HTMLDivElement;
  private leaveBtn: HTMLButtonElement;
  private lockInBtn: HTMLButtonElement;
  private charGridEl: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private charNameEl: HTMLDivElement;
  private charRoleEl: HTMLDivElement;
  private charStatsEl: HTMLDivElement;
  private playgroundWarningEl: HTMLDivElement;
  private animFrameId = 0;

  private hostUserId = '';
  private format: GameFormat = '1v1';
  private mapId = '';
  private mapName = '';
  private players: GameLobbyPlayer[] = [];
  /** Locally-previewed playground-only character (not sent to server). */
  private previewOnlyCharId: CharacterId | null = null;

  // Format/map selection elements
  private formatBtns: HTMLButtonElement[] = [];
  private mapBtns: HTMLButtonElement[] = [];

  // 3D character preview
  private preview!: CharacterPreview;

  constructor(network: NetworkManager, localUserId: string, getPortrait: (modelName: string) => string | undefined) {
    this.network = network;
    this.localUserId = localUserId;
    this.getPortrait = getPortrait;

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
      @keyframes glby-fade-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes glby-pulse-border { 0%,100% { border-color: rgba(100,200,140,0.2); } 50% { border-color: rgba(100,200,140,0.5); } }
      @keyframes glby-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
      @keyframes glby-slide-left { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
      @keyframes glby-slide-right { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
      @keyframes glby-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
      @keyframes glby-glow-pulse { 0%,100% { box-shadow: 0 0 15px rgba(100,200,140,0.1), 0 0 30px rgba(100,200,140,0.05); } 50% { box-shadow: 0 0 20px rgba(100,200,140,0.2), 0 0 40px rgba(100,200,140,0.1); } }
      .glby-btn { transition: all 0.15s ease; }
      .glby-btn:hover { filter: brightness(1.3); transform: translateY(-1px); }
      .glby-btn:active { transform: translateY(0); }
      .glby-char-card { transition: all 0.2s ease; position: relative; }
      .glby-char-card:hover { transform: translateY(-3px); background: rgba(30,40,65,0.95) !important; border-color: rgba(100,140,220,0.4) !important; box-shadow: 0 8px 24px rgba(0,0,0,0.4), 0 0 20px rgba(80,120,220,0.1) !important; }
      .glby-scrollbar::-webkit-scrollbar { width: 5px; }
      .glby-scrollbar::-webkit-scrollbar-track { background: transparent; }
      .glby-scrollbar::-webkit-scrollbar-thumb { background: rgba(100,120,200,0.2); border-radius: 3px; }
      .glby-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(100,120,200,0.35); }
      .glby-team-header { user-select: none; }
      .glby-player-row { transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease; }
      .glby-player-row:hover { background: rgba(20,25,45,0.8) !important; }
    `;
    this.element.appendChild(styleEl);

    // ── Background canvas ───────────────────────────────────────────
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none;';
    this.element.appendChild(canvas);
    this.initBackground(canvas);

    // ── Main 3-column layout ────────────────────────────────────────
    const layout = document.createElement('div');
    layout.style.cssText = 'position: relative; z-index: 1; display: flex; flex: 1; min-height: 0;';

    // ═══════════ LEFT PANEL: Character Selection ═══════════
    const leftPanel = document.createElement('div');
    leftPanel.style.cssText = `
      width: 320px; display: flex; flex-direction: column; padding: 24px;
      border-right: 1px solid rgba(100,120,200,0.08);
      background: linear-gradient(to bottom, rgba(8,10,20,0.7), rgba(5,5,12,0.9));
      animation: glby-slide-left 0.4s ease both;
    `;

    // Character selection header
    const charHeader = document.createElement('div');
    charHeader.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 20px;';
    const charIcon = document.createElement('div');
    charIcon.style.cssText = `
      width: 8px; height: 8px; border-radius: 50%;
      background: #6688cc; box-shadow: 0 0 6px rgba(100,130,200,0.5);
    `;
    const charTitle = document.createElement('div');
    charTitle.textContent = 'SELECT CHARACTER';
    charTitle.style.cssText = `
      font-size: 11px; font-weight: 700; letter-spacing: 2px; color: rgba(130,150,210,0.8);
    `;
    charHeader.appendChild(charIcon);
    charHeader.appendChild(charTitle);
    leftPanel.appendChild(charHeader);

    // Character grid (scrollable)
    this.charGridEl = document.createElement('div');
    this.charGridEl.className = 'glby-scrollbar';
    this.charGridEl.style.cssText = `
      flex: 1; overflow-y: auto; overflow-x: hidden;
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 10px; align-content: start; padding: 4px 4px 4px 0;
    `;

    // Render all characters — playgroundOnly ones are selectable for preview but can't lock in
    for (const char of CHARACTER_LIST) {
      const isDisabled = !!char.playgroundOnly;
      const card = document.createElement('div');
      card.className = 'glby-char-card';
      card.style.cssText = `
        padding: 14px 12px; border-radius: 8px; cursor: pointer; text-align: center;
        background: rgba(12,15,28,0.85);
        border: 2px solid rgba(100,120,200,0.08);
        position: relative; overflow: hidden;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
      `;

      // Role color accent bar at top
      const accentBar = document.createElement('div');
      const roleColor = getRoleColor(char.id);
      accentBar.style.cssText = `
        position: absolute; top: 0; left: 0; right: 0; height: 3px;
        background: linear-gradient(90deg, transparent, ${roleColor}, transparent);
        opacity: 0.6;
      `;
      card.appendChild(accentBar);

      const charName = document.createElement('div');
      charName.textContent = char.name;
      charName.style.cssText = `
        font-weight: 600; font-size: 13px; color: #bbc4dd;
        margin-bottom: 4px; margin-top: 2px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      `;

      const charRole = document.createElement('div');
      charRole.textContent = getCharacterRole(char.id);
      charRole.style.cssText = `font-size: 10px; color: ${roleColor}; letter-spacing: 0.5px; font-weight: 500;`;

      card.appendChild(charName);
      card.appendChild(charRole);

      // SFX warning for non-playground characters missing SFX
      if (!isDisabled && !CHARACTERS[char.id as keyof typeof CHARACTERS].soundEffects) {
        const sfxLabel = document.createElement('div');
        sfxLabel.textContent = 'SFX in development';
        sfxLabel.style.cssText = 'font-size: 9px; color: rgba(224,200,80,0.7); margin-top: 5px;';
        card.appendChild(sfxLabel);
      }

      // "In Development" label for playground-only characters
      if (isDisabled) {
        const devLabel = document.createElement('div');
        devLabel.textContent = 'In Development';
        devLabel.style.cssText = `
          font-size: 9px; font-weight: 600; color: #e05050; letter-spacing: 0.5px;
          margin-top: 6px;
        `;
        card.appendChild(devLabel);
      }

      card.dataset.charId = char.id;
      card.addEventListener('click', () => {
        if (char.playgroundOnly) {
          // Preview-only: set locally without telling the server (no-op if already selected)
          if (this.previewOnlyCharId === char.id) return;
          this.previewOnlyCharId = char.id as CharacterId;
          this.refreshLocalPreview();
        } else {
          // Real selection: send to server, clear any playground preview
          this.previewOnlyCharId = null;
          this.network.send({ type: 'select_character', characterId: char.id as any });
        }
      });
      this.charGridEl.appendChild(card);
    }

    leftPanel.appendChild(this.charGridEl);

    // Leave button at bottom of left panel
    this.leaveBtn = document.createElement('button');
    this.leaveBtn.className = 'glby-btn';
    this.leaveBtn.textContent = 'Leave Game';
    this.leaveBtn.style.cssText = `
      margin-top: 16px; padding: 10px 20px; font-size: 13px; font-weight: 600;
      background: rgba(60,60,80,0.6); color: #aaa; border: 1px solid rgba(100,100,140,0.2);
      border-radius: 6px; cursor: pointer; outline: none;
    `;
    this.leaveBtn.addEventListener('click', () => {
      this.network.send({ type: 'leave_game' });
    });
    leftPanel.appendChild(this.leaveBtn);

    // ═══════════ CENTER PANEL: Preview + Status ═══════════
    const centerPanel = document.createElement('div');
    centerPanel.style.cssText = `
      flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 32px 24px;
      animation: glby-fade-in 0.5s ease both;
      min-width: 0;
    `;

    // Status header (format + map selection)
    this.statusEl = document.createElement('div');
    this.statusEl.style.cssText = `
      text-align: center; margin-bottom: 24px;
      animation: glby-fade-in 0.4s ease both;
      display: flex; flex-direction: column; align-items: center; gap: 12px;
    `;

    // Format row
    const formatSection = document.createElement('div');
    formatSection.style.cssText = 'display: flex; flex-direction: column; align-items: center; gap: 6px;';
    const formatLabel = document.createElement('div');
    formatLabel.textContent = 'FORMAT';
    formatLabel.style.cssText = 'font-size: 10px; font-weight: 700; letter-spacing: 2px; color: rgba(130,150,210,0.6);';
    const formatRow = document.createElement('div');
    formatRow.style.cssText = 'display: flex; gap: 8px;';

    const formats: GameFormat[] = ['1v1', '2v2', '3v3'];
    for (const fmt of formats) {
      const btn = document.createElement('button');
      btn.className = 'glby-btn';
      btn.textContent = fmt;
      btn.dataset.fmt = fmt;
      btn.style.cssText = `
        padding: 6px 20px; font-size: 13px; font-weight: 700; letter-spacing: 1px;
        border-radius: 5px; cursor: pointer; outline: none;
        border: 1px solid rgba(100,120,200,0.1);
        background: rgba(20,25,40,0.6); color: rgba(150,160,180,0.6);
        transition: all 0.15s ease;
      `;
      btn.addEventListener('click', () => {
        if (this.localUserId !== this.hostUserId) return;
        if (btn.disabled) return;
        this.network.send({ type: 'change_format', format: fmt });
      });
      this.formatBtns.push(btn);
      formatRow.appendChild(btn);
    }
    formatSection.appendChild(formatLabel);
    formatSection.appendChild(formatRow);

    // Map row
    const mapSection = document.createElement('div');
    mapSection.style.cssText = 'display: flex; flex-direction: column; align-items: center; gap: 6px;';
    const mapLabel = document.createElement('div');
    mapLabel.textContent = 'MAP';
    mapLabel.style.cssText = 'font-size: 10px; font-weight: 700; letter-spacing: 2px; color: rgba(130,150,210,0.6);';
    const mapRow = document.createElement('div');
    mapRow.style.cssText = 'display: flex; gap: 8px;';

    for (const map of MAP_LIST) {
      const btn = document.createElement('button');
      btn.className = 'glby-btn';
      btn.textContent = map.name;
      btn.dataset.mapId = map.id;
      btn.style.cssText = `
        padding: 6px 20px; font-size: 13px; font-weight: 600;
        border-radius: 5px; cursor: pointer; outline: none;
        border: 1px solid rgba(100,120,200,0.1);
        background: rgba(20,25,40,0.6); color: rgba(150,160,180,0.6);
        transition: all 0.15s ease;
      `;
      btn.addEventListener('click', () => {
        if (this.localUserId !== this.hostUserId) return;
        this.network.send({ type: 'change_map', mapId: map.id });
      });
      this.mapBtns.push(btn);
      mapRow.appendChild(btn);
    }
    mapSection.appendChild(mapLabel);
    mapSection.appendChild(mapRow);

    this.statusEl.appendChild(formatSection);
    this.statusEl.appendChild(mapSection);
    centerPanel.appendChild(this.statusEl);

    // 3D Preview container
    const previewWrapper = document.createElement('div');
    previewWrapper.style.cssText = `
      position: relative;
      display: flex; flex-direction: column; align-items: center;
      flex: 1; max-height: 500px; min-height: 300px;
    `;

    // Preview background glow
    const previewGlow = document.createElement('div');
    previewGlow.style.cssText = `
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: 280px; height: 280px; border-radius: 50%;
      background: radial-gradient(circle, rgba(60,80,160,0.12) 0%, transparent 70%);
      pointer-events: none;
    `;
    previewWrapper.appendChild(previewGlow);

    // Circular platform under model
    const platform = document.createElement('div');
    platform.style.cssText = `
      position: absolute; bottom: 32px; left: 50%; transform: translateX(-50%);
      width: 200px; height: 40px; border-radius: 50%;
      background: radial-gradient(ellipse, rgba(60,80,160,0.15) 0%, transparent 70%);
      pointer-events: none;
    `;
    previewWrapper.appendChild(platform);

    this.preview = new CharacterPreview(this.element);
    previewWrapper.appendChild(this.preview.canvas);

    // Character name + role under preview
    const charInfoBox = document.createElement('div');
    charInfoBox.style.cssText = 'text-align: center; margin-top: 12px;';

    this.charNameEl = document.createElement('div');
    this.charNameEl.style.cssText = `
      font-size: 22px; font-weight: 700; color: #dde2f0;
      letter-spacing: 1px; transition: all 0.3s ease;
      min-height: 30px;
    `;

    this.charRoleEl = document.createElement('div');
    this.charRoleEl.style.cssText = `
      font-size: 12px; font-weight: 500; letter-spacing: 1.5px; text-transform: uppercase;
      margin-top: 4px; transition: all 0.3s ease;
      min-height: 18px;
    `;

    this.charStatsEl = document.createElement('div');
    this.charStatsEl.style.cssText = `
      display: flex; gap: 20px; justify-content: center; margin-top: 12px;
      min-height: 18px;
    `;

    charInfoBox.appendChild(this.charNameEl);
    charInfoBox.appendChild(this.charRoleEl);
    charInfoBox.appendChild(this.charStatsEl);

    centerPanel.appendChild(previewWrapper);
    centerPanel.appendChild(charInfoBox);

    // ═════════���═ RIGHT PANEL: Teams + Actions ═══════════
    const rightPanel = document.createElement('div');
    rightPanel.style.cssText = `
      width: 320px; display: flex; flex-direction: column; padding: 24px;
      border-left: 1px solid rgba(100,120,200,0.08);
      background: linear-gradient(to bottom, rgba(8,10,20,0.7), rgba(5,5,12,0.9));
      animation: glby-slide-right 0.4s ease both;
    `;

    // Teams header
    const teamsHeader = document.createElement('div');
    teamsHeader.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 20px;';
    const teamsIcon = document.createElement('div');
    teamsIcon.style.cssText = `
      width: 8px; height: 8px; border-radius: 50%;
      background: #66cc88; box-shadow: 0 0 6px rgba(100,200,130,0.5);
    `;
    const teamsTitle = document.createElement('div');
    teamsTitle.textContent = 'PLAYERS';
    teamsTitle.style.cssText = `
      font-size: 11px; font-weight: 700; letter-spacing: 2px; color: rgba(130,210,150,0.8);
    `;
    teamsHeader.appendChild(teamsIcon);
    teamsHeader.appendChild(teamsTitle);
    rightPanel.appendChild(teamsHeader);

    // Players list (scrollable)
    this.playersEl = document.createElement('div');
    this.playersEl.className = 'glby-scrollbar';
    this.playersEl.style.cssText = `
      flex: 1; overflow-y: auto; padding-right: 4px;
    `;
    rightPanel.appendChild(this.playersEl);

    // ── Playground-only warning ────────────────────────────────────
    this.playgroundWarningEl = document.createElement('div');
    this.playgroundWarningEl.textContent = 'This character is not playable yet.';
    this.playgroundWarningEl.style.cssText = `
      display: none; text-align: center; font-size: 11px; font-weight: 500;
      color: #e05050; margin-top: 16px; padding: 6px 10px;
      background: rgba(224,80,80,0.08); border-radius: 5px;
      border: 1px solid rgba(224,80,80,0.15);
    `;
    rightPanel.appendChild(this.playgroundWarningEl);

    // ── Lock In Button ────────────────────────────────────────────────
    this.lockInBtn = document.createElement('button');
    this.lockInBtn.className = 'glby-btn';
    this.lockInBtn.textContent = 'Lock In';
    this.lockInBtn.disabled = true;
    this.lockInBtn.style.cssText = `
      margin-top: 10px; padding: 16px 32px; font-size: 20px; font-weight: 900; letter-spacing: 4px;
      background: linear-gradient(to bottom, #2d7a3e, #1e5e2a);
      color: rgba(220,225,240,0.9);
      border: 1px solid rgba(100,255,100,0.12); border-radius: 6px;
      cursor: pointer; outline: none;
      opacity: 0.4; pointer-events: none;
    `;
    this.lockInBtn.addEventListener('click', () => {
      this.network.send({ type: 'lock_in' });
    });
    rightPanel.appendChild(this.lockInBtn);

    // ── Assemble ────────────────────────────────────────────────────
    layout.appendChild(leftPanel);
    layout.appendChild(centerPanel);
    layout.appendChild(rightPanel);
    this.element.appendChild(layout);
  }

  // ── Background ────────────────────────────────────────────────────
  private initBackground(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d')!;
    const orbs: { x: number; y: number; r: number; dx: number; dy: number; color: string; alpha: number }[] = [];

    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    window.addEventListener('resize', resize);

    // Floating ambient orbs
    for (let i = 0; i < 7; i++) {
      orbs.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: 120 + Math.random() * 250,
        dx: (Math.random() - 0.5) * 0.25,
        dy: (Math.random() - 0.5) * 0.25,
        color: ['#1a2550', '#15203a', '#201830', '#182040', '#251830', '#0f1a30', '#1a1535'][i],
        alpha: 0.25 + Math.random() * 0.15,
      });
    }

    let lastDrawTime = 0;
    const FRAME_INTERVAL = 66; // ~15fps

    const draw = (now: number) => {
      this.animFrameId = requestAnimationFrame(draw);
      if (document.hidden) return;
      if (now - lastDrawTime < FRAME_INTERVAL) return;
      lastDrawTime = now;

      ctx.fillStyle = '#05050a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (const o of orbs) {
        o.x += o.dx;
        o.y += o.dy;
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

  // ── State update ──────────────────────────────────────────────────

  update(state: {
    format: GameFormat;
    mapId: string;
    mapName: string;
    hostUserId: string;
    players: GameLobbyPlayer[];
  }): void {
    this.hostUserId = state.hostUserId;
    this.format = state.format;
    this.mapId = state.mapId;
    this.mapName = state.mapName;
    this.players = state.players;

    const isHost = this.localUserId === this.hostUserId;
    const playerCount = this.players.length;

    // Update format buttons
    for (const btn of this.formatBtns) {
      const fmt = btn.dataset.fmt as GameFormat;
      const isActive = fmt === this.format;
      const maxForFmt = getMaxPlayers(fmt);
      const tooManyPlayers = playerCount > maxForFmt;

      btn.disabled = !isHost || tooManyPlayers;

      if (isActive) {
        btn.style.background = 'rgba(50,70,140,0.6)';
        btn.style.borderColor = 'rgba(100,140,255,0.5)';
        btn.style.color = '#aac0ff';
      } else if (tooManyPlayers) {
        btn.style.background = 'rgba(20,25,40,0.3)';
        btn.style.borderColor = 'rgba(100,120,200,0.05)';
        btn.style.color = 'rgba(150,160,180,0.25)';
      } else {
        btn.style.background = 'rgba(20,25,40,0.6)';
        btn.style.borderColor = 'rgba(100,120,200,0.1)';
        btn.style.color = 'rgba(150,160,180,0.6)';
      }

      btn.style.cursor = isHost && !tooManyPlayers ? 'pointer' : 'default';
    }

    // Update map buttons
    for (const btn of this.mapBtns) {
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
      btn.style.cursor = isHost ? 'pointer' : 'default';
    }

    // Determine what to preview: playground-only local pick overrides server selection
    const localPlayer = this.players.find(p => p.userId === this.localUserId);
    const serverCharId = (localPlayer?.characterId as CharacterId) ?? null;
    const displayCharId = this.previewOnlyCharId ?? serverCharId;
    this.preview.setCharacter(displayCharId);
    this.updateCharInfo(displayCharId);

    // Highlight the displayed character card
    const cards = this.charGridEl.children;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i] as HTMLElement;
      const isSelected = card.dataset.charId === displayCharId;
      if (isSelected) {
        card.style.borderColor = 'rgba(100,200,140,0.5)';
        card.style.background = 'rgba(20,40,30,0.85)';
        card.style.boxShadow = '0 0 15px rgba(100,200,140,0.1), inset 0 0 20px rgba(100,200,140,0.05)';
      } else {
        card.style.borderColor = 'rgba(100,120,200,0.08)';
        card.style.background = 'rgba(12,15,28,0.85)';
        card.style.boxShadow = 'none';
      }
    }

    // Show warning & disable lock-in when previewing a playground-only character
    const isPlaygroundOnly = !!this.previewOnlyCharId;
    this.playgroundWarningEl.style.display = isPlaygroundOnly ? 'block' : 'none';

    // Update lock-in button state — based on server selection, not local preview
    const canLockIn = !!serverCharId && !localPlayer?.lockedIn && !isPlaygroundOnly;
    this.lockInBtn.disabled = !canLockIn;
    this.lockInBtn.style.opacity = canLockIn ? '1' : '0.4';
    this.lockInBtn.style.pointerEvents = canLockIn ? 'auto' : 'none';
    if (canLockIn) {
      this.lockInBtn.style.animation = 'glby-glow-pulse 2s ease-in-out infinite';
    } else {
      this.lockInBtn.style.animation = 'none';
    }

    // Update player list
    this.playersEl.innerHTML = '';
    const team0 = this.players.filter(p => p.team === 0);
    const team1 = this.players.filter(p => p.team === 1);

    const renderTeam = (team: GameLobbyPlayer[], teamIndex: number, label: string, color: string, dotColor: string) => {
      const teamContainer = document.createElement('div');
      teamContainer.dataset.team = String(teamIndex);
      teamContainer.style.cssText = `
        background: rgba(0,0,0,0.2); border-radius: 8px; padding: 14px;
        border: 1px solid rgba(100,120,200,0.06);
      `;

      const header = document.createElement('div');
      header.className = 'glby-team-header';
      header.style.cssText = `
        display: flex; align-items: center; gap: 8px;
        font-size: 10px; letter-spacing: 2px; font-weight: 700;
        color: ${color}; margin-bottom: 10px; padding-bottom: 8px;
        border-bottom: 1px solid rgba(100,120,200,0.06);
      `;
      const dot = document.createElement('div');
      dot.style.cssText = `
        width: 8px; height: 8px; border-radius: 50%; background: ${dotColor};
        box-shadow: 0 0 8px ${dotColor};
      `;
      header.appendChild(dot);
      header.appendChild(document.createTextNode(label));

      // Player count
      const countSpan = document.createElement('span');
      countSpan.textContent = `${team.length}`;
      countSpan.style.cssText = 'margin-left: auto; color: rgba(130,150,180,0.5); font-size: 11px;';
      header.appendChild(countSpan);

      teamContainer.appendChild(header);

      for (const p of team) {
        const row = document.createElement('div');
        row.className = 'glby-player-row';
        row.dataset.userId = p.userId;
        row.style.cssText = `
          display: flex; align-items: center;
          padding: 10px 12px; margin-bottom: 4px;
          border-radius: 6px;
          border: 1px solid ${p.lockedIn ? 'rgba(80,200,120,0.25)' : 'rgba(60,70,100,0.1)'};
          background: ${p.lockedIn ? 'rgba(30,60,40,0.5)' : 'rgba(12,15,28,0.6)'};
          ${p.lockedIn ? 'box-shadow: 0 0 12px rgba(80,200,120,0.08), inset 0 0 20px rgba(80,200,120,0.04);' : ''}
          ${isHost ? 'cursor: grab;' : ''}
        `;

        if (isHost) {
          row.draggable = true;
          row.addEventListener('dragstart', (e) => {
            e.dataTransfer!.setData('text/plain', p.userId);
            e.dataTransfer!.effectAllowed = 'move';
            row.style.opacity = '0.5';
          });
          row.addEventListener('dragend', () => {
            row.style.opacity = '1';
          });
          row.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer!.dropEffect = 'move';
            row.style.background = 'rgba(100,120,200,0.2)';
          });
          row.addEventListener('dragleave', () => {
            row.style.background = 'rgba(12,15,28,0.6)';
          });
          row.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            row.style.background = 'rgba(12,15,28,0.6)';
            const draggedUserId = e.dataTransfer!.getData('text/plain');
            if (draggedUserId && draggedUserId !== p.userId) {
              const draggedPlayer = this.players.find(pl => pl.userId === draggedUserId);
              if (draggedPlayer && draggedPlayer.team !== p.team) {
                this.network.send({ type: 'swap_team', draggedUserId, droppedOnUserId: p.userId, newTeam: p.team });
              }
            }
          });
        }

        const leftSide = document.createElement('div');
        leftSide.style.cssText = 'display: flex; align-items: center; gap: 8px; min-width: 0;';

        // Character portrait (or initial fallback) — hide playground-only selections
        const rawCharInfo = CHARACTER_LIST.find(c => c.id === p.characterId);
        const charInfo = rawCharInfo?.playgroundOnly ? undefined : rawCharInfo;
        const portraitUrl = charInfo ? this.getPortrait(charInfo.name) : undefined;
        const avatar = document.createElement('div');
        avatar.style.cssText = `
          width: 32px; height: 32px; border-radius: 4px; flex-shrink: 0;
          background: rgba(15,18,30,0.9);
          border: 1.5px solid ${p.lockedIn ? 'rgba(80,200,120,0.5)' : 'rgba(60,70,100,0.3)'};
          display: flex; align-items: center; justify-content: center;
          overflow: hidden;
        `;
        if (portraitUrl) {
          const img = document.createElement('img');
          img.src = portraitUrl;
          img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
          avatar.appendChild(img);
        }

        const nameCol = document.createElement('div');
        nameCol.style.cssText = 'min-width: 0;';

        const nameRow = document.createElement('div');
        nameRow.style.cssText = 'display: flex; align-items: center; gap: 5px; min-width: 0;';

        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = `
          font-size: 13px; font-weight: ${p.userId === this.localUserId ? '600' : '400'}; color: #bbc4dd;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        `;
        nameSpan.textContent = p.username;
        nameRow.appendChild(nameSpan);

        if (p.userId === this.hostUserId) {
          const crownSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          crownSvg.setAttribute('width', '14');
          crownSvg.setAttribute('height', '14');
          crownSvg.setAttribute('viewBox', '0 0 24 24');
          crownSvg.setAttribute('fill', 'none');
          crownSvg.style.cssText = 'flex-shrink: 0;';
          const crownPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          crownPath.setAttribute('d', 'M2 18L4 8L8 12L12 4L16 12L20 8L22 18H2Z');
          crownPath.setAttribute('fill', '#e8c84c');
          crownPath.setAttribute('stroke', '#c4a030');
          crownPath.setAttribute('stroke-width', '1.5');
          crownPath.setAttribute('stroke-linejoin', 'round');
          crownSvg.appendChild(crownPath);
          nameRow.appendChild(crownSvg);
        }

        const charName = charInfo?.name ?? '—';
        const charSpan = document.createElement('div');
        charSpan.textContent = charName;
        charSpan.style.cssText = 'font-size: 11px; color: rgba(140,150,180,0.5);';

        nameCol.appendChild(nameRow);
        nameCol.appendChild(charSpan);
        leftSide.appendChild(avatar);
        leftSide.appendChild(nameCol);

        row.appendChild(leftSide);
        teamContainer.appendChild(row);
      }

      // Drop zone for the whole team area
      if (isHost) {
        teamContainer.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer!.dropEffect = 'move';
          teamContainer.style.borderColor = 'rgba(100,120,200,0.25)';
        });
        teamContainer.addEventListener('dragleave', () => {
          teamContainer.style.borderColor = 'rgba(100,120,200,0.06)';
        });
        teamContainer.addEventListener('drop', (e) => {
          e.preventDefault();
          teamContainer.style.borderColor = 'rgba(100,120,200,0.06)';
          const draggedUserId = e.dataTransfer!.getData('text/plain');
          if (draggedUserId) {
            const draggedPlayer = this.players.find(pl => pl.userId === draggedUserId);
            if (draggedPlayer && draggedPlayer.team !== teamIndex) {
              this.network.send({ type: 'swap_team', draggedUserId, newTeam: teamIndex });
            }
          }
        });
      }

      this.playersEl.appendChild(teamContainer);
    };

    renderTeam(team0, 0, 'TEAM 1', 'rgba(100,160,255,0.7)', 'rgba(80,130,230,0.6)');
    const spacer = document.createElement('div');
    spacer.style.cssText = 'height: 10px;';
    this.playersEl.appendChild(spacer);
    renderTeam(team1, 1, 'TEAM 2', 'rgba(255,140,100,0.7)', 'rgba(230,110,80,0.6)');
  }

  /** Update the character info section below the 3D preview. */
  private updateCharInfo(charId: CharacterId | null): void {
    if (!charId) {
      this.charNameEl.textContent = '';
      this.charRoleEl.textContent = 'No character selected';
      this.charRoleEl.style.color = 'rgba(120,130,160,0.4)';
      this.charStatsEl.innerHTML = '';
      return;
    }

    const stats = CHARACTERS[charId];
    const info = CHARACTER_LIST.find(c => c.id === charId);
    this.charNameEl.textContent = info?.name ?? charId;

    const role = getCharacterRole(charId);
    const roleColor = getRoleColor(charId);
    this.charRoleEl.textContent = role;
    this.charRoleEl.style.color = roleColor;

    // Show brief stats
    this.charStatsEl.innerHTML = '';
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

  /** Re-run preview/card/warning visuals after a local playground-only toggle. */
  private refreshLocalPreview(): void {
    const localPlayer = this.players.find(p => p.userId === this.localUserId);
    const serverCharId = (localPlayer?.characterId as CharacterId) ?? null;
    const displayCharId = this.previewOnlyCharId ?? serverCharId;

    this.preview.setCharacter(displayCharId);
    this.updateCharInfo(displayCharId);

    // Re-highlight cards
    const cards = this.charGridEl.children;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i] as HTMLElement;
      const isSelected = card.dataset.charId === displayCharId;
      if (isSelected) {
        card.style.borderColor = 'rgba(100,200,140,0.5)';
        card.style.background = 'rgba(20,40,30,0.85)';
        card.style.boxShadow = '0 0 15px rgba(100,200,140,0.1), inset 0 0 20px rgba(100,200,140,0.05)';
      } else {
        card.style.borderColor = 'rgba(100,120,200,0.08)';
        card.style.background = 'rgba(12,15,28,0.85)';
        card.style.boxShadow = 'none';
      }
    }

    // Warning + lock-in state
    const isPlaygroundOnly = !!this.previewOnlyCharId;
    this.playgroundWarningEl.style.display = isPlaygroundOnly ? 'block' : 'none';

    const canLockIn = !!serverCharId && !localPlayer?.lockedIn && !isPlaygroundOnly;
    this.lockInBtn.disabled = !canLockIn;
    this.lockInBtn.style.opacity = canLockIn ? '1' : '0.4';
    this.lockInBtn.style.pointerEvents = canLockIn ? 'auto' : 'none';
    this.lockInBtn.style.animation = canLockIn ? 'glby-glow-pulse 2s ease-in-out infinite' : 'none';
  }

  destroy(): void {
    cancelAnimationFrame(this.animFrameId);
    this.preview.destroy();
    this.element.remove();
  }
}
