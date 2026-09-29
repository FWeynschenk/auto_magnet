# auto_magnet — TODO

Open work, roughly in the order it's worth doing. Anything finished moves out of here —
`user-stories.md` keeps the record of what shipped and why.

Last reviewed: 2026-09-29

---

## Check after the next deploy

These shipped but can only be confirmed on the real box.

- **The Docker image builds.** The Dockerfile now installs `ffmpeg` for `ffprobe`. It
  couldn't be built on the dev machine (no Docker daemon running there), so the first
  `docker compose build` on the server is its first real test.
- **Set `MEDIA_ROOT` and OpenSubtitles.** Add `MEDIA_ROOT=/HDD0/Shared` to the server's
  `.env` before rebuilding, and an OpenSubtitles API key (Free consumer tier) in Settings —
  plus your OpenSubtitles login, which raises downloads from 5 to 20 a day.
  Without the mount, finished-download checks skip every file and say why on the card.
- **Do your indexers return IDs?** Prowlarr's search result *has* `imdbId`/`tmdbId` fields
  (confirmed from its source), but indexers only fill them if they know them. Every search
  now logs `N result(s), M carrying an ID` — watch `docker compose logs` for a day. If `M`
  is always 0, ID *matching* does nothing for you, though ID *searching* still helps.
- **Quarantine against the real Transmission.** Tested end to end against a fake RPC server
  (32 checks). The first real magnet grab after deploy is the first live run: its torrent
  should appear in Transmission labelled `amagnet-quarantine` at 4 kB/s, then lose the
  label and speed up once its file list checks out.
- **Five suspicious files still on disk**, from before the quarantine existed. Each fails
  the current screen:
  - `#440` Starfleet Academy S01E02 — 3 MB `.mkv` beside a **4.3 GB `.txt`**
  - `#445` Peacemaker S02E07 — a single episode shipped as a 1.8 GB **`.iso`**
  - `#478` Foundation S03E10 — the same, 670 MB **`.iso`**
  - `#488` Rings of Power S02E09 — one 1.2 GB **`.zipx`**, no video
  - `#58` Banshee Origins S03E08 — largest video 33 MB (old, probably just a bad release)

---

## Next up

### 1. Webhook notifications
**Why:** the browser notifications that exist barely work, for three separate reasons:

- They fire from the poll loop in `Movies.vue` / `Shows.vue`, and `usePolling` stops the timer
  while the tab is hidden — so they cannot fire when the dashboard isn't on screen, which is
  the only time anyone wants one.
- Only the matching view notifies. A movie finishing while you're on Shows produces nothing.
- The dashboard is served over plain HTTP on a LAN address, which is not a secure context
  (`window.isSecureContext === false`, confirmed). Chrome and Firefox auto-deny notification
  permission from insecure origins. Not proven conclusively — the test browser blocks
  notifications on localhost too — so worth one minute in a real browser:
  `Notification.requestPermission().then(console.log)` at the LAN URL.

The server already knows the moment something happens — `syncDownloading()` marks
completions, and screening and file checks record their verdicts through
`quarantine.recordVerdict()`.

**Shape:** a `webhook_url` setting; POST JSON on `movie.done`, `episode.done`,
`*.awaiting_approval`, `*.blocked`, `*.replaced`, `*.failed`. Works with the dashboard closed
and needs no HTTPS — point it at ntfy, Gotify, Discord or Home Assistant.

### 2. Quieter activity log
**Why:** the log fills 1,000 rows in about twelve hours, almost all of it the same
`no usable result for "Show" S02E07` repeated on every hourly run for episodes that have
aired but have no release yet. That makes 30-day retention meaningless in practice — when
investigating the Dark Matter `.exe`, its grab four days earlier had already scrolled out of
reach behind the cap.

**Shape:** log "no usable result" once when an episode first comes up empty and again only
if that changes, or roll repeats into one line per run: `12 episodes still have no release`.

### 3. Tests
**Why:** `selector.js`, `screen.js`, `pipeline.js`, `quarantine.js` and `postprocess.js` are
now a large set of rules. They have been verified — against a fake Transmission RPC server,
real `ffprobe` on generated video files, a fake OpenSubtitles API, and a full audit of the
907 torrents on the box — but by scripts that live outside the repo.

The silent failure mode is real and has already happened twice: a corrupted `\b` in the
season regex made every season pack unmatchable while still parsing as valid JavaScript, and
widening the archive list quietly let a `.zipx` dropper back through. Neither produces an
error; the only symptom is that the wrong thing downloads, or nothing does.

**Shape:** `node --test` against a temp DB. The existing verification scripts are a
ready-made starting point.

---

## Smaller

- **Subtitles for the existing library.** Deliberately not done: finished-download checks
  only run on downloads that complete after they were deployed, so the upgrade didn't set
  them loose on hundreds of files and the OpenSubtitles daily quota. An opt-in
  "fetch missing subtitles for this show" button would cover the back catalogue a show at a
  time.
- **A season pack eats the subtitle quota.** One pack is ten-plus downloads from a daily
  allowance. Pending ones retry automatically once the quota resets, but it can take days.
- **Episode counts instead of full lists** in `GET /api/shows` (`improvements.md` §7). The
  worst of it is fixed — `results_cache` no longer ships on every poll — but thirty shows of
  five seasons is still thousands of rows every 30 seconds.
- **Default "Prefer packs" on for ended shows.** Opt-in per show today; for a back catalogue
  it is almost always right.
- **`last_error` needs a dismiss.** It clears on a completed download or a Redo, but there's
  no way to say "I've read that" on an item you're leaving alone.
- **Show that pack episodes share a torrent.** Ten episodes showing the same progress is
  correct but reads oddly.
- **`scratch/`** — seven files of 2021-era v1 data, untracked, referenced by nothing. Delete
  it if you don't want it; left alone because untracked means unrecoverable.

---

## Considered and not done

**A small local LLM to pick releases.** The box could run one — RX 6600 (8 GB) via llama.cpp
Vulkan, or on the CPU with 40 GB of RAM. It wasn't built into the main path because every
failure actually hit so far was a *metadata* problem, not a language one: an `.exe` instead of
a video, an audio-description-only track, the wrong film with the right name. Those are
solved by reading the file list, reading the streams, and matching by ID — deterministically,
repeatably, and without a model that can invent a season number. Release names are a formal
grammar rather than prose.

Where one *could* earn its place is the ambiguous tail the rules handle worst: anime with
absolute episode numbering and fansub naming, foreign or alternate titles, remakes sharing a
name when no ID is available. The honest shape is a local classifier consulted only when the
deterministic matcher is uncertain — never in the main path.
