import type { NetworkManager } from '../network/NetworkManager';
import type { LobbyUser, LobbyGameInfo, UserProfileData } from '@gtr/shared';
import { xpToLevel, xpProgress } from '@gtr/shared';
import { LobbyDialogs, makeButton } from './LobbyDialogs';

export class LobbyScreen {
  readonly element: HTMLDivElement;
  private chatLog: HTMLDivElement;
  private chatInput: HTMLInputElement;
  private userListEl: HTMLDivElement;
  private gameListEl: HTMLDivElement;
  private network: NetworkManager;
  private localUserId: string;
  private animFrameId = 0;
  private localXp = 0;
  private levelBadgeContainer: HTMLDivElement;
  private xpBarFill: HTMLDivElement;
  private xpText: HTMLDivElement;
  private dialogs: LobbyDialogs;

  onPlayground?: () => void;
  onUISetup?: () => void;
  onLogout?: () => void;
  onAdmin?: () => void;
  onChangePassword?: () => void;
  onMenu?: () => void;

  constructor(network: NetworkManager, localUserId: string, isAdmin = false, localXp = 0) {
    this.network = network;
    this.localUserId = localUserId;

    this.element = document.createElement('div');
    this.dialogs = new LobbyDialogs(this.element, network);
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

    const createBtn = makeButton('Create Game', '#3466b8', '#4a80d4');
    createBtn.style.fontWeight = '600';
    createBtn.addEventListener('click', () => {
      this.network.send({ type: 'create_game', format: '2v2', mapId: 'cage' });
    });
    btnRow.appendChild(createBtn);

    const leaderboardBtn = makeButton('Leaderboard', '#2a5a5a', '#348a7a');
    leaderboardBtn.addEventListener('click', () => {
      this.network.send({ type: 'get_leaderboard' });
    });
    btnRow.appendChild(leaderboardBtn);

    const menuBtn = makeButton('Menu', '#3a3a50', '#4a4a66');
    menuBtn.addEventListener('click', () => this.onMenu?.());
    btnRow.appendChild(menuBtn);

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

    // ── Level badge + XP bar ──────────────────────────────────────
    this.localXp = localXp;

    const levelSection = document.createElement('div');
    levelSection.style.cssText = 'display: flex; flex-direction: column; align-items: center; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid rgba(100,120,200,0.08);';

    // Badge container (swapped out on update)
    this.levelBadgeContainer = document.createElement('div');
    levelSection.appendChild(this.levelBadgeContainer);

    // "LEVEL" label
    const levelLabel = document.createElement('div');
    levelLabel.textContent = 'LEVEL';
    levelLabel.style.cssText = 'font-size: 9px; font-weight: 700; letter-spacing: 2px; color: rgba(200,180,120,0.6); margin-top: 6px;';
    levelSection.appendChild(levelLabel);

    // XP bar
    const xpBarOuter = document.createElement('div');
    xpBarOuter.style.cssText = `
      width: 100%; height: 6px; margin-top: 8px; border-radius: 3px;
      background: rgba(0,0,0,0.4); border: 1px solid rgba(180,160,100,0.15);
      overflow: hidden; position: relative;
    `;
    this.xpBarFill = document.createElement('div');
    this.xpBarFill.style.cssText = `
      height: 100%; width: 0%; border-radius: 3px;
      background: linear-gradient(90deg, #8a6d1b, #c9a84c, #8a6d1b);
      background-size: 200% 100%;
      box-shadow: 0 0 6px rgba(200,170,60,0.3);
      transition: width 0.3s ease;
    `;
    xpBarOuter.appendChild(this.xpBarFill);
    levelSection.appendChild(xpBarOuter);

    // XP text
    this.xpText = document.createElement('div');
    this.xpText.style.cssText = 'font-size: 10px; color: rgba(200,180,120,0.5); margin-top: 4px;';
    levelSection.appendChild(this.xpText);

    // Render initial state
    this.renderLevelDisplay();

    rightPanel.appendChild(levelSection);

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

    const resize = () => {
      const oldW = canvas.width || 1;
      const oldH = canvas.height || 1;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      // Scale particle positions proportionally so they don't bunch up
      for (const p of particles) {
        p.x = (p.x / oldW) * canvas.width;
        p.y = (p.y / oldH) * canvas.height;
      }
    };
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

  // ── Level display ─────────────────────────────────────────────────

  private renderLevelDisplay(): void {
    const level = xpToLevel(this.localXp);
    const progress = xpProgress(this.localXp);
    const pct = progress.needed > 0 ? (progress.current / progress.needed) * 100 : 0;

    // Replace badge
    this.levelBadgeContainer.innerHTML = '';
    this.levelBadgeContainer.appendChild(this.dialogs.createLevelBadge(level, 52));

    // Update bar + text
    this.xpBarFill.style.width = `${pct}%`;
    this.xpText.textContent = `${progress.current} / ${progress.needed} XP`;
  }

  updateXp(xp: number, oldXp?: number): void {
    const oldLevel = oldXp !== undefined ? xpToLevel(oldXp) : xpToLevel(this.localXp);
    this.localXp = xp;
    const newLevel = xpToLevel(xp);

    if (oldXp !== undefined && newLevel > oldLevel) {
      this.dialogs.playLevelUpAnimation(
        oldLevel, newLevel, this.localXp,
        this.levelBadgeContainer, this.xpBarFill, this.xpText,
        () => this.renderLevelDisplay(),
      );
    } else {
      this.renderLevelDisplay();
    }
  }


  // ── Public API ────────────────────────────────────────────────────

  addChatMessage(username: string, message: string, isAnnouncement?: boolean): void {
    const line = document.createElement('div');
    line.className = 'lby-chat-msg';
    if (isAnnouncement) {
      line.innerHTML = `<span style="color: #e0c354; font-weight: 600;">[Server]</span><span style="color: rgba(224,195,84,0.4); margin: 0 6px;">›</span><span style="color: #e0c354;">${this.escapeHtml(message)}</span>`;
    } else {
      line.innerHTML = `<span style="color: #7a9de0; font-weight: 600;">${this.escapeHtml(username)}</span><span style="color: rgba(100,120,160,0.4); margin: 0 6px;">›</span><span style="color: rgba(200,205,220,0.85);">${this.escapeHtml(message)}</span>`;
    }
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

      const isOnline = u.status === 'online';
      const dot = document.createElement('span');
      dot.style.cssText = `
        width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
        background: ${isOnline ? '#44cc44' : '#cc8844'};
        box-shadow: 0 0 4px ${isOnline ? 'rgba(68,204,68,0.4)' : 'rgba(204,136,68,0.4)'};
      `;
      if (!isOnline) {
        dot.title = u.status === 'in-game' ? 'In Multiplayer' : 'In Single Player';
      }
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
      hostLine.textContent = `${game.hostUsername}'s Game`;

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

      let actionEl: HTMLElement;
      if (game.inProgress) {
        actionEl = document.createElement('span');
        actionEl.textContent = 'In Progress';
        actionEl.style.cssText = `
          font-size: 12px; font-weight: 600; color: rgba(255,190,60,0.8);
          padding: 6px 14px; border-radius: 4px;
          background: rgba(255,190,60,0.1); border: 1px solid rgba(255,190,60,0.15);
        `;
      } else {
        const isFull = game.playerCount >= game.maxPlayers;
        actionEl = makeButton('Join', isFull ? '#3a3a4a' : '#2a6e3c', isFull ? '#3a3a4a' : '#348a4c');
        if (isFull) {
          actionEl.textContent = 'Full';
          actionEl.style.cursor = 'default';
          actionEl.style.opacity = '0.5';
          actionEl.style.pointerEvents = 'none';
        } else {
          actionEl.addEventListener('click', () => {
            this.network.send({ type: 'join_game', gameId: game.gameId });
          });
        }
      }

      row.appendChild(info);
      row.appendChild(actionEl);
      this.gameListEl.appendChild(row);
    }
  }

  showChangePasswordDialog(): void { this.dialogs.showChangePasswordDialog(); }
  showChangePasswordResult(success: boolean, error?: string): void { this.dialogs.showChangePasswordResult(success, error); }

  // ── Helpers ───────────────────────────────────────────────────────

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

  updateOpenProfileDialog(profile: UserProfileData): void { this.dialogs.updateOpenProfileDialog(profile); }

  showProfileDialog(profile: UserProfileData): void { this.dialogs.showProfileDialog(profile); }
  showLeaderboard(entries: UserProfileData[]): void { this.dialogs.showLeaderboard(entries); }

  destroy(): void {
    this.dismissContextMenu();
    cancelAnimationFrame(this.animFrameId);
    this.element.remove();
  }
}
