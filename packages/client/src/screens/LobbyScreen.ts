import type { NetworkManager } from '../network/NetworkManager';
import type { LobbyUser, LobbyGameInfo, GameFormat } from '@gtr/shared';
import { MAP_LIST } from '@gtr/shared';

export class LobbyScreen {
  readonly element: HTMLDivElement;
  private chatLog: HTMLDivElement;
  private chatInput: HTMLInputElement;
  private userListEl: HTMLDivElement;
  private gameListEl: HTMLDivElement;
  private network: NetworkManager;
  private localUserId: string;

  onPlayground?: () => void;

  constructor(network: NetworkManager, localUserId: string) {
    this.network = network;
    this.localUserId = localUserId;

    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed; inset: 0; z-index: 1000;
      display: flex; background: #05050a;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #ccc;
    `;

    // Left panel: Chat
    const chatPanel = document.createElement('div');
    chatPanel.style.cssText = `
      flex: 1; display: flex; flex-direction: column;
      border-right: 1px solid rgba(100, 120, 200, 0.15); padding: 12px;
    `;

    const chatTitle = document.createElement('div');
    chatTitle.textContent = 'Lobby Chat';
    chatTitle.style.cssText = 'font-size: 14px; font-weight: bold; color: #8899cc; margin-bottom: 8px;';

    this.chatLog = document.createElement('div');
    this.chatLog.style.cssText = `
      flex: 1; overflow-y: auto; padding: 8px;
      background: rgba(0, 0, 0, 0.4); border-radius: 4px;
      font-size: 13px; line-height: 1.6;
    `;

    this.chatInput = document.createElement('input');
    this.chatInput.type = 'text';
    this.chatInput.placeholder = 'Type a message...';
    this.chatInput.maxLength = 500;
    this.chatInput.style.cssText = `
      margin-top: 8px; padding: 8px 12px; font-size: 13px;
      background: rgba(0, 0, 0, 0.5); color: #ccc;
      border: 1px solid rgba(100, 120, 200, 0.2); border-radius: 4px; outline: none;
    `;
    this.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.chatInput.value.trim()) {
        this.network.send({ type: 'lobby_chat', message: this.chatInput.value });
        this.chatInput.value = '';
      }
    });

    chatPanel.appendChild(chatTitle);
    chatPanel.appendChild(this.chatLog);
    chatPanel.appendChild(this.chatInput);

    // Center panel: Game browser
    const centerPanel = document.createElement('div');
    centerPanel.style.cssText = 'flex: 2; display: flex; flex-direction: column; padding: 12px;';

    const header = document.createElement('div');
    header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;';

    const gamesTitle = document.createElement('div');
    gamesTitle.textContent = 'Games';
    gamesTitle.style.cssText = 'font-size: 16px; font-weight: bold; color: #8899cc;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 8px;';

    const createBtn = this.makeButton('Create Game', 'rgba(40, 80, 140, 0.8)');
    createBtn.addEventListener('click', () => this.showCreateGameDialog());
    btnRow.appendChild(createBtn);

    // Playground button (dev mode only)
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      const playgroundBtn = this.makeButton('Playground', 'rgba(80, 60, 120, 0.8)');
      playgroundBtn.addEventListener('click', () => this.onPlayground?.());
      btnRow.appendChild(playgroundBtn);
    }

    header.appendChild(gamesTitle);
    header.appendChild(btnRow);

    this.gameListEl = document.createElement('div');
    this.gameListEl.style.cssText = `
      flex: 1; overflow-y: auto; padding: 8px;
      background: rgba(0, 0, 0, 0.3); border-radius: 4px;
    `;

    centerPanel.appendChild(header);
    centerPanel.appendChild(this.gameListEl);

    // Right panel: Users
    const rightPanel = document.createElement('div');
    rightPanel.style.cssText = `
      width: 180px; display: flex; flex-direction: column;
      border-left: 1px solid rgba(100, 120, 200, 0.15); padding: 12px;
    `;

    const usersTitle = document.createElement('div');
    usersTitle.textContent = 'Online';
    usersTitle.style.cssText = 'font-size: 14px; font-weight: bold; color: #8899cc; margin-bottom: 8px;';

    this.userListEl = document.createElement('div');
    this.userListEl.style.cssText = 'flex: 1; overflow-y: auto; font-size: 13px;';

    rightPanel.appendChild(usersTitle);
    rightPanel.appendChild(this.userListEl);

    this.element.appendChild(chatPanel);
    this.element.appendChild(centerPanel);
    this.element.appendChild(rightPanel);
  }

  addChatMessage(username: string, message: string): void {
    const line = document.createElement('div');
    line.innerHTML = `<span style="color: #8899cc; font-weight: bold;">${this.escapeHtml(username)}</span>: ${this.escapeHtml(message)}`;
    this.chatLog.appendChild(line);
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  updateUsers(users: LobbyUser[]): void {
    this.userListEl.innerHTML = '';
    for (const u of users) {
      const row = document.createElement('div');
      row.style.cssText = 'padding: 4px 0; display: flex; align-items: center; gap: 6px;';
      const dot = document.createElement('span');
      dot.style.cssText = `
        width: 8px; height: 8px; border-radius: 50%; display: inline-block;
        background: ${u.status === 'online' ? '#44cc44' : '#cc8844'};
      `;
      const name = document.createElement('span');
      name.textContent = u.username;
      if (u.userId === this.localUserId) name.style.fontWeight = 'bold';
      row.appendChild(dot);
      row.appendChild(name);
      this.userListEl.appendChild(row);
    }
  }

  updateGames(games: LobbyGameInfo[]): void {
    this.gameListEl.innerHTML = '';
    if (games.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No games available. Create one!';
      empty.style.cssText = 'color: #556; font-size: 13px; text-align: center; padding: 40px;';
      this.gameListEl.appendChild(empty);
      return;
    }
    for (const game of games) {
      const row = document.createElement('div');
      row.style.cssText = `
        display: flex; justify-content: space-between; align-items: center;
        padding: 10px 12px; margin-bottom: 6px;
        background: rgba(20, 25, 40, 0.8); border-radius: 4px;
        border: 1px solid rgba(100, 120, 200, 0.15);
      `;
      const info = document.createElement('div');
      info.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 2px;">${this.escapeHtml(game.hostUsername)}'s Game</div>
        <div style="font-size: 12px; color: #778;">
          ${game.format} &middot; ${this.escapeHtml(game.mapName)} &middot; ${game.playerCount}/${game.maxPlayers}
        </div>
      `;
      const joinBtn = this.makeButton('Join', 'rgba(40, 120, 60, 0.8)');
      joinBtn.addEventListener('click', () => {
        this.network.send({ type: 'join_game', gameId: game.gameId });
      });
      row.appendChild(info);
      row.appendChild(joinBtn);
      this.gameListEl.appendChild(row);
    }
  }

  private showCreateGameDialog(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 1100;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.7);
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: linear-gradient(to bottom, rgba(20, 20, 35, 0.98), rgba(10, 10, 20, 0.98));
      border: 1px solid rgba(100, 120, 200, 0.3);
      border-radius: 8px; padding: 30px 40px;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    `;

    const title = document.createElement('div');
    title.textContent = 'Create Game';
    title.style.cssText = 'color: #8899cc; font-size: 18px; font-weight: bold; margin-bottom: 20px;';

    // Format selection
    const formatLabel = document.createElement('div');
    formatLabel.textContent = 'Format';
    formatLabel.style.cssText = 'color: #889; font-size: 12px; margin-bottom: 6px;';

    let selectedFormat: GameFormat = '1v1';
    const formatRow = document.createElement('div');
    formatRow.style.cssText = 'display: flex; gap: 8px; margin-bottom: 16px;';
    const formats: GameFormat[] = ['1v1', '2v2', '3v3'];
    const formatBtns: HTMLButtonElement[] = [];
    for (const fmt of formats) {
      const btn = this.makeButton(fmt, 'rgba(30, 40, 70, 0.8)');
      btn.style.flex = '1';
      if (fmt === selectedFormat) btn.style.borderColor = 'rgba(100, 140, 255, 0.6)';
      btn.addEventListener('click', () => {
        selectedFormat = fmt;
        formatBtns.forEach(b => b.style.borderColor = 'rgba(100, 120, 200, 0.2)');
        btn.style.borderColor = 'rgba(100, 140, 255, 0.6)';
      });
      formatBtns.push(btn);
      formatRow.appendChild(btn);
    }

    // Map selection
    const mapLabel = document.createElement('div');
    mapLabel.textContent = 'Map';
    mapLabel.style.cssText = 'color: #889; font-size: 12px; margin-bottom: 6px;';

    let selectedMap = MAP_LIST[0]?.id ?? 'cage';
    const mapRow = document.createElement('div');
    mapRow.style.cssText = 'display: flex; gap: 8px; margin-bottom: 24px;';
    const mapBtns: HTMLButtonElement[] = [];
    for (const map of MAP_LIST) {
      const btn = this.makeButton(map.name, 'rgba(30, 40, 70, 0.8)');
      btn.style.flex = '1';
      if (map.id === selectedMap) btn.style.borderColor = 'rgba(100, 140, 255, 0.6)';
      btn.addEventListener('click', () => {
        selectedMap = map.id;
        mapBtns.forEach(b => b.style.borderColor = 'rgba(100, 120, 200, 0.2)');
        btn.style.borderColor = 'rgba(100, 140, 255, 0.6)';
      });
      mapBtns.push(btn);
      mapRow.appendChild(btn);
    }

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end;';

    const cancelBtn = this.makeButton('Cancel', 'rgba(60, 40, 40, 0.8)');
    cancelBtn.addEventListener('click', () => overlay.remove());

    const createBtn = this.makeButton('Create', 'rgba(40, 80, 140, 0.8)');
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

  private makeButton(text: string, bg: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `
      padding: 8px 16px; font-size: 13px;
      background: ${bg}; color: #ddd;
      border: 1px solid rgba(100, 120, 200, 0.2); border-radius: 4px;
      cursor: pointer; outline: none;
    `;
    return btn;
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
