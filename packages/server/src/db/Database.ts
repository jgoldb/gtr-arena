import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '../../data/gtr.db');

const BCRYPT_ROUNDS = 10;

export interface UserStats {
  games_played: number;
  wins: number;
  losses: number;
}

export interface UserCharacterStats {
  character_id: string;
  games_played: number;
  wins: number;
  losses: number;
}

export class GtrDatabase {
  private db: BetterSqlite3.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT UNIQUE NOT NULL COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at    TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS user_stats (
        user_id       INTEGER PRIMARY KEY REFERENCES users(id),
        games_played  INTEGER DEFAULT 0,
        wins          INTEGER DEFAULT 0,
        losses        INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS user_character_stats (
        user_id       INTEGER REFERENCES users(id),
        character_id  TEXT NOT NULL,
        games_played  INTEGER DEFAULT 0,
        wins          INTEGER DEFAULT 0,
        losses        INTEGER DEFAULT 0,
        PRIMARY KEY (user_id, character_id)
      );
    `);

    // Migrations
    const cols = this.db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
    if (!cols.some(c => c.name === 'is_admin')) {
      this.db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
    }
    if (!cols.some(c => c.name === 'banned_until')) {
      this.db.exec("ALTER TABLE users ADD COLUMN banned_until TEXT DEFAULT NULL");
    }
    if (!cols.some(c => c.name === 'last_played')) {
      this.db.exec("ALTER TABLE users ADD COLUMN last_played TEXT DEFAULT NULL");
    }
    if (!cols.some(c => c.name === 'xp')) {
      this.db.exec('ALTER TABLE users ADD COLUMN xp INTEGER DEFAULT 0');
    }
    if (!cols.some(c => c.name === 'ban_reason')) {
      this.db.exec("ALTER TABLE users ADD COLUMN ban_reason TEXT DEFAULT NULL");
    }

    // Active game sessions — persisted for crash recovery
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS active_sessions (
        game_id       TEXT PRIMARY KEY,
        map_id        TEXT NOT NULL,
        format        TEXT NOT NULL,
        players       TEXT NOT NULL,
        game_started_at INTEGER NOT NULL,
        game_elapsed  REAL NOT NULL DEFAULT 0,
        arena_countdown_started_at INTEGER NOT NULL DEFAULT 0,
        countdown_started INTEGER NOT NULL DEFAULT 0,
        arena_preparation_active INTEGER NOT NULL DEFAULT 0,
        match_stats   TEXT NOT NULL DEFAULT '{}',
        removed_before_end TEXT NOT NULL DEFAULT '[]',
        game_state    TEXT NOT NULL,
        updated_at    INTEGER NOT NULL
      );
    `);
  }

  // ── Auth ────────────────────────────────────────────────────────────────

  register(username: string, password: string): { success: boolean; userId?: number; error?: string } {
    const existing = this.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined;
    if (existing) {
      return { success: false, error: 'Username already taken' };
    }

    const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    const result = this.db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    const userId = result.lastInsertRowid as number;

    // Create empty stats row
    this.db.prepare('INSERT INTO user_stats (user_id) VALUES (?)').run(userId);

    return { success: true, userId };
  }

  login(username: string, password: string): { success: boolean; userId?: number; storedUsername?: string; bannedUntil?: string; banReason?: string; error?: string } {
    const row = this.db.prepare('SELECT id, username, password_hash, banned_until, ban_reason FROM users WHERE username = ?').get(username) as { id: number; username: string; password_hash: string; banned_until: string | null; ban_reason: string | null } | undefined;
    if (!row) {
      return { success: false, error: 'Invalid username or password' };
    }

    if (!bcrypt.compareSync(password, row.password_hash)) {
      return { success: false, error: 'Invalid username or password' };
    }

    // Check ban status
    if (row.banned_until) {
      if (row.banned_until === 'permanent') {
        return { success: false, bannedUntil: 'permanent', banReason: row.ban_reason ?? undefined, error: 'Your account has been permanently closed' };
      }
      const banEnd = new Date(row.banned_until + 'Z');
      if (banEnd > new Date()) {
        return { success: false, bannedUntil: row.banned_until, banReason: row.ban_reason ?? undefined, error: 'You are banned' };
      }
      // Ban expired — clear it
      this.db.prepare("UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE id = ?").run(row.id);
    }

    return { success: true, userId: row.id, storedUsername: row.username };
  }

  getUsername(userId: number): string | undefined {
    const row = this.db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
    return row?.username;
  }

  // ── Stats ───────────────────────────────────────────────────────────────

  recordGameResult(userId: number, characterId: string, won: boolean): void {
    const col = won ? 'wins' : 'losses';

    this.db.prepare(
      `UPDATE user_stats SET games_played = games_played + 1, ${col} = ${col} + 1 WHERE user_id = ?`
    ).run(userId);

    this.db.prepare("UPDATE users SET last_played = datetime('now') WHERE id = ?").run(userId);

    this.db.prepare(`
      INSERT INTO user_character_stats (user_id, character_id, games_played, ${col})
      VALUES (?, ?, 1, 1)
      ON CONFLICT(user_id, character_id) DO UPDATE SET
        games_played = games_played + 1,
        ${col} = ${col} + 1
    `).run(userId, characterId);
  }

  getUserStats(userId: number): UserStats | null {
    return this.db.prepare('SELECT games_played, wins, losses FROM user_stats WHERE user_id = ?').get(userId) as UserStats | null;
  }

  getUserCharacterStats(userId: number): UserCharacterStats[] {
    return this.db.prepare('SELECT character_id, games_played, wins, losses FROM user_character_stats WHERE user_id = ?').all(userId) as UserCharacterStats[];
  }

  // ── Admin ──────────────────────────────────────────────────────────────

  isAdmin(userId: number): boolean {
    const row = this.db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId) as { is_admin: number } | undefined;
    return row?.is_admin === 1;
  }

  setAdmin(userId: number, admin: boolean): void {
    this.db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(admin ? 1 : 0, userId);
  }

  setAdminByUsername(username: string): boolean {
    const row = this.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined;
    if (!row) return false;
    this.setAdmin(row.id, true);
    return true;
  }

  getUserXp(userId: number): number {
    const row = this.db.prepare('SELECT xp FROM users WHERE id = ?').get(userId) as { xp: number } | undefined;
    return row?.xp ?? 0;
  }

  addXp(userId: number, amount: number): number {
    this.db.prepare('UPDATE users SET xp = MAX(0, COALESCE(xp, 0) + ?) WHERE id = ?').run(amount, userId);
    return this.getUserXp(userId);
  }

  setXp(userId: number, xp: number): boolean {
    const row = this.db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as { id: number } | undefined;
    if (!row) return false;
    this.db.prepare('UPDATE users SET xp = ? WHERE id = ?').run(Math.max(0, xp), userId);
    return true;
  }

  getAllUsersWithStats(): { id: number; username: string; is_admin: number; created_at: string; xp: number; games_played: number; wins: number; losses: number; banned_until: string | null; ban_reason: string | null; last_played: string | null }[] {
    return this.db.prepare(`
      SELECT u.id, u.username, u.is_admin, u.created_at, u.banned_until, u.ban_reason, u.last_played,
             COALESCE(u.xp, 0) as xp,
             COALESCE(s.games_played, 0) as games_played,
             COALESCE(s.wins, 0) as wins,
             COALESCE(s.losses, 0) as losses
      FROM users u
      LEFT JOIN user_stats s ON s.user_id = u.id
      ORDER BY u.id
    `).all() as any[];
  }

  banUser(userId: number, bannedUntil: string, reason?: string): boolean {
    const row = this.db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(userId) as { id: number; is_admin: number } | undefined;
    if (!row) return false;
    if (row.is_admin === 1) return false;
    this.db.prepare('UPDATE users SET banned_until = ?, ban_reason = ? WHERE id = ?').run(bannedUntil, reason ?? null, userId);
    return true;
  }

  unbanUser(userId: number): boolean {
    const row = this.db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as { id: number } | undefined;
    if (!row) return false;
    this.db.prepare('UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE id = ?').run(userId);
    return true;
  }

  changePassword(userId: number, currentPassword: string, newPassword: string): { success: boolean; error?: string } {
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined;
    if (!row) return { success: false, error: 'User not found' };
    if (!bcrypt.compareSync(currentPassword, row.password_hash)) {
      return { success: false, error: 'Current password is incorrect' };
    }
    const hash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
    return { success: true };
  }

  resetPassword(userId: number, newPassword: string): boolean {
    const row = this.db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as { id: number } | undefined;
    if (!row) return false;
    const hash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
    return true;
  }

  resetStats(userId: number): boolean {
    const row = this.db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as { id: number } | undefined;
    if (!row) return false;
    this.db.prepare('UPDATE user_stats SET games_played = 0, wins = 0, losses = 0 WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM user_character_stats WHERE user_id = ?').run(userId);
    this.db.prepare('UPDATE users SET last_played = NULL, xp = 0 WHERE id = ?').run(userId);
    return true;
  }

  resetAllStats(): void {
    this.db.prepare('UPDATE user_stats SET games_played = 0, wins = 0, losses = 0').run();
    this.db.prepare('DELETE FROM user_character_stats').run();
    this.db.prepare('UPDATE users SET last_played = NULL, xp = 0').run();
  }

  deleteUser(userId: number): boolean {
    const row = this.db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(userId) as { id: number; is_admin: number } | undefined;
    if (!row) return false;
    if (row.is_admin === 1) return false; // Cannot delete admins

    this.db.prepare('DELETE FROM user_character_stats WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM user_stats WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return true;
  }

  // ── Active Sessions (crash recovery) ────────────────────────────────

  saveActiveSession(data: {
    gameId: string;
    mapId: string;
    format: string;
    players: string;       // JSON
    gameStartedAt: number;
    gameElapsed: number;
    arenaCountdownStartedAt: number;
    countdownStarted: boolean;
    arenaPreparationActive: boolean;
    matchStats: string;    // JSON
    removedBeforeEnd: string; // JSON
    gameState: string;     // JSON
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO active_sessions
        (game_id, map_id, format, players, game_started_at, game_elapsed,
         arena_countdown_started_at, countdown_started, arena_preparation_active,
         match_stats, removed_before_end, game_state, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.gameId, data.mapId, data.format, data.players,
      data.gameStartedAt, data.gameElapsed,
      data.arenaCountdownStartedAt,
      data.countdownStarted ? 1 : 0,
      data.arenaPreparationActive ? 1 : 0,
      data.matchStats, data.removedBeforeEnd, data.gameState,
      Date.now(),
    );
  }

  loadActiveSessions(): {
    gameId: string;
    mapId: string;
    format: string;
    players: string;
    gameStartedAt: number;
    gameElapsed: number;
    arenaCountdownStartedAt: number;
    countdownStarted: boolean;
    arenaPreparationActive: boolean;
    matchStats: string;
    removedBeforeEnd: string;
    gameState: string;
  }[] {
    const rows = this.db.prepare('SELECT * FROM active_sessions').all() as any[];
    return rows.map(r => ({
      gameId: r.game_id,
      mapId: r.map_id,
      format: r.format,
      players: r.players,
      gameStartedAt: r.game_started_at,
      gameElapsed: r.game_elapsed,
      arenaCountdownStartedAt: r.arena_countdown_started_at,
      countdownStarted: r.countdown_started === 1,
      arenaPreparationActive: r.arena_preparation_active === 1,
      matchStats: r.match_stats,
      removedBeforeEnd: r.removed_before_end,
      gameState: r.game_state,
    }));
  }

  deleteActiveSession(gameId: string): void {
    this.db.prepare('DELETE FROM active_sessions WHERE game_id = ?').run(gameId);
  }

  deleteAllActiveSessions(): void {
    this.db.prepare('DELETE FROM active_sessions').run();
  }

  close(): void {
    this.db.close();
  }
}
