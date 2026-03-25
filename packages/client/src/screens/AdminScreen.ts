import type { NetworkManager } from '../network/NetworkManager';
import type { AdminUserRecord } from '@gtr/shared';
import { xpToLevel, xpForLevel } from '@gtr/shared';

export class AdminScreen {
  readonly element: HTMLDivElement;
  private tableBody: HTMLTableSectionElement;
  private network: NetworkManager;
  private overlay: HTMLDivElement | null = null;
  private localDbId: number;

  onBack?: () => void;

  constructor(network: NetworkManager, localDbId: number) {
    this.network = network;
    this.localDbId = localDbId;

    this.element = document.createElement('div');
    this.element.style.cssText = `
      position: fixed; inset: 0; z-index: 1000;
      display: flex; flex-direction: column;
      background: #05050a;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #ccc;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex; justify-content: space-between; align-items: center;
      padding: 16px 24px;
      border-bottom: 1px solid rgba(100, 120, 200, 0.15);
    `;

    const title = document.createElement('div');
    title.textContent = 'Admin — User Management';
    title.style.cssText = 'font-size: 18px; font-weight: bold; color: #8899cc;';

    const backBtn = this.makeButton('Back to Lobby', 'rgba(60, 40, 40, 0.8)');
    backBtn.addEventListener('click', () => this.onBack?.());

    header.appendChild(title);
    header.appendChild(backBtn);

    // Table container
    const tableWrap = document.createElement('div');
    tableWrap.style.cssText = 'flex: 1; overflow-y: auto; padding: 16px 24px;';

    const table = document.createElement('table');
    table.style.cssText = `
      width: 100%; border-collapse: collapse; font-size: 13px;
    `;

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of ['ID', 'Username', 'Level', 'Created', 'Last Played', 'Games', 'Banned', '']) {
      const th = document.createElement('th');
      th.textContent = col;
      th.style.cssText = `
        text-align: left; padding: 10px 12px;
        color: #8899cc; font-weight: bold; font-size: 12px; text-transform: uppercase;
        border-bottom: 1px solid rgba(100, 120, 200, 0.2);
      `;
      if (col === '') th.style.textAlign = 'right';
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);

    this.tableBody = document.createElement('tbody');

    table.appendChild(thead);
    table.appendChild(this.tableBody);
    tableWrap.appendChild(table);

