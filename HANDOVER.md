# XaMedia — Handover Notes

State as of 2026-09-20. Everything below is deployed, tested, and pushed.

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

- `config/config.php` (gitignored): base config — TMDB key, Gemini key, location, stations, paths.
- `data/settings.json` (gitignored): **overrides** from the PIN-gated Settings UI — keys, assistant options, stations, UMS URL, PIN hash. UI values win. Server-side consumers read keys via `load_settings()` (lib/settings.php merges config + settings.json); `kiosk-live-proxy` reads settings.json first, falls back to the config.php regex. The settings GET endpoint masks keys (`••••xxxx`) — full keys never reach the browser.
- NAS: `/home/nas/cleanup/nasconfig.py` (TMDB key + kiosk notify URL) — separate machine, edited by hand.
- Open WebUI (parked on .125): Gemini key in its DB, admin API key `sk-xamedia-…c0f2`, stable `WEBUI_SECRET_KEY` in `~/.open-webui-secret` on .125.

## The Assistant (voice agent)

**Ambient orb badge** (`deploy/kiosk-orb`, Tk always-on-top, autostart via `kiosk-orb.desktop`, bottom-left above the volume badge): blue idle / amber connecting / green pulsing live / red error; click toggles the session. **Doubles in size (64→128px, grows around a fixed center) while hot** (live/connecting) and never fades while hot; cold it fades after ~3s with the other badges. There is NO on-page assistant UI and no menu tile. The badge and the page talk through `api/assistant-ctl.php` (state + toggle command in `data/assistant/control.json`; page polls `?consume=1` every 1s, badge polls state every 500ms). Session core (assistant.js) → `kiosk-live-proxy` (localhost:8787, autostart, holds Gemini key) → **Gemini Live API**, model `gemini-3.1-flash-live-preview`, voice **Leda** + `en-GB` + RP-accent system instruction. Assistant is killed automatically when playback starts (`ASSISTANT.kill()` from openPlayer/playInVlc/KIOSK_STREAM); the orb can restart it any time, mid-movie included — user's call.

⚠️ **Do not "upgrade" the model to `gemini-3.8-live`**: it accepts tools and emits toolCall, but after a toolResponse it ends the turn with `generationComplete` and **zero audio** — the assistant goes mute every time it uses a tool (reproduced wire-level 2026-09-18; `gemini-3.1-flash-live-preview` handles the same flow correctly; `gemini-2.5-flash-native-audio-preview-12-2025` refuses the connection on this key). Also: the instruction pins English output — without it the model code-switches when it hears Spanish in the room.

