import type { NetworkManager } from '../network/NetworkManager';
import type { GameLobbyPlayer, GameFormat } from '@gtr/shared';
import { CHARACTER_LIST } from '@gtr/shared';

export class GameLobbyScreen {
  readonly element: HTMLDivElement;
  private network: NetworkManager;
  private localUserId: string;
  private playersEl: HTMLDivElement;
  private leaveBtn: HTMLButtonElement;
  private charListEl: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private animFrameId = 0;

  private hostUserId = '';
  private format: GameFormat = '1v1';
  private mapName = '';
  private players: GameLobbyPlayer[] = [];

  constructor(network: NetworkManager, localUserId: string) {
    this.network = network;
    this.localUserId = localUserId;

    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed; inset: 0; z-index: 1000;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      background: #000;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #ccc;
      overflow: hidden;
    `;

    // ── Inject animations ───────────────────────────────────────────
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      @keyframes glby-fade-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes glby-pulse-border { 0%,100% { border-color: rgba(100,200,140,0.2); } 50% { border-color: rgba(100,200,140,0.5); } }
      @keyframes glby-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
      .glby-btn { transition: all 0.15s ease; }
      .glby-btn:hover { filter: brightness(1.3); transform: translateY(-1px); }
      .glby-btn:active { transform: translateY(0); }
      .glby-char-card { transition: all 0.2s ease; }
      .glby-char-card:hover { transform: translateY(-2px); background: rgba(25,35,55,0.9) !important; }
      .glby-scrollbar::-webkit-scrollbar { width: 5px; }
      .glby-scrollbar::-webkit-scrollbar-track { background: transparent; }
      .glby-scrollbar::-webkit-scrollbar-thumb { background: rgba(100,120,200,0.2); border-radius: 3px; }
    `;
    this.element.appendChild(styleEl);

    // ── Background canvas ───────────────────────────────────────────
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none;';
    this.element.appendChild(canvas);
    this.initBackground(canvas);

    // ── Content ─────────────────────────────────────────────────────
    const content = document.createElement('div');
    content.style.cssText = `
      position: relative; z-index: 1;
      display: flex; flex-direction: column; align-items: center;
      animation: glby-fade-in 0.4s ease both;
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      background: linear-gradient(to bottom, rgba(14,16,28,0.94), rgba(8,10,18,0.96));
      border: 1px solid rgba(100,120,200,0.12);
      border-radius: 10px; padding: 32px 40px; min-width: 540px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4), 0 0 40px rgba(60,80,180,0.06);
    `;

    // ── Status header ───────────────────────────────────────────────
    this.statusEl = document.createElement('div');
    this.statusEl.style.cssText = `
      text-align: center; margin-bottom: 24px; padding-bottom: 18px;
      border-bottom: 1px solid rgba(100,120,200,0.08);
    `;

    // ── Character selection ─────────────────────────────────────────
    const charSection = document.createElement('div');
    charSection.style.cssText = 'margin-bottom: 24px;';

    const charLabel = document.createElement('div');
    charLabel.textContent = 'SELECT CHARACTER';
    charLabel.style.cssText = `
      color: rgba(120,130,160,0.5); font-size: 10px; letter-spacing: 1.5px;
      font-weight: 600; margin-bottom: 12px; text-align: center;
    `;

    this.charListEl = document.createElement('div');
    this.charListEl.style.cssText = 'display: flex; gap: 12px; justify-content: center;';

    for (const char of CHARACTER_LIST) {
      const card = document.createElement('div');
      card.className = 'glby-char-card';
      card.style.cssText = `
        padding: 16px 28px; border-radius: 8px; cursor: pointer; text-align: center;
        background: rgba(14,18,32,0.8);
        border: 2px solid rgba(100,120,200,0.1);
        min-width: 100px;
      `;

      const charName = document.createElement('div');
      charName.textContent = char.name;
      charName.style.cssText = 'font-weight: 600; font-size: 15px; color: #bbc4dd; margin-bottom: 5px;';

      const charRole = document.createElement('div');
      charRole.textContent = char.id === 'janitor' ? 'Melee / Tank' : 'Ranged / Caster';
      charRole.style.cssText = 'font-size: 11px; color: rgba(120,130,160,0.5);';

      card.appendChild(charName);
      card.appendChild(charRole);
      card.dataset.charId = char.id;
      card.addEventListener('click', () => {
        this.network.send({ type: 'select_character', characterId: char.id as any });
      });
      this.charListEl.appendChild(card);
    }

    charSection.appendChild(charLabel);
    charSection.appendChild(this.charListEl);

    // ── Players list ────────────────────────────────────────────────
    this.playersEl = document.createElement('div');
    this.playersEl.className = 'glby-scrollbar';
    this.playersEl.style.cssText = `
      margin-bottom: 24px; padding: 16px;
      background: rgba(0,0,0,0.25); border-radius: 8px;
      border: 1px solid rgba(100,120,200,0.06);
    `;

    // ── Buttons ─────────────────────────────────────────────────────
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 10px; justify-content: center;';

    this.leaveBtn = document.createElement('button');
    this.leaveBtn.className = 'glby-btn';
    this.leaveBtn.textContent = 'Leave';
    this.leaveBtn.style.cssText = `
      padding: 10px 28px; font-size: 13px; font-weight: 500;
      background: #6e2d2d; color: rgba(220,225,240,0.9);
      border: 1px solid rgba(255,255,255,0.06); border-radius: 6px;
      cursor: pointer; outline: none;
    `;
    this.leaveBtn.addEventListener('click', () => {
      this.network.send({ type: 'leave_game' });
    });

    const lockInBtn = document.createElement('button');
    lockInBtn.className = 'glby-btn';
    lockInBtn.textContent = 'Lock In';
    lockInBtn.style.cssText = `
      padding: 10px 28px; font-size: 13px; font-weight: 600;
      background: #2a6e3c; color: rgba(220,225,240,0.9);
      border: 1px solid rgba(255,255,255,0.06); border-radius: 6px;
      cursor: pointer; outline: none;
    `;
    lockInBtn.addEventListener('click', () => {
      this.network.send({ type: 'lock_in' });
    });

    btnRow.appendChild(this.leaveBtn);
    btnRow.appendChild(lockInBtn);

    box.appendChild(this.statusEl);
    box.appendChild(charSection);
    box.appendChild(this.playersEl);
    box.appendChild(btnRow);
    content.appendChild(box);
    this.element.appendChild(content);
  }

