# XaMedia — Home Entertainment Kiosk

A TV-style home entertainment system for a home LAN. A **kiosk** (any Linux
box + Google Chrome in `--kiosk` mode, driven by mouse only) serves a
fullscreen web UI; a **NAS** holds the media library and keeps it clean
automatically.

## What it does

- **Home screen**: fullscreen landscape slideshow with slow crossfade +
  Ken Burns drift, clock/date, and a weather widget (animated icons, wind,
  barometric pressure + trend, 5-day forecast). Clock and weather stay on
  screen permanently and drift a few px/minute to prevent burn-in.
- **Movies / TV / Music browser**: poster grid of your whole library (TMDB
  artwork + canonical titles), genre chip submenu (sorted by count, **All**
  last), A–Z jump bar, full TMDB detail (rating, runtime, genres, director,
  overview, cast), and a **Fix match** button to repair misidentified titles
  right from the couch.
- **Playback**: H.264/WebM plays in-browser (fullscreen player, controls and
  cursor auto-hide after 2 s). Anything the browser can't decode (AVI/VOB/
  XviD-in-MP4…) is one tap away via **Play with VLC** — VLC launches
  fullscreen on the kiosk display and exits back to the UI when done.
- **Internet radio**: station list editor, big play/stop, volume, now-playing
n  — plus a **Browse** tab over the free radio-browser.info directory
  (58k+ stations): genre chips (jazz, classical, tango, cumbia, news…),
  tap ▶ to audition, tap + to save to your stations. No API key.
- **Volume widget**: a persistent slider badge bottom-left
  (`deploy/kiosk-vol`, autostarted) — scroll wheel nudges ±5%, drag sets
  the level, click mutes, same idle-fade as the other badges.
- **On-screen keyboard**: a persistent ⌨ badge bottom-right
  (`deploy/kiosk-oskbd`, autostarted) floats above ALL windows — kiosk
  page, streaming sessions, VLC — fades out after ~3s idle like the
  streaming exit badge, and toggles `onboard` (X-level typing, works
  everywhere).
- **Assistant orb**: a persistent desktop badge bottom-left (above the
  volume badge) — blue when idle, amber while thinking, green and pulsing
  when the assistant is listening or speaking, red on error. **Click
  toggles the voice session — or just say "Hi Computer".** When hot it
  doubles in size with a bright ring on a dark contrast disc and never
  fades; when idle it shrinks and fades out after ~3 s with the other
  badges. It floats above every window, streaming sessions and VLC
  included. Sessions hang up automatically after 30 s without input (and
  whenever playback starts) — the orb can be woken again any time.
  Behind it is a **cascaded voice pipeline** (no on-page UI):
  - **Ear**: Chrome speech recognition runs only while the session is
    active — the room's TV is never streamed anywhere.
  - **Brain** (`api/assistant-brain.php`): a text LLM (Gemini flash, with
    a model fallback chain) gets the transcript, the long-term memory, the
    recent conversation and the tool declarations; it replies in words or
    issues tool calls, which the page executes against the kiosk and
    posts back for the spoken confirmation.
  - **Mouth** (`api/v1/audio/speech.php`): Gemini TTS, sentence-streamed,
    with the browser's own voice as a backstop.
  A rising chime marks activation, a falling one sleep. The legacy
  speech-to-speech **Gemini Live** path is kept behind a setting
  (Settings → Assistant → Backend). Behind it is a Gemini
  Live API voice session (no on-page UI): the browser talks to
  `deploy/live-proxy.py` (autostarted), a localhost WebSocket relay that
  holds the `gemini_api_key` from `config/config.php`; the badge
  (`deploy/kiosk-orb`, autostarted) and the page exchange state and toggle
  commands via `api/assistant-ctl.php`. (Earlier integrations — Open WebUI
  voice, the Gemini web app, and a fullscreen in-page orb overlay — were
  replaced by this; the Gemini TTS proxy `api/v1/audio/speech/index.php`
  remains available.)
  - **Tool-calling**: the assistant acts on the kiosk itself — play movies,
    TV episodes and music from the library (fuzzy title match, browser
    player with VLC fallback), tune/stop the radio, open streaming
    services, start the photo slideshow, report the weather, open any
    website fullscreen (`api/browse.php`), search and read web pages
    (`api/web-lookup.php`), remember facts on request — and **drive the
    UI**: "open Movies", "select Comedy", "scroll down", "go back",
    "main menu" all work as spoken navigation.
  - **Long-term memory**: every session's transcript is logged to
    `data/assistant/history.jsonl`; at session end
    `bin/assistant-consolidate.php` folds new history into
    `data/assistant/memory.md` (durable facts) and `summary.md` (rolling
    narrative) via a Gemini text call. Both are injected into the system
    instruction of the next session, so conversations continue across
    days. Explicit "remember that …" writes go straight to `memory.md`.
  - **Proactive greeting**: when someone returns to the kiosk after a
    long idle (default 45 min, at most every 4 h), the assistant opens
    itself and greets the household with remembered context; if nobody
    answers within ~20 s it closes quietly. Tunable via the `assistant`
    section in `data/settings.json`.
