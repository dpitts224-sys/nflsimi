const state = {
  groupCode: localStorage.getItem('pickem_group_code') || null,
  groupName: null,
  season: null,
  week: null,
  buyIn: 0,
  users: [],
  userId: null,
  passcode: null,
  adminPassword: null,
  tab: 'week',
  eventSource: null,
  gateMode: 'join', // 'join' | 'create'
};

const app = document.getElementById('app');

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function groupApi(path, opts) {
  return api(`/api/groups/${encodeURIComponent(state.groupCode)}${path}`, opts);
}

function adminHeaders() {
  return state.adminPassword ? { 'x-admin-password': state.adminPassword } : {};
}

function fmtKickoff(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function adminStorageKey(code) { return `pickem_admin_${code}`; }
function identitiesStorageKey(code) { return `pickem_identities_${code}`; }
function activeIdStorageKey(code) { return `pickem_active_${code}`; }

// Identities are the players THIS BROWSER holds valid passcodes for in a
// given group - not the group's full roster (that's state.users). A device
// can hold more than one (e.g. a shared family computer where a couple
// people each joined once and now just switch between themselves).
function loadIdentities(code) {
  try { return JSON.parse(localStorage.getItem(identitiesStorageKey(code)) || '[]'); }
  catch { return []; }
}

function saveIdentity(code, user) {
  const list = loadIdentities(code).filter((u) => u.id !== user.id);
  list.push(user);
  localStorage.setItem(identitiesStorageKey(code), JSON.stringify(list));
  localStorage.setItem(activeIdStorageKey(code), String(user.id));
}

function getActiveIdentity(code) {
  const list = loadIdentities(code);
  const activeId = Number(localStorage.getItem(activeIdStorageKey(code)));
  return list.find((u) => u.id === activeId) || list[0] || null;
}

function setActiveIdentity(code, id) {
  localStorage.setItem(activeIdStorageKey(code), String(id));
}

// ---------- bootstrap ----------
async function init() {
  bindGateForms();
  bindTopbar();
  bindTabs();
  bindAdminModal();

  if (state.groupCode) {
    const ok = await enterGroup(state.groupCode, { skipHistoryUpdate: true });
    if (!ok) return renderGate();
  } else {
    renderGate();
  }
}

// Loads a group by code, restores any saved identity for it, and switches
// the UI into the main app. Returns false (and leaves the gate showing) if
// the code doesn't exist.
async function enterGroup(code, opts = {}) {
  let info;
  try {
    info = await api(`/api/groups/${encodeURIComponent(code)}`);
  } catch (err) {
    localStorage.removeItem('pickem_group_code');
    return false;
  }

  state.groupCode = info.code;
  state.groupName = info.name;
  state.season = info.season;
  state.week = info.week;
  state.buyIn = info.buyIn;
  localStorage.setItem('pickem_group_code', state.groupCode);

  const savedAdmin = sessionStorage.getItem(adminStorageKey(state.groupCode));
  state.adminPassword = savedAdmin || null;

  await refreshUsers();

  const active = getActiveIdentity(state.groupCode);
  const stillInGroup = active && state.users.some((u) => u.id === active.id);
  state.userId = stillInGroup ? active.id : null;
  state.passcode = stillInGroup ? active.passcode : null;

  connectLiveUpdates();
  showMainApp();

  if (!state.userId) {
    openJoinModal({ dismissible: false });
  }

  document.getElementById('adminTabBtn').hidden = !state.adminPassword;
  render();
  return true;
}

function showMainApp() {
  document.getElementById('topbarControls').hidden = false;
  document.getElementById('tabsNav').hidden = false;
  const badge = document.getElementById('groupBadge');
  badge.innerHTML = `${escapeHtml(state.groupName)} <span class="code">${escapeHtml(state.groupCode)}</span>`;
  populateUserSelect();
}

function leaveGroup() {
  if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
  localStorage.removeItem('pickem_group_code');
  state.groupCode = null;
  state.groupName = null;
  state.userId = null;
  state.passcode = null;
  state.adminPassword = null;
  document.getElementById('topbarControls').hidden = true;
  document.getElementById('tabsNav').hidden = true;
  document.getElementById('adminTabBtn').hidden = true;
  state.tab = 'week';
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'week'));
  renderGate();
}

