const { all } = require('./db');

// Computes the weekly results: each user's correct-pick count, their MNF
// tiebreaker guess, and who won the week (most correct picks, ties broken by
// closeness to the actual Monday Night combined score). Scoped to one
// group - games are shared globally, but players and picks are not.
async function computeWeek(groupId, season, week) {
  const games = await all('SELECT * FROM games WHERE season = ? AND week = ? ORDER BY kickoff ASC', [
    season,
    week,
  ]);

  const users = await all('SELECT id, name FROM users WHERE group_id = ? ORDER BY LOWER(name)', [groupId]);
  const finalGames = games.filter((g) => g.status === 'final');
  const mnfGame = games.find((g) => g.is_mnf === 1);
  const mnfFinal = mnfGame && mnfGame.status === 'final';
  const mnfActualTotal = mnfFinal ? mnfGame.home_score + mnfGame.away_score : null;

  const allPicks = await all(
    `SELECT p.*, g.winner_abbr, g.status FROM picks p
     JOIN games g ON g.id = p.game_id
     JOIN users u ON u.id = p.user_id
     WHERE g.season = ? AND g.week = ? AND u.group_id = ?`,
    [season, week, groupId]
  );

  const tiebreakers = await all(
    `SELECT t.* FROM tiebreakers t
     JOIN users u ON u.id = t.user_id
     WHERE t.season = ? AND t.week = ? AND u.group_id = ?`,
    [season, week, groupId]
  );

  const results = users.map((user) => {
    const userPicks = allPicks.filter((p) => p.user_id === user.id);
    const correct = userPicks.filter(
      (p) => p.status === 'final' && p.winner_abbr && p.picked_abbr === p.winner_abbr
    ).length;
    const pickedCount = userPicks.length;
    const tb = tiebreakers.find((t) => t.user_id === user.id);
    const guess = tb ? tb.guess_points : null;
    const diff =
      guess !== null && mnfActualTotal !== null ? Math.abs(guess - mnfActualTotal) : null;

    return {
      userId: user.id,
      name: user.name,
      correct,
      pickedCount,
      tiebreakerGuess: guess,
      tiebreakerDiff: diff,
    };
  });

  const allGamesFinal = games.length > 0 && finalGames.length === games.length;

  let winnerIds = [];
  if (allGamesFinal) {
    const withPicks = results.filter((r) => r.pickedCount > 0);
    if (withPicks.length > 0) {
      const maxCorrect = Math.max(...withPicks.map((r) => r.correct));
      let top = withPicks.filter((r) => r.correct === maxCorrect);
      if (top.length > 1 && mnfActualTotal !== null) {
        const withGuess = top.filter((r) => r.tiebreakerDiff !== null);
        if (withGuess.length > 0) {
          const minDiff = Math.min(...withGuess.map((r) => r.tiebreakerDiff));
          top = withGuess.filter((r) => r.tiebreakerDiff === minDiff);
        }
      }
      winnerIds = top.map((r) => r.userId);
    }
  }

  return {
    season,
    week,
    games,
    mnfGame: mnfGame || null,
    mnfActualTotal,
    allGamesFinal,
    results: results.sort((a, b) => b.correct - a.correct),
    winnerIds,
  };
}

async function computeSeasonStandings(groupId, season) {
  const weeks = (
    await all('SELECT DISTINCT week FROM games WHERE season = ? ORDER BY week ASC', [season])
  ).map((r) => r.week);

  const users = await all('SELECT id, name FROM users WHERE group_id = ? ORDER BY LOWER(name)', [groupId]);
  const totals = new Map(
    users.map((u) => [u.id, { userId: u.id, name: u.name, weeklyWins: 0, totalCorrect: 0 }])
  );

  const weeklyBreakdown = [];
  for (const week of weeks) {
    const weekResult = await computeWeek(groupId, season, week);
    for (const r of weekResult.results) {
      const t = totals.get(r.userId);
      if (!t) continue;
      t.totalCorrect += r.correct;
      if (weekResult.winnerIds.includes(r.userId)) t.weeklyWins += 1;
    }
    weeklyBreakdown.push({
      week,
      allGamesFinal: weekResult.allGamesFinal,
      winnerIds: weekResult.winnerIds,
      winnerNames: users
        .filter((u) => weekResult.winnerIds.includes(u.id))
        .map((u) => u.name),
    });
  }

  const standings = Array.from(totals.values()).sort(
    (a, b) => b.weeklyWins - a.weeklyWins || b.totalCorrect - a.totalCorrect
  );

  return { season, standings, weeklyBreakdown };
}

// Full pick matrix for the "Winner Board" - every player's pick on every
// game, plus their running correct count. Callers must only expose this
// once the week is locked (see isWeekLocked in db.js).
async function computeBoard(groupId, season, week) {
  const games = await all('SELECT * FROM games WHERE season = ? AND week = ? ORDER BY kickoff ASC', [
    season,
    week,
  ]);
  const users = await all('SELECT id, name FROM users WHERE group_id = ? ORDER BY LOWER(name)', [groupId]);
  const picks = await all(
    `SELECT p.user_id, p.game_id, p.picked_abbr FROM picks p
     JOIN games g ON g.id = p.game_id
     JOIN users u ON u.id = p.user_id
     WHERE g.season = ? AND g.week = ? AND u.group_id = ?`,
    [season, week, groupId]
  );
  const tiebreakers = await all(
    `SELECT t.user_id, t.guess_points FROM tiebreakers t
     JOIN users u ON u.id = t.user_id
     WHERE t.season = ? AND t.week = ? AND u.group_id = ?`,
    [season, week, groupId]
  );

  const rows = users.map((user) => {
    const userPicks = {};
    let correct = 0;
    for (const g of games) {
      const p = picks.find((pk) => pk.user_id === user.id && pk.game_id === g.id);
      userPicks[g.id] = p ? p.picked_abbr : null;
      if (p && g.status === 'final' && g.winner_abbr && p.picked_abbr === g.winner_abbr) {
        correct += 1;
      }
    }
    const tb = tiebreakers.find((t) => t.user_id === user.id);
    return {
      userId: user.id,
      name: user.name,
      picks: userPicks,
      tiebreakerGuess: tb ? tb.guess_points : null,
      correct,
    };
  });

  rows.sort((a, b) => b.correct - a.correct);

  return {
    games,
    rows,
    finalCount: games.filter((g) => g.status === 'final').length,
    totalGames: games.length,
  };
}

module.exports = { computeWeek, computeSeasonStandings, computeBoard };
