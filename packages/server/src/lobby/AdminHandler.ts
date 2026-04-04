import type { WebSocket } from 'ws';
import type { ServerMessage, S2C_AdminUsersList, S2C_AdminResult, S2C_UserProfile } from '@gtr/shared';
import type { AuthManager } from '../auth/AuthManager.js';
import type { GtrDatabase } from '../db/Database.js';

/** Slim interface so AdminHandler doesn't depend on the full LobbyManager. */
export interface AdminContext {
  getUser(userId: string): { userId: string; username: string; socket: WebSocket; gameSessionId: string | null } | undefined;
  allUsers(): Iterable<{ userId: string; socket: WebSocket; gameSessionId: string | null }>;
  send(socket: WebSocket, msg: ServerMessage): void;
  gmTag(username: string, isAdmin: boolean): string;
}

export class AdminHandler {
  private auth: AuthManager;
  private db: GtrDatabase;
  private ctx: AdminContext;

  constructor(auth: AuthManager, db: GtrDatabase, ctx: AdminContext) {
    this.auth = auth;
    this.db = db;
    this.ctx = ctx;
  }

  handleAdminGetUsers(userId: string): void {
    const user = this.ctx.getUser(userId);
    if (!user || !this.auth.getIsAdmin(userId)) {
      if (user) this.ctx.send(user.socket, { type: 'error', message: 'Not authorized' });
      return;
    }

    const rows = this.db.getAllUsersWithStats();
    const msg: S2C_AdminUsersList = {
      type: 'admin_users_list',
      users: rows.map(r => ({
        id: r.id,
        username: this.ctx.gmTag(r.username, r.is_admin === 1),
        xp: r.xp,
        createdAt: r.created_at,
        gamesPlayed: r.games_played,
        wins: r.wins,
        losses: r.losses,
        bannedUntil: r.banned_until,
        banReason: r.ban_reason,
        lastPlayed: r.last_played,
      })),
    };
    this.ctx.send(user.socket, msg);
  }

  handleAdminDeleteUser(userId: string, targetUserId: number): void {
    const user = this.ctx.getUser(userId);
    if (!user || !this.auth.getIsAdmin(userId)) {
      if (user) this.ctx.send(user.socket, { type: 'error', message: 'Not authorized' });
      return;
    }

    const success = this.db.deleteUser(targetUserId);
    const result: S2C_AdminResult = {
      type: 'admin_result',
      action: 'delete_user',
      success,
      error: success ? undefined : 'Cannot delete user (not found or is admin)',
    };
    this.ctx.send(user.socket, result);

    // If successful, kick the deleted user if they're online and refresh the list
    if (success) {
      const deletedUserId = `user_${targetUserId}`;
      const deletedUser = this.ctx.getUser(deletedUserId);
      if (deletedUser) {
        this.ctx.send(deletedUser.socket, { type: 'kicked', reason: 'Your account has been deleted by an admin' });
      }
      // Send updated user list to admin
      this.handleAdminGetUsers(userId);
    }
  }

  private static BAN_DURATIONS: Record<string, { ms: number; label: string } | 'permanent'> = {
    '1h':   { ms: 60 * 60 * 1000, label: '1 hour' },
    '2h':   { ms: 2 * 60 * 60 * 1000, label: '2 hours' },
    '1d':   { ms: 24 * 60 * 60 * 1000, label: '1 day' },
    '3d':   { ms: 3 * 24 * 60 * 60 * 1000, label: '3 days' },
    '1w':   { ms: 7 * 24 * 60 * 60 * 1000, label: '1 week' },
    '1mo':  { ms: 30 * 24 * 60 * 60 * 1000, label: '1 month' },
    '1y':   { ms: 365 * 24 * 60 * 60 * 1000, label: '1 year' },
    'permanent': 'permanent',
  };

  handleAdminBanUser(userId: string, targetUserId: number, duration: string, reason?: string): void {
    const user = this.ctx.getUser(userId);
    if (!user || !this.auth.getIsAdmin(userId)) {
      if (user) this.ctx.send(user.socket, { type: 'error', message: 'Not authorized' });
      return;
    }

    const dur = AdminHandler.BAN_DURATIONS[duration];
    if (!dur) {
      this.ctx.send(user.socket, { type: 'admin_result', action: 'ban_user', success: false, error: 'Invalid ban duration' });
      return;
    }

    const trimmedReason = reason?.trim() || undefined;

    let bannedUntil: string;
    let kickReason: string;

    if (dur === 'permanent') {
      bannedUntil = 'permanent';
      kickReason = 'Your account has been permanently closed';
    } else {
      const banEnd = new Date(Date.now() + dur.ms);
      bannedUntil = banEnd.toISOString().replace('T', ' ').replace('Z', '');
      kickReason = `You have been banned for ${dur.label}`;
    }

    if (trimmedReason) {
      kickReason += `\nReason: ${trimmedReason}`;
    }

    const success = this.db.banUser(targetUserId, bannedUntil, trimmedReason);
    const result: S2C_AdminResult = {
      type: 'admin_result',
      action: 'ban_user',
      success,
      error: success ? undefined : 'Cannot ban user (not found or is admin)',
    };
    this.ctx.send(user.socket, result);

    if (success) {
      const bannedUserId = `user_${targetUserId}`;
      const bannedUser = this.ctx.getUser(bannedUserId);
      if (bannedUser) {
        this.ctx.send(bannedUser.socket, { type: 'kicked', reason: kickReason });
      }
      this.handleAdminGetUsers(userId);
    }
  }

