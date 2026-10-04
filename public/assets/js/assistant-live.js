/* Gemini Live API voice assistant — CHATBOT ONLY.
   No tools, no remote control: it holds a conversation and remembers.
   Connects to deploy/live-proxy.py on the kiosk (ws://127.0.0.1:8787), which
   relays to the Live API upstream — the API key never touches the browser.
   Mic: 16 kHz Int16 PCM out; model audio: 24 kHz Int16 PCM in.
   There is no on-page UI: the desktop orb badge (deploy/kiosk-orb) is the
   control and the indicator. Session state is published to
   api/assistant-ctl.php, and toggle commands from the badge are picked up
   from the same endpoint.
   Conversation transcripts are logged via api/assistant-log.php and the
   long-term memory from api/assistant-memory.php is injected into the
   system instruction of every session. */
(function () {
    'use strict';

    var WS_URL = 'ws://127.0.0.1:8787';
    var MIC_RATE = 16000;
    var PLAY_RATE = 24000;
    var SEND_CHUNK = MIC_RATE * 0.15; /* ~150 ms of audio per realtimeInput */

    var BASE_INSTRUCTION = 'You are the friendly home assistant on a living-room kiosk — a companion first. Always speak with a warm, natural British English accent (Received Pronunciation) and always respond in English, even if you hear another language in the room — only switch or translate when the user explicitly asks you to. The microphone also picks up the television and background chatter: if what you hear is not clearly a person addressing you, produce NO response at all — stay completely silent and never answer, repeat, or comment on the TV. Keep replies short and conversational — this is a voice conversation, not an essay. Chat, answer questions, tell stories, discuss anything. IMPORTANT: you yourself control nothing and look nothing up. When the user asks for an ACTION on the kiosk (play media, open a screen, tune the radio, menus) or for CURRENT information (news, weather, prices, scores, today\'s date), do NOT improvise: a separate system handles those and will send you a note with the outcome. Simply reply with a short holding phrase like "Let me check…" and WAIT for the note — it always comes, sometimes after several seconds — then share it briefly and naturally. Never say you cannot do something, never say you lack access, and never send the user to menus or buttons: if a note is late, stay with the holding phrase or chat warmly while you wait. For everything else — general knowledge, chat, stories — just answer yourself. Several people use this kiosk and you cannot tell voices apart: your memory below has a People section with what you know about each person. When someone tells you their name, use it and remember what you learn about them for next time. Do NOT ask who is speaking unless the answer genuinely depends on it — for general chat, just carry on. Never guess a speaker\'s identity from their voice alone.';

    function buildSetup(mem, proactive) {
        var instruction = BASE_INSTRUCTION;
        if (mem && mem.memory) {
            instruction += '\n\nWhat you remember about this household (from earlier conversations):\n' + mem.memory;
        }
        if (mem && mem.summary) {
            instruction += '\n\nRecent conversations:\n' + mem.summary;
        }
        if (proactive) {
            instruction += '\n\nYou are starting this conversation yourself because someone walked up to the kiosk. Greet the household warmly and briefly — you may reference something you remember. If no one responds, stay silent.';
        }
        var liveModel = ((window.APP_CONFIG || {}).assistant || {}).live_model || 'gemini-3.8-live';
        return {
            setup: {
                model: 'models/' + liveModel,
                generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Leda' } },
                        languageCode: 'en-GB'
                    }
                },
                systemInstruction: { parts: [{ text: instruction }] },
                /* No tools declared: gemini-3.8-live goes mute around tool
                   calls even NON_BLOCKING (verified 2026-10-03). Actions
                   are routed client-side from the user's transcription. */
                realtimeInputConfig: {
                    activityHandling: 'NO_INTERRUPTION'
                },
                /* Bound the session context — an unbounded one fills with
                   room audio until the model stops generating. */
                contextWindowCompression: {
                    slidingWindow: { targetTokens: 20000 },
                    triggerTokens: 40000
                },
                outputAudioTranscription: {},
                inputAudioTranscription: {}
            }
        };
    }

    /* Float32 (16 kHz, context rate) -> Int16 LE PCM, posted as a buffer. */
    var WORKLET_SRC =
        'class PCMCapture extends AudioWorkletProcessor {' +
        '  process(inputs) {' +
        '    var ch = inputs[0] && inputs[0][0];' +
        '    if (ch && ch.length) {' +
        '      var pcm = new Int16Array(ch.length);' +
        '      for (var i = 0; i < ch.length; i++) {' +
        '        var s = Math.max(-1, Math.min(1, ch[i]));' +
        '        pcm[i] = s < 0 ? s * 32768 : s * 32767;' +
        '      }' +
        '      this.port.postMessage(pcm.buffer, [pcm.buffer]);' +
        '    }' +
        '    return true;' +
        '  }' +
        '}' +
        "registerProcessor('pcm-capture', PCMCapture);";

    var state = 'idle'; /* idle | connecting | live | error */
    var ws = null;
    var setupDone = false;
    var micStream = null;
    var captureCtx = null;
    var captureNode = null;
    var playbackCtx = null;
    var playbackSources = [];
    var nextStartTime = 0;
    var sendBuffer = [];
    var sendLength = 0;
    var session = 0; /* bumped on every start/stop; stale async chains bail out */
    var proactive = false;
    var proactiveTimer = null;
    var pendingMemory = null;  /* memory payload awaiting the ws open */
    var lastRx = 0;            /* last downstream message timestamp */
    var lastUserSpeechAt = 0;  /* last input transcription */
    var lastModelOutputAt = 0; /* last model audio/transcription */
    var sessionStartedAt = 0;
    var lastUserText = '';     /* last user turn, for replay after a dead turn */
    var pendingReplay = null;  /* user text to re-inject after a rebuild */
    var sessionSilent = false; /* auto-restarted sessions don't chime */
    var lastGateOpenAt = 0;    /* last time the mic heard real speech */
    var GATE_RMS = 0.030;      /* speech marker opens at this normalized RMS */
    var GATE_CLOSE_RMS = 0.020;/* hysteresis: closes below this */
    var GATE_HANGOVER = 0.8;   /* seconds held open after speech */
    var gateOpen = false;
    var gateOpenUntil = 0;
    var stallTimer = null;     /* silent-upstream watchdog */
    var noTurnTimer = null;    /* generationComplete without turnComplete */
    var restartTimes = [];     /* rebuild timestamps — churn budget */
    var MAX_RESTARTS_WINDOW = 3;
    var RESTART_WINDOW_MS = 600000; /* max 3 rebuilds per 10 min */
    var SLEEP_NO_INPUT_MS = 30000;  /* hang up after 30s without user input… */
    var SLEEP_MODEL_IDLE_MS = 15000;/* …but never cut the model off mid-answer */
    var SLEEP_AFTER_MS = 300000;    /* backstop: 5 min of model silence */
    var sessionId = null;      /* conversation-log session id */
    var inBuf = '';            /* user transcription, current turn */
    var outBuf = '';           /* model transcription, current turn */
    var loggedAnything = false;
    var lastMicRms = 0;        /* most recent mic RMS (telemetry) */
    var telemetryTimer = null;

    /* ---------- state channel (orb badge) ---------- */

    function postJson(url, body) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function (r) { return r.json(); });
    }

    /* Session state is published for the desktop orb badge (kiosk-orb);
       the badge posts "toggle" commands to the same endpoint when clicked.
       The page starts idle — post it immediately so a mid-session reload
       never leaves the badge stuck showing a dead session as live. */
    function postState(s) {
        postJson('api/assistant-ctl.php', { state: s })
            .catch(function () { /* badge feedback is best-effort */ });
    }
    postState('idle');

    function toggle() {
        if (state === 'connecting') return;
        if (state === 'live') stop(); else start();
    }

    setInterval(function () {
        fetch('api/assistant-ctl.php?consume=1')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d && d.command === 'toggle') toggle();
            })
            .catch(function () { /* endpoint down — try again next tick */ });
    }, 1000);

    function base64FromInt16(pcm) {
        var bytes = new Uint8Array(pcm.length * 2);
        var view = new DataView(bytes.buffer);
        for (var i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i], true);
        var bin = '';
        for (var j = 0; j < bytes.length; j += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(j, j + 0x8000));
        }
        return btoa(bin);
    }

    function int16FromBase64(b64) {
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var view = new DataView(bytes.buffer);
        var pcm = new Int16Array(bytes.length >> 1);
        for (var j = 0; j < pcm.length; j++) pcm[j] = view.getInt16(j * 2, true);
        return pcm;
    }

    /* ---------- activation chimes ---------- */

    /* Soft synthesized cues on their own audio context — independent of
       the playback context, which stop() tears down. Chime up when the
       session goes live, chime down when it sleeps (any reason). */
    var chimeCtx = null;

    function chime(freqs) {
        try {
            if (!chimeCtx) {
                chimeCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (chimeCtx.state === 'suspended') chimeCtx.resume();
            var t0 = chimeCtx.currentTime + 0.02;
            freqs.forEach(function (f, i) {
                var osc = chimeCtx.createOscillator();
                var gain = chimeCtx.createGain();
                osc.type = 'sine';
                osc.frequency.value = f;
                var start = t0 + i * 0.16;
                gain.gain.setValueAtTime(0, start);
                gain.gain.linearRampToValueAtTime(0.22, start + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.001, start + 0.34);
                osc.connect(gain);
                gain.connect(chimeCtx.destination);
                osc.start(start);
                osc.stop(start + 0.4);
            });
        } catch (e) { /* chimes are cosmetic — never break a session */ }
    }

    function chimeUp() { chime([523.25, 659.25, 783.99]); }   /* C5 E5 G5 */
    function chimeDown() { chime([783.99, 659.25, 523.25]); } /* G5 E5 C5 */

    /* ---------- mic capture ---------- */

    function setupCapture(stream) {
        captureCtx = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: MIC_RATE
        });
        var url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
        return captureCtx.audioWorklet.addModule(url).then(function () {
            URL.revokeObjectURL(url);
            var source = captureCtx.createMediaStreamSource(stream);
            captureNode = new AudioWorkletNode(captureCtx, 'pcm-capture');
            captureNode.port.onmessage = function (ev) {
                onMicChunk(new Int16Array(ev.data));
            };
            source.connect(captureNode);
            /* keep the node pulled; its output is silence */
            captureNode.connect(captureCtx.destination);
        });
    }

    function onMicChunk(pcm) {
        /* Track "someone is speaking at the mic" for the stall watchdog. */
        var sum = 0;
        for (var i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
        var rms = Math.sqrt(sum / Math.max(1, pcm.length)) / 32768;
        lastMicRms = rms;
        var now = performance.now() / 1000;
        if (rms >= GATE_RMS) {
            gateOpen = true;
            gateOpenUntil = now + GATE_HANGOVER;
            lastGateOpenAt = Date.now();
        } else if (gateOpen && rms < GATE_CLOSE_RMS && now > gateOpenUntil) {
            gateOpen = false;
        }

        sendBuffer.push(pcm);
        sendLength += pcm.length;
        if (setupDone && ws && ws.readyState === WebSocket.OPEN && sendLength >= SEND_CHUNK) {
            flushMic();
        }
    }

    function flushMic() {
        var pcm = new Int16Array(sendLength);
        var off = 0;
        for (var i = 0; i < sendBuffer.length; i++) {
            pcm.set(sendBuffer[i], off);
            off += sendBuffer[i].length;
        }
        sendBuffer = [];
        sendLength = 0;
        try {
            ws.send(JSON.stringify({
                realtimeInput: {
                    audio: {
                        mimeType: 'audio/pcm;rate=' + MIC_RATE,
                        data: base64FromInt16(pcm)
                    }
                }
            }));
        } catch (e) { /* socket died between check and send */ }
    }

    /* ---------- playback ---------- */

    function ensurePlaybackCtx() {
        if (!playbackCtx) {
            playbackCtx = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: PLAY_RATE
            });
            nextStartTime = 0;
        }
        if (playbackCtx.state === 'suspended') playbackCtx.resume();
    }

    /* Jitter buffer: voice turns arrive realtime-paced (just-in-time), so
       any network jitter becomes an audible gap if chunks are scheduled
       immediately. Prime ~350ms before starting and after every underrun;
       the cost is a third of a second of latency, the gain is gapless
       playback. Flushed early at turn end so short replies aren't held. */
    var pendingPcm = [];
    var pendingDur = 0;
    var priming = true;
    var PRIME_SECONDS = 0.35;

    function scheduleChunk(pcm) {
        var buf = playbackCtx.createBuffer(1, pcm.length, PLAY_RATE);
        var data = buf.getChannelData(0);
        for (var i = 0; i < pcm.length; i++) {
            data[i] = pcm[i] / 32768;
        }
        var src = playbackCtx.createBufferSource();
        src.buffer = buf;
        src.connect(playbackCtx.destination);
        var now = playbackCtx.currentTime;
        if (nextStartTime < now + 0.02) nextStartTime = now + 0.02;
        src.start(nextStartTime);
        nextStartTime += buf.duration;
        playbackSources.push(src);
        src.onended = function () {
            var idx = playbackSources.indexOf(src);
            if (idx >= 0) playbackSources.splice(idx, 1);
        };
    }

    function flushPending() {
        while (pendingPcm.length) {
            scheduleChunk(pendingPcm.shift());
        }
        pendingDur = 0;
    }

    function schedulePlayback(b64) {
        ensurePlaybackCtx();
        var pcm = int16FromBase64(b64);
        if (!pcm.length) return;
        pendingPcm.push(pcm);
        pendingDur += pcm.length / PLAY_RATE;
        if (priming && pendingDur < PRIME_SECONDS) return;
        priming = false;
        flushPending();
    }

    /* barge-in: drop everything queued or playing */
    function clearPlayback() {
        playbackSources.forEach(function (s) { try { s.stop(); } catch (e) {} });
        playbackSources = [];
        nextStartTime = 0;
        pendingPcm = [];
        pendingDur = 0;
        priming = true;
    }

    /* ---------- conversation log ---------- */

    function postLog(body) {
        body.session = sessionId;
        fetch('api/assistant-log.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).catch(function () { /* logging must never break the session */ });
    }

    function flushTurn() {
        if (inBuf.trim()) {
            lastUserText = inBuf.trim();
            postLog({ who: 'user', text: inBuf.trim() });
            loggedAnything = true;
        }
        if (outBuf.trim()) {
            lastUserText = ''; /* the model answered — nothing to replay */
            postLog({ who: 'model', text: outBuf.trim() });
            loggedAnything = true;
        }
        inBuf = '';
        outBuf = '';
    }

    /* ---------- tools ---------- */

    /* ---------- UI navigation (voice) ---------- */

    function uiHome() {
        if (window.MEDIA && window.MEDIA.closePlayerUi) window.MEDIA.closePlayerUi();
        ['media-overlay', 'radio-overlay', 'photos-overlay', 'settings-overlay', 'photo-view']
            .forEach(function (id) {
                var el = document.getElementById(id);
                if (el) el.hidden = true;
            });
        document.body.classList.remove('photo-mode');
        ['photo-exit', 'photo-edit'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.hidden = true;
        });
        return Promise.resolve({ ok: true, result: 'Back to the main menu.' });
    }

    function uiScroll(dir) {
        var dy = (dir === 'up' ? -1 : 1);
        var mediaOverlay = document.getElementById('media-overlay');
        if (mediaOverlay && !mediaOverlay.hidden) return window.MEDIA.scrollPage(dir);
        var ids = ['radio-my', 'radio-browse-list', 'photos-grid'];
        for (var i = 0; i < ids.length; i++) {
            var el = document.getElementById(ids[i]);
            if (el && el.offsetParent !== null && el.clientHeight > 0) {
                el.scrollBy({ top: dy * el.clientHeight * 0.8, behavior: 'smooth' });
                return Promise.resolve({ ok: true, result: 'Scrolled ' + dir + '.' });
            }
        }
        var settingsBody = document.querySelector('.settings-body');
        if (settingsBody && settingsBody.offsetParent !== null) {
            settingsBody.scrollBy({ top: dy * settingsBody.clientHeight * 0.8, behavior: 'smooth' });
            return Promise.resolve({ ok: true, result: 'Scrolled ' + dir + '.' });
        }
        return Promise.resolve({ ok: true, result: 'There is nothing to scroll right now.' });
    }

    var EXECUTORS = {
        play_movie: function (a) { return window.MEDIA.playMovie(a.title || ''); },
        play_tv: function (a) { return window.MEDIA.playTv(a.show || '', a.season, a.episode); },
        play_music: function (a) { return window.MEDIA.playMusic(a.query || ''); },
        stop_playback: function () { return window.MEDIA.stop(); },
        play_radio: function (a) { return window.RADIO.play(a.station); },
        stop_radio: function () { return window.RADIO.stop(); },
        open_streaming: function (a) {
            return window.KIOSK_STREAM(a.service).then(function (res) {
                return res && res.ok
                    ? { ok: true, result: 'Opening ' + a.service + ' on the screen.' }
                    : { ok: false, result: 'Could not open ' + a.service + '.' };
            });
        },
        show_photos: function () {
            window.KIOSK_PHOTOS.enter();
            return Promise.resolve({ ok: true, result: 'Showing the photo slideshow.' });
        },
        get_weather: function () {
            return fetch('api/weather.php')
                .then(function (r) { return r.json(); })
                .then(function (w) { return { ok: true, result: w }; })
                .catch(function () { return { ok: false, result: 'Weather is unavailable right now.' }; });
        },
        open_website: function (a) {
            return postJson('api/browse.php', { url: a.url })
                .then(function (res) {
                    return res && res.ok
                        ? { ok: true, result: 'Opening that website on the screen.' }
                        : { ok: false, result: res && res.error ? 'Could not open it: ' + res.error : 'Could not open that website.' };
                })
                .catch(function () { return { ok: false, result: 'Could not open that website.' }; });
        },
        web_search: function (a) {
            return postJson('api/web-lookup.php', { action: 'search', q: a.query })
                .catch(function () { return { ok: false, result: 'The web search failed.' }; });
        },
        read_webpage: function (a) {
            return postJson('api/web-lookup.php', { action: 'read', url: a.url })
                .catch(function () { return { ok: false, result: 'Could not read that page.' }; });
        },
        remember: function (a) {
            return postJson('api/assistant-log.php', { remember: a.fact })
                .then(function () { return { ok: true, result: 'Noted — I will remember that.' }; })
                .catch(function () { return { ok: false, result: 'I could not store that right now.' }; });
        },
        open_screen: function (a) {
            var s = String(a.screen || '').toLowerCase();
            if (s === 'home' || s === 'main menu' || s === 'menu' || s === 'main') return uiHome();
            if (s === 'movie' || s === 'movies') return window.MEDIA.openTab('movies');
            if (s === 'tv' || s === 'series' || s === 'shows') return window.MEDIA.openTab('tv');
            if (s === 'music') return window.MEDIA.openTab('music');
            if (s === 'radio') return window.RADIO.open();
            if (s === 'photos' || s === 'photo') {
                window.KIOSK_PHOTOS.enter();
                return Promise.resolve({ ok: true, result: 'Opening photos.' });
            }
            return Promise.resolve({ ok: false, result: 'I can open movies, TV, music, radio, photos, or the main menu.' });
        },
        select_genre: function (a) { return window.MEDIA.selectGenre(a.genre || ''); },
        scroll_screen: function (a) {
            return uiScroll(String(a.direction || 'down').toLowerCase() === 'up' ? 'up' : 'down');
        },
        go_back: function () { return window.MEDIA.back(); },
        main_menu: function () { return uiHome(); }
    };

    function dispatchAction(action, query) {
        switch (action) {
            case 'play_movie': return window.MEDIA.playMovie(query);
            case 'play_tv': return window.MEDIA.playTv(query);
            case 'play_music': return window.MEDIA.playMusic(query);
            case 'stop_playback': return window.MEDIA.stop();
            case 'play_radio': return window.RADIO.play(query || undefined);
            case 'stop_radio': return window.RADIO.stop();
            case 'open_streaming': return EXECUTORS.open_streaming({ service: query });
            case 'show_photos': return EXECUTORS.show_photos();
            case 'open_screen': return EXECUTORS.open_screen({ screen: query });
            case 'select_genre': return EXECUTORS.select_genre({ genre: query });
            case 'scroll_screen': return EXECUTORS.scroll_screen({ direction: query });
            case 'go_back': return EXECUTORS.go_back();
            case 'main_menu': return EXECUTORS.main_menu();
            default: return Promise.resolve({ ok: false, result: 'Unknown action: ' + action });
        }
    }

    function injectNote(text) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify({ clientContent: {
                    turns: [{ role: 'user', parts: [{ text: text }] }],
                    turnComplete: true
                } }));
            } catch (e) { /* socket died mid-injection */ }
        }
    }

    /* Lookups go to the Scout (grounded text call); the answer comes back
       into the Live session as a system note the model voices naturally.
       The results page also opens on the kiosk screen. */
    function showSearchOnScreen(query) {
        postJson('api/browse.php', { url: 'https://duckduckgo.com/?q=' + encodeURIComponent(query) })
            .catch(function () { /* on-screen results are best-effort */ });
    }

    function handleLookup(query) {
        actedThisTurn = true;
        telemetry('scout: ' + query);
        showSearchOnScreen(query);
        postJson('api/assistant-scout.php', { q: query })
            .then(function (res) {
                if (res && res.reply) {
                    injectNote('(System note: the answer to the lookup "' + query + '" is: ' + res.reply + ' Share it with the user briefly and naturally.)');
                } else {
                    injectNote('(System note: the lookup "' + query + '" failed — the information service is unavailable. Apologise briefly to the user.)');
                }
            })
            .catch(function () {
                injectNote('(System note: the lookup "' + query + '" failed — the information service is unavailable. Apologise briefly to the user.)');
            });
    }

    function handleToolCall(toolCall) {
        var calls = toolCall.functionCalls || [];
        var responses = [];
        calls.forEach(function (fc) {
            var args = fc.args || {};
            var action = String(args.action || '').toLowerCase();
            var query = String(args.query || '');
            telemetry('tool ' + fc.name + ' ' + action + (query ? ' "' + query.slice(0, 60) + '"' : ''));
            if (fc.name === 'kiosk_action' && action === 'lookup') {
                handleLookup(query);
            } else if (fc.name === 'kiosk_action') {
                /* fire and forget — the model never waits (NON_BLOCKING) */
                dispatchAction(action, query).then(function (res) {
                    telemetry('action ' + action + ' -> ' + (res && res.result ? String(res.result).slice(0, 80) : '?'));
                });
            }
            responses.push({ id: fc.id, name: fc.name,
                response: { result: 'ok', scheduling: 'SILENT' } });
        });
        if (responses.length && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
        }
    }

    /* ---------- client-side intent routing (Layers 2 + 3) ---------- */

    /* The Voice controls nothing (3.8-live mutes around ANY tool call,
       even NON_BLOCKING — verified 2026-10-03). Instead we read the
       user's own words from the transcription: a STANDARD COMMAND
       VOCABULARY fires the local executors instantly and free; current-info
       questions go to the Scout; both come back to the Voice as an
       injected note. "Command, …" forces interpretation; unclear commands
       get quick verbal help; "help" shows the cheat sheet on screen. */
    var intentTimer = null;
    var lastIntentText = '';
    var searchMode = false;   /* "Start search" arms the next utterance */
    var actedThisTurn = false;/* something fired for the current user turn */
    var holdBackstopTimer = null;

    function scheduleIntent(text) {
        clearTimeout(intentTimer);
        intentTimer = setTimeout(function () { maybeAct(text); }, 800);
    }

    /* Fire a local action, then tell the Voice what happened — it voices
       the outcome in its own words. */
    function actNote(run, fallbackNote) {
        actedThisTurn = true;
        Promise.resolve(run()).then(function (res) {
            var result = (res && res.result) ? String(res.result) : fallbackNote;
            telemetry('act -> ' + result.slice(0, 80));
            injectNote('(System note: ' + result + ' Share it with the user briefly and naturally.)');
        }).catch(function () {
            injectNote('(System note: that action failed. Apologise briefly to the user.)');
        });
    }

    /* ---------- the standard command vocabulary (also the cheat sheet) ---------- */

    var COMMAND_SHEET = [
        ['Movies & TV', ['"Open movies"', '"Play The Matrix"', '"Play a comedy"', '"Play Breaking Bad season two"', '"Stop"']],
        ['Radio & Music', ['"Play radio"', '"Play BBC"', '"Stop the radio"', '"Play Miles Davis"']],
        ['Screens', ['"Go home"', '"Scroll down"', '"Go back"', '"Open YouTube"', '"Close the browser"', '"Show photos"']],
        ['Volume', ['"Volume up"', '"Volume down"', '"Mute"']],
        ['Web', ['"Start search" — then your question', '"What\'s the news"', '"What\'s the weather"']],
        ['Tip', ['Say "Command" first to force an action: "Command, play 2001"']]
    ];

    function showCommandSheet() {
        var el = document.getElementById('command-sheet');
        if (!el) {
            el = document.createElement('div');
            el.id = 'command-sheet';
            var html = '<div class="cs-panel"><div class="cs-head"><span>What you can say</span>' +
                '<button class="cs-close" type="button" aria-label="Close">&times;</button></div><div class="cs-cols">';
            COMMAND_SHEET.forEach(function (grp) {
                html += '<div class="cs-group"><h4>' + grp[0] + '</h4>';
                grp[1].forEach(function (c) { html += '<div class="cs-cmd">' + c + '</div>'; });
                html += '</div>';
            });
            html += '</div></div>';
            el.innerHTML = html;
            document.body.appendChild(el);
            el.addEventListener('click', function (e) {
                if (e.target === el || e.target.classList.contains('cs-close')) hideCommandSheet();
            });
        }
        el.hidden = false;
        clearTimeout(el._t);
        el._t = setTimeout(hideCommandSheet, 30000);
    }

    function hideCommandSheet() {
        var el = document.getElementById('command-sheet');
        if (el) el.hidden = true;
    }

    var GENRE_STOP = ['the', 'a', 'an', 'some', 'any', 'more', 'good', 'new'];
    var FILLER = /^(?:please[, ]+|can you |could you |would you |will you |hey |ok(?:ay)? )+/i;

    function maybeAct(text) {
        text = (text || '').trim();
        if (!text || text === lastIntentText) return;
        lastIntentText = text;
        telemetry('intent? ' + text);

        /* "Start search" arms a one-shot lookup for the next utterance. */
        if (/^start search\b/i.test(text)) {
            searchMode = true;
            injectNote('(System note: search mode is on. Ask the user, briefly, what they would like you to look up.)');
            return;
        }
        if (searchMode) {
            searchMode = false;
            handleLookup(text);
            return;
        }

        /* "Command, …" forces action interpretation; unclear commands get
           quick verbal help (see the end of this function). */
        var forced = false;
        var m;
        if ((m = text.match(/^(?:computer,? )?command[:,.]?\s*(.+)$/i))) {
            forced = true;
            text = m[1].trim();
            telemetry('forced command: ' + text);
        }
        text = text.replace(FILLER, '').trim();

        /* help / command cheat sheet */
        if (/\b(help|commands|what can (?:i|you) (?:say|do)|show commands|what are (?:the )?commands)\b/i.test(text)) {
            showCommandSheet();
            actedThisTurn = true;
            injectNote('(System note: the command sheet is on screen now. Offer the user two or three spoken examples briefly, like "play a comedy", "volume up", or "what\'s the news".)');
            return;
        }

        /* ---- commands (Layer 2: local, free, instant) ---- */
        if (/^radio[.!]?$/i.test(text)) {
            return actNote(function () { return window.RADIO.play(); }, 'The radio is playing.');
        }
        if (/\b(?:open|ohne) (?:the )?movies?\b/i.test(text)) {
            return actNote(function () { return window.MEDIA.openTab('movies'); }, 'The movie browser is open.');
        }
        if (/\b(?:open|go to|go back to) (?:the )?(?:home ?page|home ?screen|main ?menu)\b/i.test(text)) {
            return actNote(function () { return EXECUTORS.main_menu(); }, 'Back at the main menu.');
        }
        if (/\b(?:look (?:under|at)|open|show|browse)(?: the)? music\b/i.test(text)) {
            return actNote(function () { return window.MEDIA.openTab('music'); }, 'The music browser is open.');
        }
        if (/\bopen (?:the )?(?:tv|series|shows)\b/i.test(text)) {
            return actNote(function () { return window.MEDIA.openTab('tv'); }, 'The TV browser is open.');
        }
        if (/\bopen (?:the )?radio\b/i.test(text)) {
            return actNote(function () { return window.RADIO.open(); }, 'The radio panel is open.');
        }
        if ((m = text.match(/\bopen (netflix|youtube|hbo|max|prime|cameras)\b/i))) {
            return actNote(function () { return window.KIOSK_STREAM(m[1].toLowerCase()); }, 'Opening ' + m[1] + '.');
        }
        if (/\b(?:open|show|start)(?: the)? photos?\b/i.test(text)) {
            return actNote(function () { window.KIOSK_PHOTOS.enter(); return { ok: true, result: 'The photo slideshow is on screen.' }; }, 'Photos are on screen.');
        }
        if (/\bmain menu|go home|back to (?:the )?(?:home|menu)|close (?:everything|it all|all)\b/i.test(text)) {
            return actNote(function () { return EXECUTORS.main_menu(); }, 'Back at the main menu.');
        }
        if (/\b(?:exit|close)(?: the)? (?:browser|search|website|web ?page)\b/i.test(text)) {
            return actNote(function () { return postJson('api/volume.php', { action: 'close_browser' }); }, 'Browser closed.');
        }
        if (/\bscroll down\b/i.test(text)) {
            return actNote(function () { return EXECUTORS.scroll_screen({ direction: 'down' }); }, 'Scrolled down.');
        }
        if (/\bscroll up\b/i.test(text)) {
            return actNote(function () { return EXECUTORS.scroll_screen({ direction: 'up' }); }, 'Scrolled up.');
        }
        if (/\bgo back\b/i.test(text)) {
            return actNote(function () { return EXECUTORS.go_back(); }, 'Went back a level.');
        }

        /* ---- volume ---- */
        if ((m = text.match(/\b(?:volume|vol)(?: to)? (\d{1,3})(?:%| percent)?\b/i))) {
            return actNote(function () { return postJson('api/volume.php', { action: 'set', value: Number(m[1]) }); }, 'Volume set.');
        }
        if (/\b(?:volume|vol) up\b|\blouder\b/i.test(text)) {
            return actNote(function () { return postJson('api/volume.php', { action: 'up' }); }, 'Volume up.');
        }
        if (/\b(?:volume|vol) down\b|\bquieter\b|\bsofter\b/i.test(text)) {
            return actNote(function () { return postJson('api/volume.php', { action: 'down' }); }, 'Volume down.');
        }
        if (/\bunmute\b/i.test(text)) {
            return actNote(function () { return postJson('api/volume.php', { action: 'unmute' }); }, 'Unmuted.');
        }
        if (/\bmute\b/i.test(text)) {
            return actNote(function () { return postJson('api/volume.php', { action: 'mute' }); }, 'Muted.');
        }

        /* ---- genre play / filter ---- */
        if ((m = text.match(/\b(?:find|show|select|filter)(?: me)? (?:a |an |some )?([a-z-]+) (?:movies?|films?)\b/i)) && GENRE_STOP.indexOf(m[1].toLowerCase()) < 0) {
            return actNote(function () { return window.MEDIA.playGenre(m[1]); }, 'Playing something in that genre.');
        }
        if ((m = text.match(/\bplay (?:a |an |some )?(comedy|comedies|action|drama|dramas|thriller|thrillers|horror|documentary|documentaries|romance|rom-com|sci-?fi|fantasy|western|crime|mystery|adventure|animation|animated|family|war|history|musical)\b/i))) {
            return actNote(function () { return window.MEDIA.playGenre(m[1]); }, 'Playing something in that genre.');
        }
        if ((m = text.match(/\b(?:show|select|filter)(?: me)? ([a-z]+) movies\b/i)) && GENRE_STOP.indexOf(m[1].toLowerCase()) < 0) {
            return actNote(function () { return EXECUTORS.select_genre({ genre: m[1] }); }, 'Filtering movies.');
        }

        /* ---- playback control ---- */
        if (/\bstop (?:the )?radio\b/i.test(text)) {
            return actNote(function () { return window.RADIO.stop(); }, 'Radio stopped.');
        }
        if (/\bstop (?:the )?(?:movie|film|video|playback|playing|music)\b/i.test(text)) {
            return actNote(function () { return window.MEDIA.stop(); }, 'Playback stopped.');
        }
        if (/\bplay (?:the )?radio\b/i.test(text)) {
            return actNote(function () { return window.RADIO.play(); }, 'The radio is playing.');
        }
        if ((m = text.match(/\bplay (?:the )?(?:movie|film) (.+)/i))) {
            return actNote(function () { return window.MEDIA.playMovie(m[1]); }, 'Playing that movie.');
        }
        if ((m = text.match(/\bplay (?:the )?(?:series|show|episode)(?: of)? (.+)/i))) {
            return actNote(function () { return window.MEDIA.playTv(m[1]); }, 'Playing that show.');
        }
        if ((m = text.match(/\bplay (.+?) season (\d+)(?: episode (\d+))?/i))) {
            return actNote(function () { return window.MEDIA.playTv(m[1], m[2], m[3]); }, 'Playing that episode.');
        }
        if ((m = text.match(/\bplay (?:some |a )?(?:song|music|track|album)(?: by)? (.+)/i))) {
            return actNote(function () { return window.MEDIA.playMusic(m[1]); }, 'Playing that music.');
        }
        if ((m = text.match(/\bplay (?:the )?(.+?) (?:radio|station)\b/i))) {
            return actNote(function () { return window.RADIO.play(m[1]); }, 'Tuning the radio.');
        }
        if ((m = text.match(/\bwatch (.+)/i))) {
            return actNote(function () { return window.MEDIA.playMovie(m[1]); }, 'Playing that.');
        }
        /* "Play <title>" — late catch-all with a MUSIC fallback
           ("Play Carmina Burana" is music, not a movie). */
        if ((m = text.match(/\bplay (.+)/i))) {
            return actNote(function () {
                return window.MEDIA.playMovie(m[1]).then(function (res) {
                    if (res && res.ok) return res;
                    return window.MEDIA.playMusic(m[1]);
                });
            }, 'Playing that.');
        }
        /* "Open <title>" — anything not caught above is treated as a movie
           title ("Open 2001" → 2001: A Space Odyssey). */
        if ((m = text.match(/\bopen (.+)/i))) {
            return actNote(function () { return window.MEDIA.playMovie(m[1]); }, 'Opening that.');
        }

        /* ---- lookups (Layer 3: Scout, grounded search) ---- */
        if (/\b(news|headlines|weather|forecast|temperature|cloud|cloudy|rain|raining|wind|windy|sun|sunny|storm|humid|latest|current events|scores?|results?|prices?|who won|look ?up|search for|what happened)\b/i.test(text)) {
            handleLookup(text);
            return;
        }

        /* A FORCED command that matched nothing → quick simple verbal help. */
        if (forced) {
            actedThisTurn = true;
            telemetry('forced-unmatched: ' + text);
            injectNote('(System note: the command "' + text + '" was not understood. Give the user quick simple help verbally — name about four things they can say, like "play a comedy", "open movies", "volume up", or "what\'s the news" — and mention they can say "help" to see every command on screen.)');
            return;
        }
    }

    /* ---------- server messages ---------- */

    /* Transcriptions arrive as cumulative text within a turn on this API,
       but tolerate delta-style chunks too. */
    function absorbTranscription(buf, text) {
        if (buf && text.indexOf(buf) === 0) return text;
        return buf + text;
    }

    function handleServer(msg) {
        lastRx = Date.now();
        if (msg.setupComplete) {
            setupDone = true;
            state = 'live';
            postState('live');
            if (!sessionSilent) chimeUp();
            sessionSilent = false;
            if (pendingReplay) {
                /* The previous session ignored this request — ask again. */
                var replay = pendingReplay;
                pendingReplay = null;
                telemetry('replay: ' + replay);
                try {
                    ws.send(JSON.stringify({ clientContent: {
                        turns: [{ role: 'user', parts: [{ text: replay }] }],
                        turnComplete: true
                    } }));
                } catch (e) { /* socket died mid-restart */ }
            }
            if (proactive) {
                /* Nobody answers the greeting → hang up quietly. */
                proactiveTimer = setTimeout(stop, 20000);
            }
            armStallWatchdog();
            armTelemetry();
            return;
        }
        if (msg.toolCall) {
            handleToolCall(msg.toolCall);
        }
        if (msg.goAway) {
            /* The server is about to abort this session — rebuild now. */
            restartSession();
            return;
        }
        var sc = msg.serverContent;
        if (!sc) return;
        if (sc.interrupted) {
            clearPlayback();
            outBuf = '';
        }
        if (sc.generationComplete) {
            lastModelOutputAt = Date.now();
            /* Flush the jitter-buffer tail NOW: the API sometimes drops
               turnComplete under load, and without this a short answer
               would sit in the buffer unheard — the "stall". */
            if (priming && pendingPcm.length) {
                priming = false;
                flushPending();
            }
            /* And if turnComplete never follows, the session is dead —
               rebuild it. */
            clearTimeout(noTurnTimer);
            noTurnTimer = setTimeout(function () {
                if (state === 'live') {
                    telemetry('no-turncomplete');
                    restartSession();
                }
            }, 20000);
        }
        var parts = sc.modelTurn && sc.modelTurn.parts;
        if (parts) {
            for (var i = 0; i < parts.length; i++) {
                var inline = parts[i] && parts[i].inlineData;
                if (inline && inline.data && /^audio\/pcm/.test(inline.mimeType || '')) {
                    lastModelOutputAt = Date.now();
                    schedulePlayback(inline.data);
                }
            }
        }
        var inText = sc.inputTranscription && sc.inputTranscription.text;
        if (inText) {
            inBuf = absorbTranscription(inBuf, inText);
            scheduleIntent(inBuf);
            actedThisTurn = false;
            clearTimeout(holdBackstopTimer);
            lastUserSpeechAt = Date.now();
            if (proactiveTimer) {
                clearTimeout(proactiveTimer);
                proactiveTimer = null;
            }
        }
        var outText = sc.outputTranscription && sc.outputTranscription.text;
        if (outText) {
            outBuf = absorbTranscription(outBuf, outText);
            lastModelOutputAt = Date.now();
            /* The Voice said the holding phrase but NOTHING fired on our
               side — don't let it hang for 30s: nudge it to carry on. */
            if (/let me check/i.test(outText) && !actedThisTurn) {
                clearTimeout(holdBackstopTimer);
                holdBackstopTimer = setTimeout(function () {
                    if (!actedThisTurn) {
                        telemetry('hold-backstop');
                        injectNote('(System note: there was nothing to do for that — just carry on the conversation naturally and warmly.)');
                    }
                }, 6000);
            }
        }
        if (sc.turnComplete) {
            clearTimeout(noTurnTimer);
            noTurnTimer = null;
            lastModelOutputAt = Date.now();
            if (priming && pendingPcm.length) {
                /* short reply held by the jitter buffer — play the tail */
                priming = false;
                flushPending();
            }
            priming = true; /* re-buffer the next turn */
            flushTurn();
        }
    }

    /* ---------- session telemetry ---------- */

    /* Every 5s while live, log the watchdog's own view: ages of the last
       downstream frame / user speech / model output, jitter-buffer depth,
       gate and mic level. This is what turned "the API is fine in every
       simulation" into "the real session does X instead". */
    function telemetry(line) {
        postLog({ who: 'debug', text: line });
    }

    function armTelemetry() {
        clearInterval(telemetryTimer);
        telemetryTimer = setInterval(function () {
            if (state !== 'live') return;
            var now = Date.now();
            telemetry('rx-' + (now - lastRx)
                + ' user-' + (now - lastUserSpeechAt)
                + ' model-' + (now - lastModelOutputAt)
                + ' pend-' + pendingDur.toFixed(2)
                + ' gate-' + (gateOpen ? 1 : 0)
                + ' rms-' + lastMicRms.toFixed(4));
        }, 5000);
    }

    /* ---------- stall watchdog ---------- */

    /* Session rebuild, rate-limited: max 3 per 10 minutes, then reload
       the page (a wedged mic capture can't be fixed session-side). The
       budget stops the watchdog from hammering an already-overloaded API
       during 503 waves. Auto-restarts are chime-free — during an API
       degradation window the chimes themselves sound like stuttering.
       When the trigger was an ignored turn, the user's last words are
       replayed into the new session so the request isn't lost. */
    function restartSession(replay) {
        telemetry('restart' + (replay ? '-replay' : ''));
        /* Never replay fragments — a chopped two-word utterance is
           meaningless to a fresh session and just confuses it. */
        if (replay && lastUserText && lastUserText.split(/\s+/).length >= 3) {
            pendingReplay = lastUserText;
        }
        if (stallTimer) {
            clearInterval(stallTimer);
            stallTimer = null;
        }
        var cutoff = Date.now() - RESTART_WINDOW_MS;
        restartTimes = restartTimes.filter(function (t) { return t > cutoff; });
        if (restartTimes.length >= MAX_RESTARTS_WINDOW) {
            /* Session-level rebuilds can't fix this — usually a wedged mic
               capture in the browser process. A page reload rebuilds the
               whole pipeline cleanly. */
            location.reload();
            return;
        }
        restartTimes.push(Date.now());
        teardownAudio();
        state = 'idle';
        start({ proactive: proactive, silent: true });
    }

    /* The Live API occasionally stalls under load: the socket stays open
       but the model goes silent while the mic keeps streaming. Rebuild the
       session when (a) the user spoke and nothing came back for 25s, or
       (b) someone is clearly speaking at the mic but not even a
       transcription has arrived for 30s — the upstream is deaf. A quiet
       room arms neither.
       Auto-sleep: hang up after 30s without user input (never mid-answer),
       with a 5-min model-silence backstop for rooms where the TV keeps
       "talking". Ambient 24/7 listening burns the API's rate budgets —
       which is exactly what the throttling feeds on. */
    function armStallWatchdog() {
        if (stallTimer) clearInterval(stallTimer);
        stallTimer = setInterval(function () {
            if (state !== 'live') return;
            /* Someone at the mic (gate recently open) always postpones
               sleep — a dead transcription feed must never make the
               assistant doze off while the user is mid-sentence. */
            var gateRecently = (Date.now() - lastGateOpenAt) < 15000;
            var noInput = Date.now() - lastUserSpeechAt > SLEEP_NO_INPUT_MS;
            var modelIdle = Date.now() - lastModelOutputAt > SLEEP_MODEL_IDLE_MS;
            var modelSilentLong = Date.now() - lastModelOutputAt > SLEEP_AFTER_MS;
            if (!gateRecently && ((noInput && modelIdle) || modelSilentLong)) {
                telemetry('sleep noinput-' + noInput + ' idle-' + modelIdle + ' long-' + modelSilentLong);
                stop();
                return;
            }
            /* The upstream is DEAF: the mic hears someone but no input
               transcription has arrived for 20s. Keepalive frames mask
               this from lastRx — key off real speech events instead. */
            var lastHeard = Math.max(lastUserSpeechAt, sessionStartedAt);
            var deafUpstream = gateRecently && (Date.now() - lastHeard) > 20000;
            var owesAnswer = lastUserSpeechAt > lastModelOutputAt
                && (Date.now() - lastUserSpeechAt) > 12000;
            if (deafUpstream) {
                telemetry('deaf-upstream');
                restartSession(false);
            } else if (owesAnswer) {
                restartSession(true);
            }
        }, 5000);
    }

    /* ---------- websocket ---------- */

    function connectWs() {
        try {
            ws = new WebSocket(WS_URL);
        } catch (e) {
            onLost();
            return;
        }
        ws.onopen = function () {
            ws.send(JSON.stringify(buildSetup(pendingMemory, proactive)));
            pendingMemory = null;
        };
        ws.onmessage = function (ev) {
            // Gemini Live sends binary frames; browsers hand us a Blob.
            if (typeof ev.data === 'string') {
                try {
                    handleServer(JSON.parse(ev.data));
                } catch (e) { /* malformed frame — keep the session going */ }
            } else if (ev.data instanceof Blob) {
                ev.data.text().then(function (text) {
                    try {
                        handleServer(JSON.parse(text));
                    } catch (e) { /* malformed frame */ }
                });
            }
        };
        ws.onclose = function () {
            if (state === 'connecting' || state === 'live') onLost();
        };
    }

    /* Local, free voice for quota/errors — the TTS path also costs quota,
       so the exhaustion message uses the browser's own speech synthesis. */
    function sayLocal(text) {
        try {
            if (window.speechSynthesis && window.SpeechSynthesisUtterance) {
                var u = new SpeechSynthesisUtterance(text);
                u.lang = 'en-GB';
                window.speechSynthesis.speak(u);
            }
        } catch (e) { /* no local voice available */ }
    }

    function onLost() {
        telemetry('lost');
        chimeDown();
        teardownAudio();
        state = 'error';
        postState('error');
        sayLocal('Your AI quota is used up.');
        wakeStart(); /* "Hi Computer" works as a retry from error too */
    }

    /* ---------- wake phrase ("Hi Computer") ---------- */

    /* Chrome's speech recognition runs continuously while the session is
       off; hearing "hi computer" starts a session. Paused while a session
       is live (the model's own voice would feed it). Note: recognition
       audio goes to Google's speech service — same trust envelope as the
       rest of the kiosk. */
    var wakeRec = null;
    var wakeDenied = false;
    var wakeRestartTimer = null;
    var WAKE_RE = /\b(hi|hey|hello|ok|okay)?\s*computer\b/i;

    function wakeStop() {
        clearTimeout(wakeRestartTimer);
        if (wakeRec) {
            var r = wakeRec;
            wakeRec = null;
            r.onend = null;
            r.onerror = null;
            r.onresult = null;
            try { r.stop(); } catch (e) {}
        }
    }

    function wakeStart() {
        if (wakeRec || wakeDenied) return;
        var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) return; /* this Chrome has no speech recognition */
        try {
            wakeRec = new SR();
        } catch (e) {
            wakeRec = null;
            return;
        }
        wakeRec.lang = 'en-US';
        wakeRec.continuous = true;
        wakeRec.interimResults = false;
        wakeRec.onresult = function (ev) {
            if (state !== 'idle' && state !== 'error') return;
            for (var i = ev.resultIndex; i < ev.results.length; i++) {
                var alt = ev.results[i] && ev.results[i][0];
                if (alt && WAKE_RE.test(alt.transcript || '')) {
                    start();
                    return;
                }
            }
        };
        wakeRec.onerror = function (ev) {
            if (ev && ev.error === 'not-allowed') wakeDenied = true;
        };
        wakeRec.onend = function () {
            wakeRec = null;
            /* Chrome stops recognition on silence; keep it alive while
               no session is running. */
            if (!wakeDenied && (state === 'idle' || state === 'error')) {
                clearTimeout(wakeRestartTimer);
                wakeRestartTimer = setTimeout(wakeStart, 1000);
            }
        };
        try {
            wakeRec.start();
        } catch (e) {
            wakeRec = null;
        }
    }

    /* ---------- lifecycle ---------- */

    function teardownAudio() {
        if (proactiveTimer) {
            clearTimeout(proactiveTimer);
            proactiveTimer = null;
        }
        clearTimeout(noTurnTimer);
        noTurnTimer = null;
        clearTimeout(intentTimer);
        clearTimeout(holdBackstopTimer);
        clearInterval(telemetryTimer);
        telemetryTimer = null;
        if (stallTimer) {
            clearInterval(stallTimer);
            stallTimer = null;
        }
        if (ws) {
            /* The socket is closing on purpose — a late onclose must not
               be mistaken for a dropped connection. */
            try { ws.onclose = null; ws.close(); } catch (e) {}
            ws = null;
        }
        if (captureNode) {
            captureNode.port.onmessage = null;
            captureNode.disconnect();
            captureNode = null;
        }
        if (captureCtx) {
            captureCtx.close().catch(function () {});
            captureCtx = null;
        }
        if (micStream) {
            micStream.getTracks().forEach(function (t) { t.stop(); });
            micStream = null;
        }
        clearPlayback();
        if (playbackCtx) {
            playbackCtx.close().catch(function () {});
            playbackCtx = null;
        }
        sendBuffer = [];
        sendLength = 0;
        setupDone = false;
    }

    function start(opts) {
        if (state === 'connecting' || state === 'live') return;
        wakeStop(); /* the recognizer must not hear the session itself */
        state = 'connecting';
        var my = ++session;
        proactive = !!(opts && opts.proactive);
        sessionSilent = !!(opts && opts.silent);
        sessionId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        loggedAnything = false;
        inBuf = '';
        outBuf = '';
        lastRx = Date.now();
        lastModelOutputAt = Date.now(); /* 5-min grace before auto-sleep */
        sessionStartedAt = Date.now();
        postState('connecting');

        /* Long-term memory is fetched in parallel with the mic setup and
           handed to the setup message when the socket opens. */
        var memoryP = fetch('api/assistant-memory.php')
            .then(function (r) { return r.json(); })
            .catch(function () { return null; });

        navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
        }).then(function (stream) {
            if (state !== 'connecting' || my !== session) {
                stream.getTracks().forEach(function (t) { t.stop(); });
                return;
            }
            micStream = stream;
            return setupCapture(stream).then(function () { return memoryP; }).then(function (mem) {
                if (state !== 'connecting' || my !== session) {
                    teardownAudio();
                    return;
                }
                pendingMemory = mem;
                connectWs();
            });
        }).catch(function (err) {
            if (my !== session) return; /* superseded while awaiting the mic */
            teardownAudio();
            state = 'error';
            postState('error');
        });
    }

    function stop() {
        if (state === 'idle') return;
        chimeDown();
        flushTurn();
        if (loggedAnything && sessionId) postLog({ end: true });
        state = 'idle';
        session++;
        proactive = false;
        searchMode = false;
        teardownAudio();
        postState('idle');
        wakeStart();
    }

    wakeStart();

    window.ASSISTANT = {
        start: start,
        stop: stop,
        /* Playback is starting somewhere on the kiosk — hang up immediately
           so the film's audio doesn't pour into the mic. */
        kill: function () {
            if (state === 'idle') return;
            stop();
        },
        isIdle: function () { return state === 'idle' || state === 'error'; },
        /* The on-screen command cheat sheet (voice: "help"). */
        help: showCommandSheet
    };
})();