// ---------- group gate (join / create) ----------
function renderGate() {
  if (state.gateMode === 'create') {
    app.innerHTML = `
      <div class="gate-wrap">
        <div class="gate-title">Create a group</div>
        <div class="gate-subtitle">You'll get a code to share with your friends.</div>
        <div class="card gate-card">
          <label>Group name
            <input id="gateGroupName" type="text" placeholder="e.g. Dad's Pick 'Em" maxlength="60" />
          </label>
          <label>Admin password
            <input id="gateAdminPassword" type="password" placeholder="Only you should know this" />
          </label>
          <span class="muted" style="font-size:0.8rem">You'll use this password to sync each week's games and manage players.</span>
          <button id="gateCreateSubmit">Create group</button>
          <p id="gateError" class="error"></p>
        </div>
        <div class="gate-toggle">
          Already have a code? <button id="gateToJoin">Join a group instead</button>
        </div>
      </div>
    `;
  } else {
    app.innerHTML = `
      <div class="gate-wrap">
        <div class="gate-title">🏈 NFL Pick 'Em</div>
        <div class="gate-subtitle">Enter your group's code to join in.</div>
        <div class="card gate-card">
          <label>Group code
            <input id="gateCodeInput" type="text" placeholder="e.g. AB3XQZ" maxlength="6" style="text-transform:uppercase;letter-spacing:0.1em;font-weight:700" />
          </label>
          <button id="gateJoinSubmit">Join group</button>
          <p id="gateError" class="error"></p>
        </div>
        <div class="gate-toggle">
          Starting a new pool? <button id="gateToCreate">Create a group</button>
        </div>
      </div>
    `;
  }
  bindGateForms();
}

function bindGateForms() {
  const toCreate = document.getElementById('gateToCreate');
  if (toCreate) toCreate.addEventListener('click', () => { state.gateMode = 'create'; renderGate(); });
  const toJoin = document.getElementById('gateToJoin');
  if (toJoin) toJoin.addEventListener('click', () => { state.gateMode = 'join'; renderGate(); });

  const joinBtn = document.getElementById('gateJoinSubmit');
  if (joinBtn) {
    joinBtn.addEventListener('click', async () => {
      const code = document.getElementById('gateCodeInput').value.trim().toUpperCase();
      if (!code) return;
      const ok = await enterGroup(code);
      if (!ok) document.getElementById('gateError').textContent = "That group code doesn't exist";
    });
  }

  const createBtn = document.getElementById('gateCreateSubmit');
  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      const name = document.getElementById('gateGroupName').value.trim();
      const password = document.getElementById('gateAdminPassword').value;
      try {
        const info = await api('/api/groups', {
          method: 'POST',
          body: JSON.stringify({ name, adminPassword: password }),
        });
        state.adminPassword = password;
        sessionStorage.setItem(adminStorageKey(info.code), password);
        await enterGroup(info.code);
        alert(`Your group code is ${info.code} - share it with your friends so they can join!`);
      } catch (err) {
        document.getElementById('gateError').textContent = err.message;
      }
    });
  }
}

// ---------- live updates ----------
function connectLiveUpdates() {
  if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
  if (typeof EventSource === 'undefined') return;
  const dot = document.getElementById('liveDot');
  const es = new EventSource(`/api/groups/${encodeURIComponent(state.groupCode)}/stream`);
  es.addEventListener('open', () => { if (dot) dot.hidden = false; });
  es.addEventListener('error', () => { if (dot) dot.hidden = true; });
  es.addEventListener('update', () => render());
  state.eventSource = es;
}

// ---------- users ----------
async function refreshUsers() {
  state.users = await groupApi('/users');
  populateUserSelect();
}

function populateUserSelect() {
  const sel = document.getElementById('userSelect');
  if (!sel) return;
  // Only identities THIS device has valid passcodes for - not the group's
  // whole roster - so switching the dropdown can never "become" someone
  // else without their passcode.
  const mine = loadIdentities(state.groupCode).filter((u) => state.users.some((su) => su.id === u.id));
  sel.innerHTML =
    mine.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('') +
    `<option value="__new__">+ Add / restore access</option>`;
  if (state.userId) sel.value = state.userId;
  else sel.value = '__new__';
}

// ---------- join modal (self-service "add my name" + "restore access") ----------
function joinModalFormHtml() {
  return `
    <h3>What's your name?</h3>
    <input id="joinNameInput" type="text" placeholder="e.g. Steve" maxlength="40" />
    <input id="joinPasscodeInput" type="text" placeholder="Passcode (if returning)"
      maxlength="8" style="text-transform:uppercase;letter-spacing:0.08em" />
    <span class="muted" style="font-size:0.78rem">Leave the passcode blank if this is your first time joining.</span>
    <div class="modal-actions">
      <button id="joinCancel" class="ghost">Cancel</button>
      <button id="joinSubmit">Continue</button>
    </div>
    <p id="joinError" class="error"></p>
  `;
}

function openJoinModal({ dismissible = true } = {}) {
  const box = document.querySelector('#joinModal .modal-box');
  box.innerHTML = joinModalFormHtml();
  document.getElementById('joinCancel').hidden = !dismissible;
  document.getElementById('joinCancel').addEventListener('click', () => {
    document.getElementById('joinModal').classList.add('hidden');
    populateUserSelect();
  });
  document.getElementById('joinSubmit').addEventListener('click', submitJoinOrRestore);
  document.getElementById('joinModal').classList.remove('hidden');
  document.getElementById('joinNameInput').focus();
}

async function submitJoinOrRestore() {
  const name = document.getElementById('joinNameInput').value.trim();
  const passcode = document.getElementById('joinPasscodeInput').value.trim().toUpperCase();
  if (!name) return;
  try {
    const user = passcode
      ? await groupApi('/restore', { method: 'POST', body: JSON.stringify({ name, passcode }) })
      : await groupApi('/users', { method: 'POST', body: JSON.stringify({ name }) });
    saveIdentity(state.groupCode, user);
    state.userId = user.id;
    state.passcode = user.passcode;
    await refreshUsers();
    if (user.passcode && !passcode) {
      showPasscodeReveal(user.name, user.passcode);
    } else {
      document.getElementById('joinModal').classList.add('hidden');
      render();
    }
  } catch (err) {
    document.getElementById('joinError').textContent = err.message;
  }
}

// Shown exactly once, right after a fresh join - this passcode is never
// shown again, so make it hard to miss and easy to copy.
function showPasscodeReveal(name, passcode) {
  const box = document.querySelector('#joinModal .modal-box');
  box.innerHTML = `
    <h3>You're in, ${escapeHtml(name)}!</h3>
    <p class="muted">Save this passcode - it's the only way to access your picks from a different
      device later. We'll remember you automatically here, so you won't need it on this device.</p>
    <div class="code-reveal">${escapeHtml(passcode)}</div>
    <div class="modal-actions">
      <button id="passcodeOk">Got it</button>
    </div>
  `;
  document.getElementById('passcodeOk').addEventListener('click', () => {
    document.getElementById('joinModal').classList.add('hidden');
    render();
  });
}

// Form bindings for the join/restore modal are (re)attached each time
// openJoinModal() rebuilds its contents, since restoring/joining swaps
// that HTML out - see openJoinModal() and showPasscodeReveal() above.

