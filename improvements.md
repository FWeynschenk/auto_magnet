# auto_magnet — Improvement Proposals

Findings marked **[verified]** were reproduced against the actual code.

> **Status: all items in §1–§7 were implemented on 2026-07-26.** See the
> "Implementation notes" section at the bottom for what shipped, what was verified,
> and the one item deliberately deferred.

---

## 1. Scheduler architecture — the root cause behind several bugs

**This blocks the "fetch all episodes on add" feature and should be done first.**

The scheduler doesn't work from a list of episodes that exist. It *guesses* the next episode
number by incrementing the highest row it has ([scheduler.js:218-220](server/scheduler.js)):

```js
const latest = episodes.latest(show.id);
let nextSeason  = latest ? latest.season      : (show.start_season  || 1);
let nextEpisode = latest ? latest.episode + 1 : (show.start_episode || 1);
```

Everything downstream is a consequence of that guess:

- **Phantom seasons.** Guessing S03E01 for a two-season show and asking a torrent site whether it
  exists is how the Twisted Metal false positives happened. *(Patched with a null-season guard,
  but the guessing remains.)*
- **Manual mode queues unboundedly.** `episodes.latest()` counts `pending` rows, so the episode
  awaiting your approval becomes the basis for the next guess. Every run adds one more.
- **Backfill silently breaks grabbing. [verified by inspection]** `POST /:id/refresh-tmdb`
  ([shows.js:101](server/api/shows.js)) inserts missing episodes as `pending`. That jumps
  `episodes.latest()` to the newest episode, and [scheduler.js:253](server/scheduler.js)
  (`if (existingRow && existingRow.status !== 'upcoming') return false`) then refuses every
  episode below it. **Clicking "Refresh TMDB" today can permanently strand a show's back
  catalogue.** This is also exactly why "fetch all episodes on add" cannot be built on the
  current model — it would strand every show on add.

### Proposed model

Split the two jobs that are currently tangled together:

1. **Sync** — TMDB is the authority on which episodes exist. Enumerate seasons from the show's
   start point to `number_of_seasons` (already returned by `getTvDetails` and currently thrown
   away) and upsert one row per episode, `pending` if aired, `upcoming` if not.
2. **Grab** — iterate `episodes.pending(showId)` in season/episode order, capped per run. No
   arithmetic, no guessing.

This makes the phantom-season guard unnecessary, fixes manual mode (a `pending` row awaiting
approval is simply the next one in the queue, not a trigger to invent another), fixes the
backfill dead zone, and makes "populate everything on add" a two-line call to the same sync
routine.

New query needed:

```js
pending: (showId) => db.prepare(
  "SELECT * FROM episodes WHERE show_id = ? AND status = 'pending' ORDER BY season, episode"
).all(showId),
```

---

## 2. Malicious torrents

### 2.1 The current filter is broken in both directions **[verified]**

[selector.js:7,66-69](server/selector.js):

```js
const MALWARE_EXTS = ['.exe','.bat','.cmd','.scr','.msi','.pif','.vbs','.ps1','.com'];
function hasMalware(title) {
  const lower = title.toLowerCase();
  return MALWARE_EXTS.some(ext => lower.includes(ext));
}
```

Unanchored substring matching. Every one of these real-world titles is rejected as malware:

| Title | Trips on |
|---|---|
| `The.Batman.2022.1080p.WEB-DL...` | `.bat` in `.Batman` |
| `Breaking.Bad.Complete.Series...` | `.com` in `.Complete` |
| `Silicon.Valley.S05.COMPLETE.720p...` | `.com` in `.COMPLETE` |
| `The.Commuter.2018.1080p...` | `.com` in `.Commuter` |
| `Show.S01E01.1080p...[eztv.com]` | `.com` in the site tag |
| `www.TamilBlasters.com - Movie...` | `.com` in the domain prefix |

Any indexer that prefixes titles with its domain is rejected wholesale. `.com` as a DOS
executable extension is a 1990s threat that collides catastrophically with domain names in 2026.

The other direction matters more: **the title tells you nothing about the payload.** Nobody
distributing malware names the torrent `Movie.exe`. They ship a correctly-named video file
alongside a dropper, or an `.lnk`, or a password-protected archive with `password.txt`.

Minimum fix — anchor to extension boundaries and drop `.com`:

