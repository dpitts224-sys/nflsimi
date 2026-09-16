const path = require('path');
const express = require('express');
const {
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
} = require('./db');
const { fetchWeek } = require('./espn');
const { computeWeek, computeSeasonStandings, computeBoard } = require('./scoring');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Wraps an async route handler so a thrown/rejected error becomes a 500
// instead of crashing the process or hanging the request.
function h(fn) {
  return (req, res) => fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server' });
  });
}

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

app.get('/api/groups/:code/stream', h(async (req, res) => {
  const group = await get('SELECT id FROM groups WHERE code = ?', [normalizeCode(req.params.code)]);
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
}));

// ---- Group resolution ----
function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

async function loadGroup(req, res, next) {
  const group = await get('SELECT * FROM groups WHERE code = ?', [normalizeCode(req.params.code)]);
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

// Proves a request claiming to be player `userId` is actually coming from
// someone who holds that player's passcode - not just anyone in the group
// who knows their name/id (both are visible to every group member via the
// player list, so id alone proves nothing).
async function verifyPlayerAccess(userId, groupId, passcode) {
  const user = await get('SELECT passcode_hash, passcode_salt FROM users WHERE id = ? AND group_id = ?', [
    userId,
    groupId,
  ]);
  if (!user || !user.passcode_hash) return false; // no passcode set = no access, not "anyone's welcome"
  return verifyPassword(passcode || '', user.passcode_hash, user.passcode_salt);
}

// ---- Groups ----
app.post('/api/groups', h(async (req, res) => {
  const { name, adminPassword } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Your group needs a name" });
  if (!adminPassword || adminPassword.length < 4) {
    return res.status(400).json({ error: 'Admin password must be at least 4 characters' });
  }
  const { hash, salt } = hashPassword(adminPassword);
  const code = await generateGroupCode();
  const now = new Date();
  const info = await run(
    `INSERT INTO groups (code, name, admin_password_hash, admin_password_salt, current_season, current_week, buy_in)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [code, name.trim(), hash, salt, now.getFullYear(), 1, 10]
  );
  res.json({ id: info.rows[0].id, code, name: name.trim() });
}));

app.get('/api/groups/:code', loadGroup, h(async (req, res) => {
  res.json({
    code: req.group.code,
    name: req.group.name,
    season: req.group.current_season,
    week: req.group.current_week,
    buyIn: req.group.buy_in,
  });
}));

app.post('/api/groups/:code/login', loadGroup, h(async (req, res) => {
  const { password } = req.body;
  if (!verifyPassword(password || '', req.group.admin_password_hash, req.group.admin_password_salt)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  res.json({ ok: true });
}));

app.post('/api/groups/:code/state', loadGroup, requireGroupAdmin, h(async (req, res) => {
  const { season, week, buyIn } = req.body;
  await run(
    `UPDATE groups SET
       current_season = COALESCE(?, current_season),
       current_week = COALESCE(?, current_week),
       buy_in = COALESCE(?, buy_in)
     WHERE id = ?`,
    [season ?? null, week ?? null, buyIn ?? null, req.group.id]
  );
  broadcastUpdate(req.group.id, 'state');
  res.json({ ok: true });
}));

// ---- Users ----
// Anyone with the group code can add their own name - no admin password
// needed. This is the self-service "join" flow.
app.get('/api/groups/:code/users', loadGroup, h(async (req, res) => {
  const users = await all('SELECT id, name FROM users WHERE group_id = ? ORDER BY LOWER(name)', [
    req.group.id,
  ]);
  res.json(users);
}));

app.post('/api/groups/:code/users', loadGroup, h(async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const trimmed = name.trim().slice(0, 40);
  const existing = await get('SELECT id FROM users WHERE group_id = ? AND LOWER(name) = LOWER(?)', [
    req.group.id,
    trimmed,
  ]);
  if (existing) {
    return res.status(400).json({
      error: "Someone in this group already has that name - if that's you, use \"Restore access\" with your passcode instead",
    });
  }
  const passcode = generatePasscode();
  const { hash, salt } = hashPassword(passcode);
  const info = await run(
    'INSERT INTO users (group_id, name, passcode_hash, passcode_salt) VALUES (?, ?, ?, ?) RETURNING id',
    [req.group.id, trimmed, hash, salt]
  );
  broadcastUpdate(req.group.id, 'users');
  // The passcode is only ever shown here, at creation - store it now,
  // because there's no way to recover it later (only reset it by
  // rejoining, which an admin removal + a fresh join effectively does).
  res.json({ id: info.rows[0].id, name: trimmed, passcode });
}));

// Restores access to an existing player identity on a new device/browser,
// given their name + the passcode they were shown when they first joined.
// Doesn't rotate the passcode, so it keeps working on every other device
// that already has it too.
app.post('/api/groups/:code/restore', loadGroup, h(async (req, res) => {
  const { name, passcode } = req.body;
  if (!name || !passcode) return res.status(400).json({ error: 'Name and passcode are required' });
  const user = await get('SELECT id, name, passcode_hash, passcode_salt FROM users WHERE group_id = ? AND LOWER(name) = LOWER(?)', [
    req.group.id,
    name.trim(),
  ]);
  if (!user || !user.passcode_hash || !verifyPassword(passcode, user.passcode_hash, user.passcode_salt)) {
    return res.status(401).json({ error: 'Name or passcode is incorrect' });
  }
  res.json({ id: user.id, name: user.name, passcode });
}));

app.delete('/api/groups/:code/users/:id', loadGroup, requireGroupAdmin, h(async (req, res) => {
  await run('DELETE FROM users WHERE id = ? AND group_id = ?', [req.params.id, req.group.id]);
  broadcastUpdate(req.group.id, 'users');
  res.json({ ok: true });
}));

// ---- Games ----
// Games are the real, shared NFL schedule/scores - not per-group - so any
// group syncing a week benefits every other group too. The whole week's
// picks (and the tiebreaker) lock together at the kickoff of the week's
// first game, not per-game.
app.get('/api/groups/:code/weeks/:season/:week/games', loadGroup, h(async (req, res) => {
  const { season, week } = req.params;
  const games = await all('SELECT * FROM games WHERE season = ? AND week = ? ORDER BY kickoff ASC', [
    season,
    week,
  ]);
  const locked = await isWeekLocked(Number(season), Number(week));
  res.json(games.map((g) => ({ ...g, locked })));
}));

app.post('/api/groups/:code/admin/weeks/:season/:week/sync', loadGroup, requireGroupAdmin, h(async (req, res) => {
  const { season, week } = req.params;
  const seasontype = req.body?.seasontype || 2;
  try {
    const count = await fetchWeek(Number(season), Number(week), Number(seasontype));
    broadcastUpdate(req.group.id, 'sync');
    res.json({ ok: true, gamesSynced: count });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// ---- Picks ----
// Returns picks for a week. A given user's own picks are only included if
// the request proves it's really them (their passcode) - otherwise
// everyone's picks stay hidden until the whole week locks, so nobody can
// peek at or copy a pick before making their own.
app.get('/api/groups/:code/weeks/:season/:week/picks', loadGroup, h(async (req, res) => {
  const { season, week } = req.params;
  const viewerId = Number(req.query.userId) || null;
  const isVerifiedViewer =
    viewerId && (await verifyPlayerAccess(viewerId, req.group.id, req.query.passcode));
  const locked = await isWeekLocked(Number(season), Number(week));
  const rows = await all(
    `SELECT p.user_id, p.game_id, p.picked_abbr
     FROM picks p
     JOIN games g ON g.id = p.game_id
     JOIN users u ON u.id = p.user_id
     WHERE g.season = ? AND g.week = ? AND u.group_id = ?`,
    [season, week, req.group.id]
  );
  const visible = rows
    .filter((r) => (isVerifiedViewer && r.user_id === viewerId) || locked)
    .map((r) => ({ userId: r.user_id, gameId: r.game_id, pickedAbbr: r.picked_abbr }));
  res.json(visible);
}));

app.post('/api/groups/:code/picks', loadGroup, h(async (req, res) => {
  const { userId, gameId, pickedAbbr, passcode } = req.body;
  if (!userId || !gameId || !pickedAbbr) {
    return res.status(400).json({ error: 'userId, gameId, and pickedAbbr are required' });
  }
  if (!(await verifyPlayerAccess(userId, req.group.id, passcode))) {
    return res.status(403).json({ error: 'Invalid player credentials' });
  }
  const game = await get('SELECT * FROM games WHERE id = ?', [gameId]);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (await isWeekLocked(game.season, game.week)) {
    return res.status(403).json({ error: "This week's picks are locked - the first game has already started" });
  }
  if (pickedAbbr !== game.home_abbr && pickedAbbr !== game.away_abbr) {
    return res.status(400).json({ error: 'pickedAbbr must be one of the two teams' });
  }
  await run(
    `INSERT INTO picks (user_id, game_id, picked_abbr, updated_at)
     VALUES (?, ?, ?, now())
     ON CONFLICT(user_id, game_id) DO UPDATE SET
       picked_abbr = excluded.picked_abbr, updated_at = excluded.updated_at`,
    [userId, gameId, pickedAbbr]
  );
  broadcastUpdate(req.group.id, 'picks');
  res.json({ ok: true });
}));

// ---- Tiebreaker (Monday Night total points) ----
app.get('/api/groups/:code/weeks/:season/:week/tiebreakers', loadGroup, h(async (req, res) => {
  const { season, week } = req.params;
  const viewerId = Number(req.query.userId) || null;
  const isVerifiedViewer =
    viewerId && (await verifyPlayerAccess(viewerId, req.group.id, req.query.passcode));
  const locked = await isWeekLocked(Number(season), Number(week));
  const rows = await all(
    `SELECT t.user_id, t.guess_points
     FROM tiebreakers t
     JOIN users u ON u.id = t.user_id
     WHERE t.season = ? AND t.week = ? AND u.group_id = ?`,
    [season, week, req.group.id]
  );
  const visible = rows
    .filter((r) => (isVerifiedViewer && r.user_id === viewerId) || locked)
    .map((r) => ({ userId: r.user_id, guessPoints: r.guess_points }));
  res.json(visible);
}));

app.post('/api/groups/:code/tiebreakers', loadGroup, h(async (req, res) => {
  const { userId, season, week, guessPoints, passcode } = req.body;
  if (!userId || !season || !week || guessPoints === undefined) {
    return res.status(400).json({ error: 'userId, season, week, and guessPoints are required' });
  }
  if (!(await verifyPlayerAccess(userId, req.group.id, passcode))) {
    return res.status(403).json({ error: 'Invalid player credentials' });
  }
  const mnf = await get('SELECT * FROM games WHERE season = ? AND week = ? AND is_mnf = 1', [
    season,
    week,
  ]);
  if (!mnf) return res.status(400).json({ error: 'No Monday Night game found for this week' });
  if (await isWeekLocked(Number(season), Number(week))) {
    return res.status(403).json({ error: "This week's picks are locked - the first game has already started" });
  }
  await run(
    `INSERT INTO tiebreakers (user_id, season, week, guess_points, updated_at)
     VALUES (?, ?, ?, ?, now())
     ON CONFLICT(user_id, season, week) DO UPDATE SET
       guess_points = excluded.guess_points, updated_at = excluded.updated_at`,
    [userId, season, week, guessPoints]
  );
  broadcastUpdate(req.group.id, 'tiebreaker');
  res.json({ ok: true });
}));

// ---- Results & standings ----
app.get('/api/groups/:code/weeks/:season/:week/results', loadGroup, h(async (req, res) => {
  const { season, week } = req.params;
  res.json(await computeWeek(req.group.id, Number(season), Number(week)));
}));

app.get('/api/groups/:code/standings/:season', loadGroup, h(async (req, res) => {
  res.json(await computeSeasonStandings(req.group.id, Number(req.params.season)));
}));

// ---- Winner Board ----
// A shared, real-time view of the group's picks. Only exposed once the
// week is locked, so it can never leak an unlocked pick.
app.get('/api/groups/:code/weeks/:season/:week/board', loadGroup, h(async (req, res) => {
  const season = Number(req.params.season);
  const week = Number(req.params.week);
  const lockTime = await getWeekLockTime(season, week);
  const locked = lockTime !== null && new Date(lockTime) <= new Date();
  if (!locked) {
    return res.json({ locked: false, lockTime });
  }
  res.json({ locked: true, lockTime, ...(await computeBoard(req.group.id, season, week)) });
}));

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`NFL Pick 'Em Simulator running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });
