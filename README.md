# auto_magnet

A self-hosted dashboard that automatically finds, scores, and downloads torrents for your movies and TV shows. It watches TMDB for new episodes, searches Prowlarr and EZTV, picks the best match, and pushes the magnet link straight to your Transmission instance — no manual searching required.

Then it plays them: in the browser, or on Android with offline downloads, with accounts and per-person progress.

---

## Features

- **Automatic episode tracking** — follows airing schedules from TMDB, grabs episodes as soon as they air
- **Multi-source search** — queries Prowlarr (all your indexers), EZTV, and YTS in parallel
- **Smart torrent scoring** — ranks results by quality, seeders, release group, source type, codec and audio; rejects cams, screeners, season packs, and releases that aren't actually the title you asked for
- **Content screening** — every release is judged on its real file list before it may download: executables, disc images, crack/keygen folders, password-protected or archive-only releases, oversized "text files", and videos too small for their claimed quality are rejected. Magnets wait in a throttled quarantine until their file list can be checked
- **Matching by ID** — asks Prowlarr by IMDb/TMDB id alongside the text search, so a release is confirmed to be *that* film rather than one with the same name; an audio-description release is ranked below any ordinary one
- **Finished-download checks** — opens each completed file and replaces it if it has no video, no audio, or only an audio-description track
- **Subtitles** — fetches subtitles in your language from OpenSubtitles when a release has none, preferring ones timed to your exact file
- **Manual mode** — browse and approve ranked candidates yourself; every row is already resolved to a magnet, so picking one starts the download immediately
- **Packs** — optional per show: grab a complete series or a whole season in one torrent instead of episode by episode, which for older shows is often the only thing still well seeded
- **Multiple Transmission instances** — route individual movies or shows to different servers
- **Activity log** — every search, grab, rejection and failure, with filters, so "why didn't this download?" has an answer
- **Timeline view** — see upcoming releases across all tracked shows and movies at a glance
- **Retry & recovery** — stale downloads are automatically reset and retried with the next best result
- **Per-item settings** — override quality (4K / 1080p / 720p), auto vs manual mode per movie or show
- **TMDB refresh** — re-sync episode air dates on demand and insert any episodes TMDB was missing
- **Manual episode insert** — add a specific S/E directly when TMDB data is incomplete
- **Watch in the browser** — anything that won't play in a browser is repackaged or converted (on the GPU when there is one) into a separate web version, so the original keeps seeding; playback starts while it converts
- **Accounts** — admins run the downloader, viewers only watch; everyone has their own resume points, watched marks, "continue watching" and "next up"
- **Subtitle sync** — fetched subtitles that weren't matched to your exact file are aligned to the audio, including frame-rate drift; the player can nudge, save, auto-sync or restore timing by hand
- **Android app** — browse, stream, and download for offline viewing; progress made offline is merged when the phone is back online

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

