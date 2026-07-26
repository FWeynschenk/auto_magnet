# auto_magnet — User Stories & Bug Tracker

Stories are ordered by feature area. Each story has acceptance criteria and, where applicable,
a **Bugs** section cross-referenced to the code.

---

## 1. Add a movie

> As a user I want to search for a movie by title and add it so that the app downloads it automatically.

**Acceptance criteria**
- Type-ahead search against TMDB returns results with poster, year, and overview.
- Adding stores the TMDB digital/streaming release date; the scheduler waits for that date before grabbing.
- Duplicate adds are rejected with a clear message.
- Choosing "manual" mode shows a Browse button instead of downloading automatically.

**Bugs**
- `server/api/search.js:87` — `POST /search/grab` (manual-mode confirm for movies) does not set
  `download_started_at`. Because `isStale(null)` returns `false`, a stuck manually-grabbed movie
  will never be auto-retried by the stale-download recovery logic.
- `server/api/movies.js:66` — `POST /movies/retry-failed` resets `status`, `results_cache`, and
  `progress` but does **not** clear `tried_magnets`. If every available torrent was already tried
  before the failure, the retry will immediately fail again with no candidates.
- `server/api/movies.js:57` — `POST /movies/:id/redo` clears `magnet` and `torrent_id` but also
  does **not** clear `tried_magnets`, so redo cannot re-attempt a torrent that was previously tried.

---

## 2. Add a TV show

> As a user I want to search for a TV show and pick a starting season/episode so that the app only
> downloads episodes I don't already have.

**Acceptance criteria**
- TMDB search returns TV results; the user can choose start season and start episode.
- After adding, the scheduler begins from the chosen starting point on its next run.
- Quality and mode (auto/manual) are configurable per show.

**Bugs**
- `server/scheduler.js:222–228` *(now fixed)* — When TMDB returns `null` for a season (season does
  not exist yet), `effectivelyAired(n, undefined)` fell through to `hasAired(null)` which returned
  `true`. The scheduler then searched torrent sites for a non-existent episode, found false
  positives (e.g. game-named collisions like "Twisted Metal"), and created spurious pending rows.
  **Fixed** by the explicit `if (!seasonInfo) return false` guard added on 2026-05-25.

---

## 3. Automatic episode grabbing

> As a user I want new episodes to be downloaded automatically as soon as they air so that I don't
> have to do anything after the initial setup.

**Acceptance criteria**
- Scheduler runs on the configured interval (default 60 min).
- Episodes are only grabbed after their air date plus the configured buffer (default 4 h).
- The "smarter inference" rule: if a later episode has a confirmed air date, earlier ones in the
  same season are treated as aired too.
- Up to 15 episodes per show are grabbed in a single scheduler pass.
- "Run Now" in Settings triggers an immediate pass.

**Bugs — none confirmed.**

---

## 4. Manual-mode episode approval

> As a user I want to review the top 5 torrent candidates before anything is downloaded so that I
> stay in control of what gets added to Transmission.

**Acceptance criteria**
- In manual mode, the scheduler pre-searches and caches top 5 results, then stops — no download
  is initiated without user approval.
- Only one episode is queued for approval at a time; the next episode does not appear until the
  current one is approved or skipped.
- The Browse dialog shows title, size, seeders, source, and quality for each candidate.
- Clicking a candidate sends it to Transmission and advances to the next pending episode.

**Bugs**
- `server/scheduler.js:258–276` — **Critical.** `episodes.latest()` returns ALL non-upcoming
  episodes, including those with status `pending`. In manual mode, after the scheduler creates
  episode N as pending (awaiting approval), the next run calculates `latest = episode N` and
  advances to episode N+1. It finds no existing row for N+1 and creates that as pending too.
  This repeats every run: N+2, N+3, … — the queue grows unboundedly without the user approving
  anything. The fix: in `grabNextEpisode`, before doing anything else, return `false` if
  `latest.status === 'pending'` and the show is in manual mode.
- `server/api/search.js:98` — `POST /search/grab` (manual confirm for episodes) does not set
  `download_started_at`, so stale-download recovery never triggers for manually approved episodes.
- `client/src/components/ShowManageDialog.vue:193` — `submitAddEpisode` does
  `await emit('add-episode', ...)`. Vue 3 `emit` is synchronous and does not return a Promise,
  so async errors from the parent handler are never caught. The form always resets and
  `addEpError` is never populated on network failures.

---

## 5. Episode redo / skip

> As a user I want to reset a failed or bad download and re-grab it, or skip an episode entirely,
> so that the scheduler can advance past problems.

**Acceptance criteria**
- Redo resets the episode to pending and triggers the scheduler.
- Skip marks the episode as skipped; the scheduler advances past it.
- A skipped episode can be restored (treated as pending again).
- Redo on a downloading episode replaces it.

