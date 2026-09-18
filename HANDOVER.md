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

Kiosk-native overlay (orb, captions, dive-straight-into-talk) → `kiosk-live-proxy` (localhost:8787, autostart, holds Gemini key) → **Gemini Live API**, model `gemini-3.1-flash-live-preview`, voice **Leda** + `en-GB` + RP-accent system instruction.

⚠️ **Do not "upgrade" the model to `gemini-3.8-live`**: it accepts tools and emits toolCall, but after a toolResponse it ends the turn with `generationComplete` and **zero audio** — the assistant goes mute every time it uses a tool (reproduced wire-level 2026-09-18; `gemini-3.1-flash-live-preview` handles the same flow correctly; `gemini-2.5-flash-native-audio-preview-12-2025` refuses the connection on this key). Also: the instruction pins English output — without it the model code-switches when it hears Spanish in the room.

**Hard-won protocol facts** (see commit history):
- Live API sends **binary WS frames** — decode to text before the browser sees them.
- Mic envelope must be `realtimeInput.audio` — the older `mediaChunks` is *accepted but silently ignored* (no error, model never hears you). The meter in live-proxy logs up/down bytes per session.
- Continuous realtime-paced streaming is required (VAD needs trailing silence, not an abrupt stop).
- Tool calling: `tools` in the setup message; server sends `toolCall.functionCalls[]` (`id`, `name`, `args`); client answers `toolResponse.functionResponses[]` (`id`, `name`, `response`). Executed **browser-side** in assistant.js — the proxy stays a dumb relay.
- **Silent stalls happen** (seen 2026-09-18 during a Gemini demand spike): the socket stays open but the model goes mute mid-session — no close frame, no error. Defenses: assistant.js stall watchdog (user spoke + nothing downstream for 25s → rebuild session, max 2 auto-restarts) and a 12s timeout on every tool executor so a hung kiosk API can't wedge a turn. Every teardown nulls `ws.onclose` first, or the stale handler kills the fresh session.
- **Room TV breaks VAD**: the kiosk mic hears the TV; with default `START_OF_ACTIVITY_INTERRUPTS` every TV burst barges in and chops answers ("choppy, unusable"). Setup uses `realtimeInputConfig.activityHandling: 'NO_INTERRUPTION'` (accepted by 3.1-flash-live-preview) — user barge-in is sacrificed. `proactivity.proactiveAudio` (the ideal "ignore the TV" feature) is **rejected at setup** by 3.1-flash-live-preview — setup closes 1000 immediately when an unsupported field is present; test new setup fields wire-level before deploying. Short enum names (`NO_INTERRUPTION`) are required, not the `ACTIVITY_HANDLING_*` long form.
- live-proxy meter: `done.set()` in the handler finally — without it the meter task leaks per session and `gather` never returns (log fills with frozen counters, disconnects never print).

## Assistant tools, memory, proactive (Phase 2, done 2026-09-18)

- **Tools** (declared in assistant.js, executed against kiosk UI/APIs): play_movie / play_tv / play_music / stop_playback (hooks in media.js: `window.MEDIA`), play_radio / stop_radio (`window.RADIO` in radio.js), open_streaming (`window.KIOSK_STREAM` in app.js), show_photos (`window.KIOSK_PHOTOS.enter`), get_weather, open_website (→ new `api/browse.php`), web_search / read_webpage (→ new `api/web-lookup.php`, DuckDuckGo HTML + tag-stripped read), remember (→ `api/assistant-log.php`).
- **kiosk-stream allowlist widened**: `https://*` now allowed (was a service domain list); plain http still LAN-only. Reinstall the wrapper when deploying (`install -m755 -o root deploy/kiosk-stream /usr/local/bin/`).
- **Memory**: transcripts → `data/assistant/history.jsonl`; session end spawns `bin/assistant-consolidate.php` (Gemini text call — primary `assistant.text_model` = `gemini-3.6-flash`, fallback chain 3.5-flash → 3.1-flash-lite → 2.5-flash with retries, since 3.6 503s under load and the 2.x line is being retired) → rewrites `memory.md` + appends to `summary.md` (rolling narrative). Both are fetched by `api/assistant-memory.php` and injected into the next session's system instruction. Consolidation log: `data/assistant/consolidate.log`; cursor in `state.json`.
- **Multi-user (Tier 2)**: no voice-ID in the Live API, so identity is self-declared — `memory.md` is structured as per-person `## <Name>` sections plus `## Household`; the system instruction tells the model to ask who's speaking when it matters, and the remember tool name-anchors facts. Tier 3 (real speaker embeddings, e.g. SpeechBrain ECAPA on the kiosk or the AI rig) is parked.
- **Proactive greeting**: activity after >45 min idle (cooldown 4 h) opens the assistant to greet with remembered context; closes silently after ~20 s if nobody answers. Settings: `assistant` section in `data/settings.json` (`proactive_enabled`, `proactive_idle_minutes`, `proactive_cooldown_hours`, `text_model`); defaults in `lib/settings.php`.

## Operational gotchas (recurring)

- **pkill/pgrep self-match**: any `pkill -f "foo"` run over ssh whose command line contains "foo" kills its own session. Use the bracket trick (`[-]foo`) or separate calls.
- **Stale browser assets**: all static files carry `?v=<filemtime>`; after deploys, `ctrl+r` the kiosk (or restart chrome).
- **sudo env**: wrappers must export `HOME`, `XDG_RUNTIME_DIR`, `DISPLAY`, `XAUTHORITY` explicitly (sudo -u doesn't reset env; VLC audio + Tk windows break otherwise).
- **Display**: Cinnamon's xrandr daemon fights manual mode changes; standardized on 1920x1080 via autostart + `~/.config/monitors.xml`.
- **Media cache**: `api/media.php` caches 6h; corrections/ingest bust it explicitly.
- **Photo ownership**: Takeout imports run without sudo (or chown after) — root-owned photos break rotate/delete.

## What's next

Parked ideas: wake word, ffprobe codec pass for auto-VLC routing, favourites tile, CDP agentic browsing (click/scroll/fill — current browsing is open-on-screen + server-side read only), unwatched-episode tracking, settings-UI editors for the `assistant` section.

## Verification tooling

Headless driving of the kiosk UI: `google-chrome --headless --remote-debugging-port=922x` + CDP scripts (see git history for patterns), or `xdotool` + `scrot` over ssh for the real display. Proxy/session logs: `/tmp/live-proxy.log` on the kiosk (transient); ingest log at `/home/nas/cleanup/ingest.log`.
