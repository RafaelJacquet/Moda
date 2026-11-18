// Base SQLite (module natif de Node, aucune dépendance).
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbFile);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS otp (
    email        TEXT PRIMARY KEY,
    code_hash    TEXT NOT NULL,
    expires_at   INTEGER NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    window_start INTEGER NOT NULL,
    send_count   INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    filename     TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    prompt       TEXT,
    created_by   TEXT,
    created_at   INTEGER NOT NULL,
    source       TEXT NOT NULL DEFAULT 'imported'
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id         TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    prompt     TEXT NOT NULL,
    spec       TEXT,
    status     TEXT NOT NULL,
    step       TEXT,
    iteration  INTEGER NOT NULL DEFAULT 0,
    problems   TEXT,
    error      TEXT,
    demo       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// Migrations légères : colonnes d'usage (tokens / coût) et de placement
for (const [table, col] of [
  ['jobs', 'tokens_in INTEGER NOT NULL DEFAULT 0'],
  ['jobs', 'tokens_out INTEGER NOT NULL DEFAULT 0'],
  ['jobs', 'cost_usd REAL NOT NULL DEFAULT 0'],
  ['jobs', "placement TEXT NOT NULL DEFAULT 'sol'"],
  ['jobs', 'model TEXT'],
  ['assets', "placement TEXT NOT NULL DEFAULT 'sol'"],
]) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
  } catch { /* colonne déjà présente */ }
}

// Nettoyage périodique des OTP et sessions expirés
export function cleanupExpired() {
  const now = Date.now();
  db.prepare('DELETE FROM otp WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}
setInterval(cleanupExpired, 15 * 60 * 1000).unref();
cleanupExpired();