**Bugs**
- `server/api/shows.js:157` — `POST /shows/:id/episodes/:epId/redo` does not clear
  `tried_magnets`. After a redo the selector still excludes all previously attempted magnets,
  so if the only available torrent was tried before, the redo fails instantly with no candidates.
  The same omission exists in the retry-failed path (`shows.js:178`).

---

## 6. TMDB refresh

> As a user I want to re-sync episode air dates from TMDB on demand so that newly announced
> episodes appear in the tracker and dates that were previously missing get filled in.

**Acceptance criteria**
- "Refresh TMDB" button re-fetches all known seasons plus two ahead.
- Air dates are updated on existing rows; upcoming rows whose air date has now passed are
  upgraded to pending.
- Episodes that exist on TMDB but were missing locally are inserted.
- The start season/episode setting is respected — nothing below that threshold is inserted.

**Bugs — none confirmed.**

---

## 7. Manual episode insert

> As a user I want to add a specific S/E directly when TMDB data is incomplete so that the
> scheduler can still grab it.

**Acceptance criteria**
- Season and episode fields accept positive integers; the form is disabled until both are filled.
- Optional air date can be set.
- Duplicate inserts return a clear error without changing the existing row.
- The scheduler is triggered after a successful insert.

**Bugs**
- `client/src/components/ShowManageDialog.vue:193` (same as story 4) — async errors from the API
  call are silently swallowed; the error banner never shows on network failures.

---

## 8. Stale download recovery

> As a user I want stuck downloads to be automatically reset and retried so that a dead torrent
> does not block a show indefinitely.

**Acceptance criteria**
- Any downloading torrent not completed within 24 h is reset to pending.
- The previously tried magnet is added to `tried_magnets` so it won't be picked again.
- The next scheduler run picks the next best available torrent.

**Bugs**
- `server/api/search.js:87,98` — Manually grabbed movies and episodes never get
  `download_started_at` set, so `isStale()` always returns `false` for them and they are
  excluded from stale recovery entirely.

---

## 9. Timeline view

> As a user I want to see a chronological view of upcoming and recent releases across all my
> tracked movies and shows so that I know what to expect.

**Acceptance criteria**
- Shows episodes and movies within a 30-day past / 60-day future window.
- Items without an air/release date are excluded.
- Sorted by date; today is visible on load.

**Bugs — none confirmed.** (Note: the SQL date expressions are injected as string literals into
prepared statement templates in `server/api/timeline.js:8–9`; these are safe constants but an
unusual pattern worth noting.)

---

## 10. Torrent search and scoring

> As a user I want the app to pick the best available torrent automatically so that I get the
> right quality without manual intervention.

**Acceptance criteria**
- Results are sourced from Prowlarr, EZTV (shows), and YTS (movies) in parallel.
- CAMs, screeners, and season packs are hard-rejected for show episode grabs.
- Results are scored by seeders, quality match, source type, HDR, trusted release groups,
  and whether a magnet link is present.
- Strict quality mode limits results to exactly the preferred quality.
- Blocked tags (user-configured) hard-reject matching results.

**Invariant: every result shown to the user must be grabbable.**
A row the user can click must go straight to Transmission with no further network work. All three
sources now guarantee a magnet — EZTV and YTS always produced one; Prowlarr now resolves or drops.

**Bugs**
- `server/sources/prowlarr.js:59` *(fixed 2026-07-26)* — Results carrying only a `download_url`
  were kept and displayed. Prowlarr omits `magnetUrl`/`infoHash` for many indexers, and the
  best-effort resolver only handled the redirect-to-magnet case, silently giving up (`catch (_) {}`)
  when Prowlarr served `.torrent` bytes directly. Those rows then failed at grab time, when
  `addTorrent` had to fetch the torrent live — **without** the `X-Api-Key` header that the search
  path sends, so Prowlarr answered 401. Because `selector.js:149` awards `+150` for having a
  magnet, magnet-less rows sank down the top-5, so the failure hit hardest when the user picked
  something other than the default row.
  **Fixed** by `server/sources/torrent-meta.js`: the resolver now follows redirects (absolute or
  relative, with the API key attached) and, when handed `.torrent` bytes, derives the infohash by
  SHA1-ing the raw bencoded `info` dictionary and rebuilds a magnet with the torrent's own
  announce list. Anything still unresolved is dropped from the result set.
- `server/api/search.js:29` *(fixed 2026-07-26)* — `/search/preview` served `results_cache`
  verbatim, so caches written before the above fix could still surface ungrabbable rows. Cached
  results are now filtered to magnet-bearing rows and fall through to a live search if none
  survive. The `JSON.parse` there was also unguarded and would 500 on a malformed cache.

---

## 11. Settings

