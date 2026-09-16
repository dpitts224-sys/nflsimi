const crypto = require('crypto');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Create a free Postgres database (e.g. at neon.tech) and set ' +
      'DATABASE_URL to its connection string before starting the server.'
  );
}

const isLocalDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Managed Postgres providers (Neon, Heroku, etc.) terminate TLS with certs
  // that aren't always in Node's default trust store - this is the standard,
  // widely-used way to connect to them without bundling a CA file. Skipped
  // for local development databases, which typically don't speak TLS at all.
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

// better-sqlite3 used `?` placeholders; keep that style everywhere else in
// the app and just translate to Postgres's `$1, $2, ...` here.
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function all(sql, params = []) {
  const res = await pool.query(toPgSql(sql), params);
  return res.rows;
}

async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

// For INSERT/UPDATE/DELETE. Returns { rowCount, rows } - add `RETURNING ...`
// to the SQL when you need values back (e.g. a newly inserted id).
async function run(sql, params = []) {
  const res = await pool.query(toPgSql(sql), params);
  return { rowCount: res.rowCount, rows: res.rows };
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS groups (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      admin_password_hash TEXT NOT NULL,
      admin_password_salt TEXT NOT NULL,
      current_season INTEGER NOT NULL,
      current_week INTEGER NOT NULL DEFAULT 1,
      buy_in INTEGER NOT NULL DEFAULT 10,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      passcode_hash TEXT,
      passcode_salt TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS games (
      id SERIAL PRIMARY KEY,
      season INTEGER NOT NULL,
      week INTEGER NOT NULL,
      espn_id TEXT NOT NULL UNIQUE,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      home_abbr TEXT NOT NULL,
      away_abbr TEXT NOT NULL,
      kickoff TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      home_score INTEGER,
      away_score INTEGER,
      winner_abbr TEXT,
      is_mnf INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS picks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      picked_abbr TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, game_id)
    );

    CREATE TABLE IF NOT EXISTS tiebreakers (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      season INTEGER NOT NULL,
      week INTEGER NOT NULL,
      guess_points INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, season, week)
    );
  `);

  // Migration for deployments that predate per-player passcodes.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS passcode_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS passcode_salt TEXT;
  `);
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

async function generateGroupCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (await get('SELECT 1 FROM groups WHERE code = ?', [code]));
  return code;
}

// A private per-player passcode, shown once when they join. It's what
// proves a pick/tiebreaker request is really coming from that player (not
// just anyone in the group who knows their name), and what lets them
// restore access from a different device later - no email/SMS needed.
function generatePasscode() {
  return Array.from({ length: 8 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
}

// All picks and the tiebreaker for a week lock together at the kickoff of
// that week's FIRST game, not per-game - matching a standard pick 'em pool
// where your whole slate is due before the week starts. Games (and
// therefore lock times) are shared across every group.
async function getWeekLockTime(season, week) {
  const row = await get('SELECT MIN(kickoff) AS "lockTime" FROM games WHERE season = ? AND week = ?', [
    season,
    week,
  ]);
  return row?.lockTime || null;
}

async function isWeekLocked(season, week) {
  const lockTime = await getWeekLockTime(season, week);
  return lockTime !== null && new Date(lockTime) <= new Date();
}

module.exports = {
  pool,
  all,
  get,
  run,
  initSchema,
  hashPassword,
  verifyPassword,
  generateGroupCode,
  generatePasscode,
  getWeekLockTime,
  isWeekLocked,
};