The first visit asks you to create the admin account (if `AMAGNET_TOKEN` is set in `.env`, it
asks for that too, so nobody else on the network can claim the server first). Then go to
**Settings** and verify the Transmission connection. You're ready.

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
| `MEDIA_ROOT` | `/HDD0/Shared` | Media folder mounted into the container, at the same path, for finished-download checks and subtitles |
| `AMAGNET_NO_SCHEDULER` | `0` | Set to `1` to start with the scheduler off — nothing is searched for or sent to Transmission, and `POST /api/scheduler/run` returns 503 |
| `AMAGNET_TOKEN` | — | Optional. Required to create the first account, and accepted as an admin bearer token by scripts |
| `WEB_ROOT` | `./web` | Host folder for web versions (mounted at `WEB_PATH=/web` in the container) |
| `RENDER_GID` | — | Numeric `render` group id, for GPU encoding once enabled in `docker-compose.yml` |
| `AMAGNET_TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy, so client addresses and https come from its headers |

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
| Quarantine hold | `24h` | How long a magnet may wait for its file list before it is removed |
| Check finished downloads | on | Probe completed files and fetch missing subtitles |
| When a file is unusable | replace | `replace` deletes and re-grabs; `flag` keeps it and says why |
| Subtitle languages | `en` | 2-letter codes; the first is the one fetched |
| Search again for missing subtitles | `12,24,36,120,240` | Hours after a download at which a search that found nothing is repeated |
| OpenSubtitles API key | — | Required for subtitles (Free consumer tier: 5 downloads/day) |
| OpenSubtitles username / password | — | Optional; raises downloads to 20/day |
| Media path mapping | — | Only if the container sees files under a different path than Transmission |
| Unverifiable magnets | start | Whether to start or delete a magnet whose file list never arrives |
| Extra Transmission instances | — | Named servers, selectable per movie or show with "Download to" |
| Blocked tags | — | Comma-separated keywords to always reject in torrent titles |
| TMDB region | `US` | Region used for movie digital release dates |
| Prepare web versions | as soon as checked | Or only when someone presses play |
| Encoder | automatic | GPU (VAAPI) when available, else libx264 |
| Converted video height | `1080p` | Converted video is scaled down to this; repackaged video is never touched |
| Keep free | `20` GB | Web versions pause while the disk holding them has less free than this, and carry on once there is room. `0` turns it off |
| Align fetched subtitles | on | Sync subtitles not matched by file hash to the audio |
| Remove originals after seeding | never | Or *repackaged only*, or *repackaged and converted* — see [Removing originals after seeding](#removing-originals-after-seeding) |
| … once the ratio reaches | `2` | Upload ratio a torrent must reach first |
| … or after seeding for | `0` days | Remove anyway after this long; `0` = ratio only |

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
- An episode without a date is assumed to air weekly after the nearest dated one before it (or the season premiere). A new season whose later episodes are listed but not yet dated stays *upcoming* instead of being searched every run; a gap in an old season's dates still counts as aired
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
**Grab** hands it to Transmission immediately and returns.

### Quarantine

A magnet has no file list: Transmission only learns what is inside by fetching
the metadata from peers, and **it only talks to peers while a torrent is
running** — a paused torrent never gets its file list. So a magnet is added
running but throttled to 4 kB/s and labelled `amagnet-quarantine` (visible in
the Transmission UI). The metadata — tens of kilobytes — gets through; the
payload effectively doesn't. The throttle and label are applied *before* it is
started, so it never runs at full speed unchecked.

- **Passes the screen** → label removed, throttle lifted, download proceeds.
- **Fails** → removed with its data; the item goes back to pending with that
  release excluded, so the next run picks the next candidate.
- **Metadata still missing** after the two-minute grab-time watch → it simply
  stays quarantined. The sweep at the start of every scheduler run (and at
  startup) checks it again. Nothing is ever released on a timer.
- **Nobody seeding it** for 24 hours (`Quarantine hold` in Settings) → removed.

A grab that turns out to be a **duplicate** of a torrent already in
Transmission is left exactly as it was — it is your existing download, and
nothing screens, pauses or deletes it.

The same sweep also checks anything auto_magnet was tracking as downloading but
had never screened — every magnet grabbed before the quarantine existed. A
failure there **stops** the torrent and flags it on the card; it never deletes,
because those may be partly downloaded or started by hand.

---

## After a download finishes

Screening reads file *names*. Once a download completes, auto_magnet opens the
file with `ffprobe` and reads its actual streams, which catches what no name
can:

| Finding | What happens |
|---|---|
| No video stream | Unusable |
| No audio | Unusable |
| Every audio track is audio description | Unusable |
| An audio-description track *plus* an ordinary one | Fine — the AD track is extra |
| English subtitles embedded, or a `.en.srt` beside it | Nothing to fetch |
| No subtitles in your language | Fetched from OpenSubtitles |

An **unusable** download is deleted and the next candidate grabbed — but only
when auto_magnet added the torrent itself and it covers a single item. A season
pack, or a torrent that was already in Transmission, is only ever flagged on the
card, whatever the setting says. Set **When a file is unusable** to *Keep it* to
flag everything instead.

Only downloads that complete **after this feature is deployed** are checked, so
upgrading doesn't set it loose on your whole library.

### Subtitles

Fetched subtitles are saved beside the video as `<video name>.en.srt` — the
naming Jellyfin and Plex pick up — and owned by the same user as the video. The
search asks first for a subtitle timed to your *exact file* (by its
OpenSubtitles file hash), and only then by IMDb id and season/episode,
preferring one from the same release group. Machine-translated, AI-translated
and forced-only subtitles are excluded.

OpenSubtitles needs an **API key**, which identifies the application: create a
free account at opensubtitles.com and add an API consumer on the **Free** tier.
Your **login is optional** but worth adding — it raises the limit:

| Setup | Downloads per day |
|---|---|
| API key only | 5 |
| API key + free account | 20 |

Searching doesn't count, only downloads, and the counters reset at midnight UTC.
20 a day covers new episodes comfortably; a backfilled season pack takes a day
or two.

**Something that has only just come out** often has no subtitles yet. A search that finds
nothing is repeated **12, 24, 36, 120 and 240 hours** after the download completed (Settings →
*Search again for missing subtitles*); the card says when the next try is. A try missed while
the server was down is made once when it is back, not once per missed point, and items whose
last try passed more than two days ago — the back catalogue, on the first run after upgrading —
aren't retried. Remove originals after seeding waits for these tries, so a subtitle found late
still has a video to sit beside.

The free consumer tier also allows **5 requests per second**. auto_magnet paces
itself to 4, waits out any `429`, logs in once a day, and — once the day's
downloads are spent — sends nothing more at all, searches included, until the
reset. That state is kept in the database, so a restart doesn't spend requests
rediscovering it. A rejected login is not retried for a day.

### Setup

The check needs `ffprobe` (included in the Docker image) and the media folder
mounted into the container **at the same path Transmission uses**. Set
`MEDIA_ROOT` in `.env` to the folder that holds your movie and show paths:

```bash
MEDIA_ROOT=/HDD0/Shared
```

If the container has to see the files under a different path, set **Media path
mapping** in Settings, e.g. `/HDD0/Shared=>/media`. A file that stays
unreachable for a day is marked as skipped, with the reason on the card.

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

## Show folders

Each show is downloaded into a folder named after it, made safe for Windows: the
library is shared over Samba, and Windows forbids `\ / : * ? " < > |` in a name
and drops trailing dots and spaces. Samba shows such a folder to Windows clients
under a scrambled stand-in like `A9VK1B~E`, which is what *Avatar: Seven
Havens* used to look like. A colon now becomes a dash, the way Sonarr does it:

| Title | Folder |
|---|---|
| Avatar: Seven Havens | Avatar - Seven Havens |
| Re:Zero | Re-Zero |
| Love/Hate | Love-Hate |
| What If...? | What If |

Older folders don't follow that, and some shows were also split across two
folders whose names differ only in case (`House of the Dragon` and
`house of the dragon`). **Settings → Show folders → Check show folders** lists
every such folder and what moving it involves. Nothing moves until you press
**Move** on a row, and then:

- torrent data is moved by Transmission itself, so it keeps seeding;
- everything else follows — fetched subtitles, files added by hand, and old
  downloads whose torrents have since been removed;
- nothing is ever overwritten: anything already present at the destination is
  left where it is and reported;
- the old folder is removed only if it ends up empty.

Folders that only exist on disk — old downloads no longer in Transmission — are
found too, when the media folder is mounted. A media server watching the folder
picks a moved show up on its next scan; moving one show and checking it there
first is the cautious way.

---

## Activity log

The **Activity** page records every search, grab, rejection, screen verdict and failure, with
level and item-type filters. It is written to the database as well as stdout, so it survives a
restart. Entries older than 30 days are pruned at the end of each scheduler run.

---

## Watching

Everything that has finished downloading appears under **Watch** — for every account, admins
and viewers alike. Add viewers in **Settings → Accounts**; they see only the Watch pages.

### How a file gets to the browser

Each finished file is probed once and given one of three plans:

| Plan | When | What happens |
|---|---|---|
| **Direct** | MP4 with H.264 video and AAC/MP3 audio | Served as it is, with range requests |
| **Repackage** | Video is fine, but the file is MKV, or the audio is AC-3/DTS/TrueHD, or the right audio track isn't the first one, or it is an MP4 with more than one ordinary audio track | Video copied untouched, audio converted to stereo AAC. Takes about a minute, no loss of picture quality |
| **Convert** | HEVC, 10-bit, HDR (tone-mapped to SDR), MPEG-4 Part 2, VC-1 | Re-encoded to 8-bit H.264, scaled to at most 1080p (configurable) |

Repackaged and converted versions are HLS, written to their own folder (`WEB_PATH`, the `./web`
volume in Docker) — **the original is never touched**, so Transmission keeps seeding it. The
playlist grows as the encode runs, so playback can begin after the first few seconds are done.

An MP4 with several audio tracks would play as it is, but a browser (Safari aside) only ever plays
its first track — no way to reach a second language, or past a wrongly flagged default. So it gets
a web version too, and plays as it is until that is ready. Files already in the library are
re-planned from their stored probe when the server starts.

**Every audio track is kept**, each as stereo AAC (about 85 MB an hour per extra track). The one
in your first subtitle language — never commentary or audio description — plays by default; the
others are named after their language and title. Switch with the **Audio** menu under the video
(or `A`) in the browser, and the settings (gear) button in the Android player — downloads carry
every track too. Web versions made before this have one track; they keep playing, and are rebuilt
with all of them before *Remove originals after seeding* lets their original go.

By default a web version is built as soon as a download passes its file check. Set **Settings →
Playback → Prepare web versions** to *Only when someone presses play* to save disk space; the
first play then waits for the first segment. Budget roughly the size of the converted originals.

Files downloaded before this existed are indexed in the background, 40 every half hour, or all
at once with **Settings → Watch library → Scan library now**.

### Removing originals after seeding

A repackaged or converted item is on disk twice: the original, which Transmission seeds, and its
web version. **Settings → Playback → Remove originals after seeding** (off by default) lets go of
the original once the torrent has given back enough, and keeps the web version as the only copy.

| Setting | Removes |
|---|---|
| Never | Nothing |
| Repackaged items only | Originals whose web version has the same video, copied untouched. Every audio track is kept; lost are surround sound (each track is stereo AAC) and image subtitles |
| Repackaged and converted | Also originals that were re-encoded — the web version is then the only quality left (8-bit SDR H.264, at most the *Converted video height*) |

At the end of each scheduler run, a torrent is removed — files, folder and Transmission entry —
when it has finished and reached the ratio (default `2`), or has seeded for the set number of
days, **and every video file in it** belongs to an item whose web version is complete. So a season
pack waits until its last episode is converted, and a pack holding a video nothing tracks is never
removed. Files that play as they are (*direct*) have no second copy and are never removed, and
neither is a torrent that was already in Transmission before auto_magnet asked for it.

Before the torrent goes, every subtitle the player can show is converted to WebVTT and kept with
the web version; fetched `.srt` files beside the video are then deleted with it. They can no longer
be re-timed or saved — the player's offset still works. **Delete all web versions** skips these,
since there is nothing to rebuild them from, and so does **Retry**.

Two things to know before turning it on: anything else reading the media folder — a Samba share,
Jellyfin or Plex — loses the original too; and if Transmission stops seeding at a lower ratio than
this one (its own *seed ratio limit*), only the day limit will ever remove anything. The Activity
log records each removal and the space freed.

### GPU encoding

With an AMD or Intel GPU, encoding runs through VAAPI. In Docker, uncomment the `devices` and
`group_add` lines in `docker-compose.yml` and set `RENDER_GID` in `.env` to
`getent group render | cut -d: -f3`. **Settings → Watch library** shows which encoder is in use.

The GPU decodes and scales too, not just encodes: HEVC, AV1, VP9 and MPEG-2 (8 or 10-bit) stay on
the GPU from decoder to encoder. 10-bit H.264 has no hardware decoder, so it is decoded on the CPU.
HDR comes down to the CPU once for tone mapping, after it is scaled to 1080p.
That tone mapping is the slow part: expect roughly 1–2× real time for 4K HDR, against several
times real time for SDR.