```js
const MALWARE_EXT_RE =
  /\.(exe|bat|cmd|scr|msi|pif|vbs|ps1|jar|apk|lnk|iso)(?=[\s.\-_\]\)]|$)/i;
```

### 2.2 Screen actual torrent contents

`server/sources/torrent-meta.js` already parses the bencoded `info` dictionary to derive the
infohash. The file list is in the same dictionary — `info.files[]` (`path`, `length`) for
multi-file torrents, or `info.name`/`info.length` for single-file. Extending `parseTorrent` to
return it costs almost nothing and enables screening on real contents rather than a filename:

- Reject any executable/script extension in an actual file path (this is where the extension
  check belongs).
- Reject when the largest file isn't a video container — the classic dropper ships a 3 MB
  "sample" plus an installer.
- Reject when video files are a small fraction of total size.
- Flag archives (`.rar`/`.zip`/`.7z`) paired with a `password`/`readme` text file — a
  long-standing malware pattern, and useless to an automated pipeline regardless.

### 2.3 Verify magnet-only results before they download

Content screening only works when we hold the `.torrent` bytes. EZTV, YTS, and Prowlarr's
`magnetUrl` results give us a magnet with no file list. For those, let Transmission fetch the
metadata and inspect before committing:

1. `torrent-add` with `paused: true`.
2. Poll `torrent-get` for `files` until metadata arrives.
3. Run the same screen. Pass → `torrent-start`. Fail → `torrent-remove` with
   `delete-local-data: true`, mark the episode failed, record the magnet in `tried_magnets`.

This closes the gap completely: nothing reaches disk unscreened.

### 2.4 Trust gating

`preferred_*_groups` currently only adds `+20` to the score ([selector.js:148](server/selector.js)),
so an untrusted release with 11 more seeders outranks a trusted one. Worth a per-show or global
"trusted groups only" toggle for users who want a hard gate rather than a nudge.

---

## 3. Security of the dashboard itself

**No authentication, and CORS is wide open** ([index.js:11](server/index.js) — `app.use(cors())`).

Any website you visit while the dashboard is reachable can issue cross-origin requests to it.
There are no credentials to forge because there are none. A malicious page can `POST
/api/search/grab` with an arbitrary magnet and put anything it likes into your Transmission, or
`PUT /api/settings` to repoint `transmission_host` at a host it controls. `GET /api/settings`
masks the secrets, but still discloses your hosts and paths cross-origin.

Given this is bound to a LAN port, the pragmatic fixes are:

- Restrict CORS to the dashboard's own origin (it's a same-origin SPA — CORS isn't needed at all).
- Add a shared-secret header or basic auth, checked in middleware ahead of `/api`.
- Bind to a specific interface rather than all of them.

**The SPA catch-all swallows API 404s** ([index.js:34](server/index.js)). `app.get('*')` matches
`/api/typo` and returns `index.html`, so a client bug surfaces as "unexpected token `<` in JSON"
instead of a 404. Register a JSON 404 for `/api/*` before the catch-all.

**Dynamic column names in SQL.** `update()` in [db.js:128,147,186](server/db.js) interpolates
`Object.keys(data)` straight into the statement. Every current caller filters through an
allowlist, so it isn't exploitable today — but it's one unfiltered call away from injection.
Validate keys against a per-table column set inside the helper.

---

## 4. TMDB usage — answering the caching question

**Posters do not consume API quota.** They're served from `image.tmdb.org`
([tmdb.js:6](server/tmdb.js)), a CDN on a different host from `api.themoviedb.org`. Only the
latter is rate-limited. The absolute CDN URL is stored in the DB and rendered directly by the
browser, which caches it under the CDN's own cache headers. There's nothing to fix for quota
reasons. (Two non-quota reasons you might still proxy them: every page view leaks your IP to
TMDB, and posters break on a LAN-only or offline dashboard.)

**Season metadata is where the waste is.** `populateUpcoming` calls `getSeasonDetails` for three
seasons per show ([scheduler.js:189](server/scheduler.js)) — and does it *before* `processShow`
builds its `seasonCache` ([scheduler.js:309](server/scheduler.js)), so those calls bypass the
cache entirely and repeat every single run, forever. Thirty shows is ~90 uncached calls an hour,
~2,000 a day, almost all re-fetching seasons that finished airing years ago.

Two fixes, in order of value:

1. **Persist season data with a TTL.** A `tmdb_season_cache` table keyed by
   `(tmdb_id, season_number)`. A season whose last episode aired in the past is immutable —
   cache it indefinitely. Only the current and next season need periodic refresh. This is also
   what makes "fetch all episodes on add" cheap to repeat.
2. **Pass `fetchSeason` into `populateUpcoming`** so it shares the per-run cache. One-line
   change, immediately removes most of the duplication.

---

## 5. Shows view — parity and sorting

Movies ([Movies.vue:12-27](client/src/views/Movies.vue)) has sort (added/title/year/status), a
status filter, and a grid/list toggle persisted to `localStorage`. Shows
([Shows.vue:12-16](client/src/views/Shows.vue)) has only Active/Paused. The two views were
clearly built at different times and never reconciled.

Shows should gain:

- **Sort** — recently added, title, next air date, unwatched/pending count, last grabbed.
  "Next airing" is the genuinely useful one and the data is already on the episode rows.
- **Status filter** — has pending / downloading / failed / fully caught up / ended.
- **Grid–list toggle**, same `localStorage` pattern.
- **A text filter box.** Neither view has one; past ~30 items both become a scroll hunt.

Also worth extracting: both views duplicate `reload`/`silentReload`/`remove`/`update`/polling
almost verbatim. A shared composable would keep them from drifting further.

---

## 6. UI/UX

**Destructive actions have no confirmation.** `Remove` is a red button in a four-button vertical
stack on every card ([ShowCard.vue:39](client/src/components/ShowCard.vue)), and
[Shows.vue:130](client/src/views/Shows.vue) deletes immediately. Episodes cascade
([db.js:45](server/db.js)), so a misclick silently destroys the show's entire history. Needs a
confirm step, and ideally undo.

**Failures are invisible.** `remove`, `update`, and `redo` in both views `await` the API with no
`try`/`catch`. A failed call produces an unhandled rejection and, from the user's side, a button
that simply does nothing. There's no global toast/error surface anywhere in the app.

**Dialogs aren't keyboard-usable.** None of the five dialogs close on Escape, none trap focus,
none set `role="dialog"`/`aria-modal`. Overlay click works; that's it.

**Mobile is broken.** `AddDialog` is a fixed `width: 520px` with no `max-width`
([AddDialog.vue:165](client/src/components/AddDialog.vue)) and overflows narrower screens.
Settings forces a two-column grid at every width ([Settings.vue:221](client/src/views/Settings.vue)).
The navbar doesn't wrap. No media queries exist in the app.

**Inconsistent visual rhythm** — the "wacky" feeling is mostly these:
- Show cards are `minmax(480px, 1fr)` vs movies at `minmax(380px, 1fr)`, so the two pages have
  different column counts at the same window size.
- Movie cards open a stats dialog on poster click; show cards open a manage dialog. Same gesture,
  different kind of destination.
- Buttons stack vertically on show cards, horizontally elsewhere.
- Icon-only controls (`☰`/`⊞`) have `title` but no `aria-label`.
- The timeline strip renders on every page including Settings, and its collapsed state isn't
  persisted the way `movies_view` is.

**Notification permission is requested on load** ([App.vue:39](client/src/App.vue)) rather than
on a user gesture. Browsers penalise this and some suppress the prompt outright. Move it behind
an explicit "Enable notifications" control in Settings.

**Episode bubbles look interactive but aren't** — `cursor: default`, tooltip-only. Clicking one
to jump to that episode in the manage dialog is the obvious expectation.

---

## 7. Other technical items

- **Unbounded list payloads.** `GET /api/shows` returns every show with every episode inline
  ([shows.js:9](server/api/shows.js)), re-fetched by both views every 30 s. Thirty shows of five
  seasons is thousands of rows per poll. Return counts plus a summary, fetch full episode lists
  on demand.
- **No global time budget in the scheduler.** Shows are processed sequentially, up to 15
  episodes each, with a 90 s Prowlarr timeout per search ([prowlarr.js:22](server/sources/prowlarr.js)).
  Worst case a single run outlasts the interval; `_running` prevents overlap, so runs get skipped
  silently. Add a deadline and log when it's hit.
- **Fire-and-forget without a catch.** [index.js:28](server/index.js) —
  `require('./scheduler').run()` has no `.catch()`. Every other call site attaches one.