  // ── Background ────────────────────────────────────────────────────
  private initBackground(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d')!;
    const orbs: { x: number; y: number; r: number; dx: number; dy: number; color: string; alpha: number }[] = [];

    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    window.addEventListener('resize', resize);

    // Floating ambient orbs
    for (let i = 0; i < 5; i++) {
      orbs.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: 100 + Math.random() * 200,
        dx: (Math.random() - 0.5) * 0.3,
        dy: (Math.random() - 0.5) * 0.3,
        color: ['#1a2550', '#15203a', '#201830', '#182040', '#251830'][i],
        alpha: 0.3 + Math.random() * 0.2,
      });
    }

    let lastDrawTime = 0;
    const FRAME_INTERVAL = 66; // ~15fps — plenty for slow ambient motion

    const draw = (now: number) => {
      this.animFrameId = requestAnimationFrame(draw);
      if (document.hidden) return;
      if (now - lastDrawTime < FRAME_INTERVAL) return;
      lastDrawTime = now;

      ctx.fillStyle = '#000';
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
    mapName: string;
    hostUserId: string;
    players: GameLobbyPlayer[];
  }): void {
    this.hostUserId = state.hostUserId;
    this.format = state.format;
    this.mapName = state.mapName;
    this.players = state.players;

    // Status header
    this.statusEl.innerHTML = '';
    const fmtBadge = document.createElement('span');
    fmtBadge.textContent = this.format;
    fmtBadge.style.cssText = `
      display: inline-block; padding: 3px 12px; border-radius: 4px;
      font-size: 12px; font-weight: 700; letter-spacing: 1px;
      background: rgba(50,70,140,0.3); color: rgba(140,170,255,0.9);
      margin-right: 10px;
    `;
    const mapSpan = document.createElement('span');
    mapSpan.textContent = this.mapName;
    mapSpan.style.cssText = 'font-size: 16px; font-weight: 600; color: #8a9cc4;';

    this.statusEl.appendChild(fmtBadge);
    this.statusEl.appendChild(mapSpan);

    // Highlight selected character
    const localPlayer = this.players.find(p => p.userId === this.localUserId);
    const cards = this.charListEl.children;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i] as HTMLElement;
      const isSelected = card.dataset.charId === localPlayer?.characterId;
      card.style.borderColor = isSelected ? 'rgba(100,200,140,0.5)' : 'rgba(100,120,200,0.1)';
      card.style.background = isSelected ? 'rgba(25,45,35,0.7)' : 'rgba(14,18,32,0.8)';
      if (isSelected) {
        card.style.boxShadow = '0 0 15px rgba(100,200,140,0.1)';
      } else {
        card.style.boxShadow = 'none';
      }
    }

    // Update player list
    this.playersEl.innerHTML = '';
    const team0 = this.players.filter(p => p.team === 0);
    const team1 = this.players.filter(p => p.team === 1);
    const isHost = this.localUserId === this.hostUserId;

    const renderTeam = (team: GameLobbyPlayer[], teamIndex: number, label: string, color: string) => {
      const teamContainer = document.createElement('div');
      teamContainer.dataset.team = String(teamIndex);

      const header = document.createElement('div');
      header.style.cssText = `
        display: flex; align-items: center; gap: 8px;
        font-size: 10px; letter-spacing: 1.5px; font-weight: 600;
        color: ${color}; margin-bottom: 8px;
      `;
      const dot = document.createElement('div');
      dot.style.cssText = `width: 6px; height: 6px; border-radius: 50%; background: ${color};`;
      header.appendChild(dot);
      header.appendChild(document.createTextNode(label));
      teamContainer.appendChild(header);

      for (const p of team) {
        const row = document.createElement('div');
        row.dataset.userId = p.userId;
        row.style.cssText = `
          display: flex; justify-content: space-between; align-items: center;
          padding: 8px 12px; margin-bottom: 4px;
          background: rgba(14,18,32,0.6); border-radius: 5px;
          border-left: 3px solid ${p.lockedIn ? 'rgba(80,200,120,0.5)' : 'rgba(80,90,120,0.15)'};
          ${isHost ? 'cursor: grab;' : ''}
          transition: background 0.15s ease, transform 0.15s ease;
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
          // Each player row is also a drop target for swapping
          row.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer!.dropEffect = 'move';
            row.style.background = 'rgba(100,120,200,0.2)';
          });
          row.addEventListener('dragleave', () => {
            row.style.background = 'rgba(14,18,32,0.6)';
          });
          row.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            row.style.background = 'rgba(14,18,32,0.6)';
            const draggedUserId = e.dataTransfer!.getData('text/plain');
            if (draggedUserId && draggedUserId !== p.userId) {
              const draggedPlayer = this.players.find(pl => pl.userId === draggedUserId);
              if (draggedPlayer && draggedPlayer.team !== p.team) {
                this.network.send({ type: 'swap_team', draggedUserId, droppedOnUserId: p.userId, newTeam: p.team });
              }
            }
          });
        }

        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = `font-size: 13px; font-weight: ${p.userId === this.localUserId ? '600' : '400'}; color: #bbc4dd;`;
        const hostLabel = p.userId === this.hostUserId ? ' (Host)' : '';
        nameSpan.textContent = `${this.escapeHtml(p.username)}${hostLabel}`;

        const rightSide = document.createElement('div');
        rightSide.style.cssText = 'display: flex; align-items: center; gap: 8px;';

        const charName = CHARACTER_LIST.find(c => c.id === p.characterId)?.name ?? '—';
        const charSpan = document.createElement('span');
        charSpan.textContent = charName;
        charSpan.style.cssText = 'font-size: 12px; color: rgba(140,150,180,0.6);';

        if (p.lockedIn) {
          const readyBadge = document.createElement('span');
          readyBadge.textContent = 'READY';
          readyBadge.style.cssText = `
            font-size: 9px; font-weight: 700; letter-spacing: 1px;
            padding: 2px 8px; border-radius: 3px;
            background: rgba(50,160,80,0.2); color: rgba(100,220,130,0.9);
          `;
          rightSide.appendChild(charSpan);
          rightSide.appendChild(readyBadge);
        } else {
          rightSide.appendChild(charSpan);
        }

        row.appendChild(nameSpan);
        row.appendChild(rightSide);
        teamContainer.appendChild(row);
      }

      // Drop zone for the whole team area
      if (isHost) {
        teamContainer.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer!.dropEffect = 'move';
          teamContainer.style.background = 'rgba(100,120,200,0.08)';
          teamContainer.style.borderRadius = '6px';
        });
        teamContainer.addEventListener('dragleave', () => {
          teamContainer.style.background = '';
        });
        teamContainer.addEventListener('drop', (e) => {
          e.preventDefault();
          teamContainer.style.background = '';
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

    renderTeam(team0, 0, 'TEAM 1', 'rgba(100,160,255,0.6)');
    const spacer = document.createElement('div');
    spacer.style.cssText = 'height: 12px;';
    this.playersEl.appendChild(spacer);
    renderTeam(team1, 1, 'TEAM 2', 'rgba(255,130,100,0.6)');

  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  destroy(): void {
    cancelAnimationFrame(this.animFrameId);
    this.element.remove();
  }
}
