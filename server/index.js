const path = require('path');
const express = require('express');
const { db, getSetting, setSetting } = require('./db');
const { fetchWeek } = require('./espn');
const { computeWeek, computeSeasonStandings } = require('./scoring');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function requireAdmin(req, res, next) {
  const supplied = req.header('x-admin-password');
  if (supplied !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }
  next();
}

function currentSeasonWeek() {
  const season = Number(getSetting('current_season', new Date().getFullYear()));
  const week = Number(getSetting('current_week', 1));
  return { season, week };
}

// ---- App state ----
app.get('/api/state', (req, res) => {
  const { season, week } = currentSeasonWeek();
  res.json({ season, week, buyIn: Number(getSetting('buy_in', 10)) });
});

app.post('/api/admin/state', requireAdmin, (req, res) => {
  const { season, week, buyIn } = req.body;
  if (season !== undefined) setSetting('current_season', season);
  if (week !== undefined) setSetting('current_week', week);
  if (buyIn !== undefined) setSetting('buy_in', buyIn);
  res.json({ ok: true });
});

// ---- Users ----
app.get('/api/users', (req, res) => {
  const users = db
    .prepare('SELECT id, name, is_admin FROM users ORDER BY name COLLATE NOCASE')
    .all();
  res.json(users);
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    const info = db.prepare('INSERT INTO users (name) VALUES (?)').run(name.trim());
    res.json({ id: info.lastInsertRowid, name: name.trim() });
  } catch (err) {
    res.status(400).json({ error: 'That name already exists' });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Games ----
app.get('/api/weeks/:season/:week/games', (req, res) => {
  const { season, week } = req.params;
  const games = db
    .prepare('SELECT * FROM games WHERE season = ? AND week = ? ORDER BY kickoff ASC')
    .all(season, week);
  const now = new Date();
  const withLock = games.map((g) => ({ ...g, locked: new Date(g.kickoff) <= now }));
  res.json(withLock);
});

app.post('/api/admin/weeks/:season/:week/sync', requireAdmin, async (req, res) => {
  const { season, week } = req.params;
  const seasontype = req.body?.seasontype || 2;
  try {
    const count = await fetchWeek(Number(season), Number(week), Number(seasontype));
    res.json({ ok: true, gamesSynced: count });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- Picks ----
// Returns picks for a week. A given user's own picks are always included;
// other users' picks are only revealed for games that have already locked
// (kicked off), so nobody can copy an unlocked pick.
app.get('/api/weeks/:season/:week/picks', (req, res) => {
  const { season, week } = req.params;
  const viewerId = Number(req.query.userId) || null;
  const rows = db
    .prepare(
      `SELECT p.id, p.user_id, p.game_id, p.picked_abbr, g.kickoff
       FROM picks p JOIN games g ON g.id = p.game_id
       WHERE g.season = ? AND g.week = ?`
    )
    .all(season, week);
  const now = new Date();
  const visible = rows
    .filter((r) => r.user_id === viewerId || new Date(r.kickoff) <= now)
    .map((r) => ({ userId: r.user_id, gameId: r.game_id, pickedAbbr: r.picked_abbr }));
  res.json(visible);
});

app.post('/api/picks', (req, res) => {
  const { userId, gameId, pickedAbbr } = req.body;
  if (!userId || !gameId || !pickedAbbr) {
    return res.status(400).json({ error: 'userId, gameId, and pickedAbbr are required' });
  }
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (new Date(game.kickoff) <= new Date()) {
    return res.status(403).json({ error: 'This game has already locked' });
  }
  if (pickedAbbr !== game.home_abbr && pickedAbbr !== game.away_abbr) {
    return res.status(400).json({ error: 'pickedAbbr must be one of the two teams' });
  }
  db.prepare(
    `INSERT INTO picks (user_id, game_id, picked_abbr, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, game_id) DO UPDATE SET
       picked_abbr = excluded.picked_abbr, updated_at = excluded.updated_at`
  ).run(userId, gameId, pickedAbbr);
  res.json({ ok: true });
});

// ---- Tiebreaker (Monday Night total points) ----
app.get('/api/weeks/:season/:week/tiebreakers', (req, res) => {
  const { season, week } = req.params;
  const viewerId = Number(req.query.userId) || null;
  const mnf = db
    .prepare('SELECT * FROM games WHERE season = ? AND week = ? AND is_mnf = 1')
    .get(season, week);
  const locked = mnf ? new Date(mnf.kickoff) <= new Date() : false;
  const rows = db
    .prepare('SELECT user_id, guess_points FROM tiebreakers WHERE season = ? AND week = ?')
    .all(season, week);
  const visible = rows
    .filter((r) => r.user_id === viewerId || locked)
    .map((r) => ({ userId: r.user_id, guessPoints: r.guess_points }));
  res.json(visible);
});

app.post('/api/tiebreakers', (req, res) => {
  const { userId, season, week, guessPoints } = req.body;
  if (!userId || !season || !week || guessPoints === undefined) {
    return res.status(400).json({ error: 'userId, season, week, and guessPoints are required' });
  }
  const mnf = db
    .prepare('SELECT * FROM games WHERE season = ? AND week = ? AND is_mnf = 1')
    .get(season, week);
  if (!mnf) return res.status(400).json({ error: 'No Monday Night game found for this week' });
  if (new Date(mnf.kickoff) <= new Date()) {
    return res.status(403).json({ error: 'The Monday Night game has already locked' });
  }
  db.prepare(
    `INSERT INTO tiebreakers (user_id, season, week, guess_points, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, season, week) DO UPDATE SET
       guess_points = excluded.guess_points, updated_at = excluded.updated_at`
  ).run(userId, season, week, guessPoints);
  res.json({ ok: true });
});

// ---- Results & standings ----
app.get('/api/weeks/:season/:week/results', (req, res) => {
  const { season, week } = req.params;
  res.json(computeWeek(Number(season), Number(week)));
});

app.get('/api/standings/:season', (req, res) => {
  res.json(computeSeasonStandings(Number(req.params.season)));
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`NFL Pick 'Em Simulator running at http://localhost:${PORT}`);
});