> As a user I want to configure Transmission, Prowlarr, TMDB, quality defaults, and scheduler
> behaviour from the UI so that I never need to edit config files after the initial setup.

**Acceptance criteria**
- Sensitive values (Transmission password, API keys) are masked in the GET response.
- Saving a masked placeholder value does not overwrite the stored secret.
- Transmission connection status is shown live.
- Scheduler interval, air-date buffer, file-size limits, quality, and blocked tags are all
  editable and take effect on the next scheduler run.

**Bugs — none confirmed.** (Minor: the mask check in `server/api/settings.js:24–26` has a
redundant outer `if` — the truthy guard and the ternary are equivalent — but the behaviour
is correct.)

---

---

## 12. Notifications  *(not implemented)*

> As a user I want to be notified when an episode is ready for approval or a download completes
> so that I don't have to keep opening the dashboard to check.

**Suggested implementation**
- Webhook setting: POST a JSON payload to a user-configured URL on events (download complete,
  awaiting approval, download failed).
- Events: `episode.done`, `episode.awaiting_approval`, `episode.failed`, `movie.done`,
  `movie.awaiting_approval`.
- Optional: native browser push notifications via the Web Push API for the dashboard tab.

---

## 13. Show ended — auto-pause  *(not implemented)*

> As a user I want shows that TMDB marks as "Ended" or "Cancelled" to be automatically paused
> so that the scheduler stops checking for new episodes without me having to remember to do it.

**Suggested implementation**
- `getTvDetails` already returns `show_status` (`"Ended"`, `"Cancelled"`, `"Returning Series"`,
  etc.) but it is currently unused after the initial add.
- Store `show_status` on the `shows` table (migration needed).
- During `processShow`, if the fetched status is `Ended` or `Cancelled` and there are no more
  episodes to grab, set `active = 0` and log the reason.
- Refresh TMDB should also update the stored status and re-activate if a show is unexpectedly
  renewed.

---

## 14. Audit log / scheduler history  *(not implemented)*

> As a user I want to see a log of what the scheduler did each run so that I can diagnose why
> something wasn't downloaded or why a particular torrent was chosen.

**Suggested implementation**
- Add a `scheduler_log` table: `id`, `run_at`, `level` (info/warn/error), `entity_type`,
  `entity_id`, `message`.
- Replace bare `console.log` calls in `scheduler.js` with a helper that writes to both stdout
  and this table.
- Expose `GET /api/log?limit=200` and a Log tab in the UI.
- Prune rows older than 30 days on each scheduler run to keep the DB small.

---

## 15. Season pack support  *(not implemented)*

> As a user I want the option to download a full season pack when one is available so that I can
> get an entire season in one torrent rather than episode by episode.

**Suggested implementation**
- Per-show toggle: `prefer_season_pack` (off by default — current behaviour unchanged).
- When enabled, at the start of a new season the scheduler searches for a pack
  (`isSeasonPack` in `selector.js` is already detected; it just needs to be promoted rather
  than rejected when the toggle is on).
- Mark all episodes in the season as `downloading` pointing to the same `torrent_id`; mark
  them `done` together when Transmission reports 100%.

---

## 16. Multiple Transmission instances  *(not implemented)*

> As a user I want to route different shows or movies to different Transmission servers so that
> downloads land on the right machine/drive without manual intervention.

**Suggested implementation**
- Add an optional `transmission_override` column to `movies` and `shows`.
- A small JSON object: `{ host, port, user, pw }`.
- `addTorrent` already builds a client from settings; pass an optional override object through.
- UI: per-item "Download to…" dropdown in the add/edit dialogs.

---

## Summary table

| # | Story | Severity | Status |
|---|-------|----------|--------|
| 4 | Manual mode queues unbounded pending episodes | **High** | **Fixed** (2026-07-26) |
| 6 | Refresh TMDB stranded the back catalogue | **High** | **Fixed** (2026-07-26) |
| 1,4,8 | `download_started_at` not set on manual grabs | **Medium** | **Fixed** (2026-07-26) |
| 1,5 | `tried_magnets` not cleared on redo / retry-failed | **Medium** | **Fixed** (2026-07-26) |
| 2 | Scheduler grabs non-existent seasons | **High** | **Fixed** (2026-05-25) |
| 4,7 | `emit` swallows async errors in add-episode form | Low | **Fixed** (2026-07-26) |
| 10 | Ungrabbable (magnet-less) results shown in Browse | **High** | **Fixed** (2026-07-26) |
| 10 | Stale cache could serve magnet-less rows | **Medium** | **Fixed** (2026-07-26) |
| 12 | Notifications | — | Not implemented |
| 13 | Show ended auto-pause | — | Not implemented |
| 14 | Audit log / scheduler history | — | Not implemented |
| 15 | Season pack support | — | Not implemented |
| 16 | Multiple Transmission instances | — | Not implemented |
