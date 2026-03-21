import type { NetworkManager } from '../network/NetworkManager';
import type { GameLobbyPlayer, GameFormat } from '@gtr/shared';
import { CHARACTER_LIST } from '@gtr/shared';

export class GameLobbyScreen {
  readonly element: HTMLDivElement;
  private network: NetworkManager;
  private localUserId: string;
  private playersEl: HTMLDivElement;
  private startBtn: HTMLButtonElement;
  private leaveBtn: HTMLButtonElement;
  private charListEl: HTMLDivElement;
  private statusEl: HTMLDivElement;

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
      background: radial-gradient(ellipse at center, #0a0a14 0%, #000000 100%);
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #ccc;
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      background: linear-gradient(to bottom, rgba(20, 20, 35, 0.95), rgba(10, 10, 20, 0.95));
      border: 1px solid rgba(100, 120, 200, 0.3);
      border-radius: 8px; padding: 30px 40px; min-width: 500px;
    `;

    this.statusEl = document.createElement('div');
    this.statusEl.style.cssText = 'font-size: 16px; font-weight: bold; color: #8899cc; margin-bottom: 20px; text-align: center;';

    // Character selection
    const charLabel = document.createElement('div');
    charLabel.textContent = 'Select Character';
    charLabel.style.cssText = 'color: #889; font-size: 12px; margin-bottom: 8px;';

    this.charListEl = document.createElement('div');
    this.charListEl.style.cssText = 'display: flex; gap: 12px; margin-bottom: 20px; justify-content: center;';

    for (const char of CHARACTER_LIST) {
      const card = document.createElement('div');
      card.style.cssText = `
        padding: 12px 20px; border-radius: 6px; cursor: pointer; text-align: center;
        background: rgba(20, 25, 40, 0.8);
        border: 2px solid rgba(100, 120, 200, 0.15);
        transition: border-color 0.2s;
      `;
      card.innerHTML = `
        <div style="font-weight: bold; font-size: 14px; margin-bottom: 4px;">${char.name}</div>
        <div style="font-size: 11px; color: #778;">${char.id === 'janitor' ? 'Melee / Tank' : 'Ranged / Caster'}</div>
      `;
      card.dataset.charId = char.id;
      card.addEventListener('click', () => {
        this.network.send({ type: 'select_character', characterId: char.id as any });
      });
      this.charListEl.appendChild(card);
    }

    // Players list
    this.playersEl = document.createElement('div');
    this.playersEl.style.cssText = `
      margin-bottom: 20px; padding: 12px;
      background: rgba(0, 0, 0, 0.3); border-radius: 4px;
    `;

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 12px; justify-content: center;';

    this.leaveBtn = document.createElement('button');
    this.leaveBtn.textContent = 'Leave';
    this.leaveBtn.style.cssText = `
      padding: 10px 24px; font-size: 14px;
      background: rgba(120, 40, 40, 0.8); color: #ddd;
      border: 1px solid rgba(200, 80, 80, 0.3); border-radius: 4px;
      cursor: pointer; outline: none;
    `;
    this.leaveBtn.addEventListener('click', () => {
      this.network.send({ type: 'leave_game' });
    });

    const lockInBtn = document.createElement('button');
    lockInBtn.textContent = 'Lock In';
    lockInBtn.style.cssText = `
      padding: 10px 24px; font-size: 14px;
      background: rgba(40, 100, 60, 0.8); color: #ddd;
      border: 1px solid rgba(80, 200, 100, 0.3); border-radius: 4px;
      cursor: pointer; outline: none;
    `;
    lockInBtn.addEventListener('click', () => {
      this.network.send({ type: 'lock_in' });
    });

    this.startBtn = document.createElement('button');
    this.startBtn.textContent = 'Start Game';
    this.startBtn.style.cssText = `
      padding: 10px 24px; font-size: 14px; font-weight: bold;
      background: rgba(40, 80, 160, 0.8); color: #ddd;
      border: 1px solid rgba(100, 140, 255, 0.3); border-radius: 4px;
      cursor: pointer; outline: none; display: none;
    `;
    this.startBtn.addEventListener('click', () => {
      this.network.send({ type: 'start_game' });
    });

    btnRow.appendChild(this.leaveBtn);
    btnRow.appendChild(lockInBtn);
    btnRow.appendChild(this.startBtn);

    box.appendChild(this.statusEl);
    box.appendChild(charLabel);
    box.appendChild(this.charListEl);
    box.appendChild(this.playersEl);
    box.appendChild(btnRow);
    this.element.appendChild(box);
  }

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

    this.statusEl.textContent = `${this.format} - ${this.mapName}`;

    // Highlight selected character
    const localPlayer = this.players.find(p => p.userId === this.localUserId);
    const cards = this.charListEl.children;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i] as HTMLElement;
      const isSelected = card.dataset.charId === localPlayer?.characterId;
      card.style.borderColor = isSelected ? 'rgba(100, 200, 140, 0.6)' : 'rgba(100, 120, 200, 0.15)';
    }

    // Update player list
    this.playersEl.innerHTML = '';
    const team0 = this.players.filter(p => p.team === 0);
    const team1 = this.players.filter(p => p.team === 1);

    const renderTeam = (team: GameLobbyPlayer[], label: string) => {
      const header = document.createElement('div');
      header.textContent = label;
      header.style.cssText = 'font-size: 12px; color: #778; margin-bottom: 6px; font-weight: bold;';
      this.playersEl.appendChild(header);

      for (const p of team) {
        const row = document.createElement('div');
        row.style.cssText = `
          display: flex; justify-content: space-between; align-items: center;
          padding: 6px 8px; margin-bottom: 4px;
          background: rgba(20, 25, 40, 0.6); border-radius: 3px;
        `;
        const charName = CHARACTER_LIST.find(c => c.id === p.characterId)?.name ?? '(none)';
        const lockIcon = p.lockedIn ? ' [Ready]' : '';
        const isHost = p.userId === this.hostUserId ? ' (Host)' : '';
        row.innerHTML = `
          <span>${this.escapeHtml(p.username)}${isHost}</span>
          <span style="color: ${p.lockedIn ? '#44cc44' : '#889'}; font-size: 12px;">
            ${charName}${lockIcon}
          </span>
        `;
        this.playersEl.appendChild(row);
      }
    };

    renderTeam(team0, 'Team 1');
    if (team1.length > 0) {
      const spacer = document.createElement('div');
      spacer.style.cssText = 'height: 8px;';
      this.playersEl.appendChild(spacer);
      renderTeam(team1, 'Team 2');
    }

    // Show/hide start button (only for host)
    this.startBtn.style.display = this.hostUserId === this.localUserId ? 'block' : 'none';
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  destroy(): void {
    this.element.remove();
  }
}