function bindTopbar() {
  document.getElementById('userSelect').addEventListener('change', (e) => {
    if (e.target.value === '__new__') {
      openJoinModal({ dismissible: true });
      return;
    }
    const id = Number(e.target.value);
    const identity = loadIdentities(state.groupCode).find((u) => u.id === id);
    if (identity) {
      state.userId = identity.id;
      state.passcode = identity.passcode;
      setActiveIdentity(state.groupCode, identity.id);
    }
    render();
  });
  document.getElementById('adminBtn').addEventListener('click', () => {
    if (state.adminPassword) {
      state.adminPassword = null;
      sessionStorage.removeItem(adminStorageKey(state.groupCode));
      document.getElementById('adminTabBtn').hidden = true;
      if (state.tab === 'admin') switchTab('week');
      render();
    } else {
      document.getElementById('adminModal').classList.remove('hidden');
    }
  });
  document.getElementById('leaveGroupBtn').addEventListener('click', () => {
    if (confirm('Switch to a different group? You can rejoin this one later with its code.')) {
      leaveGroup();
    }
  });
}

function bindAdminModal() {
  const modal = document.getElementById('adminModal');
  document.getElementById('adminCancel').addEventListener('click', () => modal.classList.add('hidden'));
  document.getElementById('adminSubmit').addEventListener('click', async () => {
    const pw = document.getElementById('adminPassword').value;
    try {
      await groupApi('/login', { method: 'POST', body: JSON.stringify({ password: pw }) });
      state.adminPassword = pw;
      sessionStorage.setItem(adminStorageKey(state.groupCode), pw);
      document.getElementById('adminTabBtn').hidden = false;
      document.getElementById('adminError').textContent = '';
      document.getElementById('adminPassword').value = '';
      modal.classList.add('hidden');
      render();
    } catch (err) {
      document.getElementById('adminError').textContent = err.message;
    }
  });
}

function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  render();
}

// ---------- rendering ----------
async function render() {
  if (!state.groupCode) return renderGate();
  if (state.tab === 'week') return renderWeekTab();
  if (state.tab === 'board') return renderBoardTab();
  if (state.tab === 'results') return renderResultsTab();
  if (state.tab === 'standings') return renderStandingsTab();
  if (state.tab === 'admin') return renderAdminTab();
}

