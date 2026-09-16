const { run } = require('./db');

const SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

function easternWeekday(iso) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
  }).format(new Date(iso));
}

// seasontype: 1 = preseason, 2 = regular season, 3 = postseason
async function fetchWeek(season, week, seasontype = 2) {
  const url = `${SCOREBOARD_URL}?year=${season}&week=${week}&seasontype=${seasontype}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ESPN scoreboard request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const events = data.events || [];

  const parsed = events.map((event) => {
    const comp = event.competitions[0];
    const home = comp.competitors.find((c) => c.homeAway === 'home');
    const away = comp.competitors.find((c) => c.homeAway === 'away');
    const completed = comp.status?.type?.completed === true;
    const state = comp.status?.type?.state; // 'pre' | 'in' | 'post'
    const status = completed ? 'final' : state === 'in' ? 'in_progress' : 'scheduled';

    const homeScore = home.score !== undefined ? Number(home.score) : null;
    const awayScore = away.score !== undefined ? Number(away.score) : null;
    let winnerAbbr = null;
    if (status === 'final' && homeScore !== null && awayScore !== null) {
      if (homeScore > awayScore) winnerAbbr = home.team.abbreviation;
      else if (awayScore > homeScore) winnerAbbr = away.team.abbreviation;
      // a tie leaves winnerAbbr null; nobody gets credit for that game
    }

    return {
      espnId: event.id,
      kickoff: event.date,
      homeTeam: home.team.displayName,
      awayTeam: away.team.displayName,
      homeAbbr: home.team.abbreviation,
      awayAbbr: away.team.abbreviation,
      status,
      homeScore,
      awayScore,
      winnerAbbr,
    };
  });

  // Determine the Monday Night game: the Monday game with the latest kickoff.
  const mondayGames = parsed.filter((g) => easternWeekday(g.kickoff) === 'Monday');
  let mnfEspnId = null;
  if (mondayGames.length > 0) {
    mnfEspnId = mondayGames.reduce((latest, g) =>
      new Date(g.kickoff) > new Date(latest.kickoff) ? g : latest
    ).espnId;
  }

  for (const g of parsed) {
    await run(
      `INSERT INTO games (
         season, week, espn_id, home_team, away_team, home_abbr, away_abbr,
         kickoff, status, home_score, away_score, winner_abbr, is_mnf
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(espn_id) DO UPDATE SET
         kickoff = excluded.kickoff,
         status = excluded.status,
         home_score = excluded.home_score,
         away_score = excluded.away_score,
         winner_abbr = excluded.winner_abbr,
         is_mnf = excluded.is_mnf`,
      [
        season,
        week,
        g.espnId,
        g.homeTeam,
        g.awayTeam,
        g.homeAbbr,
        g.awayAbbr,
        g.kickoff,
        g.status,
        g.homeScore,
        g.awayScore,
        g.winnerAbbr,
        g.espnId === mnfEspnId ? 1 : 0,
      ]
    );
  }

  return parsed.length;
}

module.exports = { fetchWeek };