A file that fails is retried decoding on the CPU, then entirely on the CPU. After three GPU
decoding failures in a row, decoding stays on the CPU until the server restarts. The Activity log
shows how each web version was made and how fast, e.g. *web version ready (transcode, GPU) in
512s, 13.4× real time*.

Repackaging and converting run side by side, one of each at a time, so a long conversion queue
never holds up files that need only a minute.

### Disk space

Web versions never fill the disk. Below **Keep free** (20 GB by default) no new one starts.
**Settings → Watch library** then says they are paused, the Activity log records it once, and they
carry on by themselves once there is room again (checked every five minutes). One already running
is stopped if free space falls to half the reserve (downloads share the disk). It is queued again
to start over.

If the disk fills anyway (downloads, Docker's build cache), the server no longer crashes on every
start. It logs `THE DISK IS FULL` once a minute and keeps serving, and it carries on without a
restart once space is freed. Docker's build cache is a common culprit after a few rebuilds:
`docker system df`, then `docker builder prune`.

### Subtitles in the player

Sidecar `.srt`/`.vtt`/`.ass` files named after the video (or in a release's `Subs/` folder) and
embedded text tracks are offered; image-based tracks (PGS, VobSub) can't be shown as text. The
first full track in your first subtitle language is on by default.

The timing controls under the video shift subtitles live (`Z`/`X` also work). For a `.srt` beside
the video you can then **Save to file**, **Auto-sync** it to the audio, or **Restore** the original
— the first change keeps a `.bak` copy, which media players ignore.

A subtitle fetched from OpenSubtitles by IMDb id rather than by file hash was timed against some
other release, so it is aligned to the audio automatically: speech energy is cross-correlated
with when cues are on screen, trying the common 23.976/24/25 fps mismatches too. The change is
only applied when the match clearly stands out; otherwise the file is left alone and the log
says why.

### Progress

Each account has its own resume points. Past 92% of the running time (or within the last two
minutes) counts as watched. Under 30 seconds isn't a resume point. A report carries the time it
was made, so progress uploaded late from a phone never overwrites newer progress from elsewhere.

### Keyboard (player)

`Space`/`K` play/pause · `←`/`→` 10 s · `F` fullscreen · `Z`/`X` subtitles earlier/later · `A` next audio track · `N` next episode

### Android app

The app is in `android/`. Every CI run builds it — download `auto_magnet-android` from the run's
artifacts — or build it yourself with the Android SDK and JDK 17 or newer (Android Studio's bundled
JBR works; the build uses Gradle 9.7 and AGP 9.4):

```bash
cd android && ./gradlew assembleDebug   # app/build/outputs/apk/debug/app-debug.apk
```

Sign in with the server address (e.g. `http://192.168.0.102:62201`) and an account. Then:

- **Play** streams, resuming where that account left off, with subtitles and every audio track
  (switch in the settings menu); at the end of an episode the next one starts.
- **Download** keeps a copy on the phone: the original file for direct-play items, the web
  version for the rest (available once it has finished converting). Subtitles come with it.
  Downloads wait for Wi-Fi unless you switch that off on the Downloads tab.
- Progress made offline is uploaded when the app is next opened online.
- **Picture-in-picture**: going Home while something plays shrinks it to a floating window
  (automatically on Android 12+), with back 10 s, play/pause and forward 10 s. Closing the window
  saves the position. Opening another item while one plays there switches to it.

**Admins also get a Manage tab** — the downloader side, through the same endpoints as the web
dashboard:

- **Waiting for you**: manual-mode movies, and the episode each manual-mode show is waiting on,
  with a Choose button.
- **Movies / Shows**: everything tracked, with its status, progress and last error. Open one to
  change quality, mode, following and season packs, Redo, Skip or Restore episodes, refresh a
  show's episodes from TMDB, or stop tracking it.
- **+** searches TMDB and adds a movie or show (quality, automatic or manual, the season and
  episode to start from, season packs, and which Transmission instance when there is more than
  one).
- **Choose** opens the torrent picker: the ranked releases with quality, seeders, size, indexer,
  whether the contents were checked and any warnings; ↻ searches the indexers again, the search
  box runs a literal query, and *filtered out* lists what was rejected and why. Tapping a release
  asks before it downloads.

Viewers don't see the tab, and the server refuses those endpoints to them anyway. Settings, the
activity log and accounts stay in the web dashboard.

Reaching the server away from home needs a route to it: a VPN such as WireGuard or Tailscale
is the safe one. Exposing the port to the internet is not recommended.

---

## Working on it

```bash
npm install            # server dependencies
npm run build:client   # build the SPA into client/dist
npm run dev            # server with --watch
```

The server serves `client/dist`, so the SPA has to be built at least once before the dashboard
renders. Rebuild it after any change under `client/src`.

Tests: `npm test` (needs `ffmpeg`). They cover the plan and encode decisions, progress rules,
subtitle parsing and sync against synthetic audio, and an end-to-end run of a real server
against generated video — accounts, direct play, a real remux and transcode, subtitles and
progress. The Android app's models are tested against captured server responses:
`cd android && ./gradlew testDebugUnitTest`.

Four documents, each with a different job:

| File | What it holds |
|---|---|
| `README.md` | How to run it, configure it, and what the features do |
| `TODO.md` | Open work. The first place to look for what's next |
| `user-stories.md` | What each feature is for, the bugs found against it, and what shipped when |
| `improvements.md` | Audit findings and the reasoning behind past reworks — mostly historical |

### Running a test or demo instance

A server started against a database that contains auto-mode items **will grab them** — that is
what it is for — using whatever Transmission host and download paths its settings name. A
database created fresh seeds those settings from `.env`, so a throwaway instance started next
to a real `.env` is pointed at the real Transmission and the real disks. EZTV needs no API key,
so this happens even with no Prowlarr configured.

Start any test instance with the scheduler off:

```bash
AMAGNET_NO_SCHEDULER=1 DB_PATH=/tmp/test.db node server/index.js
```

Isolating the database is not enough on its own — it isolates the records, not the side effects.


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
│   ├── quarantine.js     # Screen verdicts, and the sweeps that finish them
│   ├── postprocess.js    # Finished-download checks and subtitle fetching
│   ├── paths.js          # Show folder names (Windows-safe) and path mapping
│   ├── library.js        # Finding and moving show folders that don't match
│   ├── transmission.js   # Transmission RPC client
│   ├── auth.js           # Accounts, sessions, the API guard
│   ├── media.js          # Watch library: locating files, play plans, encode queue, subtitles
│   ├── progress.js       # Per-user resume points, continue watching, next up
│   ├── cleanup.js        # Removing originals that have seeded, keeping the web version
│   ├── subsync.js        # Aligning subtitles to the audio
│   ├── subtitle-text.js  # SRT/WebVTT parsing and writing
│   ├── sources/
│   │   ├── prowlarr.js   # Multi-indexer search
│   │   ├── eztv.js       # Show torrent fallback
│   │   ├── yts.js        # Movie torrent fallback
│   │   └── opensubtitles.js # Subtitle search and download
│   └── api/
│       ├── movies.js
│       ├── shows.js
│       ├── search.js
│       ├── settings.js
│       ├── timeline.js
│       ├── log.js
│       ├── library.js
│       ├── auth.js       # Sign-in, setup, accounts
│       └── watch.js      # Browsing, streaming, subtitles, progress
├── client/               # Vue 3 frontend (Vite)
│   ├── public/
│   │   └── favicon.png
│   ├── src/
│   │   ├── views/        # Movies, Shows, Activity, Settings, Login, Watch, ShowWatch, Player
│   │   └── components/
│   └── dist/             # Built SPA — served by Express in production
├── android/              # Android app (Kotlin, Compose, Media3)
├── test/                 # node --test suites
├── deploy/
│   └── auto-magnet.service   # systemd unit for a bare-metal host
├── .env.example
├── docker-compose.yml
├── package.json
├── README.md
├── TODO.md               # open work, reviewed as it changes
├── user-stories.md       # what each feature is for, and what shipped when
└── improvements.md       # audit findings and the reasoning behind past reworks
```
