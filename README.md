# NFL Pick 'Em Simulator

A weekly NFL pick 'em app for a group of friends/family, replacing the
Google Sheet workflow. Each week everyone picks the winner of every game,
guesses the combined total points of the Monday Night game as a tiebreaker,
and the app automatically figures out who had the most correct picks (and
who wins the week if there's a tie).

The app supports many independent pools on one deployment: anyone can spin
up a **group**, gets a short shareable **code**, and only people with that
code see that group's players/picks/standings. Real NFL schedules and
scores are shared across every group (no reason to duplicate public data),
but everything else - who's playing, who picked what, the season standings
- is scoped to your group alone.

## Features

- **Self-service groups** — anyone visiting the site can create a group
  (name + admin password) and gets back a 6-character code. Share that code
  and a link to the site with your friends.
- **Self-service players, one sheet per name** — friends join by entering
  the group code and typing their own name; no admin has to add them.
  Each player has exactly one set of picks per week (enforced by the
  database), and it's locked in — including the tiebreaker — the moment the
  week's *first* game kicks off, not game-by-game. That means you can't
  wait to see Sunday's early games before picking the late ones.
- **Auto-loaded schedule & scores** — pulls each week's matchups and final
  scores from ESPN's public scoreboard, no manual data entry.
- **Winner Board** — a shared, real-time view where everyone in the group
  can see the whole group's picks side-by-side, correct/incorrect
  highlighted as games finish. It's only visible once the week is locked
  (so it can never leak an unlocked pick), and updates live for everyone
  watching — no refresh needed — as people pick and as scores come in.
- **Monday Night tiebreaker** — a dedicated box to guess the combined total
  points of the Monday night game; used to break ties on correct-pick count.
- **Weekly results** — correct-pick counts per player, the week's winner(s),
  and an even pot split if you use a buy-in.
- **Season standings** — cumulative weekly wins and total correct picks.
- **Simple admin panel** — set the current season/week and buy-in, sync a
  week's games, and remove players — protected by that group's own admin
  password (set when the group was created).

## Running it

Requires Node.js 18+ and a Postgres database (a free one from
[neon.tech](https://neon.tech) works well - see **Deploying** below for
the full walkthrough).

```bash
npm install
cp .env.example .env   # then paste your DATABASE_URL in
npm start
```

Open http://localhost:3000. There's no admin password to configure up
front - each group sets its own when it's created.

## Weekly workflow

1. Whoever's running the pool opens the site, clicks **"Create a group"**,
   names it, and sets an admin password. They get back a short code (e.g.
   `AB3XQZ`) - **share that code plus the site link** with the group.
2. Everyone else opens the link, enters the code, and types their own name
   to join - no admin setup needed per player.
3. **Admin tab** (the creator is logged in automatically; anyone else can
   log in with the group's admin password): set the current Season/Week,
   click **"Sync this week from ESPN"** to pull in that week's games (the
   Monday Night game is detected automatically).
4. Everyone clicks a winner for each game and fills in their Monday Night
   total-points guess — before the week's first game kicks off, since
   that's when everything locks.
5. Once locked, anyone in the group can open the **Winner Board** tab to
   see the whole group's picks together, live.
6. As games finish, re-sync the week (Admin tab) to pull final scores —
   the **Results** tab and the **Winner Board** update automatically:
   correct-pick counts, the week's winner(s), and the pot split.
7. The **Season Standings** tab tracks weekly wins and total correct picks
   across the whole season.

Tie-breaking rule: the player(s) with the most correct picks wins the week.
If multiple players tie on correct picks, whoever's Monday Night total-point
guess is closest to the actual combined score wins. If it's still tied, the
pot is split evenly among the remaining tied players.

## Deploying so everyone can reach it

The app itself runs on Render's free tier, but its data lives in a
**separate, genuinely persistent Postgres database** (a free one from
Neon) rather than a local file. This matters: Render's free web services
don't just sleep after 15 minutes of inactivity, they spin back up on a
**fresh container** on the next visit - anything written to local disk
(like a SQLite file) is gone at that point. A real database elsewhere
doesn't have that problem.

### Step 1: create a free Neon Postgres database

1. Go to [neon.tech](https://neon.tech) and create a free account/project
   (no credit card required).
2. Once the project's created, copy its **connection string** (Neon shows
   this on the project dashboard - it looks like
   `postgres://user:password@ep-xxxx.neon.tech/neondb?sslmode=require`).
   Keep this handy for the next step.

### Step 2: deploy the app to Render

This repo includes a `render.yaml` blueprint:

1. Click **Deploy to Render**:
   [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dpitts224-sys/nflsimi/tree/claude/nfl-pick-em-simulator-0fwee9)
2. Sign in to Render (or create a free account) and connect your GitHub —
   Render will read `render.yaml` and pre-fill everything.
3. When it asks for the `DATABASE_URL` environment variable, paste in the
   Neon connection string from Step 1.
4. Click **Apply** / **Create Web Service**. In a minute or two you'll get a
   live URL like `https://nfl-pick-em-xxxx.onrender.com` — open it, create
   your group, and share the link + your group's code with everyone.

One thing worth knowing about Render's free tier: the service still spins
down after 15 minutes of no traffic and takes a few seconds to wake back
up on the next visit. That's harmless now (your data isn't going anywhere)
- just don't be surprised by a slow first load once in a while.

If you'd rather not use the button, the manual steps are: on render.com,
**New → Web Service**, connect the `dpitts224-sys/nflsimi` repo, build
command `npm install`, start command `npm start`, add the `DATABASE_URL`
env var.

### Alternative: your own always-on machine

Run `npm start` there (pointed at any Postgres, including one running
locally) and share the machine's address, or set up a free tunnel like
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
or [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) so the group
can reach it from outside your network.

### Alternative: another host (Railway, Fly.io, etc.)

Works the same way anywhere Node runs: point the host at this repo, build
with `npm install`, start with `npm start`, and set `DATABASE_URL` to your
Neon (or other Postgres) connection string.

## Notes / things you may want to tweak

- **Picks and the tiebreaker lock for good once the week's first game
  kicks off** - enforced entirely server-side (the server independently
  re-derives lock status from the real kickoff time on every request), so
  there's no client-side trick that reopens it.
- **Each player gets a private passcode** when they join (shown once) that's
  required to submit or view their own not-yet-locked picks - so nobody in
  the group can pick, peek at picks early, or otherwise act as another
  player just by knowing their name (which is otherwise public within the
  group). Browsers remember it automatically after joining; typing the same
  name + passcode again on a different device restores access there too, and
  doesn't invalidate it anywhere else. There's still no *admin*-level login
  per player, by design - joining and picking stays a one-field "what's your
  name?" for the common case.
- Losing a passcode means losing that identity - there's no recovery besides
  an admin removing that player so they can rejoin fresh (which resets their
  picks). Not a concern season-to-season since nothing needs re-entering
  once you're in, but worth knowing.
- Once someone's created or joined a group in their browser, reopening the
  same link remembers their group and name (via localStorage) - "Switch
  group" in the top bar clears that if they need to join a different pool.
- The ESPN endpoint is a public, unauthenticated JSON API ESPN uses for
  their own scoreboard pages. It's not an official/documented API, so if
  ESPN ever changes its response shape the sync could need a small update
  in `server/espn.js`.
- Season type defaults to regular season (`seasontype=2`). Postseason weeks
  would need `seasontype=3` — easiest way to handle that today is passing
  `{"seasontype": 3}` in the sync request body (the Admin UI only exposes
  regular season sync, but the API supports it).
