# auto_magnet

A self-hosted dashboard that automatically finds, scores, and downloads torrents for your movies and TV shows. It watches TMDB for new episodes, searches Prowlarr and EZTV, picks the best match, and pushes the magnet link straight to your Transmission instance — no manual searching required.

---

## Features

- **Automatic episode tracking** — follows airing schedules from TMDB, grabs episodes as soon as they air
- **Multi-source search** — queries Prowlarr (all your indexers), EZTV, and YTS in parallel
- **Smart torrent scoring** — ranks results by quality, seeders, release group, and source type; rejects cams, screeners, and season packs
- **Manual mode** — browse and approve the top 5 candidates yourself before any download starts
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

Advanced settings (UI only, not in `.env`):

| Setting | Default | Description |
|---|---|---|
| Air date buffer | `4h` | Hours after a listed air date before the scheduler attempts a grab |
| Scheduler interval | `60 min` | How often the scheduler runs |
| Min file size | `200 MB` | Reject torrents smaller than this |
| Max file size | `60 GB` | Reject torrents larger than this |
| Strict quality | off | Only accept results that exactly match the preferred quality |
| Blocked tags | — | Comma-separated keywords to always reject in torrent titles |
| TMDB region | `US` | Region used for movie digital release dates |

---

## Usage

### Movies

1. Click **+ Add Movie**, search by title, select from the TMDB results.
2. Choose quality and mode (auto / manual), then confirm.
3. The scheduler will look for a torrent on its next run (or immediately if triggered manually). In auto mode the best result is added to Transmission straight away. In manual mode a **Browse** button appears — click it to see the top 5 candidates and pick one.

### Shows

1. Click **+ Add Show**, search, select.
2. Choose the season and episode to start from (useful if you already have early seasons), quality, and mode.
3. The scheduler grabs episodes as they air. Multiple simultaneously-released episodes are all picked up in a single run.
4. Click a show card to open the manage dialog where you can:
   - **Redo** — reset an episode to pending so it gets re-grabbed
   - **Skip** — mark an episode as skipped so the scheduler advances past it
   - **Refresh TMDB** — re-sync all air dates and insert any missing episodes
   - **Add episode manually** — insert a specific S/E as pending when TMDB data is incomplete

### Scheduler

The scheduler runs automatically on the configured interval. You can also trigger a run instantly from the Settings page with **Run Now**. The scheduler:

- Grabs all aired, not-yet-downloaded episodes in a single pass (up to 15 per show)
- Uses smarter air date inference: if episode 5 has a confirmed past air date, episodes 1–4 are treated as aired even if TMDB hasn't populated their individual dates
- Populates a 60-day upcoming timeline so future episodes appear in the Timeline view before they air
- Monitors active downloads in Transmission and marks them done on completion
- Automatically retries stale downloads (stuck for more than 24 hours) with the next best result

---

## Updating

### Docker deployment

```bash
git pull

# Rebuild the frontend
npm run build:client

# Rebuild and restart the container
npm run docker:build
npm run docker:up
```

Only `auto-magnet` needs rebuilding; Prowlarr can stay running:

```bash
docker compose build auto-magnet
docker compose up -d auto-magnet
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
│       └── timeline.js
├── client/               # Vue 3 frontend (Vite)
│   ├── public/
│   │   └── favicon.png
│   ├── src/
│   │   ├── views/        # Movies, Shows, Settings, Timeline
│   │   └── components/
│   └── dist/             # Built SPA — served by Express in production
├── .env.example
├── docker-compose.yml
└── package.json
```
