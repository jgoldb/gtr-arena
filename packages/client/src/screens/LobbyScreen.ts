import type { NetworkManager } from '../network/NetworkManager';
import type { LobbyUser, LobbyGameInfo, GameFormat, UserProfileData } from '@gtr/shared';
import { MAP_LIST } from '@gtr/shared';

export class LobbyScreen {
  readonly element: HTMLDivElement;
  private chatLog: HTMLDivElement;
  private chatInput: HTMLInputElement;
  private userListEl: HTMLDivElement;
  private gameListEl: HTMLDivElement;
  private network: NetworkManager;
  private localUserId: string;
  private animFrameId = 0;

  onPlayground?: () => void;
  onLogout?: () => void;
  onAdmin?: () => void;

  constructor(network: NetworkManager, localUserId: string, isAdmin = false) {
    this.network = network;
    this.localUserId = localUserId;

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
      @keyframes lby-fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes lby-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(100,140,255,0); } 50% { box-shadow: 0 0 12px 2px rgba(100,140,255,0.15); } }
      @keyframes lby-glow-line { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
      .lby-panel { animation: lby-fade-in 0.4s ease both; }
      .lby-game-row:hover { border-color: rgba(100,160,255,0.4) !important; background: rgba(25,35,60,0.9) !important; }
      .lby-btn { transition: all 0.15s ease; }
      .lby-btn:hover { filter: brightness(1.3); transform: translateY(-1px); }
      .lby-btn:active { transform: translateY(0); }
      .lby-chat-msg { animation: lby-fade-in 0.2s ease both; }
      .lby-input:focus { border-color: rgba(100,160,255,0.5) !important; box-shadow: 0 0 8px rgba(100,140,255,0.1); }
      .lby-scrollbar::-webkit-scrollbar { width: 5px; }
      .lby-scrollbar::-webkit-scrollbar-track { background: transparent; }
      .lby-scrollbar::-webkit-scrollbar-thumb { background: rgba(100,120,200,0.2); border-radius: 3px; }
      .lby-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(100,120,200,0.35); }
    `;
    this.element.appendChild(styleEl);

    // ── Animated background canvas ──────────────────────────────────
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none;';
    this.element.appendChild(canvas);
    this.initBackground(canvas);

    // ── Main layout (over canvas) ───────────────────────────────────
    const layout = document.createElement('div');
    layout.style.cssText = 'position: relative; z-index: 1; display: flex; flex: 1; min-height: 0;';

    // ═══════════ Left panel: Chat ═══════════
    const chatPanel = document.createElement('div');
    chatPanel.className = 'lby-panel';
    chatPanel.style.cssText = `
      width: 300px; display: flex; flex-direction: column; padding: 20px;
      border-right: 1px solid rgba(100, 120, 200, 0.08);
      background: linear-gradient(to bottom, rgba(8,10,20,0.6), rgba(5,5,12,0.8));
    `;
    chatPanel.style.animationDelay = '0.05s';

    const chatHeader = document.createElement('div');
    chatHeader.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 14px;';
    const chatIcon = document.createElement('div');
    chatIcon.style.cssText = `
      width: 8px; height: 8px; border-radius: 50%;
      background: #6688cc; box-shadow: 0 0 6px rgba(100,130,200,0.5);
    `;
    const chatTitle = document.createElement('div');
    chatTitle.textContent = 'LOBBY CHAT';
    chatTitle.style.cssText = `
      font-size: 11px; font-weight: 700; letter-spacing: 2px; color: rgba(130,150,210,0.8);
    `;
    chatHeader.appendChild(chatIcon);
    chatHeader.appendChild(chatTitle);

    this.chatLog = document.createElement('div');
    this.chatLog.className = 'lby-scrollbar';
    this.chatLog.style.cssText = `
      flex: 1; overflow-y: auto; padding: 12px;
      background: rgba(0,0,0,0.3); border-radius: 6px;
      border: 1px solid rgba(100,120,200,0.06);
      font-size: 13px; line-height: 1.7;
    `;

    this.chatInput = document.createElement('input');
    this.chatInput.type = 'text';
    this.chatInput.placeholder = 'Type a message...';
    this.chatInput.maxLength = 500;
    this.chatInput.className = 'lby-input';
    this.chatInput.style.cssText = `
      margin-top: 10px; padding: 10px 14px; font-size: 13px;
      background: rgba(0,0,0,0.4); color: #ccc;
      border: 1px solid rgba(100,120,200,0.12); border-radius: 6px; outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    `;
    this.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.chatInput.value.trim()) {
        this.network.send({ type: 'lobby_chat', message: this.chatInput.value });
        this.chatInput.value = '';
      }
    });

    chatPanel.appendChild(chatHeader);
    chatPanel.appendChild(this.chatLog);
    chatPanel.appendChild(this.chatInput);

    // ═══════════ Center panel: Games ═══════════
    const centerPanel = document.createElement('div');
    centerPanel.className = 'lby-panel';
    centerPanel.style.cssText = 'flex: 1; display: flex; flex-direction: column; padding: 20px; min-width: 0;';
    centerPanel.style.animationDelay = '0.1s';

    // Top bar: title + buttons
    const topBar = document.createElement('div');
    topBar.style.cssText = `
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 16px; padding-bottom: 16px;
      border-bottom: 1px solid rgba(100,120,200,0.08);
    `;

    const titleArea = document.createElement('div');
    const gamesTitle = document.createElement('div');
    gamesTitle.textContent = 'GAMES';
    gamesTitle.style.cssText = `
      font-size: 11px; font-weight: 700; letter-spacing: 2px; color: rgba(130,150,210,0.8);
    `;
    const gamesSubtitle = document.createElement('div');
    gamesSubtitle.textContent = 'Join or create a match';
    gamesSubtitle.style.cssText = 'font-size: 12px; color: rgba(120,130,160,0.5); margin-top: 2px;';
    titleArea.appendChild(gamesTitle);
    titleArea.appendChild(gamesSubtitle);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 8px; align-items: center;';

    const createBtn = this.makeButton('+ Create Game', '#3466b8', '#4a80d4');
    createBtn.style.fontWeight = '600';
    createBtn.addEventListener('click', () => this.showCreateGameDialog());
    btnRow.appendChild(createBtn);

    const leaderboardBtn = this.makeButton('Leaderboard', '#2a5a5a', '#348a7a');
    leaderboardBtn.addEventListener('click', () => {
      this.network.send({ type: 'get_leaderboard' });
    });
    btnRow.appendChild(leaderboardBtn);

    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      const playgroundBtn = this.makeButton('Playground', '#5a3d8a', '#7050a8');
      playgroundBtn.addEventListener('click', () => this.onPlayground?.());
      btnRow.appendChild(playgroundBtn);
    }

    if (isAdmin) {
      const adminBtn = this.makeButton('Admin', '#8a5a20', '#a87030');
      adminBtn.addEventListener('click', () => this.onAdmin?.());
      btnRow.appendChild(adminBtn);
    }

    const logoutBtn = this.makeButton('Logout', '#6e2d2d', '#8a3a3a');
    logoutBtn.addEventListener('click', () => this.onLogout?.());
    btnRow.appendChild(logoutBtn);

    topBar.appendChild(titleArea);
    topBar.appendChild(btnRow);

    // Game list
    this.gameListEl = document.createElement('div');
    this.gameListEl.className = 'lby-scrollbar';
    this.gameListEl.style.cssText = `
      flex: 1; overflow-y: auto; padding: 4px;
    `;

    centerPanel.appendChild(topBar);
    centerPanel.appendChild(this.gameListEl);

    // ═══════════ Right panel: Online users ═══════════
    const rightPanel = document.createElement('div');
    rightPanel.className = 'lby-panel';
    rightPanel.style.cssText = `
      width: 200px; display: flex; flex-direction: column; padding: 20px;
      border-left: 1px solid rgba(100, 120, 200, 0.08);
      background: linear-gradient(to bottom, rgba(8,10,20,0.6), rgba(5,5,12,0.8));
    `;
    rightPanel.style.animationDelay = '0.15s';

    const usersHeader = document.createElement('div');
    usersHeader.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 14px;';
    const usersIcon = document.createElement('div');
    usersIcon.style.cssText = `
      width: 8px; height: 8px; border-radius: 50%;
      background: #44cc44; box-shadow: 0 0 6px rgba(68,204,68,0.5);
    `;
    const usersTitle = document.createElement('div');
    usersTitle.textContent = 'ONLINE';
    usersTitle.style.cssText = `
      font-size: 11px; font-weight: 700; letter-spacing: 2px; color: rgba(130,150,210,0.8);
    `;
    usersHeader.appendChild(usersIcon);
    usersHeader.appendChild(usersTitle);

    this.userListEl = document.createElement('div');
    this.userListEl.className = 'lby-scrollbar';
    this.userListEl.style.cssText = 'flex: 1; overflow-y: auto; font-size: 13px;';

    rightPanel.appendChild(usersHeader);
    rightPanel.appendChild(this.userListEl);

    layout.appendChild(chatPanel);
    layout.appendChild(centerPanel);
    layout.appendChild(rightPanel);
    this.element.appendChild(layout);
  }

  // ── Background animation ────────────────────────────────────────
  private initBackground(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d')!;
    const particles: { x: number; y: number; vx: number; vy: number; size: number; alpha: number; color: string }[] = [];

    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    window.addEventListener('resize', resize);

    for (let i = 0; i < 80; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.15,
        vy: (Math.random() - 0.5) * 0.15,
        size: Math.random() * 1.5 + 0.3,
        alpha: Math.random() * 0.4 + 0.1,
        color: ['#334477', '#445588', '#556699', '#667788'][Math.floor(Math.random() * 4)],
      });
    }

    let lastDrawTime = 0;
    const FRAME_INTERVAL = 66; // ~15fps — plenty for slow ambient motion

    const draw = (now: number) => {
      this.animFrameId = requestAnimationFrame(draw);
      if (document.hidden) return;
      if (now - lastDrawTime < FRAME_INTERVAL) return;
      lastDrawTime = now;

      ctx.fillStyle = 'rgba(5, 5, 10, 0.12)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;

        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }

      // Subtle connecting lines between nearby particles (check ~20% of pairs per frame)
      ctx.globalAlpha = 0.03;
      ctx.strokeStyle = '#6688cc';
      ctx.lineWidth = 0.5;
      const len = particles.length;
      const step = 5; // only check every 5th pair — rotates which pairs are drawn
      const offset = (Math.floor(now / FRAME_INTERVAL)) % step;
      for (let i = offset; i < len; i += step) {
        for (let j = i + 1; j < len; j += step) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          if (dx * dx + dy * dy < 15000) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.stroke();
          }
        }
      }

      ctx.globalAlpha = 1;
    };
    this.animFrameId = requestAnimationFrame(draw);
  }

  // ── Public API ────────────────────────────────────────────────────

  addChatMessage(username: string, message: string): void {
    const line = document.createElement('div');
    line.className = 'lby-chat-msg';
    line.innerHTML = `<span style="color: #7a9de0; font-weight: 600;">${this.escapeHtml(username)}</span><span style="color: rgba(100,120,160,0.4); margin: 0 6px;">›</span><span style="color: rgba(200,205,220,0.85);">${this.escapeHtml(message)}</span>`;
    this.chatLog.appendChild(line);
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  updateUsers(users: LobbyUser[]): void {
    this.userListEl.innerHTML = '';
    for (const u of users) {
      const row = document.createElement('div');
      row.style.cssText = `
        padding: 7px 10px; display: flex; align-items: center; gap: 8px;
        border-radius: 4px; margin-bottom: 2px;
        transition: background 0.15s; cursor: pointer;
      `;
      row.addEventListener('mouseenter', () => { row.style.background = 'rgba(100,120,200,0.06)'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showContextMenu(e.clientX, e.clientY, u.userId, u.username);
      });

      const dot = document.createElement('span');
      dot.style.cssText = `
        width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
        background: ${u.status === 'online' ? '#44cc44' : '#cc8844'};
        box-shadow: 0 0 4px ${u.status === 'online' ? 'rgba(68,204,68,0.4)' : 'rgba(204,136,68,0.4)'};
      `;
      const name = document.createElement('span');
      name.textContent = u.username;
      name.style.cssText = `
        color: ${u.userId === this.localUserId ? '#8aadee' : 'rgba(180,185,200,0.7)'};
        font-weight: ${u.userId === this.localUserId ? '600' : '400'};
        font-size: 13px;
      `;
      row.appendChild(dot);
      row.appendChild(name);
      this.userListEl.appendChild(row);
    }
  }

  updateGames(games: LobbyGameInfo[]): void {
    this.gameListEl.innerHTML = '';
    if (games.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = `
        color: rgba(120,130,160,0.4); font-size: 14px; text-align: center;
        padding: 60px 20px; line-height: 2;
      `;
      empty.innerHTML = `
        <div style="font-size: 28px; margin-bottom: 8px; opacity: 0.3;">⚔</div>
        <div>No games available</div>
        <div style="font-size: 12px; color: rgba(100,120,200,0.3);">Create one to get started</div>
      `;
      this.gameListEl.appendChild(empty);
      return;
    }
    for (const game of games) {
      const row = document.createElement('div');
      row.className = 'lby-game-row';
      row.style.cssText = `
        display: flex; justify-content: space-between; align-items: center;
        padding: 14px 16px; margin-bottom: 6px;
        background: rgba(12,16,30,0.7); border-radius: 6px;
        border: 1px solid rgba(100,120,200,0.08);
        transition: all 0.2s ease; cursor: default;
      `;

      const info = document.createElement('div');
      const hostLine = document.createElement('div');
      hostLine.style.cssText = 'font-weight: 600; font-size: 14px; color: #bbc4dd; margin-bottom: 3px;';
      hostLine.textContent = `${this.escapeHtml(game.hostUsername)}'s Game`;

      const metaLine = document.createElement('div');
      metaLine.style.cssText = 'display: flex; gap: 10px; font-size: 12px; color: rgba(120,130,160,0.6);';

      const fmtBadge = document.createElement('span');
      fmtBadge.textContent = game.format;
      fmtBadge.style.cssText = `
        padding: 1px 8px; border-radius: 3px; font-size: 11px; font-weight: 600;
        background: rgba(60,80,160,0.25); color: rgba(140,170,255,0.8);
      `;
      const mapSpan = document.createElement('span');
      mapSpan.textContent = this.escapeHtml(game.mapName);
      const countSpan = document.createElement('span');
      countSpan.textContent = `${game.playerCount}/${game.maxPlayers} players`;

      metaLine.appendChild(fmtBadge);
      metaLine.appendChild(mapSpan);
      metaLine.appendChild(countSpan);
      info.appendChild(hostLine);
      info.appendChild(metaLine);

      const isFull = game.playerCount >= game.maxPlayers;
      const joinBtn = this.makeButton('Join', isFull ? '#3a3a4a' : '#2a6e3c', isFull ? '#3a3a4a' : '#348a4c');
      if (isFull) {
        joinBtn.textContent = 'Full';
        joinBtn.style.cursor = 'default';
        joinBtn.style.opacity = '0.5';
        joinBtn.style.pointerEvents = 'none';
      } else {
        joinBtn.addEventListener('click', () => {
          this.network.send({ type: 'join_game', gameId: game.gameId });
        });
      }

      row.appendChild(info);
      row.appendChild(joinBtn);
      this.gameListEl.appendChild(row);
    }
  }

  // ── Create game dialog ────────────────────────────────────────────
  private showCreateGameDialog(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 1100;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
      animation: lby-fade-in 0.15s ease both;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: linear-gradient(to bottom, rgba(18,20,35,0.98), rgba(8,10,18,0.99));
      border: 1px solid rgba(100,120,200,0.15);
      border-radius: 10px; padding: 32px 40px; min-width: 380px;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 0 40px rgba(60,80,180,0.08);
      animation: lby-fade-in 0.25s ease both;
    `;

    const title = document.createElement('div');
    title.textContent = 'CREATE GAME';
    title.style.cssText = `
      font-size: 11px; font-weight: 700; letter-spacing: 2px;
      color: rgba(130,150,210,0.8); margin-bottom: 24px;
    `;

    // Format selection
    const formatLabel = document.createElement('div');
    formatLabel.textContent = 'FORMAT';
    formatLabel.style.cssText = 'color: rgba(120,130,160,0.5); font-size: 10px; letter-spacing: 1.5px; font-weight: 600; margin-bottom: 8px;';

    let selectedFormat: GameFormat = '1v1';
    const formatRow = document.createElement('div');
    formatRow.style.cssText = 'display: flex; gap: 8px; margin-bottom: 20px;';
    const formats: GameFormat[] = ['1v1', '2v2', '3v3'];
    const formatBtns: HTMLButtonElement[] = [];

    const updateFormatBtns = () => {
      for (const btn of formatBtns) {
        const isActive = btn.dataset.fmt === selectedFormat;
        btn.style.background = isActive ? 'rgba(50,70,140,0.6)' : 'rgba(20,25,40,0.6)';
        btn.style.borderColor = isActive ? 'rgba(100,140,255,0.5)' : 'rgba(100,120,200,0.1)';
        btn.style.color = isActive ? '#aac0ff' : 'rgba(150,160,180,0.6)';
      }
    };

    for (const fmt of formats) {
      const btn = document.createElement('button');
      btn.className = 'lby-btn';
      btn.textContent = fmt;
      btn.dataset.fmt = fmt;
      btn.style.cssText = `
        flex: 1; padding: 10px 0; font-size: 14px; font-weight: 600;
        border-radius: 6px; cursor: pointer; outline: none;
        border: 1px solid rgba(100,120,200,0.1);
        background: rgba(20,25,40,0.6); color: rgba(150,160,180,0.6);
      `;
      btn.addEventListener('click', () => { selectedFormat = fmt; updateFormatBtns(); });
      formatBtns.push(btn);
      formatRow.appendChild(btn);
    }
    updateFormatBtns();

    // Map selection
    const mapLabel = document.createElement('div');
    mapLabel.textContent = 'MAP';
    mapLabel.style.cssText = 'color: rgba(120,130,160,0.5); font-size: 10px; letter-spacing: 1.5px; font-weight: 600; margin-bottom: 8px;';

    let selectedMap = MAP_LIST[0]?.id ?? 'cage';
    const mapRow = document.createElement('div');
    mapRow.style.cssText = 'display: flex; gap: 8px; margin-bottom: 28px;';
    const mapBtns: HTMLButtonElement[] = [];

    const updateMapBtns = () => {
      for (const btn of mapBtns) {
        const isActive = btn.dataset.mapId === selectedMap;
        btn.style.background = isActive ? 'rgba(50,70,140,0.6)' : 'rgba(20,25,40,0.6)';
        btn.style.borderColor = isActive ? 'rgba(100,140,255,0.5)' : 'rgba(100,120,200,0.1)';
        btn.style.color = isActive ? '#aac0ff' : 'rgba(150,160,180,0.6)';
      }
    };

    for (const map of MAP_LIST) {
      const btn = document.createElement('button');
      btn.className = 'lby-btn';
      btn.textContent = map.name;
      btn.dataset.mapId = map.id;
      btn.style.cssText = `
        flex: 1; padding: 10px 0; font-size: 13px; font-weight: 600;
        border-radius: 6px; cursor: pointer; outline: none;
        border: 1px solid rgba(100,120,200,0.1);
        background: rgba(20,25,40,0.6); color: rgba(150,160,180,0.6);
      `;
      btn.addEventListener('click', () => { selectedMap = map.id; updateMapBtns(); });
      mapBtns.push(btn);
      mapRow.appendChild(btn);
    }
    updateMapBtns();

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end;';

    const cancelBtn = this.makeButton('Cancel', '#4a2a2a', '#5e3636');
    cancelBtn.addEventListener('click', () => overlay.remove());

    const createBtn = this.makeButton('Create', '#2a5090', '#3466b8');
    createBtn.style.fontWeight = '600';
    createBtn.addEventListener('click', () => {
      this.network.send({ type: 'create_game', format: selectedFormat, mapId: selectedMap });
      overlay.remove();
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(createBtn);

    dialog.appendChild(title);
    dialog.appendChild(formatLabel);
    dialog.appendChild(formatRow);
    dialog.appendChild(mapLabel);
    dialog.appendChild(mapRow);
    dialog.appendChild(btnRow);
    overlay.appendChild(dialog);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    this.element.appendChild(overlay);
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private makeButton(text: string, bg: string, hoverBg: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'lby-btn';
    btn.textContent = text;
    btn.style.cssText = `
      padding: 8px 18px; font-size: 12px; font-weight: 500;
      background: ${bg}; color: rgba(220,225,240,0.9);
      border: 1px solid rgba(255,255,255,0.06); border-radius: 5px;
      cursor: pointer; outline: none; white-space: nowrap;
    `;
    btn.addEventListener('mouseenter', () => { btn.style.background = hoverBg; });
    btn.addEventListener('mouseleave', () => { btn.style.background = bg; });
    return btn;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ── Context menu ──────────────────────────────────────────────────

  private showContextMenu(x: number, y: number, userId: string, username: string): void {
    this.dismissContextMenu();

    const menu = document.createElement('div');
    menu.className = 'lby-context-menu';
    menu.style.cssText = `
      position: fixed; left: ${x}px; top: ${y}px; z-index: 1200;
      background: linear-gradient(to bottom, rgba(22,24,40,0.98), rgba(12,14,24,0.98));
      border: 1px solid rgba(100,120,200,0.2);
      border-radius: 6px; padding: 4px 0; min-width: 140px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.6), 0 0 20px rgba(40,60,140,0.08);
      animation: lby-fade-in 0.1s ease both;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    `;

    const inspectItem = document.createElement('div');
    inspectItem.textContent = `Inspect`;
    inspectItem.style.cssText = `
      padding: 8px 16px; font-size: 13px; color: rgba(190,200,220,0.9);
      cursor: pointer; transition: background 0.1s;
    `;
    inspectItem.addEventListener('mouseenter', () => { inspectItem.style.background = 'rgba(60,80,160,0.3)'; });
    inspectItem.addEventListener('mouseleave', () => { inspectItem.style.background = 'transparent'; });
    inspectItem.addEventListener('click', () => {
      this.dismissContextMenu();
      this.network.send({ type: 'inspect_user', targetUserId: userId });
    });

    menu.appendChild(inspectItem);
    this.element.appendChild(menu);

    // Clamp to viewport
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
      if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;
    });

    const dismiss = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        this.dismissContextMenu();
        document.removeEventListener('mousedown', dismiss);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
    this._contextMenu = menu;
    this._contextDismiss = dismiss;
  }

  private _contextMenu: HTMLDivElement | null = null;
  private _contextDismiss: ((e: MouseEvent) => void) | null = null;

  private dismissContextMenu(): void {
    if (this._contextMenu) {
      this._contextMenu.remove();
      this._contextMenu = null;
    }
    if (this._contextDismiss) {
      document.removeEventListener('mousedown', this._contextDismiss);
      this._contextDismiss = null;
    }
  }

  // ── Profile dialog ───────────────────────────────────────────────────

  showProfileDialog(profile: UserProfileData): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 1100;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
      animation: lby-fade-in 0.15s ease both;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: linear-gradient(to bottom, rgba(14,16,32,0.98), rgba(6,8,18,0.99));
      border: 1px solid rgba(80,110,200,0.18);
      border-radius: 12px; padding: 0; min-width: 340px; overflow: hidden;
      box-shadow: 0 24px 80px rgba(0,0,0,0.6), 0 0 60px rgba(40,60,160,0.06);
      animation: lby-fade-in 0.25s ease both;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    `;

    // Header banner
    const header = document.createElement('div');
    header.style.cssText = `
      background: linear-gradient(135deg, rgba(30,50,100,0.6), rgba(50,30,90,0.4));
      padding: 28px 32px 22px; border-bottom: 1px solid rgba(80,110,200,0.1);
      position: relative; overflow: hidden;
    `;
    // Decorative glow
    const glow = document.createElement('div');
    glow.style.cssText = `
      position: absolute; top: -40px; right: -20px; width: 120px; height: 120px;
      background: radial-gradient(circle, rgba(80,120,255,0.12), transparent 70%);
      pointer-events: none;
    `;
    header.appendChild(glow);

    const nameEl = document.createElement('div');
    nameEl.textContent = profile.username;
    nameEl.style.cssText = 'font-size: 22px; font-weight: 700; color: #dde2f0; position: relative;';
    const joinedEl = document.createElement('div');
    const joinedDate = new Date(profile.createdAt + 'Z');
    joinedEl.textContent = `Joined ${joinedDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
    joinedEl.style.cssText = 'font-size: 12px; color: rgba(130,150,200,0.6); margin-top: 4px; position: relative;';
    header.append(nameEl, joinedEl);

    // Stats body
    const body = document.createElement('div');
    body.style.cssText = 'padding: 24px 32px 28px;';

    const winRate = profile.gamesPlayed > 0 ? (profile.wins / profile.gamesPlayed * 100) : 0;

    const statsGrid = document.createElement('div');
    statsGrid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 16px;';

    const addStat = (label: string, value: string, color: string) => {
      const cell = document.createElement('div');
      cell.style.cssText = `
        background: rgba(15,18,35,0.6); border: 1px solid rgba(80,100,180,0.08);
        border-radius: 8px; padding: 14px 16px; text-align: center;
      `;
      const valEl = document.createElement('div');
      valEl.textContent = value;
      valEl.style.cssText = `font-size: 24px; font-weight: 700; color: ${color}; line-height: 1;`;
      const lblEl = document.createElement('div');
      lblEl.textContent = label;
      lblEl.style.cssText = 'font-size: 10px; font-weight: 600; letter-spacing: 1.5px; color: rgba(120,140,180,0.5); margin-top: 6px; text-transform: uppercase;';
      cell.append(valEl, lblEl);
      statsGrid.appendChild(cell);
    };

    addStat('Games Played', String(profile.gamesPlayed), '#8ab4f8');
    addStat('Win Rate', profile.gamesPlayed > 0 ? `${winRate.toFixed(1)}%` : '-', winRate >= 50 ? '#66cc88' : '#cc8866');
    addStat('Wins', String(profile.wins), '#66cc88');
    addStat('Losses', String(profile.losses), '#cc6666');

    body.appendChild(statsGrid);

    // Close button
    const closeRow = document.createElement('div');
    closeRow.style.cssText = 'padding: 0 32px 20px; text-align: right;';
    const closeBtn = this.makeButton('Close', '#3a3a50', '#4a4a66');
    closeBtn.addEventListener('click', () => overlay.remove());
    closeRow.appendChild(closeBtn);

    dialog.append(header, body, closeRow);
    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    this.element.appendChild(overlay);
  }

  // ── Leaderboard ──────────────────────────────────────────────────────

  showLeaderboard(entries: UserProfileData[]): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 1100;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
      animation: lby-fade-in 0.15s ease both;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: linear-gradient(to bottom, rgba(14,16,32,0.98), rgba(6,8,18,0.99));
      border: 1px solid rgba(80,110,200,0.18);
      border-radius: 12px; padding: 0; min-width: 600px; max-width: 750px; max-height: 80vh;
      overflow: hidden; display: flex; flex-direction: column;
      box-shadow: 0 24px 80px rgba(0,0,0,0.6), 0 0 60px rgba(40,60,160,0.06);
      animation: lby-fade-in 0.25s ease both;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      background: linear-gradient(135deg, rgba(30,50,100,0.6), rgba(50,30,90,0.4));
      padding: 22px 32px; border-bottom: 1px solid rgba(80,110,200,0.1);
      display: flex; justify-content: space-between; align-items: center;
      flex-shrink: 0;
    `;
    const title = document.createElement('div');
    title.textContent = 'LEADERBOARD';
    title.style.cssText = 'font-size: 12px; font-weight: 700; letter-spacing: 2px; color: rgba(130,150,210,0.8);';
    const closeBtn = this.makeButton('Close', '#3a3a50', '#4a4a66');
    closeBtn.addEventListener('click', () => overlay.remove());
    header.append(title, closeBtn);

    // Table container
    const tableWrap = document.createElement('div');
    tableWrap.className = 'lby-scrollbar';
    tableWrap.style.cssText = 'flex: 1; overflow-y: auto; padding: 16px 24px 24px;';

    const table = document.createElement('table');
    table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 13px;';

    type SortKey = 'username' | 'gamesPlayed' | 'wins' | 'losses' | 'winRate' | 'createdAt';
    let sortKey: SortKey = 'wins';
    let sortAsc = false;

    const columns: { key: SortKey; label: string; align?: string }[] = [
      { key: 'username', label: 'Player' },
      { key: 'gamesPlayed', label: 'Games' },
      { key: 'wins', label: 'Wins' },
      { key: 'losses', label: 'Losses' },
      { key: 'winRate', label: 'Win %' },
      { key: 'createdAt', label: 'Joined' },
    ];

    const getValue = (e: UserProfileData, key: SortKey): string | number => {
      if (key === 'winRate') return e.gamesPlayed > 0 ? e.wins / e.gamesPlayed : 0;
      return e[key];
    };

    const renderTable = () => {
      table.innerHTML = '';

      // Thead
      const thead = document.createElement('thead');
      const hRow = document.createElement('tr');
      for (const col of columns) {
        const th = document.createElement('th');
        const arrow = sortKey === col.key ? (sortAsc ? ' ▲' : ' ▼') : '';
        th.textContent = col.label + arrow;
        th.style.cssText = `
          padding: 10px 12px; text-align: left; font-size: 10px; font-weight: 700;
          letter-spacing: 1px; color: rgba(130,150,210,0.6); text-transform: uppercase;
          border-bottom: 1px solid rgba(80,100,180,0.12); cursor: pointer;
          user-select: none; white-space: nowrap; transition: color 0.15s;
        `;
        if (sortKey === col.key) th.style.color = 'rgba(160,180,255,0.9)';
        th.addEventListener('mouseenter', () => { th.style.color = 'rgba(160,180,255,0.9)'; });
        th.addEventListener('mouseleave', () => { th.style.color = sortKey === col.key ? 'rgba(160,180,255,0.9)' : 'rgba(130,150,210,0.6)'; });
        th.addEventListener('click', () => {
          if (sortKey === col.key) { sortAsc = !sortAsc; } else { sortKey = col.key; sortAsc = col.key === 'username' || col.key === 'createdAt'; }
          renderTable();
        });
        hRow.appendChild(th);
      }
      thead.appendChild(hRow);
      table.appendChild(thead);

      // Sort entries
      const sorted = [...entries].sort((a, b) => {
        const av = getValue(a, sortKey);
        const bv = getValue(b, sortKey);
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return sortAsc ? cmp : -cmp;
      });

      // Tbody
      const tbody = document.createElement('tbody');
      for (const entry of sorted) {
        const tr = document.createElement('tr');
        tr.style.cssText = 'transition: background 0.15s;';
        tr.addEventListener('mouseenter', () => { tr.style.background = 'rgba(40,50,80,0.2)'; });
        tr.addEventListener('mouseleave', () => { tr.style.background = 'transparent'; });

        const wr = entry.gamesPlayed > 0 ? (entry.wins / entry.gamesPlayed * 100) : 0;
        const joinedDate = new Date(entry.createdAt + 'Z');
        const joined = joinedDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

        const values: { text: string; color: string }[] = [
          { text: entry.username, color: '#bbc4dd' },
          { text: String(entry.gamesPlayed), color: '#8ab4f8' },
          { text: String(entry.wins), color: '#66cc88' },
          { text: String(entry.losses), color: '#cc6666' },
          { text: entry.gamesPlayed > 0 ? `${wr.toFixed(1)}%` : '-', color: wr >= 50 ? '#66cc88' : '#cc8866' },
          { text: joined, color: 'rgba(150,160,190,0.6)' },
        ];

        for (const v of values) {
          const td = document.createElement('td');
          td.textContent = v.text;
          td.style.cssText = `padding: 10px 12px; color: ${v.color}; border-bottom: 1px solid rgba(80,100,180,0.05); white-space: nowrap;`;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    };

    renderTable();
    tableWrap.appendChild(table);
    dialog.append(header, tableWrap);
    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    this.element.appendChild(overlay);
  }

  destroy(): void {
    this.dismissContextMenu();
    cancelAnimationFrame(this.animFrameId);
    this.element.remove();
  }
}
