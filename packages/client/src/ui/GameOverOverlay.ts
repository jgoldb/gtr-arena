import type { PlayerMatchResult } from '@gtr/shared';
import { CHARACTER_LIST } from '@gtr/shared';

export interface GameOverCallbacks {
  sendMessage: (msg: Record<string, unknown>) => void;
  onExitToLobby: () => void;
}

export class GameOverOverlay {
  private _isGameOver = false;
  private gameOverScreen: HTMLDivElement | null = null;
  private gameOverBox: HTMLDivElement | null = null;
  private rematchOverlay: HTMLDivElement | null = null;
  private rematchReadyText: HTMLDivElement | null = null;
  private rematchMapMode: 'random' | 'same' | 'new' = 'random';

  constructor(private readonly callbacks: GameOverCallbacks) {}

  get isGameOver(): boolean { return this._isGameOver; }

  private static readonly BTN_STYLE = `
    padding: 12px 32px; font-size: 15px; font-weight: bold;
    background: rgba(40, 80, 160, 0.8); color: #ddd;
    border: 1px solid rgba(100, 140, 255, 0.3); border-radius: 4px;
    cursor: pointer; outline: none;
  `;

  show(winningTeam: number, localTeam: number, allPlayersPresent: boolean, playerResults: PlayerMatchResult[]): void {
    this._isGameOver = true;
    const won = localTeam === winningTeam;

    this.gameOverScreen = document.createElement('div');
    this.gameOverScreen.style.cssText = `
      position: fixed; inset: 0; z-index: 900;
      display: flex; align-items: center; justify-content: center;
      pointer-events: none;
    `;

    this.gameOverBox = document.createElement('div');
    this.gameOverBox.style.cssText = `
      background: linear-gradient(to bottom, rgba(20, 20, 35, 0.95), rgba(10, 10, 20, 0.95));
      border: 1px solid ${won ? 'rgba(80, 200, 100, 0.5)' : 'rgba(200, 80, 80, 0.5)'};
      border-radius: 8px; padding: 30px 36px; text-align: center;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      min-width: 560px; pointer-events: auto; position: relative;
    `;

    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = '\u00d7';
    dismissBtn.style.cssText = `
      position: absolute; top: 8px; right: 12px; background: none; border: none;
      color: #888; font-size: 24px; cursor: pointer; outline: none; padding: 4px 8px;
      line-height: 1;
    `;
    dismissBtn.addEventListener('mouseenter', () => { dismissBtn.style.color = '#fff'; });
    dismissBtn.addEventListener('mouseleave', () => { dismissBtn.style.color = '#888'; });
    dismissBtn.addEventListener('click', () => {
      this.gameOverScreen?.remove();
      this.gameOverScreen = null;
      this.gameOverBox = null;
    });
    this.gameOverBox.appendChild(dismissBtn);

    const title = document.createElement('div');
    title.textContent = won ? 'Victory!' : 'Defeat';
    title.style.cssText = `color: ${won ? '#44cc44' : '#cc4444'}; font-size: 32px; font-weight: bold; margin-bottom: 20px;`;
    this.gameOverBox.appendChild(title);

    // ── Scoreboard table ──────────────────────────────────────────────
    const getCharName = (charId: string) => CHARACTER_LIST.find(c => c.id === charId)?.name ?? charId;
    const formatNum = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

    const winners = playerResults.filter(p => p.team === winningTeam).sort((a, b) => b.stats.damageDealt - a.stats.damageDealt);
    const losers = playerResults.filter(p => p.team !== winningTeam).sort((a, b) => b.stats.damageDealt - a.stats.damageDealt);

    const headerCellStyle = `
      padding: 6px 12px; font-size: 11px; font-weight: bold; text-transform: uppercase;
      color: #888; letter-spacing: 0.5px; border-bottom: 1px solid rgba(255,255,255,0.1);
      white-space: nowrap;
    `;
    const cellStyle = `padding: 7px 12px; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,0.05); white-space: nowrap;`;
    const numCellStyle = `${cellStyle} text-align: right; font-variant-numeric: tabular-nums;`;

    const table = document.createElement('table');
    table.style.cssText = 'width: 100%; border-collapse: collapse; margin-bottom: 20px;';

    const thead = document.createElement('thead');
    thead.innerHTML = `<tr>
      <th style="${headerCellStyle} text-align: left;">Player</th>
      <th style="${headerCellStyle} text-align: right;">Lvl</th>
      <th style="${headerCellStyle} text-align: right;">KB</th>
      <th style="${headerCellStyle} text-align: right;">Deaths</th>
      <th style="${headerCellStyle} text-align: right;">Damage</th>
      <th style="${headerCellStyle} text-align: right;">Healing</th>
      <th style="${headerCellStyle} text-align: right;">XP</th>
    </tr>`;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    const renderTeamRows = (players: PlayerMatchResult[], isWinningTeam: boolean) => {
      if (players.length === 0) return;

      const divider = document.createElement('tr');
      const divCell = document.createElement('td');
      divCell.colSpan = 7;
      divCell.style.cssText = `
        padding: 6px 12px 4px; font-size: 11px; font-weight: bold; text-transform: uppercase;
        color: ${isWinningTeam ? '#5a5' : '#a55'}; letter-spacing: 0.5px;
        border-bottom: 1px solid ${isWinningTeam ? 'rgba(80,200,100,0.2)' : 'rgba(200,80,80,0.2)'};
        text-align: left;
      `;
      divCell.textContent = isWinningTeam ? 'Winners' : 'Losers';
      divider.appendChild(divCell);
      tbody.appendChild(divider);

      for (const p of players) {
        const row = document.createElement('tr');
        const rowBg = isWinningTeam ? 'rgba(40, 80, 40, 0.15)' : 'rgba(80, 40, 40, 0.15)';
        row.style.cssText = `background: ${rowBg};`;

        const nameCell = document.createElement('td');
        nameCell.style.cssText = `${cellStyle} text-align: left;`;
        nameCell.innerHTML = `<span style="color: #eee; font-weight: bold;">${p.username}</span>` +
          `<span style="color: #777; font-size: 11px; margin-left: 6px;">${getCharName(p.characterId)}</span>`;
        row.appendChild(nameCell);

        const lvlCell = document.createElement('td');
        lvlCell.style.cssText = numCellStyle;
        lvlCell.style.color = '#ccc';
        lvlCell.textContent = String(p.level);
        row.appendChild(lvlCell);

        const kbCell = document.createElement('td');
        kbCell.style.cssText = numCellStyle;
        kbCell.style.color = p.stats.kills > 0 ? '#e8c35a' : '#666';
        kbCell.textContent = String(p.stats.kills);
        row.appendChild(kbCell);

        const deathCell = document.createElement('td');
        deathCell.style.cssText = numCellStyle;
        deathCell.style.color = p.stats.deaths > 0 ? '#c44' : '#666';
        deathCell.textContent = String(p.stats.deaths);
        row.appendChild(deathCell);

        const dmgCell = document.createElement('td');
        dmgCell.style.cssText = numCellStyle;
        dmgCell.style.color = '#e07040';
        dmgCell.textContent = formatNum(p.stats.damageDealt);
        row.appendChild(dmgCell);

        const healCell = document.createElement('td');
        healCell.style.cssText = numCellStyle;
        healCell.style.color = p.stats.healingDone > 0 ? '#44cc44' : '#666';
        healCell.textContent = formatNum(p.stats.healingDone);
        row.appendChild(healCell);

        const xpCell = document.createElement('td');
        xpCell.style.cssText = numCellStyle;
        xpCell.style.color = '#b080e0';
        xpCell.textContent = `+${formatNum(p.xpGained)}`;
        row.appendChild(xpCell);

        tbody.appendChild(row);
      }
    };

    renderTeamRows(winners, true);
    renderTeamRows(losers, false);
    table.appendChild(tbody);
    this.gameOverBox.appendChild(table);

    // ── Buttons ───────────────────────────────────────────────────────

    if (allPlayersPresent) {
      const rematchSection = document.createElement('div');
      rematchSection.style.cssText = 'margin-bottom: 12px;';

      const mapModeRow = document.createElement('div');
      mapModeRow.style.cssText = 'display: flex; gap: 8px; justify-content: center; margin-bottom: 10px;';

      const toggleBtnStyle = (active: boolean) => `
        padding: 8px 18px; font-size: 13px; font-weight: bold;
        background: ${active ? 'rgba(60, 120, 200, 0.9)' : 'rgba(40, 40, 60, 0.6)'};
        color: ${active ? '#fff' : '#888'};
        border: 1px solid ${active ? 'rgba(100, 160, 255, 0.5)' : 'rgba(80, 80, 100, 0.3)'};
        border-radius: 4px; cursor: pointer; outline: none; transition: all 0.15s;
      `;

      const randomBtn = document.createElement('button');
      randomBtn.textContent = 'Random Map';
      randomBtn.style.cssText = toggleBtnStyle(true);
      this.rematchMapMode = 'random';

      const sameBtn = document.createElement('button');
      sameBtn.textContent = 'Same Map';
      sameBtn.style.cssText = toggleBtnStyle(false);

      const newBtn = document.createElement('button');
      newBtn.textContent = 'New Map';
      newBtn.style.cssText = toggleBtnStyle(false);

      const updateToggle = (mode: 'random' | 'same' | 'new') => {
        this.rematchMapMode = mode;
        randomBtn.style.cssText = toggleBtnStyle(mode === 'random');
        sameBtn.style.cssText = toggleBtnStyle(mode === 'same');
        newBtn.style.cssText = toggleBtnStyle(mode === 'new');
      };

      randomBtn.addEventListener('click', () => updateToggle('random'));
      sameBtn.addEventListener('click', () => updateToggle('same'));
      newBtn.addEventListener('click', () => updateToggle('new'));

      mapModeRow.appendChild(randomBtn);
      mapModeRow.appendChild(sameBtn);
      mapModeRow.appendChild(newBtn);
      rematchSection.appendChild(mapModeRow);

      const rematchBtn = document.createElement('button');
      rematchBtn.textContent = 'Rematch';
      rematchBtn.style.cssText = `
        padding: 12px 32px; font-size: 15px; font-weight: bold;
        background: rgba(40, 160, 80, 0.8); color: #ddd;
        border: 1px solid rgba(80, 200, 120, 0.4); border-radius: 4px;
        cursor: pointer; outline: none; width: 100%;
      `;
      rematchBtn.addEventListener('click', () => {
        this.callbacks.sendMessage({ type: 'request_rematch', mapMode: this.rematchMapMode });
      });
      rematchSection.appendChild(rematchBtn);

      this.gameOverBox.appendChild(rematchSection);
    }

    const lobbyBtn = document.createElement('button');
    lobbyBtn.textContent = 'Exit Game';
    lobbyBtn.style.cssText = GameOverOverlay.BTN_STYLE;
    lobbyBtn.addEventListener('click', () => {
      this.callbacks.onExitToLobby();
      this.callbacks.sendMessage({ type: 'return_to_lobby' });
    });
    this.gameOverBox.appendChild(lobbyBtn);

    this.gameOverScreen.appendChild(this.gameOverBox);
    document.body.appendChild(this.gameOverScreen);
  }

