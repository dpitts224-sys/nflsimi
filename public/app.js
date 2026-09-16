const state = {
  season: null,
  week: null,
  buyIn: 0,
  users: [],
  userId: Number(localStorage.getItem('pickem_user_id')) || null,
  adminPassword: sessionStorage.getItem('pickem_admin_password') || null,
  tab: 'week',
};

const app = document.getElementById('app');

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function adminHeaders() {
  return state.adminPassword ? { 'x-admin-password': state.adminPassword } : {};
}

function fmtKickoff(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// ---------- bootstrap ----------
async function init() {
  await refreshUsers();
  await refreshState();
  bindTopbar();
  bindTabs();
  bindAdminModal();
  if (state.adminPassword) document.getElementById('adminTabBtn').hidden = false;
  render();
}

async function refreshState() {
  const s = await api('/api/state');
  state.season = s.season;
  state.week = s.week;
  state.buyIn = s.buyIn;
}

async function refreshUsers() {
  state.users = await api('/api/users');
  const sel = document.getElementById('userSelect');
  sel.innerHTML =
    '<option value="">Who are you?</option>' +
    state.users.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
  if (state.userId) sel.value = state.userId;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function bindTopbar() {
  document.getElementById('userSelect').addEventListener('change', (e) => {
    state.userId = Number(e.target.value) || null;
    if (state.userId) localStorage.setItem('pickem_user_id', state.userId);
    else localStorage.removeItem('pickem_user_id');
    render();
  });
  document.getElementById('adminBtn').addEventListener('click', () => {
    if (state.adminPassword) {
      state.adminPassword = null;
      sessionStorage.removeItem('pickem_admin_password');
      document.getElementById('adminTabBtn').hidden = true;
      if (state.tab === 'admin') switchTab('week');
      render();
    } else {
      document.getElementById('adminModal').classList.remove('hidden');
    }
  });
}

function bindAdminModal() {
  const modal = document.getElementById('adminModal');
  document.getElementById('adminCancel').addEventListener('click', () => modal.classList.add('hidden'));
  document.getElementById('adminSubmit').addEventListener('click', async () => {
    const pw = document.getElementById('adminPassword').value;
    try {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: pw }) });
      state.adminPassword = pw;
      sessionStorage.setItem('pickem_admin_password', pw);
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
  if (state.tab === 'week') return renderWeekTab();
  if (state.tab === 'results') return renderResultsTab();
  if (state.tab === 'standings') return renderStandingsTab();
  if (state.tab === 'admin') return renderAdminTab();
}

async function renderWeekTab() {
  app.innerHTML = '<p class="empty-state">Loading…</p>';
  const { season, week } = state;
  const [games, picks, tiebreakers] = await Promise.all([
    api(`/api/weeks/${season}/${week}/games`),
    api(`/api/weeks/${season}/${week}/picks?userId=${state.userId || ''}`),
    api(`/api/weeks/${season}/${week}/tiebreakers?userId=${state.userId || ''}`),
  ]);

  if (games.length === 0) {
    app.innerHTML = `<p class="empty-state">No games loaded yet for Season ${season}, Week ${week}.<br/>Ask your admin to sync this week from the Admin tab.</p>`;
    return;
  }

  const myPickFor = (gameId) => picks.find((p) => p.gameId === gameId && p.userId === state.userId);
  const otherPicksFor = (gameId) => picks.filter((p) => p.gameId === gameId && p.userId !== state.userId);

  const cards = games.map((g) => {
    const mine = myPickFor(g.id);
    const others = otherPicksFor(g.id);
    const isFinal = g.status === 'final';

    const teamButton = (abbr, teamName, score, isHome) => {
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
          ${teamButton(g.away_abbr, g.away_team, g.away_score, false)}
          ${teamButton(g.home_abbr, g.home_team, g.home_score, true)}
        </div>
        ${g.locked ? `<div class="locked-note">🔒 Locked${isFinal ? ' — final' : ' — in progress'}</div>` : ''}
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
          mnfGame.status === 'final' ? mnfGame.home_score + mnfGame.away_score : 'game in progress'
        }</span>` : ''}
      </div>`;
  }

  app.innerHTML = `
    <div class="card" style="display:flex;justify-content:space-between;align-items:center">
      <div><strong>Season ${season} — Week ${week}</strong></div>
      ${!state.userId ? '<span class="muted">Pick your name above to make picks</span>' : ''}
    </div>
    ${cards.join('')}
    ${tiebreakerHtml}
  `;

  app.querySelectorAll('.team-btn[data-game]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('/api/picks', {
          method: 'POST',
          body: JSON.stringify({
            userId: state.userId,
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
        await api('/api/tiebreakers', {
          method: 'POST',
          body: JSON.stringify({ userId: state.userId, season, week, guessPoints: val }),
        });
        renderWeekTab();
      } catch (err) {
        alert(err.message);
      }
    });
  }
}

async function renderResultsTab() {
  app.innerHTML = '<p class="empty-state">Loading…</p>';
  const { season, week } = state;
  const r = await api(`/api/weeks/${season}/${week}/results`);

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
  const s = await api(`/api/standings/${state.season}`);

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
      <div class="admin-row">
        <input id="newUserName" placeholder="Add a player's name" />
        <button id="addUserBtn">Add player</button>
      </div>
    </div>
  `;

  document.getElementById('saveStateBtn').addEventListener('click', async () => {
    try {
      await api('/api/admin/state', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({
          season: Number(document.getElementById('seasonInput').value),
          week: Number(document.getElementById('weekInput').value),
          buyIn: Number(document.getElementById('buyInInput').value),
        }),
      });
      await refreshState();
      render();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('syncBtn').addEventListener('click', async () => {
    const status = document.getElementById('syncStatus');
    status.textContent = 'Syncing…';
    try {
      const r = await api(`/api/admin/weeks/${state.season}/${state.week}/sync`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({}),
      });
      status.textContent = `Synced ${r.gamesSynced} games.`;
    } catch (err) {
      status.textContent = err.message;
    }
  });

  document.getElementById('addUserBtn').addEventListener('click', async () => {
    const input = document.getElementById('newUserName');
    if (!input.value.trim()) return;
    try {
      await api('/api/admin/users', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ name: input.value.trim() }),
      });
      input.value = '';
      await refreshUsers();
      render();
    } catch (err) {
      alert(err.message);
    }
  });

  document.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this player and all of their picks?')) return;
      await api(`/api/admin/users/${btn.dataset.remove}`, { method: 'DELETE', headers: adminHeaders() });
      await refreshUsers();
      render();
    });
  });
}

init();