  handleAdminUnbanUser(userId: string, targetUserId: number): void {
    const user = this.ctx.getUser(userId);
    if (!user || !this.auth.getIsAdmin(userId)) {
      if (user) this.ctx.send(user.socket, { type: 'error', message: 'Not authorized' });
      return;
    }

    const success = this.db.unbanUser(targetUserId);
    const result: S2C_AdminResult = {
      type: 'admin_result',
      action: 'unban_user',
      success,
      error: success ? undefined : 'User not found',
    };
    this.ctx.send(user.socket, result);

    if (success) {
      this.handleAdminGetUsers(userId);
    }
  }

  handleAdminResetPassword(userId: string, targetUserId: number): void {
    const user = this.ctx.getUser(userId);
    if (!user || !this.auth.getIsAdmin(userId)) {
      if (user) this.ctx.send(user.socket, { type: 'error', message: 'Not authorized' });
      return;
    }

    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
    let newPassword = '';
    for (let i = 0; i < 12; i++) {
      newPassword += chars[Math.floor(Math.random() * chars.length)];
    }

    const success = this.db.resetPassword(targetUserId, newPassword);
    const result: S2C_AdminResult = {
      type: 'admin_result',
      action: 'reset_password',
      success,
      error: success ? undefined : 'Cannot reset password (not found or is admin)',
      generatedPassword: success ? newPassword : undefined,
    };
    this.ctx.send(user.socket, result);
  }

  handleAdminResetStats(userId: string, targetUserId: number): void {
    const user = this.ctx.getUser(userId);
    if (!user || !this.auth.getIsAdmin(userId)) {
      if (user) this.ctx.send(user.socket, { type: 'error', message: 'Not authorized' });
      return;
    }

    const success = this.db.resetStats(targetUserId);
    const result: S2C_AdminResult = {
      type: 'admin_result',
      action: 'reset_stats',
      success,
      error: success ? undefined : 'User not found',
    };
    this.ctx.send(user.socket, result);

    if (success) {
      // Notify the target user if they're online so their lobby XP/level updates in real time
      const targetSocketId = this.auth.getUserIdByDbId(targetUserId);
      if (targetSocketId) {
        const targetUser = this.ctx.getUser(targetSocketId);
        if (targetUser) {
          this.ctx.send(targetUser.socket, { type: 'xp_update', xp: 0, adminSet: true });
        }
      }

      // Broadcast updated profile to all lobby users so open inspect dialogs refresh
      this.broadcastUserProfile(targetUserId);
      this.handleAdminGetUsers(userId);
    }
  }

  handleAdminNukeStats(userId: string): void {
    const user = this.ctx.getUser(userId);
    if (!user || !this.auth.getIsAdmin(userId)) {
      if (user) this.ctx.send(user.socket, { type: 'error', message: 'Not authorized' });
      return;
    }

    this.db.resetAllStats();

    const result: S2C_AdminResult = {
      type: 'admin_result',
      action: 'nuke_stats',
      success: true,
    };
    this.ctx.send(user.socket, result);

    // Notify all online users that their XP was reset
    for (const u of this.ctx.allUsers()) {
      this.ctx.send(u.socket, { type: 'xp_update', xp: 0, adminSet: true });
    }

    this.handleAdminGetUsers(userId);
  }

  handleAdminSetXp(userId: string, targetUserId: number, xp: number): void {
    const user = this.ctx.getUser(userId);
    if (!user || !this.auth.getIsAdmin(userId)) {
      if (user) this.ctx.send(user.socket, { type: 'error', message: 'Not authorized' });
      return;
    }

    if (!Number.isFinite(xp) || xp < 0) {
      this.ctx.send(user.socket, { type: 'admin_result', action: 'set_xp', success: false, error: 'Invalid XP value' });
      return;
    }

    const success = this.db.setXp(targetUserId, xp);
    const result: S2C_AdminResult = {
      type: 'admin_result',
      action: 'set_xp',
      success,
      error: success ? undefined : 'User not found',
    };
    this.ctx.send(user.socket, result);

    if (success) {
      // Notify the target user if they're online so their lobby XP/level updates in real time
      const targetSocketId = this.auth.getUserIdByDbId(targetUserId);
      if (targetSocketId) {
        const targetUser = this.ctx.getUser(targetSocketId);
        if (targetUser) {
          this.ctx.send(targetUser.socket, { type: 'xp_update', xp, adminSet: true });
        }
      }

      // Broadcast updated profile to all lobby users so open inspect dialogs refresh
      this.broadcastUserProfile(targetUserId);
      this.handleAdminGetUsers(userId);
    }
  }

  /** Broadcast an updated user profile to all lobby users (for live inspect dialog refresh). */
  private broadcastUserProfile(targetUserId: number): void {
    const rows = this.db.getAllUsersWithStats();
    const row = rows.find(r => r.id === targetUserId);
    if (!row) return;

    const charStats = this.db.getUserCharacterStats(targetUserId);
    const profileMsg: S2C_UserProfile = {
      type: 'user_profile',
      broadcast: true,
      profile: {
        username: this.ctx.gmTag(row.username, row.is_admin === 1),
        xp: row.xp,
        gamesPlayed: row.games_played,
        wins: row.wins,
        losses: row.losses,
        createdAt: row.created_at,
        lastPlayed: row.last_played,
        characterStats: charStats.map(c => ({
          characterId: c.character_id,
          gamesPlayed: c.games_played,
          wins: c.wins,
          losses: c.losses,
        })),
      },
    };
    for (const u of this.ctx.allUsers()) {
      if (!u.gameSessionId) {
        this.ctx.send(u.socket, profileMsg);
      }
    }
  }
}
