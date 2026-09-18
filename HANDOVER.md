# XaMedia — Handover Notes

State as of 2026-09-18. Everything below is deployed, tested, and pushed.

## The machines

| Machine | IP | Role | Access |
|---|---|---|---|
| Kiosk | 192.168.10.144 | Linux Mint 22.3 laptop (MateBook X Pro, i7-8550U, UHD 620), runs the whole UI | `ssh -o BatchMode=yes user@192.168.10.144` (key auth from dev box; sudo password: user) |
| NAS | 192.168.10.227 | Linux Mint VM, media library + UMS + camview | `ssh -o BatchMode=yes nas@192.168.10.227` (key auth; sudo password: xaxAdm1n#) |
| AI rig | 192.168.10.125 | The dev box (this repo's master copy lives here at `/home/jon/kimi/entertainment`). Runs Ollama + (parked) Open WebUI | local |

## Architecture in one picture

- Kiosk serves the app on Apache port 80 from `/var/www/entertainment` (vhost `deploy/entertainment.conf`); Chrome `--kiosk` at boot via `~/.config/autostart/entertainment-kiosk.desktop`.
- Media: NAS exports `/mnt/sdb1/library` read-only via NFS → kiosk mounts at `/mnt/library` → Apache `Alias /media`.
- The NAS dump (`/mnt/sdb1` root) is the original messy library — **never delete it without a deliberate decision**; `library/` is hardlinks. `nas/ingest.py` (cron `*/5`) auto-files new dump arrivals (TMDB match, poster, hardlink, kiosk notify).
- `deploy/kiosk-*` wrappers on the kiosk run desktop actions as the login user, invoked from PHP via tight sudoers rules (`/etc/sudoers.d/kiosk-{vlc,stream,osk,power}`).

## The two browsers

- **Kiosk UI** runs in Chrome's *default* profile (`~/.config/google-chrome`).
- **Streaming sessions** (Netflix/YouTube/HBO/Prime/Cameras tiles) run in a *separate* profile `~/.xamedia-chrome` via `deploy/kiosk-stream` — service logins (incl. Google account) persist there. Exit badge: always-on-top Tk, fades after ~3s idle, same for the OSK badge (`kiosk-oskbd`, bottom-right) and volume badge (`kiosk-vol`, bottom-left, drag/scroll/mute). All three autostart at login.

## Credentials — where things live (never in git)

- `config/config.php` (gitignored): TMDB key, Gemini key (`gemini_api_key`), location, stations.
- NAS: `/home/nas/cleanup/nasconfig.py` (TMDB key + kiosk notify URL).
- Kiosk `data/settings.json`: PIN hash (PIN-gated Settings; default PIN 1234 — user should change).
- Open WebUI (parked on .125): Gemini key in its DB, admin API key `sk-xamedia-…c0f2`, stable `WEBUI_SECRET_KEY` in `~/.open-webui-secret` on .125.

## The Assistant (voice agent)

Kiosk-native overlay (orb, captions, dive-straight-into-talk) → `kiosk-live-proxy` (localhost:8787, autostart, holds Gemini key) → **Gemini Live API**, model `gemini-3.8-live`, voice **Leda** + `en-GB` + RP-accent system instruction.

**Hard-won protocol facts** (see commit history):
- Live API sends **binary WS frames** — decode to text before the browser sees them.
- Mic envelope must be `realtimeInput.audio` — the older `mediaChunks` is *accepted but silently ignored* (no error, model never hears you). The meter in live-proxy logs up/down bytes per session.
- Continuous realtime-paced streaming is required (VAD needs trailing silence, not an abrupt stop).

## Operational gotchas (recurring)

- **pkill/pgrep self-match**: any `pkill -f "foo"` run over ssh whose command line contains "foo" kills its own session. Use the bracket trick (`[-]foo`) or separate calls.
- **Stale browser assets**: all static files carry `?v=<filemtime>`; after deploys, `ctrl+r` the kiosk (or restart chrome).
- **sudo env**: wrappers must export `HOME`, `XDG_RUNTIME_DIR`, `DISPLAY`, `XAUTHORITY` explicitly (sudo -u doesn't reset env; VLC audio + Tk windows break otherwise).
- **Display**: Cinnamon's xrandr daemon fights manual mode changes; standardized on 1920x1080 via autostart + `~/.config/monitors.xml`.
- **Media cache**: `api/media.php` caches 6h; corrections/ingest bust it explicitly.
- **Photo ownership**: Takeout imports run without sudo (or chown after) — root-owned photos break rotate/delete.

## What's next (Phase 2)

Assistant tool-calling against the kiosk's own APIs (Live API function calling → `api/media.php`, radio, cameras, photos). The Live session + proxy are the foundation; add `tools` to the setup message and a functionCall handler in assistant.js that POSTs to the kiosk endpoints.

Other parked ideas: wake word, ffprobe codec pass for auto-VLC routing, favourites tile.

## Verification tooling

Headless driving of the kiosk UI: `google-chrome --headless --remote-debugging-port=922x` + CDP scripts (see git history for patterns), or `xdotool` + `scrot` over ssh for the real display. Proxy/session logs: `/tmp/live-proxy.log` on the kiosk (transient); ingest log at `/home/nas/cleanup/ingest.log`.
