# auto_magnet

A self-hosted dashboard that automatically finds, scores, and downloads torrents for your movies and TV shows. It watches TMDB for new episodes, searches Prowlarr and EZTV, picks the best match, and pushes the magnet link straight to your Transmission instance — no manual searching required.

---

## Features

- **Automatic episode tracking** — follows airing schedules from TMDB, grabs episodes as soon as they air
- **Multi-source search** — queries Prowlarr (all your indexers), EZTV, and YTS in parallel
- **Smart torrent scoring** — ranks results by quality, seeders, release group, source type, codec and audio; rejects cams, screeners, season packs, and releases that aren't actually the title you asked for
- **Content screening** — every release is judged on its real file list before anything downloads: executables, crack/keygen folders, password-protected archives, double extensions, and videos too small for their claimed quality are rejected
- **Manual mode** — browse and approve ranked candidates yourself; every row is already resolved to a magnet, so picking one starts the download immediately
- **Packs** — optional per show: grab a complete series or a whole season in one torrent instead of episode by episode, which for older shows is often the only thing still well seeded
- **Multiple Transmission instances** — route individual movies or shows to different servers
- **Activity log** — every search, grab, rejection and failure, with filters, so "why didn't this download?" has an answer
- **Timeline view** — see upcoming releases across all tracked shows and movies at a glance
- **Retry & recovery** — stale downloads are automatically reset and retried with the next best result
- **Per-item settings** — override quality (4K / 1080p / 720p), auto vs manual mode per movie or show
- **TMDB refresh** — re-sync episode air dates on demand and insert any episodes TMDB was missing
- **Manual episode insert** — add a specific S/E directly when TMDB data is incomplete

---

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Frontend | Vue 3 + Vite |
| Database | SQLite (WAL mode, built-in `node:sqlite`) |
| Metadata | TMDB API |
| Torrent search | Prowlarr · EZTV · YTS |
| Downloader | Transmission (via RPC) |
| Container | Docker + Docker Compose |

---

## Prerequisites