- **Streaming tiles**: Netflix, YouTube, HBO Max and Prime TV launch a
  dedicated fullscreen Chrome session (`deploy/kiosk-stream`) with a
  persistent profile (logins stay signed in; Chrome bundles Widevine for
  1080p-capable DRM) and an always-on-top ✕ Exit button — quitting returns
  to the kiosk.
- **Settings** behind a PIN pad (default `1234` — change it): weather
  location search, radio stations, slideshow timing, photos status, UMS
  URL, **API keys** (TMDB + Gemini — stored keys are masked; empty field
  keeps the current one), **assistant options** (proactive greeting, idle
  minutes, cooldown, memory model), PIN — plus two-tap **Reboot /
  Shutdown** buttons in the header
  (`api/power.php`; sudoers: `www-data ALL=(root) NOPASSWD:
  /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff`).
  Everything set here lives in `data/settings.json` and overrides
  `config/config.php`, so a deployment rarely needs file edits at all.
- **Photos**: slideshow reads a local folder; import via **Settings →
  Photos → Import from USB** (browse the drive, pick any folder, harvest
  it and all subfolders into the library — idempotent, structure
  preserved) or `bin/import-takeout.sh` for Google Takeout exports
  (Google's 2025 API changes killed direct sync).
  Photo mode (Photos tile) has a manager grid: GD/EXIF-aware thumbnails,
  two-tap purge to a recoverable `.trash/`, in-place 90° rotate, and a
  blank-photo pre-filter (`bin/scan-blanks.php` scores luminance variance
  via ffmpeg; Find blanks → Purge N blank in the grid).
- **NAS auto-ingest**: drop a media file anywhere in the NAS dump folder;
  within ~15 minutes it's TMDB-matched, hardlinked into the clean library,
  poster-fetched, and on the kiosk. Duplicates are refused; unmatched titles
  are filed anyway (fix them later with Fix match).

## Architecture

```
┌────────── Kiosk (192.168.x.x, Linux Mint/Ubuntu) ──────────┐
│ Apache + PHP 8 ── /var/www/entertainment (this repo)       │
│ Firefox --kiosk http://localhost/                          │
│ VLC (spawned via deploy/kiosk-play + sudoers rule)         │
│ /mnt/library  ← NFS ro mount ──────────────┐               │
└────────────────────────────────────────────┼───────────────┘
┌────────── NAS ─────────────────────────────┼───────────────┐
│ /mnt/sdb1/         media dump (untouched originals)        │
│ /mnt/sdb1/library/ clean hardlinked tree ──┘ (NFS export)  │
│ nas/ingest.py (cron */5 min) watcher + TMDB matcher        │
│ Universal Media Server → DLNA for smart TVs                │
└────────────────────────────────────────────────────────────┘
```

No framework, no build step, no Composer/npm, no database. Settings live in
`config/config.php` + `data/settings.json`.

## Repository layout

```
public/            kiosk web app (index.php, api/, assets/)
lib/settings.php   shared settings loader (config + settings.json overlay)
config/            config.example.php — copy to config.php (gitignored)
data/              photos/, cache/, posters/, tmdb_map.json (gitignored),
                   assistant/ — voice-assistant memory (gitignored)
bin/               import-takeout.sh (Google Photos via Takeout)
nas/               NAS-side pipeline: ingest watcher, library cleanup,
                   poster fetcher, TMDB alias table
backgrounds/       48 curated landscape slides (1920×1200) — see "Photos"
deploy/            kiosk system files (Apache vhost, sudoers, kiosk-play,
                   autostart .desktop, fstab line)
```

## Deploy guide

### NAS

1. Mount your media disk at `/mnt/sdb1` (or adjust paths in `nas/ingest.py`).
2. Install + configure Universal Media Server (optional, for DLNA TVs) and
   share only `/mnt/sdb1/library`.
3. `cd nas && cp nasconfig.example.py nasconfig.py` — add your TMDB key and
   the kiosk's notify URL.
4. First-time cleanup of an existing messy library: run `scan.py` →
   `enrich.py` → `emit.py` (read-only audit; review `proposal.json`), then
   hardlink the tree with your build step of choice — see `ingest.py`'s
   filing functions for the same logic.
5. Export the clean tree read-only:
   `apt install nfs-kernel-server`, then in `/etc/exports`:
   `/mnt/sdb1/library KIOSK_IP(ro,sync,no_subtree_check,all_squash,anonuid=1000,anongid=1000)`
   and `exportfs -ra`.
6. Auto-ingest: `crontab -e` →
   `*/5 * * * * /path/to/nas/ingest.py >> /path/to/ingest.log 2>&1`
7. Posters for existing movies: `python3 fetch_posters.py`.
8. Genre map (for the kiosk genre submenu): build `genres.json` from the
   TMDB detail cache (see the one-liner in `nas/` history) and place it at
   `data/genres.json` on the kiosk. New ingests and Fix-match corrections
   update it automatically.

### Kiosk

1. `apt install apache2 php libapache2-mod-php php-curl php-mbstring vlc nfs-common unzip python3-tk onboard`
   and Google Chrome: download `google-chrome-stable_current_amd64.deb` from
   dl.google.com and `apt install ./google-chrome-stable_current_amd64.deb`,
   plus `python3-websocket` (used by kiosk-voice-auto) and
   `python3-websockets` (used by kiosk-live-proxy)
2. Copy this repo to `/var/www/entertainment`;
   `cp config/config.example.php config/config.php` and edit it (TMDB key,
   location, stations, UMS URL). Keys and most options can also be set
   later from the kiosk's Settings UI — `config.php` is the base,
   `data/settings.json` the override.
3. `chown -R www-data:www-data data/`
4. Apache: copy `deploy/entertainment.conf` to
   `/etc/apache2/sites-available/`, `a2ensite entertainment`,
   `a2dissite 000-default`, `systemctl reload apache2`.
5. NFS mount: `mkdir /mnt/library`, add `deploy/fstab.example` to
   `/etc/fstab` (adjust NAS IP), `systemctl daemon-reload && mount /mnt/library`.
6. VLC launcher: `install -m755 -o root deploy/kiosk-play /usr/local/bin/`
   (edit `KIOSK_USER` inside), and `deploy/kiosk-vlc.sudoers` to
   `/etc/sudoers.d/kiosk-vlc` (`chmod 440`, edit the user).
   On-screen keyboard: `install -m755 -o root deploy/kiosk-oskbd /usr/local/bin/`
   and copy `deploy/kiosk-oskbd.desktop` to `~/.config/autostart/`.
   Volume widget: `install -m755 -o root deploy/kiosk-vol /usr/local/bin/`
   and copy `deploy/kiosk-vol.desktop` to `~/.config/autostart/`.
   USB photo import: `install -m755 -o root deploy/kiosk-photo-import /usr/local/bin/`
   and `deploy/kiosk-photo-import.sudoers` to `/etc/sudoers.d/kiosk-photo-import`
   (`chmod 440`).
   Live proxy (voice assistant): `install -m755 -o root deploy/live-proxy.py /usr/local/bin/kiosk-live-proxy`
   and copy `deploy/kiosk-live-proxy.desktop` to `~/.config/autostart/`.
   Streaming sessions: `install -m755 -o root deploy/kiosk-stream /usr/local/bin/`
   with `www-data ALL=(user) NOPASSWD: /usr/local/bin/kiosk-stream` in a
   sudoers.d file (adjust user). Chrome runs with `--password-store=basic`
   to skip the keyring unlock prompt when launched headlessly. The streaming
   profile lives at `~/.xamedia-chrome` (created on first launch).
7. Kiosk autostart: copy `deploy/entertainment-kiosk.desktop` to
   `~/.config/autostart/` (adjust display mode to your panel — `xrandr` to
   list modes).
8. Photos: copy the curated backgrounds into place —
   `cp -r backgrounds /var/www/entertainment/data/photos/landscapes` —
   then add your own via `bin/import-takeout.sh` (Google Takeout) or by
   dropping any JPG/PNG/WebP folder into `data/photos/`.

### Photos: source and license

`backgrounds/` contains 48 landscape photos fetched from
[picsum.photos](https://picsum.photos), which serves photos from
[Unsplash](https://unsplash.com). The Unsplash license allows free use,
including commercially, with **no attribution required** (a credit is
appreciated but optional). Your own imported photos live in the gitignored
`data/photos/` — only the curated set is versioned.

Open `http://kiosk-ip/` — done. Settings tile PIN is `1234`; change it in
Settings → PIN.

## Secrets policy

- `config/config.php`, `nas/nasconfig.py`, `data/` — all gitignored.
  Only `*.example` files with placeholders are committed. Keep it that way.
- API keys set via the Settings UI land in `data/settings.json` (also
  gitignored) and override `config/config.php`. The settings GET endpoint
  only ever returns them masked; full keys never leave the server.
