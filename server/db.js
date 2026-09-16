const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    admin_password_hash TEXT NOT NULL,
    admin_password_salt TEXT NOT NULL,
    current_season INTEGER NOT NULL,
    current_week INTEGER NOT NULL DEFAULT 1,
    buy_in INTEGER NOT NULL DEFAULT 10,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    espn_id TEXT NOT NULL UNIQUE,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    home_abbr TEXT NOT NULL,
    away_abbr TEXT NOT NULL,
    kickoff TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    home_score INTEGER,
    away_score INTEGER,
    winner_abbr TEXT,
    is_mnf INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    picked_abbr TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, game_id)
  );

  CREATE TABLE IF NOT EXISTS tiebreakers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    guess_points INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, season, week)
  );
`);

// --- Migration: old single-tenant installs had a global `users` table with
// UNIQUE(name) and no group_id, plus a generic `settings` key/value table
// for the current season/week/buy-in. If we detect that shape, fold
// everything into one auto-created "Migrated Group" rather than losing data.
function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function migrateLegacySingleGroupSchema() {
  if (columnExists('users', 'group_id')) return; // already on the new schema

  const migrate = db.transaction(() => {
    const legacyUsers = db.prepare('SELECT id, name, created_at FROM users').all();
    const legacySettings = tableExists('settings')
      ? db.prepare('SELECT key, value FROM settings').all()
      : [];
    const settingsMap = Object.fromEntries(legacySettings.map((s) => [s.key, s.value]));

    db.exec('ALTER TABLE users RENAME TO users_legacy');
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    if (legacyUsers.length > 0) {
      const tempPassword = generateGroupCode(); // reuse the same friendly alphabet for a temp password
      const { hash, salt } = hashPassword(tempPassword);
      const code = generateGroupCode();
      const info = db
        .prepare(
          `INSERT INTO groups (code, name, admin_password_hash, admin_password_salt, current_season, current_week, buy_in)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          code,
          'Migrated Group',
          hash,
          salt,
          Number(settingsMap.current_season) || new Date().getFullYear(),
          Number(settingsMap.current_week) || 1,
          Number(settingsMap.buy_in) || 10
        );
      const groupId = info.lastInsertRowid;
      const insertUser = db.prepare(
        'INSERT INTO users (id, group_id, name, created_at) VALUES (?, ?, ?, ?)'
      );
      for (const u of legacyUsers) insertUser.run(u.id, groupId, u.name, u.created_at);

      console.log('='.repeat(60));
      console.log('Migrated pre-existing players into a new group:');
      console.log(`  Group code:      ${code}`);
      console.log(`  Admin password:  ${tempPassword}`);
      console.log('Log in with these once, then treat them as you would any group.');
      console.log('='.repeat(60));
    }

    db.exec('DROP TABLE users_legacy');
    if (tableExists('settings')) db.exec('DROP TABLE settings');
  });

  migrate();
}

// --- Password hashing (scrypt - no extra native dependency needed) ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const attempt = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return attempt.length === expected.length && crypto.timingSafeEqual(attempt, expected);
}

// --- Group codes: short, shareable, no ambiguous characters (no 0/O/1/I) ---
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateGroupCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (db.prepare('SELECT 1 FROM groups WHERE code = ?').get(code));
  return code;
}

// All picks and the tiebreaker for a week lock together at the kickoff of
// that week's FIRST game, not per-game - matching a standard pick 'em pool
// where your whole slate is due before the week starts. Games (and
// therefore lock times) are shared across every group.
function getWeekLockTime(season, week) {
  const row = db
    .prepare('SELECT MIN(kickoff) AS lockTime FROM games WHERE season = ? AND week = ?')
    .get(season, week);
  return row?.lockTime || null;
}

function isWeekLocked(season, week) {
  const lockTime = getWeekLockTime(season, week);
  return lockTime !== null && new Date(lockTime) <= new Date();
}

migrateLegacySingleGroupSchema();

module.exports = {
  db,
  hashPassword,
  verifyPassword,
  generateGroupCode,
  getWeekLockTime,
  isWeekLocked,
};
