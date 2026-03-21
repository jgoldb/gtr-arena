import type { WebSocket } from 'ws';

interface UserRecord {
  userId: string;
  username: string;
  token: string;
  socket: WebSocket | null;
}

let nextId = 1;

export class AuthManager {
  private users = new Map<string, UserRecord>(); // token -> UserRecord
  private userById = new Map<string, UserRecord>(); // userId -> UserRecord

  authenticate(
    username: string,
    token: string,
    socket: WebSocket
  ): { success: boolean; userId: string; error?: string } {
    if (!username || username.length < 1 || username.length > 20) {
      return { success: false, userId: '', error: 'Username must be 1-20 characters' };
    }
    if (!token) {
      return { success: false, userId: '', error: 'Token required' };
    }

    // Check if this token already exists (reconnection)
    const existing = this.users.get(token);
    if (existing) {
      existing.socket = socket;
      existing.username = username; // allow username updates
      return { success: true, userId: existing.userId };
    }

    // New user
    const userId = `user_${nextId++}`;
    const record: UserRecord = { userId, username, token, socket };
    this.users.set(token, record);
    this.userById.set(userId, record);
    return { success: true, userId };
  }

  disconnect(userId: string): void {
    const record = this.userById.get(userId);
    if (record) {
      record.socket = null;
    }
  }

  getSocket(userId: string): WebSocket | null {
    return this.userById.get(userId)?.socket ?? null;
  }

  getUsername(userId: string): string | undefined {
    return this.userById.get(userId)?.username;
  }
}
