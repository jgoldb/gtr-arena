import type { WebSocket } from 'ws';
import type { GtrDatabase } from '../db/Database.js';

interface ActiveSession {
  userId: string;       // string ID used throughout lobby/game (e.g. "user_5")
  dbId: number;         // numeric PK in the database
  username: string;
  isAdmin: boolean;
  socket: WebSocket | null;
}

export class AuthManager {
  private db: GtrDatabase;
  /** Active sessions keyed by userId string */
  private sessions = new Map<string, ActiveSession>();
  /** Reverse lookup: dbId -> userId (for reconnection) */
  private userIdByDbId = new Map<number, string>();

  constructor(db: GtrDatabase) {
    this.db = db;
  }

  authenticate(
    username: string,
    password: string,
    mode: 'login' | 'register',
    socket: WebSocket
  ): { success: boolean; userId: string; username?: string; isAdmin?: boolean; bannedUntil?: string; banReason?: string; error?: string; replacedSocket?: WebSocket } {
    if (!username || username.length < 1 || username.length > 20) {
      return { success: false, userId: '', error: 'Username must be 1-20 characters' };
    }
    if (!/^[a-zA-Z0-9]+$/.test(username)) {
      return { success: false, userId: '', error: 'Username must contain only letters and numbers' };
    }
    if (!password || password.length < 1) {
      return { success: false, userId: '', error: 'Password is required' };
    }

    let dbId: number;
    // Use the originally-registered casing, not whatever the user typed at login
    let displayUsername = username;

    if (mode === 'register') {
      const result = this.db.register(username, password);
      if (!result.success) {
        return { success: false, userId: '', error: result.error };
      }
      dbId = result.userId!;
    } else {
      const result = this.db.login(username, password);
      if (!result.success) {
        return { success: false, userId: '', bannedUntil: result.bannedUntil, banReason: result.banReason, error: result.error };
      }
      dbId = result.userId!;
      displayUsername = result.storedUsername!;
    }

    // Promote to admin if ADMIN_USERNAME env var matches
    const adminUsername = process.env.ADMIN_USERNAME;
    if (adminUsername && displayUsername.toLowerCase() === adminUsername.toLowerCase()) {
      this.db.setAdmin(dbId, true);
    }

    const isAdmin = this.db.isAdmin(dbId);

    // Check if this DB user already has an active session (reconnection / duplicate login)
    const existingUserId = this.userIdByDbId.get(dbId);
    if (existingUserId) {
      const session = this.sessions.get(existingUserId)!;
      const replacedSocket = session.socket ?? undefined;
      session.socket = socket;
      session.username = displayUsername;
      session.isAdmin = isAdmin;
      return { success: true, userId: existingUserId, username: displayUsername, isAdmin, replacedSocket };
    }

    // New session
    const userId = `user_${dbId}`;
    const session: ActiveSession = { userId, dbId, username: displayUsername, isAdmin, socket };
    this.sessions.set(userId, session);
    this.userIdByDbId.set(dbId, userId);
    return { success: true, userId, username: displayUsername, isAdmin };
  }

  disconnect(userId: string): void {
    const session = this.sessions.get(userId);
    if (session) {
      session.socket = null;
      // Keep the session around so they can reconnect
    }
  }

  /** Remove session entirely (e.g. when user fully leaves). */
  removeSession(userId: string): void {
    const session = this.sessions.get(userId);
    if (session) {
      this.userIdByDbId.delete(session.dbId);
      this.sessions.delete(userId);
    }
  }

  getSocket(userId: string): WebSocket | null {
    return this.sessions.get(userId)?.socket ?? null;
  }

  getUsername(userId: string): string | undefined {
    return this.sessions.get(userId)?.username;
  }

  getDbId(userId: string): number | undefined {
    return this.sessions.get(userId)?.dbId;
  }

  getIsAdmin(userId: string): boolean {
    return this.sessions.get(userId)?.isAdmin ?? false;
  }

  getUserIdByDbId(dbId: number): string | undefined {
    return this.userIdByDbId.get(dbId);
  }
}