  showRematchChallenge(challengerUsername: string, mapMode: 'random' | 'same' | 'new', totalPlayers: number, readyCount: number): void {
    this.clearRematch();

    this.rematchOverlay = document.createElement('div');
    this.rematchOverlay.style.cssText = `
      position: fixed; inset: 0; z-index: 950;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.5); pointer-events: auto;
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      background: linear-gradient(to bottom, rgba(20, 20, 40, 0.97), rgba(10, 10, 25, 0.97));
      border: 1px solid rgba(100, 140, 220, 0.3);
      border-radius: 8px; padding: 32px 40px; text-align: center;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      min-width: 300px;
    `;

    const heading = document.createElement('div');
    heading.textContent = 'Rematch Challenge';
    heading.style.cssText = 'color: #ccd; font-size: 22px; font-weight: bold; margin-bottom: 12px;';

    const desc = document.createElement('div');
    const modeLabel = mapMode === 'random' ? 'Random Map' : mapMode === 'same' ? 'Same Map' : 'New Map';
    desc.textContent = `${challengerUsername} wants a rematch (${modeLabel})`;
    desc.style.cssText = 'color: #99a; font-size: 14px; margin-bottom: 16px;';

    this.rematchReadyText = document.createElement('div');
    this.rematchReadyText.textContent = `${readyCount} / ${totalPlayers} ready`;
    this.rematchReadyText.style.cssText = 'color: #8cf; font-size: 16px; font-weight: bold; margin-bottom: 20px;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 12px; justify-content: center;';

    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = 'Accept';
    acceptBtn.style.cssText = `
      padding: 10px 28px; font-size: 15px; font-weight: bold;
      background: rgba(40, 160, 80, 0.8); color: #ddd;
      border: 1px solid rgba(80, 200, 120, 0.4); border-radius: 4px;
      cursor: pointer; outline: none;
    `;

    const declineBtn = document.createElement('button');
    declineBtn.textContent = 'Decline';
    declineBtn.style.cssText = `
      padding: 10px 28px; font-size: 15px; font-weight: bold;
      background: rgba(160, 50, 50, 0.8); color: #ddd;
      border: 1px solid rgba(200, 80, 80, 0.4); border-radius: 4px;
      cursor: pointer; outline: none;
    `;

    acceptBtn.addEventListener('click', () => {
      this.callbacks.sendMessage({ type: 'accept_rematch' });
      acceptBtn.disabled = true;
      acceptBtn.style.opacity = '0.5';
      declineBtn.disabled = true;
      declineBtn.style.opacity = '0.5';
    });

    declineBtn.addEventListener('click', () => {
      this.callbacks.sendMessage({ type: 'decline_rematch' });
    });

    btnRow.appendChild(acceptBtn);
    btnRow.appendChild(declineBtn);

    box.appendChild(heading);
    box.appendChild(desc);
    box.appendChild(this.rematchReadyText);
    box.appendChild(btnRow);
    this.rematchOverlay.appendChild(box);
    document.body.appendChild(this.rematchOverlay);
  }

