# NFL Pick 'Em Simulator

A weekly NFL pick 'em app for a group of friends/family, replacing the
Google Sheet workflow. Each week everyone picks the winner of every game,
guesses the combined total points of the Monday Night game as a tiebreaker,
and the app automatically figures out who had the most correct picks (and
who wins the week if there's a tie).

## Features

- **Auto-loaded schedule & scores** — pulls each week's matchups and final
  scores from ESPN's public scoreboard, no manual data entry.
- **Pick 'em** — everyone clicks the team they think will win each game.
  Picks lock automatically at kickoff, and other players' picks stay hidden
  until their game locks (so nobody can copy).
- **Monday Night tiebreaker** — a dedicated box to guess the combined total
  points of the Monday night game; used to break ties on correct-pick count.
- **Weekly results** — correct-pick counts per player, the week's winner(s),
  and an even pot split if you use a buy-in.
- **Season standings** — cumulative weekly wins and total correct picks.
- **Simple admin panel** — add/remove players, set the current season/week,
  set the buy-in, and sync a week's games — protected by a single shared
  admin password (no accounts needed for players).

## Running it

Requires Node.js 18+.

```bash
npm install
cp .env.example .env   # then edit ADMIN_PASSWORD in .env
npm start
```

Open http://localhost:3000. Data is stored in a local `data.sqlite` file
(created automatically).

To have it pick up your `.env` file, either use a process manager that
loads it (pm2, systemd `EnvironmentFile=`, Docker `--env-file`, your host's
"environment variables" settings) or export the vars manually:

```bash
ADMIN_PASSWORD=your-password PORT=3000 npm start
```

## Weekly workflow

1. **Admin tab**: set the current Season/Week, click **"Sync this week from
   ESPN"** to pull in that week's games (the Monday Night game is detected
   automatically).
2. Share the link with the group. Everyone picks their name from the
   dropdown in the top bar and clicks a winner for each game, plus fills in
   their Monday Night total-points guess.
3. As games finish, re-sync the week (Admin tab) to pull final scores —
   the **Results** tab updates automatically: correct-pick counts, the
   week's winner(s), and the pot split.
4. The **Season Standings** tab tracks weekly wins and total correct picks
   across the whole season.

Tie-breaking rule: the player(s) with the most correct picks wins the week.
If multiple players tie on correct picks, whoever's Monday Night total-point
guess is closest to the actual combined score wins. If it's still tied, the
pot is split evenly among the remaining tied players.

## Deploying so everyone can reach it

This is a small single-process Node app with a local SQLite file, so it
runs anywhere Node runs:

- **A free web host** (e.g. Render, Railway, Fly.io): point it at this repo,
  set the `ADMIN_PASSWORD` environment variable, run `npm install && npm
  start`, and attach a small persistent disk/volume so `data.sqlite`
  survives restarts/redeploys.
- **A home server / Raspberry Pi / always-on PC**: just run `npm start`
  there and share the machine's address (or set up a free tunnel like
  Cloudflare Tunnel or Tailscale so your dad's group can reach it from
  outside your network).

## Notes / things you may want to tweak

- There's no per-player login/password — anyone with the link can select
  any name from the dropdown and pick for them. That matches a low-stakes
  friend group; if you want to lock that down, the easiest addition would
  be a simple PIN per player.
- The ESPN endpoint is a public, unauthenticated JSON API ESPN uses for
  their own scoreboard pages. It's not an official/documented API, so if
  ESPN ever changes its response shape the sync could need a small update
  in `server/espn.js`.
- Season type defaults to regular season (`seasontype=2`). Postseason weeks
  would need `seasontype=3` — easiest way to handle that today is passing
  `{"seasontype": 3}` in the sync request body (the Admin UI only exposes
  regular season sync, but the API supports it).
