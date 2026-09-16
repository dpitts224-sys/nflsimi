# NFL Pick 'Em Simulator

A weekly NFL pick 'em app for a group of friends/family, replacing the
Google Sheet workflow. Each week everyone picks the winner of every game,
guesses the combined total points of the Monday Night game as a tiebreaker,
and the app automatically figures out who had the most correct picks (and
who wins the week if there's a tie).

## Features

- **Auto-loaded schedule & scores** — pulls each week's matchups and final
  scores from ESPN's public scoreboard, no manual data entry.
- **Pick 'em, one sheet per player** — everyone picks their name and clicks a
  winner for each game. Each player has exactly one set of picks per week
  (enforced by the database, not just the UI), and it's locked in — including
  the tiebreaker — the moment the week's *first* game kicks off, not
  game-by-game. That means you can't wait to see Sunday's early games before
  picking the late ones.
- **Winner Board** — an optional shared view where everyone can see the
  whole group's picks side-by-side, correct/incorrect highlighted as games
  finish. It's only visible once the week is locked (so it can never leak an
  unlocked pick), and it updates in real time for everyone watching — no
  refresh needed — as people pick and as scores come in.
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
   their Monday Night total-points guess — before the week's first game
   kicks off, since that's when everything locks.
3. Once locked, anyone can open the **Winner Board** tab to see the whole
   group's picks together, live.
4. As games finish, re-sync the week (Admin tab) to pull final scores —
   the **Results** tab and the **Winner Board** update automatically:
   correct-pick counts, the week's winner(s), and the pot split.
5. The **Season Standings** tab tracks weekly wins and total correct picks
   across the whole season.

Tie-breaking rule: the player(s) with the most correct picks wins the week.
If multiple players tie on correct picks, whoever's Monday Night total-point
guess is closest to the actual combined score wins. If it's still tied, the
pot is split evenly among the remaining tied players.

## Deploying so everyone can reach it

### Option A: Render (easiest, free, no credit card)

This repo includes a `render.yaml` blueprint, so deploying is a few clicks:

1. Click **Deploy to Render**:
   [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dpitts224-sys/nflsimi/tree/claude/nfl-pick-em-simulator-0fwee9)
2. Sign in to Render (or create a free account) and connect your GitHub —
   Render will read `render.yaml` and pre-fill everything.
3. When it asks for the `ADMIN_PASSWORD` environment variable, set it to
   something only you know.
4. Click **Apply** / **Create Web Service**. In a minute or two you'll get a
   live URL like `https://nfl-pick-em-xxxx.onrender.com` — that's the link
   to share with the group.

Two things worth knowing about Render's free tier:
- The service **spins down after 15 minutes of no traffic** and takes a
  few seconds to wake back up on the next visit — a non-issue for a
  once-a-week pool, just don't be surprised by a slow first load.
- The free tier has no persistent disk, so `data.sqlite` survives restarts
  and sleep/wake cycles, but is **wiped on a new deploy** (i.e. whenever
  this code is updated and redeployed). For a single season this is
  usually fine since you won't be redeploying mid-season; if you want data
  to survive redeploys too, add a $1/mo 1GB disk in the Render dashboard
  (Settings → Disks) and set the `DB_PATH` env var to a path under it.

If you'd rather not use the button, the manual steps are: on render.com,
**New → Web Service**, connect the `dpitts224-sys/nflsimi` repo, build
command `npm install`, start command `npm start`, add the `ADMIN_PASSWORD`
env var.

### Option B: your own always-on machine

Just run `npm start` there and share the machine's address, or set up a
free tunnel like [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
or [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) so the group can
reach it from outside your network. Data lives on real disk here, so
nothing ever gets wiped.

### Option C: another host (Railway, Fly.io, etc.)

Works the same way anywhere Node runs: point the host at this repo, set
`ADMIN_PASSWORD`, build with `npm install`, start with `npm start`, and
attach persistent storage if the platform supports it (needed for
`data.sqlite` to survive restarts/redeploys long-term).

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