  showRematchReadyCheck(readyCount: number, totalPlayers: number): void {
    this.clearRematch();

    this.rematchOverlay = document.createElement('div');
    this.rematchOverlay.style.cssText = `
      position: fixed; inset: 0; z-index: 950;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.5); pointer-events: auto;
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      background: linear-gradient(to bottom, rgba(20, 20, 40, 0.97), rgba(10, 10, 25, 0.97));
      border: 1px solid rgba(100, 140, 220, 0.3);
      border-radius: 8px; padding: 32px 40px; text-align: center;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      min-width: 280px;
    `;

    const heading = document.createElement('div');
    heading.textContent = 'Waiting for players...';
    heading.style.cssText = 'color: #ccd; font-size: 20px; font-weight: bold; margin-bottom: 16px;';

    this.rematchReadyText = document.createElement('div');
    this.rematchReadyText.textContent = `${readyCount} / ${totalPlayers} ready`;
    this.rematchReadyText.style.cssText = 'color: #8cf; font-size: 18px; font-weight: bold;';

    box.appendChild(heading);
    box.appendChild(this.rematchReadyText);
    this.rematchOverlay.appendChild(box);
    document.body.appendChild(this.rematchOverlay);
  }

  updateRematchReady(readyCount: number, totalPlayers: number): void {
    if (this.rematchReadyText) {
      this.rematchReadyText.textContent = `${readyCount} / ${totalPlayers} ready`;
      return;
    }
    this.showRematchReadyCheck(readyCount, totalPlayers);
  }

  handleRematchFailed(reason: string): void {
    this.clearRematch();

    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 950;
      display: flex; align-items: center; justify-content: center;
      pointer-events: none;
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      background: linear-gradient(to bottom, rgba(30, 15, 15, 0.95), rgba(15, 10, 10, 0.95));
      border: 1px solid rgba(200, 80, 80, 0.4);
      border-radius: 8px; padding: 24px 36px; text-align: center;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    `;

    const text = document.createElement('div');
    text.textContent = reason;
    text.style.cssText = 'color: #e88; font-size: 16px; font-weight: bold;';

    box.appendChild(text);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    setTimeout(() => overlay.remove(), 3000);
  }

  clearRematch(): void {
    this.rematchOverlay?.remove();
    this.rematchOverlay = null;
    this.rematchReadyText = null;
  }

  cleanup(): void {
    this.gameOverScreen?.remove();
    this.gameOverScreen = null;
    this.gameOverBox = null;
    this._isGameOver = false;
    this.clearRematch();
  }
}