- **`setInterval` never cleared** in [App.vue:36](client/src/App.vue) (no `onUnmounted`).
- **Four independent poll timers** (App 30 s, Movies 30 s, Shows 30 s, Timeline 5 min) all
  running regardless of tab visibility. Gate on `document.visibilityState`.
- **No index on `episodes.status`**, used by `downloading()` and `failed()`. Trivial at current
  scale; worth adding alongside the pending-queue work.

---

## Suggested order

| Priority | Item | Why |
|---|---|---|
| 1 | Scheduler sync/grab split (§1) | Unblocks episode backfill; fixes manual mode, refresh-tmdb stranding, and phantom seasons at the root |
| 2 | Fix `hasMalware` anchoring (§2.1) | One regex; currently rejecting most legitimate releases |
| 3 | Fetch all episodes on add (§1) | Requested; trivial once §1 lands |
| 4 | Content screening from `.torrent` (§2.2) | Real malware defence; parser already exists |
| 5 | CORS + auth (§3) | Any visited website can currently drive your Transmission |
| 6 | Confirm on destructive actions (§6) | Data loss from a single misclick |
| 7 | Season cache with TTL (§4) | Removes ~2,000 redundant TMDB calls/day |
| 8 | Add-paused verification (§2.3) | Closes the magnet-only screening gap |
| 9 | Shows sort/filter/search (§5) | Requested; parity with Movies |
| 10 | Error surfacing + dialog a11y (§6) | Silent failures are the worst failures |

---

## Implementation notes (2026-07-26)

### New files

| File | Purpose |
|---|---|
| `server/screen.js` | Content screening on real file lists; anchored extension patterns |
| `server/sources/torrent-meta.js` | Bencode reader — infohash, trackers, file list |
| `client/src/toast.js` | App-wide notification store + `guard()` wrapper |
| `client/src/components/ToastHost.vue` | Toast renderer |
| `client/src/components/ConfirmDialog.vue` | Reusable confirmation |
| `client/src/composables/useDialog.js` | Escape, focus trap, scroll lock, focus restore |
| `client/src/composables/usePolling.js` | Visibility-gated polling |

### Scheduler (§1)

`grabNextEpisode` is gone. `syncEpisodes()` mirrors TMDB into the episodes table and owns the
aired/unaired decision; the grab phase walks `episodes.pending(showId)`. No episode number is
ever invented. `SYNC_PROTECTED` guards `downloading`/`done`/`failed`/`skipped` from being
overwritten. `populateUpcoming` was removed — full sync inserts upcoming rows anyway.

Verified with a temp-DB harness against a two-season show with no S3:

- 7 episodes seeded; aired → `pending`, unaired → `upcoming`
- no phantom S3 row created
- re-sync added 0 rows and preserved `done`/`downloading`
- a deleted mid-season episode was re-inserted **and queued** — the old stranding bug
- `upcoming` → `pending` once the air date passed

### Malware (§2)

`hasMalware` previously rejected all 8 test titles including 6 legitimate ones. Now anchored via
`EXECUTABLE_RE`. Screening runs at two points: at search time on file lists parsed from
`.torrent` bytes, and at add time for magnet-only results (add paused → poll
`torrent-get` → start or `torrent-remove` with `delete-local-data`). A screen rejection records
the magnet in `tried_magnets` and leaves the item pending, so the next run tries the next
candidate rather than failing outright. 12/12 screening cases pass, including
`The.Batman.2022.COMPLETE` correctly allowed.

Also added: `trusted_only` setting for a hard release-group gate (§2.4), off by default.

### Security (§3)

CORS is now off unless `AMAGNET_CORS_ORIGIN` is set. `AMAGNET_TOKEN` enables shared-secret auth
on `/api` (unset = unchanged open behaviour, with a startup warning). JSON 404 + error handler
registered before the SPA catch-all. `assertColumns()` validates dynamic column names against
`PRAGMA table_info`. `AMAGNET_BIND` allows binding to a specific interface.

Verified: 401 JSON unauthenticated, 200 with token, JSON 404 on unknown API route, secrets masked.

### Deferred

**Unbounded list payloads** (§7, first bullet). Returning episode counts instead of full lists
would change the response shape that `ShowCard`, `EpisodeGrid`, `ShowManageDialog`, and both
views all read, for a modest gain. Visibility-gated polling removes most of the practical cost
(hidden tabs no longer poll at all) and `idx_episodes_show_status` was added. Worth revisiting
if show counts grow past a few hundred.
