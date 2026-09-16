const path = require('path');
const express = require('express');
const {
  db,
  hashPassword,
  verifyPassword,
  generateGroupCode,
  getWeekLockTime,
  isWeekLocked,
} = require('./db');
const { fetchWeek } = require('./espn');
const { computeWeek, computeSeasonStandings, computeBoard } = require('./scoring');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Live updates (Server-Sent Events), scoped per group ----
// Any time a group's picks, tiebreakers, schedule, or settings change, every
// browser connected to THAT group gets pinged so open tabs (like the Winner
// Board) refresh themselves without anyone hitting reload. Other groups on
// the same deployment never hear about it.
const sseClientsByGroup = new Map(); // groupId -> Set<res>

function broadcastUpdate(groupId, type) {
  const clients = sseClientsByGroup.get(groupId);
  if (!clients) return;
  const payload = `event: update\ndata: ${JSON.stringify({ type, at: Date.now() })}\n\n`;
  for (const res of clients) res.write(payload);
}

app.get('/api/groups/:code/stream', (req, res) => {
  const group = db.prepare('SELECT id FROM groups WHERE code = ?').get(normalizeCode(req.params.code));
  if (!group) return res.status(404).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  if (!sseClientsByGroup.has(group.id)) sseClientsByGroup.set(group.id, new Set());
  const clients = sseClientsByGroup.get(group.id);
  clients.add(res);

  const heartbeat = setInterval(() => res.write(':hb\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

// ---- Group resolution ----
function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function loadGroup(req, res, next) {
  const group = db.prepare('SELECT * FROM groups WHERE code = ?').get(normalizeCode(req.params.code));
  if (!group) return res.status(404).json({ error: "That group code doesn't exist" });
  req.group = group;
  next();
}

function requireGroupAdmin(req, res, next) {
  const supplied = req.header('x-admin-password') || '';
  if (!verifyPassword(supplied, req.group.admin_password_hash, req.group.admin_password_salt)) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }
  next();
}

// A user id passed in a request body must actually belong to the group in
// the URL - otherwise anyone who can guess a user id from another group
// could pick or view on their behalf.
function userBelongsToGroup(userId, groupId) {
  return !!db.prepare('SELECT 1 FROM users WHERE id = ? AND group_id = ?').get(userId, groupId);
}

// ---- Groups ----
app.post('/api/groups', (req, res) => {
  const { name, adminPassword } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Your group needs a name" });
  if (!adminPassword || adminPassword.length < 4) {
    return res.status(400).json({ error: 'Admin password must be at least 4 characters' });
  }
  const { hash, salt } = hashPassword(adminPassword);
  const code = generateGroupCode();
  const now = new Date();
  const info = db
    .prepare(
      `INSERT INTO groups (code, name, admin_password_hash, admin_password_salt, current_season, current_week, buy_in)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(code, name.trim(), hash, salt, now.getFullYear(), 1, 10);
  res.json({ id: info.lastInsertRowid, code, name: name.trim() });
});

app.get('/api/groups/:code', loadGroup, (req, res) => {
  res.json({
    code: req.group.code,
    name: req.group.name,
    season: req.group.current_season,
    week: req.group.current_week,
    buyIn: req.group.buy_in,
  });
});

app.post('/api/groups/:code/login', loadGroup, (req, res) => {
  const { password } = req.body;
  if (!verifyPassword(password || '', req.group.admin_password_hash, req.group.admin_password_salt)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  res.json({ ok: true });
});

app.post('/api/groups/:code/state', loadGroup, requireGroupAdmin, (req, res) => {
  const { season, week, buyIn } = req.body;
  db.prepare(
    `UPDATE groups SET
       current_season = COALESCE(?, current_season),
       current_week = COALESCE(?, current_week),
       buy_in = COALESCE(?, buy_in)
     WHERE id = ?`
  ).run(season ?? null, week ?? null, buyIn ?? null, req.group.id);
  broadcastUpdate(req.group.id, 'state');
  res.json({ ok: true });
});

// ---- Users ----
// Anyone with the group code can add their own name - no admin password
// needed. This is the self-service "join" flow.
app.get('/api/groups/:code/users', loadGroup, (req, res) => {
  const users = db
    .prepare('SELECT id, name FROM users WHERE group_id = ? ORDER BY name COLLATE NOCASE')
    .all(req.group.id);
  res.json(users);
});

app.post('/api/groups/:code/users', loadGroup, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const trimmed = name.trim().slice(0, 40);
  const existing = db
    .prepare('SELECT id FROM users WHERE group_id = ? AND name = ? COLLATE NOCASE')
    .get(req.group.id, trimmed);
  if (existing) {
    return res.status(400).json({ error: 'Someone in this group already has that name - try adding an initial' });
  }
  const info = db
    .prepare('INSERT INTO users (group_id, name) VALUES (?, ?)')
    .run(req.group.id, trimmed);
  broadcastUpdate(req.group.id, 'users');
  res.json({ id: info.lastInsertRowid, name: trimmed });
});

app.delete('/api/groups/:code/users/:id', loadGroup, requireGroupAdmin, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ? AND group_id = ?').run(req.params.id, req.group.id);
  broadcastUpdate(req.group.id, 'users');
  res.json({ ok: true });
});

// ---- Games ----
// Games are the real, shared NFL schedule/scores - not per-group - so any
// group syncing a week benefits every other group too. The whole week's
// picks (and the tiebreaker) lock together at the kickoff of the week's
// first game, not per-game.
app.get('/api/groups/:code/weeks/:season/:week/games', loadGroup, (req, res) => {
  const { season, week } = req.params;
  const games = db
    .prepare('SELECT * FROM games WHERE season = ? AND week = ? ORDER BY kickoff ASC')
    .all(season, week);
  const locked = isWeekLocked(Number(season), Number(week));
  res.json(games.map((g) => ({ ...g, locked })));
});

app.post('/api/groups/:code/admin/weeks/:season/:week/sync', loadGroup, requireGroupAdmin, async (req, res) => {
  const { season, week } = req.params;
  const seasontype = req.body?.seasontype || 2;
  try {
    const count = await fetchWeek(Number(season), Number(week), Number(seasontype));
    broadcastUpdate(req.group.id, 'sync');
    res.json({ ok: true, gamesSynced: count });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- Picks ----
// Returns picks for a week. A given user's own picks are always included;
// everyone else's in the SAME group stays hidden until the whole week
// locks, so nobody can copy a pick before making their own.
app.get('/api/groups/:code/weeks/:season/:week/picks', loadGroup, (req, res) => {
  const { season, week } = req.params;
  const viewerId = Number(req.query.userId) || null;
  const locked = isWeekLocked(Number(season), Number(week));
  const rows = db
    .prepare(
      `SELECT p.user_id, p.game_id, p.picked_abbr
       FROM picks p
       JOIN games g ON g.id = p.game_id
       JOIN users u ON u.id = p.user_id
       WHERE g.season = ? AND g.week = ? AND u.group_id = ?`
    )
    .all(season, week, req.group.id);
  const visible = rows
    .filter((r) => r.user_id === viewerId || locked)
    .map((r) => ({ userId: r.user_id, gameId: r.game_id, pickedAbbr: r.picked_abbr }));
  res.json(visible);
});

app.post('/api/groups/:code/picks', loadGroup, (req, res) => {
  const { userId, gameId, pickedAbbr } = req.body;
  if (!userId || !gameId || !pickedAbbr) {
    return res.status(400).json({ error: 'userId, gameId, and pickedAbbr are required' });
  }
  if (!userBelongsToGroup(userId, req.group.id)) {
    return res.status(403).json({ error: 'That player is not in this group' });
  }
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (isWeekLocked(game.season, game.week)) {
    return res.status(403).json({ error: "This week's picks are locked - the first game has already started" });
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
  broadcastUpdate(req.group.id, 'picks');
  res.json({ ok: true });
});

// ---- Tiebreaker (Monday Night total points) ----
app.get('/api/groups/:code/weeks/:season/:week/tiebreakers', loadGroup, (req, res) => {
  const { season, week } = req.params;
  const viewerId = Number(req.query.userId) || null;
  const locked = isWeekLocked(Number(season), Number(week));
  const rows = db
    .prepare(
      `SELECT t.user_id, t.guess_points
       FROM tiebreakers t
       JOIN users u ON u.id = t.user_id
       WHERE t.season = ? AND t.week = ? AND u.group_id = ?`
    )
    .all(season, week, req.group.id);
  const visible = rows
    .filter((r) => r.user_id === viewerId || locked)
    .map((r) => ({ userId: r.user_id, guessPoints: r.guess_points }));
  res.json(visible);
});

app.post('/api/groups/:code/tiebreakers', loadGroup, (req, res) => {
  const { userId, season, week, guessPoints } = req.body;
  if (!userId || !season || !week || guessPoints === undefined) {
    return res.status(400).json({ error: 'userId, season, week, and guessPoints are required' });
  }
  if (!userBelongsToGroup(userId, req.group.id)) {
    return res.status(403).json({ error: 'That player is not in this group' });
  }
  const mnf = db
    .prepare('SELECT * FROM games WHERE season = ? AND week = ? AND is_mnf = 1')
    .get(season, week);
  if (!mnf) return res.status(400).json({ error: 'No Monday Night game found for this week' });
  if (isWeekLocked(Number(season), Number(week))) {
    return res.status(403).json({ error: "This week's picks are locked - the first game has already started" });
  }
  db.prepare(
    `INSERT INTO tiebreakers (user_id, season, week, guess_points, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, season, week) DO UPDATE SET
       guess_points = excluded.guess_points, updated_at = excluded.updated_at`
  ).run(userId, season, week, guessPoints);
  broadcastUpdate(req.group.id, 'tiebreaker');
  res.json({ ok: true });
});

// ---- Results & standings ----
app.get('/api/groups/:code/weeks/:season/:week/results', loadGroup, (req, res) => {
  const { season, week } = req.params;
  res.json(computeWeek(req.group.id, Number(season), Number(week)));
});

app.get('/api/groups/:code/standings/:season', loadGroup, (req, res) => {
  res.json(computeSeasonStandings(req.group.id, Number(req.params.season)));
});

// ---- Winner Board ----
// A shared, real-time view of the group's picks. Only exposed once the
// week is locked, so it can never leak an unlocked pick.
app.get('/api/groups/:code/weeks/:season/:week/board', loadGroup, (req, res) => {
  const season = Number(req.params.season);
  const week = Number(req.params.week);
  const lockTime = getWeekLockTime(season, week);
  const locked = lockTime !== null && new Date(lockTime) <= new Date();
  if (!locked) {
    return res.json({ locked: false, lockTime });
  }
  res.json({ locked: true, lockTime, ...computeBoard(req.group.id, season, week) });
});

app.listen(PORT, () => {
  console.log(`NFL Pick 'Em Simulator running at http://localhost:${PORT}`);
});