async function renderWeekTab() {
  app.innerHTML = '<p class="empty-state">Loading…</p>';
  const { season, week } = state;
  const idQuery = `userId=${state.userId || ''}&passcode=${encodeURIComponent(state.passcode || '')}`;
  const [games, picks, tiebreakers] = await Promise.all([
    groupApi(`/weeks/${season}/${week}/games`),
    groupApi(`/weeks/${season}/${week}/picks?${idQuery}`),
    groupApi(`/weeks/${season}/${week}/tiebreakers?${idQuery}`),
  ]);

  if (games.length === 0) {
    app.innerHTML = `<p class="empty-state">No games loaded yet for Season ${season}, Week ${week}.<br/>Ask your group's admin to sync this week from the Admin tab.</p>`;
    return;
  }

  const myPickFor = (gameId) => picks.find((p) => p.gameId === gameId && p.userId === state.userId);
  const otherPicksFor = (gameId) => picks.filter((p) => p.gameId === gameId && p.userId !== state.userId);

  const cards = games.map((g) => {
    const mine = myPickFor(g.id);
    const others = otherPicksFor(g.id);
    const isFinal = g.status === 'final';

    const teamButton = (abbr, teamName, score) => {
      const selected = mine?.pickedAbbr === abbr;
      let cls = 'team-btn';
      if (selected) cls += ' selected';
      if (isFinal && g.winner_abbr) cls += abbr === g.winner_abbr ? ' winner' : ' loser';
      const disabled = g.locked || !state.userId;
      return `<button class="${cls}" ${disabled ? 'disabled' : ''} data-game="${g.id}" data-abbr="${abbr}">
        <span class="abbr">${escapeHtml(teamName)}</span>
        ${score !== null && score !== undefined ? `<span class="score">${score}</span>` : ''}
      </button>`;
    };

    const othersHtml = g.locked && others.length
      ? `<div class="muted" style="font-size:0.8rem">Also picked: ${others
          .map((o) => {
            const u = state.users.find((u) => u.id === o.userId);
            return `${escapeHtml(u ? u.name : '?')} → ${o.pickedAbbr}`;
          })
          .join(', ')}</div>`
      : '';

    return `
      <div class="card game-card">
        <div class="game-meta">
          <span>${fmtKickoff(g.kickoff)}</span>
          ${g.is_mnf ? '<span class="mnf-badge">MNF</span>' : ''}
        </div>
        <div class="matchup">
          ${teamButton(g.away_abbr, g.away_team, g.away_score)}
          ${teamButton(g.home_abbr, g.home_team, g.home_score)}
        </div>
        ${g.locked ? `<div class="locked-note">🔒 Locked${
          g.status === 'final' ? ' — final' : g.status === 'in_progress' ? ' — in progress' : ' — not started yet'
        }</div>` : ''}
        ${othersHtml}
      </div>`;
  });

  const mnfGame = games.find((g) => g.is_mnf === 1);
  let tiebreakerHtml = '';
  if (mnfGame) {
    const mine = tiebreakers.find((t) => t.userId === state.userId);
    const locked = mnfGame.locked;
    tiebreakerHtml = `
      <div class="card tiebreaker-box">
        <strong>🔶 Monday Night Tiebreaker</strong>
        <span class="muted">Guess the combined total points scored by both teams (${escapeHtml(mnfGame.away_abbr)} @ ${escapeHtml(mnfGame.home_abbr)}). Closest guess breaks ties for the week.</span>
        <div class="admin-row">
          <input id="tiebreakerInput" type="number" min="0" placeholder="e.g. 45"
            value="${mine ? mine.guessPoints : ''}" ${locked || !state.userId ? 'disabled' : ''} />
          <button id="tiebreakerSubmit" ${locked || !state.userId ? 'disabled' : ''}>Save guess</button>
        </div>
        ${locked ? `<span class="locked-note">🔒 Locked — actual total: ${
          mnfGame.status === 'final'
            ? mnfGame.home_score + mnfGame.away_score
            : mnfGame.status === 'in_progress' ? 'game in progress' : 'game not started yet'
        }</span>` : ''}
      </div>`;
  }

  const weekLocked = games[0]?.locked;
  const lockNote = weekLocked
    ? '🔒 All picks for this week are locked.'
    : `Picks lock at kickoff of the first game (${fmtKickoff(games[0].kickoff)}) — after that, no changes.`;

  app.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
        <strong>Season ${season} — Week ${week}</strong>
        <span class="muted">${lockNote}</span>
      </div>
      <p class="page-hint">Pick a winner for every game below (and guess the Monday Night combined score) before the week's first kickoff — after that, your picks are locked in for good.</p>
    </div>
    ${!state.userId ? '<p class="empty-state">Add your name above to make picks</p>' : ''}
    ${cards.join('')}
    ${tiebreakerHtml}
  `;

  app.querySelectorAll('.team-btn[data-game]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await groupApi('/picks', {
          method: 'POST',
          body: JSON.stringify({
            userId: state.userId,
            passcode: state.passcode,
            gameId: Number(btn.dataset.game),
            pickedAbbr: btn.dataset.abbr,
          }),
        });
        renderWeekTab();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  const tbBtn = document.getElementById('tiebreakerSubmit');
  if (tbBtn) {
    tbBtn.addEventListener('click', async () => {
      const val = Number(document.getElementById('tiebreakerInput').value);
      if (!Number.isFinite(val) || val < 0) return alert('Enter a valid number of points');
      try {
        await groupApi('/tiebreakers', {
          method: 'POST',
          body: JSON.stringify({ userId: state.userId, passcode: state.passcode, season, week, guessPoints: val }),
        });
        renderWeekTab();
      } catch (err) {
        alert(err.message);
      }
    });
  }
}

async function renderBoardTab() {
  app.innerHTML = '<p class="empty-state">Loading…</p>';
  const { season, week } = state;
  const board = await groupApi(`/weeks/${season}/${week}/board`);

  if (!board.locked) {
    const when = board.lockTime ? fmtKickoff(board.lockTime) : null;
    app.innerHTML = `<div class="card">
      <strong>Winner Board</strong>
      <p class="muted" style="margin-top:8px">
        ${when
          ? `Everyone's picks are hidden until this week locks at kickoff of the first game (${when}). Check back then to see the whole group's board update live as games finish.`
          : 'No games loaded for this week yet.'}
      </p>
    </div>`;
    return;
  }

  if (board.games.length === 0 || board.rows.length === 0) {
    app.innerHTML = '<p class="empty-state">Nothing to show yet.</p>';
    return;
  }

  const gameHeaders = board.games
    .map(
      (g) => `<th>
        <div class="board-game-header">
          <span>${escapeHtml(g.away_abbr)} @ ${escapeHtml(g.home_abbr)}</span>
          ${g.status === 'final' ? `<span class="score">${g.away_score}-${g.home_score}</span>` : `<span class="score">${escapeHtml(g.status.replace('_', ' '))}</span>`}
        </div>
      </th>`
    )
    .join('');

  const rows = board.rows
    .map((row) => {
      const cells = board.games
        .map((g) => {
          const pick = row.picks[g.id];
          if (!pick) return '<td class="pick-missing">—</td>';
          let cls = 'pick-pending';
          if (g.status === 'final' && g.winner_abbr) {
            cls = pick === g.winner_abbr ? 'pick-correct' : 'pick-wrong';
          }
          return `<td class="${cls}">${escapeHtml(pick)}</td>`;
        })
        .join('');
      return `<tr>
        <td class="player-col">${escapeHtml(row.name)}</td>
        ${cells}
        <td><strong>${row.correct}/${board.finalCount}</strong></td>
        <td>${row.tiebreakerGuess ?? '—'}</td>
      </tr>`;
    })
    .join('');

  app.innerHTML = `
    <div class="card">
      <strong>Winner Board — Season ${season}, Week ${week}</strong>
      <span class="muted" style="margin-left:8px">Live — updates automatically as picks and scores come in</span>
      <p class="page-hint">See everyone in your group's picks side by side, with correct/incorrect highlighted as each game finishes.</p>
    </div>
    <div class="card board-table-wrap">
      <table class="board">
        <thead><tr><th class="player-col">Player</th>${gameHeaders}<th>Correct</th><th>MNF guess</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function renderResultsTab() {
  app.innerHTML = '<p class="empty-state">Loading…</p>';
  const { season, week } = state;
  const r = await groupApi(`/weeks/${season}/${week}/results`);

  if (r.games.length === 0) {
    app.innerHTML = '<p class="empty-state">No games for this week yet.</p>';
    return;
  }

  const rows = r.results.map((row) => {
    const isWinner = r.winnerIds.includes(row.userId);
    return `<tr class="${isWinner ? 'winner-row' : ''}">
      <td>${isWinner ? '🏆 ' : ''}${escapeHtml(row.name)}</td>
      <td>${row.correct} / ${r.games.filter((g) => g.status === 'final').length}</td>
      <td>${row.tiebreakerGuess ?? '—'}</td>
      <td>${row.tiebreakerDiff ?? '—'}</td>
    </tr>`;
  });

  const potNote = r.winnerIds.length
    ? `Pot split ${r.winnerIds.length > 1 ? `between ${r.winnerIds.length} winners` : 'to the winner'}: $${(
        (state.buyIn * r.results.length) / (r.winnerIds.length || 1)
      ).toFixed(2)} each`
    : 'Week not finished yet';

  app.innerHTML = `
    <div class="card">
      <strong>Season ${season} — Week ${week} Results</strong>
      <div class="muted" style="margin-top:4px">
        ${r.allGamesFinal ? potNote : `In progress — ${r.games.filter((g) => g.status === 'final').length}/${r.games.length} games final`}
      </div>
      <p class="page-hint">See who's correctly picked the most games this week, and how the pot splits once every game is final.</p>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Player</th><th>Correct picks</th><th>MNF guess</th><th>Diff from actual</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
      ${r.mnfActualTotal !== null ? `<p class="muted" style="margin-top:10px">Actual MNF combined total: <strong>${r.mnfActualTotal}</strong></p>` : ''}
    </div>
  `;
}

async function renderStandingsTab() {
  app.innerHTML = '<p class="empty-state">Loading…</p>';
  const s = await groupApi(`/standings/${state.season}`);

  if (s.standings.length === 0) {
    app.innerHTML = '<p class="empty-state">No standings yet — add players and sync a week first.</p>';
    return;
  }

  const rows = s.standings.map(
    (row, i) => `<tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(row.name)}</td>
      <td>${row.weeklyWins}</td>
      <td>${row.totalCorrect}</td>
    </tr>`
  );

  const weekly = s.weeklyBreakdown
    .map(
      (w) =>
        `<span class="pill ${w.allGamesFinal ? 'win' : 'pending'}">Wk ${w.week}: ${
          w.allGamesFinal ? (w.winnerNames.join(' & ') || '—') : 'in progress'
        }</span>`
    )
    .join(' ');

  app.innerHTML = `
    <div class="card">
      <strong>Season ${s.season} Standings</strong>
      <p class="page-hint">Track each player's cumulative weekly wins and total correct picks across the whole season.</p>
      <table style="margin-top:10px">
        <thead><tr><th>#</th><th>Player</th><th>Weekly wins 🏆</th><th>Total correct picks</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>
    <div class="card">
      <strong>Weekly winners</strong>
      <div style="margin-top:10px; display:flex; flex-wrap:wrap; gap:6px">${weekly}</div>
    </div>
  `;
}

async function renderAdminTab() {
  app.innerHTML = `
    <p class="page-hint" style="margin-bottom:16px">Set the current season/week and buy-in, sync each week's real NFL schedule, and remove players if needed — all admin-only actions for this group.</p>
    <div class="card admin-section">
      <strong>Group</strong>
      <div class="admin-row">
        <span class="muted">Share this code so friends can join:</span>
        <span class="group-badge">${escapeHtml(state.groupCode)}</span>
      </div>
    </div>

    <div class="card admin-section">
      <strong>Season / Week</strong>
      <div class="admin-row">
        <label>Season <input id="seasonInput" type="number" value="${state.season}" style="width:100px" /></label>
        <label>Week <input id="weekInput" type="number" min="1" max="22" value="${state.week}" style="width:80px" /></label>
        <label>Buy-in ($) <input id="buyInInput" type="number" min="0" value="${state.buyIn}" style="width:90px" /></label>
        <button id="saveStateBtn">Save</button>
      </div>
      <div class="admin-row">
        <button id="syncBtn">Sync this week from ESPN</button>
        <span id="syncStatus" class="muted"></span>
      </div>
    </div>

    <div class="card admin-section">
      <strong>Players</strong>
      <div class="admin-row" id="userChips">
        ${state.users.map((u) => `<span class="user-chip">${escapeHtml(u.name)} <button class="small ghost" data-remove="${u.id}">✕</button></span>`).join('')}
      </div>
      <span class="muted" style="font-size:0.8rem">Players usually add themselves from the top bar - use this only to remove someone.</span>
    </div>
  `;

  document.getElementById('saveStateBtn').addEventListener('click', async () => {
    try {
      await groupApi('/state', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({
          season: Number(document.getElementById('seasonInput').value),
          week: Number(document.getElementById('weekInput').value),
          buyIn: Number(document.getElementById('buyInInput').value),
        }),
      });
      const info = await api(`/api/groups/${encodeURIComponent(state.groupCode)}`);
      state.season = info.season;
      state.week = info.week;
      state.buyIn = info.buyIn;
      render();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('syncBtn').addEventListener('click', async () => {
    const status = document.getElementById('syncStatus');
    status.textContent = 'Syncing…';
    try {
      const r = await groupApi(`/admin/weeks/${state.season}/${state.week}/sync`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({}),
      });
      status.textContent = `Synced ${r.gamesSynced} games.`;
    } catch (err) {
      status.textContent = err.message;
    }
  });

  document.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this player and all of their picks?')) return;
      await groupApi(`/users/${btn.dataset.remove}`, { method: 'DELETE', headers: adminHeaders() });
      await refreshUsers();
      render();
    });
  });
}

init();