- **Transmission** running somewhere on your network with RPC enabled
- **Prowlarr** with at least one indexer configured (or use the bundled Docker Compose which runs Prowlarr for you)
- A free **TMDB API key** — [get one here](https://www.themoviedb.org/settings/api)

---

## Setup

### Option A — Docker Compose (recommended)

This runs Prowlarr and auto_magnet together. Transmission lives on your existing network.

**1. Clone and configure**

```bash
git clone <repo-url> auto_magnet
cd auto_magnet
cp .env.example .env
```

Edit `.env`:

```env
# Your Transmission instance
TRANSMISSION_HOST=192.168.1.x
TRANSMISSION_PORT=9091
TRANSMISSION_USER=youruser
TRANSMISSION_PW=yourpassword

# Paths as Transmission sees them on its own filesystem
MOVIEPATH=/path/to/movies
SHOWSPATH=/path/to/shows

# TMDB API key
TMDB_API_KEY=your_key_here

# Prowlarr API key — leave blank for first boot (see step 3)
PROWLARR_API_KEY=

# Dashboard port
AMAGNET_PORT=62201

# Linux user for Prowlarr container — run `id` to find yours
PUID=1000
PGID=1000
TZ=Europe/Amsterdam
```

**2. Build and start**

```bash
npm run build:client       # builds the Vue frontend into client/dist
npm run docker:build       # builds the auto_magnet Docker image
npm run docker:up          # starts prowlarr + auto_magnet
```

**3. Configure Prowlarr**

Open `http://host:9696`, finish the setup wizard, and add your indexers. Then:

- Go to **Settings → General** and copy the API key
- Paste it as `PROWLARR_API_KEY` in `.env`
- Restart only the auto_magnet container:

```bash
docker compose up -d auto-magnet
```

**4. Open the dashboard**

`http://host:62201`

Go to **Settings** and verify the Transmission connection. You're ready.

---

### Option B — Bare metal (development / local)

```bash
git clone <repo-url> auto_magnet
cd auto_magnet
cp .env.example .env   # fill in your values

npm install
npm run build:client   # build the Vue SPA once

npm start              # starts the server on the configured port
```

For live-reload during backend development:

```bash
npm run dev            # runs server with --watch (Node.js 18.11+)
```

For frontend development with hot module replacement:

```bash
# In one terminal — backend
npm run dev

# In another terminal — Vite dev server (proxies /api to the backend)
cd client && npm run dev
```

The Vite dev server runs on port 5173 by default and proxies all `/api` calls to `localhost:62201`.

---

## Configuration reference

All settings can be changed at runtime from the **Settings** page in the UI. The `.env` file only seeds defaults on the very first run — after that, values are stored in the SQLite database and `.env` changes have no effect unless you clear the database.

| Setting | Default | Description |
|---|---|---|
| `TRANSMISSION_HOST` | `localhost` | Hostname or IP of your Transmission instance |
| `TRANSMISSION_PORT` | `9091` | Transmission RPC port |
| `TRANSMISSION_USER` | — | Transmission RPC username (if auth is enabled) |
| `TRANSMISSION_PW` | — | Transmission RPC password |
| `MOVIEPATH` | — | Download directory for movies (as Transmission sees it) |
| `SHOWSPATH` | — | Download directory for shows (as Transmission sees it) |
| `TMDB_API_KEY` | — | TMDB v3 API key |
| `PROWLARR_API_KEY` | — | Prowlarr API key |
| `PROWLARR_HOST` | `localhost` | Prowlarr hostname |
| `PROWLARR_PORT` | `9696` | Prowlarr port |
| `MIN_SEEDS` | `10` | Minimum seeders required to consider a result |
| `DEFAULT_QUALITY` | `1080p` | Preferred quality: `2160p`, `1080p`, or `720p` |
| `AMAGNET_PORT` | `62201` | Port the dashboard listens on |
| `AMAGNET_NO_SCHEDULER` | `0` | Set to `1` to start with the scheduler off — nothing is searched for or sent to Transmission, and `POST /api/scheduler/run` returns 503 |

Advanced settings (UI only, not in `.env`):

| Setting | Default | Description |
|---|---|---|
| Air date buffer | `4h` | Hours after a listed air date before the scheduler attempts a grab |
| Scheduler interval | `60 min` | How often the scheduler runs |
| Min file size | `200 MB` | Reject torrents smaller than this |
| Max file size | `60 GB` | Reject torrents larger than this |
| Strict quality | off | Only accept results that exactly match the preferred quality |
| Reuse results for | `20 min` | How long a search stays reusable, so reopening the picker is instant |
| Title match strictness | `0.7` | Share of the requested title's words a release must contain |
| Allow disc images | off | Permit `.iso` / `.img` releases, whose contents cannot be screened |
| Unverifiable magnets | start | Whether to start or delete a magnet whose file list never arrives |
| Extra Transmission instances | — | Named servers, selectable per movie or show with "Download to" |
| Blocked tags | — | Comma-separated keywords to always reject in torrent titles |
| TMDB region | `US` | Region used for movie digital release dates |

---

## Usage

### Movies

1. Click **+ Add Movie**, search by title, select from the TMDB results.
2. Choose quality and mode (auto / manual), then confirm.
3. The scheduler will look for a torrent on its next run (or immediately if triggered manually). In auto mode the best result is added to Transmission straight away. In manual mode a **Browse** button appears — click it to see the ranked candidates and pick one.

### Shows

1. Click **+ Add Show**, search, select.
2. Choose the season and episode to start from (useful if you already have early seasons), quality, and mode.
3. The scheduler grabs episodes as they air. Multiple simultaneously-released episodes are all picked up in a single run.
4. Click a show card to open the manage dialog where you can:
   - **Redo** — reset an episode to pending so it gets re-grabbed
   - **Skip** — mark an episode as skipped so the scheduler advances past it
   - **Refresh TMDB** — re-sync all air dates and insert any missing episodes
   - **Choose…** — pick a release for one episode by hand, without switching the whole show to manual mode
   - **Prefer season packs** — grab the whole season in one torrent when every episode of it is still outstanding and the season has finished airing
   - **Download to** — send this show to a different Transmission instance
   - **Add episode manually** — insert a specific S/E as pending when TMDB data is incomplete

### Scheduler

The scheduler runs automatically on the configured interval. You can also trigger a run instantly from the Settings page with **Run Now**. The scheduler:

- Grabs all aired, not-yet-downloaded episodes in a single pass (up to 15 per show)
- Uses smarter air date inference: if episode 5 has a confirmed past air date, episodes 1–4 are treated as aired even if TMDB hasn't populated their individual dates
- Populates a 60-day upcoming timeline so future episodes appear in the Timeline view before they air
- Monitors active downloads in Transmission and marks them done on completion
- Automatically retries stale downloads (stuck for more than 24 hours) with the next best result

---

## How a grab works

Searching every indexer through Prowlarr takes tens of seconds, and turning an
indexer's download URL into a magnet costs another round trip per result. Both
are done once, up front:

1. **Search** all applicable sources. Responses are cached for 20 minutes
   (configurable) and concurrent callers share one request, so the scheduler and
   the UI never search the same thing twice.
2. **Filter and score** the raw results — wrong title, wrong episode, cam source,
   implausible size for the claimed quality, blocked tags, too few seeders.
3. **Resolve magnets** for the shortlist only, not for all 50+ raw results.
4. **Screen contents** on anything whose `.torrent` could be parsed.

Everything that reaches the picker therefore already has a magnet, so clicking
**Grab** hands it to Transmission immediately and returns. For magnet-only
results, whose file list nobody can see until the metadata arrives, the torrent
is added paused and screening continues in the background; if it turns out to be
a dropper the torrent is purged and the item is flagged with the reason.

### Running a test or demo instance

A server started against a database that contains auto-mode items **will grab them** — that is
what it is for — using whatever Transmission host and download paths its settings name. A
database created fresh seeds those settings from `.env`, so a throwaway instance started next
to a real `.env` is pointed at the real Transmission and the real disks. EZTV needs no API key,
so this happens even with no Prowlarr configured.

Start any test instance with the scheduler off:

\`\`\`bash
AMAGNET_NO_SCHEDULER=1 DB_PATH=/tmp/test.db node server/index.js
\`\`\`

Isolating the database is not enough on its own — it isolates the records, not the side effects.

---

## Choosing a torrent by hand

**Browse** (manual mode) and **Choose…** (per episode) open the same picker. Every row in it
already has a magnet, so clicking **Grab** hands it to Transmission and returns immediately —
no second trip to any indexer.

- The header says whether the list was **reused** and how old it is. **Refresh** re-queries the
  indexers.
- **Filtered out** lists everything that was rejected and why — wrong episode, cam source,
  400 MB claiming to be 2160p, contains an executable.
- The search box runs a **literal query against Prowlarr**, skipping the title and episode
  checks entirely. This is the escape hatch for anime, foreign titles, alternate cuts, and
  anything the canonical TMDB name doesn't find. Clearing the box restores the automatic list.
- ↑ ↓ moves, Enter grabs, and ⧉ copies the magnet.

---

## Packs

Off by default. Enable **Prefer packs** per show, in the Add dialog or the manage dialog. The
scheduler then tries the biggest sensible unit first and falls back:

**1. The complete series.** Only for a show TMDB reports as Ended or Cancelled where *every*
episode of *every* season is still outstanding — a back catalogue being picked up from
scratch, which is exactly what a "Complete Series" release exists for. This is the case that
matters most for older shows: the individual episodes of something that finished a decade ago
are usually dead, while the complete run is one healthy torrent.

**2. A season at a time.** For any season where every episode is `pending`, `skipped` or
`failed`, at least two are pending, and nothing is still `upcoming` — a season mid-flight has
no complete pack yet.

**3. Individual episodes**, as normal, for whatever the packs didn't cover.

Packs are only ever used where they cover episodes you don't already have, so nothing gets
re-downloaded. A `failed` episode doesn't block a pack but isn't revived by one either — use
**Redo** or **Retry Failed** for those.

### How a pack is checked

A pack is not just a bigger download, and the normal filters would throw every one of them out,
so three things change:

- **Size limits are read per episode.** A 180 GB complete series is 3 GB an episode, which is
  what the min/max size settings are actually about. Judging the total against a single-item
  cap would reject every pack there is.
- **The season coverage is verified.** "S01-S03" is rejected for a five-season show, naming the
  seasons it misses.
- **The file list is counted.** A title can only *claim* to be complete. Where the `.torrent`
  could be parsed, a pack must actually contain at least 90% of the expected episodes — this is
  what catches a well-seeded "Complete Series" that turns out to be half the show. It matters
  because the episodes a pack covers are marked as handled, so a short pack leaves a hole
  nothing goes back for.

Content screening is unchanged: a pack carrying an executable is rejected like anything else.

---

## Multiple Transmission instances

The **Transmission** settings block describes the default instance. Add more under **Extra
Transmission instances**, give each a name, then pick one per item with **Download to** — in
the Add dialog, in a show's manage dialog, or in a movie's details dialog. Items with nothing
chosen use the default.

Torrent ids restart at 1 on every instance, so auto_magnet tracks each download by
instance *and* id. An instance that is unreachable is reported as such and skipped; it does not
hold up the others. Deleting an instance that items still point at is safe — they fall back to
the default.

---

## Activity log

The **Activity** page records every search, grab, rejection, screen verdict and failure, with
level and item-type filters. It is written to the database as well as stdout, so it survives a
restart. Entries older than 30 days are pruned at the end of each scheduler run.

---

## Updating

### Docker deployment

```bash
git pull
docker compose build auto-magnet
docker compose up -d auto-magnet
```

Only `auto-magnet` needs rebuilding — Prowlarr and FlareSolverr can stay running. There is no
need to build the frontend first: the Dockerfile builds it in its own stage, and `client/dist`
is excluded by `.dockerignore` anyway.

Back the database up first. It lives in the `auto-magnet-data` volume, and `docker cp` works
while the container is running:

```bash
docker cp auto-magnet:/data/auto_magnet.db ./auto_magnet.db.bak
```

### Bare metal

```bash
git pull
npm install                # pick up any new backend dependencies
npm run build:client       # rebuild the frontend
npm start                  # or restart your process manager (pm2 restart auto_magnet, etc.)
```

Database schema migrations run automatically on every startup — no manual SQL needed.

---

## Project structure

```
auto_magnet/
├── server/
│   ├── index.js          # Express server, static file serving
│   ├── db.js             # SQLite schema, migrations, query helpers
│   ├── scheduler.js      # Main automation loop
│   ├── tmdb.js           # TMDB API client
│   ├── selector.js       # Torrent scoring and selection
│   ├── pipeline.js       # Search → filter → resolve magnets → screen
│   ├── screen.js         # Content screening of torrent file lists
│   ├── search-cache.js   # Short-lived source-search reuse
│   ├── log.js            # Activity log — stdout plus the database
│   ├── transmission.js   # Transmission RPC client
│   ├── sources/
│   │   ├── prowlarr.js   # Multi-indexer search
│   │   ├── eztv.js       # Show torrent fallback
│   │   └── yts.js        # Movie torrent fallback
│   └── api/
│       ├── movies.js
│       ├── shows.js
│       ├── search.js
│       ├── settings.js
│       ├── timeline.js
│       └── log.js
├── client/               # Vue 3 frontend (Vite)
│   ├── public/
│   │   └── favicon.png
│   ├── src/
│   │   ├── views/        # Movies, Shows, Activity, Settings
│   │   └── components/
│   └── dist/             # Built SPA — served by Express in production
├── .env.example
├── docker-compose.yml
└── package.json
```