**Hard-won protocol facts** (see commit history):
- Live API sends **binary WS frames** — decode to text before the browser sees them.
- Mic envelope must be `realtimeInput.audio` — the older `mediaChunks` is *accepted but silently ignored* (no error, model never hears you). The meter in live-proxy logs up/down bytes per session.
- Continuous realtime-paced streaming is required (VAD needs trailing silence, not an abrupt stop).
- Tool calling: `tools` in the setup message; server sends `toolCall.functionCalls[]` (`id`, `name`, `args`); client answers `toolResponse.functionResponses[]` (`id`, `name`, `response`). Executed **browser-side** in assistant.js — the proxy stays a dumb relay.
- **Realtime-paced delivery**: voice answers on gemini-3.1-flash-live-preview arrive ~1.0× realtime (just-in-time); text-turn answers burst at ~3.7×. Just-in-time delivery makes per-chunk scheduling stutter on any network jitter — assistant.js therefore runs a 350ms jitter buffer (prime → play → flush tail at turnComplete → re-prime per turn).
- Side discovery 2026-09-21: `api/v1/audio/speech.php` writes a **malformed WAV header** (garbage sample-rate field — `file` reads it, ffmpeg/python wave reject it). The PCM payload itself is fine; strip 44 bytes to use. Fix when someone next touches the TTS proxy.
- **Silent stalls happen** (seen 2026-09-18 during a Gemini demand spike): the socket stays open but the model goes mute mid-session — no close frame, no error. Defenses: assistant.js stall watchdog (user spoke + nothing downstream for 25s → rebuild session, max 2 auto-restarts) and a 12s timeout on every tool executor so a hung kiosk API can't wedge a turn. Every teardown nulls `ws.onclose` first, or the stale handler kills the fresh session.
- **Room TV breaks VAD**: the kiosk mic hears the TV; with default `START_OF_ACTIVITY_INTERRUPTS` every TV burst barges in and chops answers ("choppy, unusable"). Setup uses `realtimeInputConfig.activityHandling: 'NO_INTERRUPTION'` (accepted by 3.1-flash-live-preview) — user barge-in is sacrificed. `proactivity.proactiveAudio` (the ideal "ignore the TV" feature) is **rejected at setup** by 3.1-flash-live-preview — setup closes 1000 immediately when an unsupported field is present; test new setup fields wire-level before deploying. Short enum names (`NO_INTERRUPTION`) are required, not the `ACTIVITY_HANDLING_*` long form.
- **Room noise kills aged sessions** (the big one): constant TV "activity" fills the session context window until the model fades (answers the TV, incoherent) then goes mute with the socket open. Fresh sessions always work — that's the tell. Defenses deployed: `contextWindowCompression` sliding window, a deaf-upstream watchdog arm (mic sees speech but no transcription for 30s → rebuild), a "stay silent for the TV" instruction, and **ASSISTANT.kill() on every playback path** (openPlayer, playInVlc, KIOSK_STREAM) so movie/streaming audio never pours into the mic. A client-side RMS noise gate was tried and REMOVED — measured room data: ambient p50 RMS 0.007 but TV peaks 0.13, louder than couch speech, so energy gating can't separate them (it ate user onsets and made things slower). If TV interference persists, the remaining levers are physical (mic placement, TV volume) or push-to-talk.
- **API budget burn (2026-09-20)**: ambient 24/7 listening plus watchdog churn during 503 waves shows up in the Google console as 409/503 storms and "choppy as if under extreme load" a few minutes into sessions. Countermeasures in assistant.js: **auto-hangup after 30s without user input** (never mid-answer; 5-min model-silence backstop for when the TV keeps "talking"), watchdog rebuilds capped at **3 per 10 min** (then error state, orb red, click retries), `goAway` handled by rebuilding within the same budget, and the dead `assistant` AI-Studio mapping removed from api/stream.php (streaming-profile Live sessions share the same quota). Proxy/orb autostart .desktop files now redirect to /tmp logs (they used to log nothing after a reboot).
- **Wake phrase**: "Hi Computer" (regex `\b(hi|hey|hello|ok|okay)?\s*computer\b`) starts a session via Chrome's SpeechRecognition running in the kiosk page — paused while a session is live, auto-restarted on Chrome's recognition timeouts. NB: recognition audio goes to Google's speech service; if offline-only wake word is ever wanted, the upgrade path is a local Vosk/Porcupine listener POSTing `toggle` to `api/assistant-ctl.php`. If the mic permission for speech recognition is denied, the listener disables itself silently (orb click always works).
- **Wedged mic capture (2026-09-21)**: after many hours and dozens of wake/session cycles, the main Chrome's capture died — sessions started, streamed silence upstream, model deaf (down frozen at ~726B), while `arecord` and a fresh Chrome captured fine. Fixed by restarting Chrome. The watchdog's last resort after the restart budget is now `location.reload()` (rebuilds the page pipeline; if the whole Chrome process is wedged, a full browser restart is still the cure — relaunch command mirrors deploy/entertainment-kiosk.desktop).
- **Chimes**: rising C–E–G triad when the session goes live (any trigger), falling G–E–C on sleep/error — synthesized in assistant.js on a dedicated AudioContext (never torn down by stop(), unlike the playback context).
- live-proxy meter: the meter task must run ALONGSIDE the pumps (`asyncio.ensure_future`), never inside their `gather` — it only stops on `done.set()`, which fires after the pumps finish, so gathering it deadlocks the handler: every session leaks its upstream Gemini connection forever. Symptom of the leak: the API's concurrent-session limit fills with zombies and NEW sessions connect then get nothing back (`down=0B`, setup never completes). Fixed 2026-09-18 (second attempt — the first put `done.set()` in a `finally` that only runs after the same deadlocked gather). Verify after any proxy change: connect a session, close it, expect a `disconnected` line and the meter to stop ticking.

## Assistant tools, memory, proactive (Phase 2, done 2026-09-18)

- **Tools** (declared in assistant.js, executed against kiosk UI/APIs): play_movie / play_tv / play_music / stop_playback (hooks in media.js: `window.MEDIA`), play_radio / stop_radio / open (`window.RADIO` in radio.js), open_streaming (`window.KIOSK_STREAM` in app.js), show_photos (`window.KIOSK_PHOTOS.enter`), get_weather, open_website (→ `api/browse.php`), web_search / read_webpage (→ `api/web-lookup.php`, DuckDuckGo HTML + tag-stripped read), remember (→ `api/assistant-log.php`). **UI navigation**: open_screen (movies/tv/music/radio/photos/home), select_genre, scroll_screen, go_back (media.js `navBack` mirrors the on-screen Back buttons), main_menu (uiHome in assistant.js closes every overlay).
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

Parked ideas: ffprobe codec pass for auto-VLC routing, favourites tile, CDP agentic browsing (click/scroll/fill — current browsing is open-on-screen + server-side read only), unwatched-episode tracking, settings-UI editors for the `assistant` section, offline wake word (Vosk/Porcupine) to replace the Web Speech listener.

## Verification tooling

Headless driving of the kiosk UI: `google-chrome --headless --remote-debugging-port=922x` + CDP scripts (see git history for patterns), or `xdotool` + `scrot` over ssh for the real display. Proxy/session logs: `/tmp/live-proxy.log` on the kiosk (transient); ingest log at `/home/nas/cleanup/ingest.log`.
