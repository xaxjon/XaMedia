# XaMedia — Handover Notes

State as of 2026-09-21. Everything below is deployed, tested, and pushed.

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

## The Assistant v3 (cascaded pipeline, current default)

**Ambient orb badge** (`deploy/kiosk-orb`, Tk always-on-top, autostart via `kiosk-orb.desktop`, bottom-left above the volume badge): blue idle / amber thinking / green pulsing listening+speaking / red error; click toggles the session. **Doubles in size (64→128px, grows around a fixed center) while hot** and never fades while hot; cold it fades after ~3s with the other badges. There is NO on-page assistant UI and no menu tile. The badge and the page talk through `api/assistant-ctl.php` (state + toggle command in `data/assistant/control.json`; page polls `?consume=1` every 1s, badge polls state every 500ms).

**Pipeline** (`public/assets/js/assistant.js`, state machine off → listening → thinking → speaking):
- **Ear**: Chrome `SpeechRecognition` (continuous, en-US, interim results; 2.5s trailing-interim counts as end-of-turn; auto-restart on Chrome's recognition timeouts). Runs ONLY while a session is active — the TV is never streamed. Local phrases skip the brain: "go to sleep" / "stop listening" / "goodbye" etc.
- **Brain** (`api/assistant-brain.php`): POST `{text}` → `{reply}` or `{tool_calls}`; page executes tools and POSTs `{tool_results}` (cap 3 rounds). Server side: persona instruction + `memory.md` + `summary.md` + last 12 user/model lines from `history.jsonl` + the 18 tool declarations. Gemini text model from `assistant.text_model` (default gemini-3.6-flash) with fallback chain (3.5-flash → 3.1-flash-lite → 2.5-flash — note 2.5 is being retired and 404s on this key). 12s per-model cap, ~48s worst case; page timeout 55s. **Gotchas**: empty `properties` must serialize as `{}` not `[]` (use `new stdClass`); Gemini 3.x signs functionCall parts with `thoughtSignature` — the endpoint returns it per call and the page must echo it back in `tool_results` or the replay 400s.
- **Mouth** (`api/v1/audio/speech.php`): Gemini TTS (Leda, en-GB), sentence-split with prefetch pipelining; 15s per-sentence cap; browser `speechSynthesis` backstop if every sentence fails. The proxy's WAV header was fixed 2026-09-21 (`pack('VvvVVvv', …)` — field widths matter).
- **Chimes**: rising C–E–G on activation, falling on sleep (any reason incl. kill/error). Dedicated AudioContext.
- **Sleep**: 30s without any heard speech, media-start (`ASSISTANT.kill()` from openPlayer/playInVlc/KIOSK_STREAM), sleep phrase, orb click.
- **Memory**: transcripts → `data/assistant/history.jsonl`; session end spawns `bin/assistant-consolidate.php` (text_model + fallbacks) → rewrites `memory.md` (per-person `## Name` sections + `## Household`) and appends `summary.md`; both injected into the next brain call. `remember` tool writes straight to memory.md. Consolidation log: `data/assistant/consolidate.log`.
- **Telemetry**: `who=debug` lines in history.jsonl (start/heard/brain ms/tool calls/tts ms/sleep/error) — excluded from consolidation. This is what cracked every case in the Live era; keep it.
- **Cost control (paid tier)**: every transcript used to cost a full brain call (~2–3k input tokens of persona+memory+history+18 tool declarations) — in a TV-filled room that was the spend (one test evening ran ~3¢/exchange). Now a **relevance pre-filter** (gemini-3.1-flash-lite, ~500 input tokens, 3 output tokens, thinkingBudget 0) decides "addressed to the assistant?" first; NO → `{reply:'SILENT', filtered:true}` and the full brain never runs. Filter failure fails OPEN. Also: history trimmed to 8 lines, summary.md capped at 1500 chars in the payload, `thinkingBudget: 0` everywhere (2.5–3.5s → ~1s per brain call), TTS = `gemini-3.1-flash-tts-preview` with all sentences of a reply fetched in PARALLEL (serial fetching was the 13s/turn). TTS characters are negligible; the Live backend (audio tokens) is the expensive one — avoid it on paid tier.
- **Multi-user**: no voice ID — self-declared names, per-person memory sections (Tier 2). Tier 3 (speaker embeddings) parked.
- **Proactive greeting**: activity after >30 min idle (cooldown 4h) starts a session with a greet pseudo-turn; ignored → sleeps in 25s. Settings: `assistant` section in data/settings.json (`backend`, `proactive_*`, `text_model`, `live_model`).

## Live backend (legacy, `assistant-live.js`)

Kept behind Settings → Assistant → Backend = `live`. Chrome overlay JS → `kiosk-live-proxy` (localhost:8787, autostart, holds Gemini key) → **Gemini Live API**, model from `assistant.live_model` (default `gemini-3.1-flash-live-preview`), voice Leda. Historical gotchas below apply only to this path.

- Live API sends **binary WS frames** — decode to text before the browser sees them.
- Mic envelope must be `realtimeInput.audio` (`mediaChunks` is silently ignored).
- Continuous realtime-paced streaming required (VAD needs trailing silence).
- **Model availability on this key** (probed 2026-09-18/21): ONLY `gemini-3.1-flash-live-preview` works end-to-end. `gemini-3.8-live` eats post-tool turns (toolCall accepted, then turnComplete with zero audio — re-test wire-level after Google updates; the test is scripted in git history). 2.5-flash-live / 3.7/3.8-flash-live reject setup entirely.
- Silent stalls: socket open, model mute — watchdog (owes-answer 12s, deaf-upstream 30s) rebuilds, max 3/10min, then `location.reload()`.
- Dropped turnComplete under load: flush jitter tail on generationComplete; rebuild if no turnComplete in 8s.
- Realtime-paced (1.0×) voice delivery → 350ms jitter buffer required or playback stutters.
- Room TV: `realtimeInputConfig.activityHandling: 'NO_INTERRUPTION'` (barge-in sacrificed) + stay-silent instruction; `proactivity.proactiveAudio` is REJECTED by 3.1-flash-live-preview.
- live-proxy meter must run alongside the pumps (never in their gather) or every session leaks upstream until the concurrent-session limit refuses new setups.
- Unsupported setup fields → connection closes 1000 immediately; test new fields wire-level before deploying.
- **Quota insight (2026-09-21)**: the Live model's "eaten turns" coincided with 429s across ALL Gemini models on the key — continuous audio streaming burns the free tier fast. A big reason the cascade won.

## Operational gotchas (recurring)

- **pkill/pgrep self-match**: any `pkill -f "foo"` run over ssh whose command line contains "foo" kills its own session. Use the bracket trick (`[-]foo`) or separate calls.
- **Stale browser assets**: all static files carry `?v=<filemtime>`; after deploys, `ctrl+r` the kiosk (or restart chrome).
- **sudo env**: wrappers must export `HOME`, `XDG_RUNTIME_DIR`, `DISPLAY`, `XAUTHORITY` explicitly (sudo -u doesn't reset env; VLC audio + Tk windows break otherwise).
- **Display**: Cinnamon's xrandr daemon fights manual mode changes; standardized on 1920x1080 via autostart + `~/.config/monitors.xml`.
- **Media cache**: `api/media.php` caches 6h; corrections/ingest bust it explicitly.
- **Photo ownership**: Takeout imports run without sudo (or chown after) — root-owned photos break rotate/delete.
- **USB photo import**: Settings → Photos → Import from USB. udisks mounts live under `/media/<user>/<drive>` whose parent has an ACL `other::---` — www-data can't traverse them, so browse/harvest run as root via `/usr/local/bin/kiosk-photo-import` (sudoers `deploy/kiosk-photo-import.sudoers`), which confines paths to /media and chowns the harvest to www-data. Structure under the picked folder is preserved into `data/photos/<folder>/`; re-runs skip existing files (idempotent); 50k-file cap per harvest.

## What's next

Parked ideas: ffprobe codec pass for auto-VLC routing, favourites tile, CDP agentic browsing (click/scroll/fill — current browsing is open-on-screen + server-side read only), unwatched-episode tracking, offline wake word + STT (Vosk/Porcupine — replaces both Google speech services), Kimi K2 as an alternative brain (OpenAI-compatible endpoint; settings-level swap), Tier 3 speaker ID.

## Verification tooling

Headless driving of the kiosk UI: `google-chrome --headless=new --remote-debugging-port=922x --user-data-dir=/tmp/x ...` + CDP via python `websocket` with `suppress_origin=True` (see git history for patterns), or `xdotool` + `scrot` over ssh for the real display. Assistant pipeline testable voice-free: `ASSISTANT.debugTurn("open the movies please")` injects a transcript. Proxy/session logs: `/tmp/live-proxy.log` + `/tmp/kiosk-orb.log` on the kiosk (transient); assistant telemetry in `data/assistant/history.jsonl`; brain upstream errors in Apache's `entertainment-error.log`; ingest log at `/home/nas/cleanup/ingest.log`.