    this.element.appendChild(header);
    this.element.appendChild(tableWrap);
  }

  updateUsers(users: AdminUserRecord[]): void {
    this.tableBody.innerHTML = '';

    for (const user of users) {
      const tr = document.createElement('tr');
      tr.style.cssText = 'border-bottom: 1px solid rgba(100, 120, 200, 0.08);';
      tr.addEventListener('mouseenter', () => tr.style.background = 'rgba(100, 120, 200, 0.05)');
      tr.addEventListener('mouseleave', () => tr.style.background = '');

      let banStatus = '-';
      if (user.bannedUntil === 'permanent') {
        banStatus = 'Permanent';
      } else if (user.bannedUntil) {
        const banEnd = new Date(user.bannedUntil + 'Z');
        banStatus = banEnd > new Date() ? `Until ${banEnd.toLocaleString()}` : '-';
      }

      const lastPlayed = user.lastPlayed
        ? new Date(user.lastPlayed + 'Z').toLocaleDateString()
        : 'Never';

      const cells = [
        String(user.id),
        user.username,
        String(xpToLevel(user.xp)),
        new Date(user.createdAt + 'Z').toLocaleDateString(),
        lastPlayed,
        String(user.gamesPlayed),
        banStatus,
      ];

      for (let i = 0; i < cells.length; i++) {
        const td = document.createElement('td');
        td.textContent = cells[i];
        td.style.cssText = 'padding: 10px 12px;';
        if (i === cells.length - 1 && cells[i] !== '-') {
          td.style.color = '#cc4444';
        }
        tr.appendChild(td);
      }

      // Action buttons cell
      const actionTd = document.createElement('td');
      actionTd.style.cssText = 'padding: 10px 12px; text-align: right; white-space: nowrap;';

      const isSelf = user.id === this.localDbId;

      const isBanned = user.bannedUntil === 'permanent' ||
        (user.bannedUntil != null && new Date(user.bannedUntil + 'Z') > new Date());

      const banBtn = isBanned
        ? this.makeButton('Unban', 'rgba(30, 120, 50, 0.8)')
        : this.makeButton('Ban', 'rgba(140, 100, 20, 0.8)');
      banBtn.style.padding = '4px 12px';
      banBtn.style.fontSize = '12px';
      banBtn.style.marginRight = '6px';
      if (isSelf) {
        banBtn.disabled = true;
        banBtn.style.opacity = '0.3';
        banBtn.style.cursor = 'default';
      } else {
        banBtn.addEventListener('click', () => {
          if (isBanned) {
            this.network.send({ type: 'admin_unban_user', targetUserId: user.id });
          } else {
            this.showBanDialog(user);
          }
        });
      }
      actionTd.appendChild(banBtn);

      const resetPwBtn = this.makeButton('Reset PW', 'rgba(50, 80, 120, 0.8)');
      resetPwBtn.style.padding = '4px 12px';
      resetPwBtn.style.fontSize = '12px';
      resetPwBtn.style.marginRight = '6px';
      resetPwBtn.addEventListener('click', () => {
        this.showResetPasswordConfirm(user);
      });
      actionTd.appendChild(resetPwBtn);

      const resetStatsBtn = this.makeButton('Reset', 'rgba(120, 80, 30, 0.8)');
      resetStatsBtn.style.padding = '4px 12px';
      resetStatsBtn.style.fontSize = '12px';
      resetStatsBtn.style.marginRight = '6px';
      resetStatsBtn.addEventListener('click', () => this.showResetStatsConfirm(user));
      actionTd.appendChild(resetStatsBtn);

      const xpBtn = this.makeButton('XP', 'rgba(80, 60, 120, 0.8)');
      xpBtn.style.padding = '4px 12px';
      xpBtn.style.fontSize = '12px';
      xpBtn.style.marginRight = '6px';
      xpBtn.addEventListener('click', () => this.showSetXpDialog(user));
      actionTd.appendChild(xpBtn);

      const delBtn = this.makeButton('Delete', 'rgba(140, 30, 30, 0.8)');
      delBtn.style.padding = '4px 12px';
      delBtn.style.fontSize = '12px';
      if (isSelf) {
        delBtn.disabled = true;
        delBtn.style.opacity = '0.3';
        delBtn.style.cursor = 'default';
      } else {
        delBtn.addEventListener('click', () => this.showDeleteConfirm(user));
      }
      actionTd.appendChild(delBtn);
      tr.appendChild(actionTd);

      this.tableBody.appendChild(tr);
    }
  }

  private showDeleteConfirm(user: AdminUserRecord): void {
    if (this.overlay) this.overlay.remove();

    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 1100;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.7);
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: linear-gradient(to bottom, rgba(20, 20, 35, 0.98), rgba(10, 10, 20, 0.98));
      border: 1px solid rgba(200, 60, 60, 0.4);
      border-radius: 8px; padding: 30px 40px; max-width: 400px;
    `;

    const title = document.createElement('div');
    title.textContent = 'Delete User';
    title.style.cssText = 'color: #cc4444; font-size: 18px; font-weight: bold; margin-bottom: 12px;';

    const msg = document.createElement('div');
    msg.textContent = `Are you sure you want to delete "${user.username}"? This will permanently remove their account and all stats. This cannot be undone.`;
    msg.style.cssText = 'color: #aaa; font-size: 14px; line-height: 1.5; margin-bottom: 24px;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end;';

    const cancelBtn = this.makeButton('Cancel', 'rgba(40, 40, 60, 0.8)');
    cancelBtn.addEventListener('click', () => {
      this.overlay?.remove();
      this.overlay = null;
    });

    const confirmBtn = this.makeButton('Delete', 'rgba(160, 30, 30, 0.9)');
    confirmBtn.addEventListener('click', () => {
      this.network.send({ type: 'admin_delete_user', targetUserId: user.id });
      this.overlay?.remove();
      this.overlay = null;
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);

    dialog.appendChild(title);
    dialog.appendChild(msg);
    dialog.appendChild(btnRow);
    this.overlay.appendChild(dialog);

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.overlay?.remove();
        this.overlay = null;
      }
    });

    this.element.appendChild(this.overlay);
  }

  private showResetStatsConfirm(user: AdminUserRecord): void {
    if (this.overlay) this.overlay.remove();

    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 1100;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.7);
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: linear-gradient(to bottom, rgba(20, 20, 35, 0.98), rgba(10, 10, 20, 0.98));
      border: 1px solid rgba(200, 160, 40, 0.4);
      border-radius: 8px; padding: 30px 40px; max-width: 400px;
    `;

    const title = document.createElement('div');
    title.textContent = 'Reset Stats';
    title.style.cssText = 'color: #ccaa44; font-size: 18px; font-weight: bold; margin-bottom: 12px;';

    const msg = document.createElement('div');
    msg.textContent = `Are you sure you want to reset all stats for "${user.username}"? This will set games played, wins, losses, and last played to zero. This cannot be undone.`;
    msg.style.cssText = 'color: #aaa; font-size: 14px; line-height: 1.5; margin-bottom: 24px;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end;';

    const cancelBtn = this.makeButton('Cancel', 'rgba(40, 40, 60, 0.8)');
    cancelBtn.addEventListener('click', () => {
      this.overlay?.remove();
      this.overlay = null;
    });

    const confirmBtn = this.makeButton('Reset', 'rgba(160, 120, 20, 0.9)');
    confirmBtn.addEventListener('click', () => {
      this.network.send({ type: 'admin_reset_stats', targetUserId: user.id });
      this.overlay?.remove();
      this.overlay = null;
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);

    dialog.appendChild(title);
    dialog.appendChild(msg);
    dialog.appendChild(btnRow);
    this.overlay.appendChild(dialog);

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.overlay?.remove();
        this.overlay = null;
      }
    });

    this.element.appendChild(this.overlay);
  }

  private showResetPasswordConfirm(user: AdminUserRecord): void {
    if (this.overlay) this.overlay.remove();

    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 1100;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.7);
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: linear-gradient(to bottom, rgba(20, 20, 35, 0.98), rgba(10, 10, 20, 0.98));
      border: 1px solid rgba(60, 130, 200, 0.4);
      border-radius: 8px; padding: 30px 40px; max-width: 400px;
    `;

    const title = document.createElement('div');
    title.textContent = 'Reset Password';
    title.style.cssText = 'color: #6699cc; font-size: 18px; font-weight: bold; margin-bottom: 12px;';

    const msg = document.createElement('div');
    msg.textContent = `Are you sure you want to reset the password for "${user.username}"? A new random password will be generated.`;
    msg.style.cssText = 'color: #aaa; font-size: 14px; line-height: 1.5; margin-bottom: 24px;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end;';

    const cancelBtn = this.makeButton('Cancel', 'rgba(40, 40, 60, 0.8)');
    cancelBtn.addEventListener('click', () => {
      this.overlay?.remove();
      this.overlay = null;
    });

    const confirmBtn = this.makeButton('Reset Password', 'rgba(40, 70, 120, 0.9)');
    confirmBtn.addEventListener('click', () => {
      this.network.send({ type: 'admin_reset_password', targetUserId: user.id });
      this.overlay?.remove();
      this.overlay = null;
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);

    dialog.appendChild(title);
    dialog.appendChild(msg);
    dialog.appendChild(btnRow);
    this.overlay.appendChild(dialog);

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.overlay?.remove();
        this.overlay = null;
      }
    });

    this.element.appendChild(this.overlay);
  }

  private showSetXpDialog(user: AdminUserRecord): void {
    if (this.overlay) this.overlay.remove();

    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 1100;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.7);
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: linear-gradient(to bottom, rgba(20, 20, 35, 0.98), rgba(10, 10, 20, 0.98));
      border: 1px solid rgba(140, 100, 200, 0.4);
      border-radius: 8px; padding: 30px 40px; max-width: 400px;
    `;

    const title = document.createElement('div');
    title.textContent = `Set XP — ${user.username}`;
    title.style.cssText = 'color: #aa88dd; font-size: 18px; font-weight: bold; margin-bottom: 6px;';

    const currentInfo = document.createElement('div');
    currentInfo.textContent = `Current: ${user.xp.toLocaleString()} XP (Level ${xpToLevel(user.xp)})`;
    currentInfo.style.cssText = 'color: #888; font-size: 13px; margin-bottom: 16px;';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '1';
    input.value = String(user.xp);
    input.style.cssText = `
      width: 100%; box-sizing: border-box; padding: 10px 14px;
      background: rgba(0, 0, 0, 0.4); color: #ddd; font-size: 16px;
      border: 1px solid rgba(140, 100, 200, 0.3); border-radius: 4px;
      outline: none; font-family: monospace;
    `;

    const levelPreview = document.createElement('div');
    levelPreview.style.cssText = 'color: #aa88dd; font-size: 14px; margin-top: 10px; margin-bottom: 20px;';

    const updatePreview = () => {
      const val = parseInt(input.value);
      if (isNaN(val) || val < 0) {
        levelPreview.textContent = 'Enter a valid positive number';
        levelPreview.style.color = '#cc4444';
      } else {
        const lvl = xpToLevel(val);
        const nextLvlXp = xpForLevel(lvl + 1);
        levelPreview.textContent = `= Level ${lvl}  (next level at ${nextLvlXp.toLocaleString()} XP)`;
        levelPreview.style.color = '#aa88dd';
      }
    };
    updatePreview();
    input.addEventListener('input', updatePreview);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end;';

    const cancelBtn = this.makeButton('Cancel', 'rgba(40, 40, 60, 0.8)');
    cancelBtn.addEventListener('click', () => {
      this.overlay?.remove();
      this.overlay = null;
    });

    const confirmBtn = this.makeButton('Set XP', 'rgba(100, 60, 160, 0.9)');
    confirmBtn.addEventListener('click', () => {
      const val = parseInt(input.value);
      if (isNaN(val) || val < 0) return;
      this.network.send({ type: 'admin_set_xp', targetUserId: user.id, xp: val });
      this.overlay?.remove();
      this.overlay = null;
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);

    dialog.appendChild(title);
    dialog.appendChild(currentInfo);
    dialog.appendChild(input);
    dialog.appendChild(levelPreview);
    dialog.appendChild(btnRow);
    this.overlay.appendChild(dialog);

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.overlay?.remove();
        this.overlay = null;
      }
    });

    this.element.appendChild(this.overlay);
    input.focus();
    input.select();
  }

  private showBanDialog(user: AdminUserRecord): void {
    if (this.overlay) this.overlay.remove();

    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 1100;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.7);
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: linear-gradient(to bottom, rgba(20, 20, 35, 0.98), rgba(10, 10, 20, 0.98));
      border: 1px solid rgba(200, 160, 40, 0.4);
      border-radius: 8px; padding: 30px 40px; max-width: 400px;
    `;

    const title = document.createElement('div');
    title.textContent = `Ban "${user.username}"`;
    title.style.cssText = 'color: #ccaa44; font-size: 18px; font-weight: bold; margin-bottom: 12px;';

    const reasonLabel = document.createElement('div');
    reasonLabel.textContent = 'Reason (optional):';
    reasonLabel.style.cssText = 'color: #aaa; font-size: 14px; margin-bottom: 6px;';

    const reasonInput = document.createElement('input');
    reasonInput.type = 'text';
    reasonInput.placeholder = 'e.g. Toxic behavior';
    reasonInput.maxLength = 200;
    reasonInput.style.cssText = `
      width: 100%; box-sizing: border-box; padding: 8px 10px; margin-bottom: 16px;
      background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(100, 120, 200, 0.2);
      border-radius: 4px; color: #ddd; font-size: 13px; font-family: inherit;
      outline: none;
    `;
    reasonInput.addEventListener('focus', () => reasonInput.style.borderColor = 'rgba(200, 160, 40, 0.4)');
    reasonInput.addEventListener('blur', () => reasonInput.style.borderColor = 'rgba(100, 120, 200, 0.2)');

    const label = document.createElement('div');
    label.textContent = 'Select ban duration:';
    label.style.cssText = 'color: #aaa; font-size: 14px; margin-bottom: 16px;';

    const durations: { value: string; label: string }[] = [
      { value: '1h', label: '1 Hour' },
      { value: '2h', label: '2 Hours' },
      { value: '1d', label: '1 Day' },
      { value: '3d', label: '3 Days' },
      { value: '1w', label: '1 Week' },
      { value: '1mo', label: '1 Month' },
      { value: '1y', label: '1 Year' },
      { value: 'permanent', label: 'Permanent' },
    ];

    let selected = '1d';

    const grid = document.createElement('div');
    grid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 24px;';
    const durationBtns: HTMLButtonElement[] = [];

    for (const dur of durations) {
      const btn = this.makeButton(dur.label, 'rgba(30, 40, 70, 0.8)');
      btn.style.padding = '8px 12px';
      btn.style.fontSize = '13px';
      if (dur.value === selected) btn.style.borderColor = 'rgba(200, 160, 40, 0.6)';
      if (dur.value === 'permanent') btn.style.color = '#cc4444';
      btn.addEventListener('click', () => {
        selected = dur.value;
        durationBtns.forEach(b => b.style.borderColor = 'rgba(100, 120, 200, 0.2)');
        btn.style.borderColor = 'rgba(200, 160, 40, 0.6)';
      });
      durationBtns.push(btn);
      grid.appendChild(btn);
    }

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end;';

    const cancelBtn = this.makeButton('Cancel', 'rgba(40, 40, 60, 0.8)');
    cancelBtn.addEventListener('click', () => {
      this.overlay?.remove();
      this.overlay = null;
    });

    const confirmBtn = this.makeButton('Ban', 'rgba(160, 120, 20, 0.9)');
    confirmBtn.addEventListener('click', () => {
      const reason = reasonInput.value.trim() || undefined;
      this.network.send({ type: 'admin_ban_user', targetUserId: user.id, duration: selected, reason });
      this.overlay?.remove();
      this.overlay = null;
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);

    dialog.appendChild(title);
    dialog.appendChild(reasonLabel);
    dialog.appendChild(reasonInput);
    dialog.appendChild(label);
    dialog.appendChild(grid);
    dialog.appendChild(btnRow);
    this.overlay.appendChild(dialog);

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.overlay?.remove();
        this.overlay = null;
      }
    });

    this.element.appendChild(this.overlay);
  }

  showResetPasswordResult(generatedPassword: string): void {
    if (this.overlay) this.overlay.remove();

    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 1100;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.7);
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: linear-gradient(to bottom, rgba(20, 20, 35, 0.98), rgba(10, 10, 20, 0.98));
      border: 1px solid rgba(60, 130, 200, 0.4);
      border-radius: 8px; padding: 30px 40px; max-width: 420px;
    `;

    const title = document.createElement('div');
    title.textContent = 'Password Reset';
    title.style.cssText = 'color: #6699cc; font-size: 18px; font-weight: bold; margin-bottom: 12px;';

    const msg = document.createElement('div');
    msg.textContent = 'New password has been copied to clipboard:';
    msg.style.cssText = 'color: #aaa; font-size: 14px; margin-bottom: 12px;';

    const pwDisplay = document.createElement('div');
    pwDisplay.textContent = generatedPassword;
    pwDisplay.style.cssText = `
      background: rgba(0,0,0,0.4); padding: 10px 16px; border-radius: 4px;
      font-family: monospace; font-size: 16px; color: #88ccff;
      border: 1px solid rgba(100,120,200,0.2); margin-bottom: 20px;
      user-select: all; text-align: center; letter-spacing: 1px;
    `;

    navigator.clipboard.writeText(generatedPassword).catch(() => {
      msg.textContent = 'New password (copy manually):';
    });

    const closeBtn = this.makeButton('OK', 'rgba(40, 60, 100, 0.8)');
    closeBtn.style.display = 'block';
    closeBtn.style.marginLeft = 'auto';
    closeBtn.addEventListener('click', () => {
      this.overlay?.remove();
      this.overlay = null;
    });

    dialog.appendChild(title);
    dialog.appendChild(msg);
    dialog.appendChild(pwDisplay);
    dialog.appendChild(closeBtn);
    this.overlay.appendChild(dialog);

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.overlay?.remove();
        this.overlay = null;
      }
    });

    this.element.appendChild(this.overlay);
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

  destroy(): void {
    this.overlay?.remove();
    this.element.remove();
  }
}
