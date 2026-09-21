/* Gemini Live API voice assistant.
   Connects to deploy/live-proxy.py on the kiosk (ws://127.0.0.1:8787), which
   relays to the Live API upstream — the API key never touches the browser.
   Mic: 16 kHz Int16 PCM out; model audio: 24 kHz Int16 PCM in.
   There is no on-page UI: the desktop orb badge (deploy/kiosk-orb) is the
   control and the indicator. Session state is published to
   api/assistant-ctl.php, and toggle commands from the badge are picked up
   from the same endpoint.
   Tools (function calling) execute locally against the kiosk UI and APIs;
   conversation transcripts are logged via api/assistant-log.php and the
   long-term memory from api/assistant-memory.php is injected into the
   system instruction of every session. */
(function () {
    'use strict';

    var WS_URL = 'ws://127.0.0.1:8787';
    var MIC_RATE = 16000;
    var PLAY_RATE = 24000;
    var SEND_CHUNK = MIC_RATE * 0.15; /* ~150 ms of audio per realtimeInput */

    var BASE_INSTRUCTION = 'You are the friendly home assistant on a living-room kiosk. Always speak with a warm, natural British English accent (Received Pronunciation) and always respond in English, even if you hear another language in the room — only switch or translate when the user explicitly asks you to. The microphone also picks up the television and background chatter: if what you hear is not clearly a person addressing you, produce NO response at all — stay completely silent and never answer, repeat, or comment on the TV. Keep replies short and conversational — this is a voice conversation, not an essay. You can act on the kiosk with your tools: play movies, TV episodes and music from the local library, tune the internet radio, open streaming services and websites on the screen, look things up on the web, check the weather, and remember facts the household asks you to keep. You can also drive the kiosk screens directly: open the movie, TV or music browsers, filter movies by genre, scroll a page up or down, go back a level, and return to the main menu — use these when the user asks you to navigate, browse, or show them something. When a tool does something, confirm it briefly and naturally. Several people use this kiosk and you cannot tell voices apart: your memory below has a People section with what you know about each person. When someone tells you their name, use it and attribute what you learn to them via the remember tool. If knowing who is speaking would change your answer — their preferences, their shows, their plans — politely ask who you are talking to. Never guess a speaker\'s identity from their voice alone.';

    var TOOLS = [{
        functionDeclarations: [
            { name: 'play_movie', description: 'Play a movie from the local media library on the kiosk.', parameters: { type: 'OBJECT', properties: { title: { type: 'STRING', description: 'Movie title (approximate is fine)' } }, required: ['title'] } },
            { name: 'play_tv', description: 'Play an episode of a TV series from the local media library.', parameters: { type: 'OBJECT', properties: { show: { type: 'STRING', description: 'Series name' }, season: { type: 'INTEGER', description: 'Season number (optional)' }, episode: { type: 'INTEGER', description: 'Episode number (optional)' } }, required: ['show'] } },
            { name: 'play_music', description: 'Play music from the local library: an artist/album folder or a specific track.', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Artist, album or track name' } }, required: ['query'] } },
            { name: 'stop_playback', description: 'Stop whatever is currently playing (video, music or VLC).', parameters: { type: 'OBJECT', properties: {} } },
            { name: 'play_radio', description: 'Tune the internet radio to a saved station.', parameters: { type: 'OBJECT', properties: { station: { type: 'STRING', description: 'Station name (omit to resume the last one)' } } } },
            { name: 'stop_radio', description: 'Stop the internet radio.', parameters: { type: 'OBJECT', properties: {} } },
            { name: 'open_streaming', description: 'Open a streaming service fullscreen on the kiosk.', parameters: { type: 'OBJECT', properties: { service: { type: 'STRING', description: 'One of: netflix, youtube, hbo, prime, cameras' } }, required: ['service'] } },
            { name: 'show_photos', description: 'Start the photo-frame slideshow on the kiosk.', parameters: { type: 'OBJECT', properties: {} } },
            { name: 'get_weather', description: 'Get the current weather and forecast for the household location.', parameters: { type: 'OBJECT', properties: {} } },
            { name: 'open_website', description: 'Open a website fullscreen on the kiosk display.', parameters: { type: 'OBJECT', properties: { url: { type: 'STRING', description: 'Full URL, e.g. https://www.bbc.com' } }, required: ['url'] } },
            { name: 'web_search', description: 'Search the web; returns titles, snippets and links.', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] } },
            { name: 'read_webpage', description: 'Fetch a web page and read its text content.', parameters: { type: 'OBJECT', properties: { url: { type: 'STRING' } }, required: ['url'] } },
            { name: 'remember', description: 'Store a fact, preference or note in long-term memory. Use when the user asks you to remember something, or when you learn a durable preference. When the fact is about a specific person, include their name (e.g. "Emma prefers classical radio in the morning").', parameters: { type: 'OBJECT', properties: { fact: { type: 'STRING', description: 'One concise sentence' } }, required: ['fact'] } },
            { name: 'open_screen', description: 'Open a kiosk screen: the movies/TV/music browser, the radio, photos, or the home screen.', parameters: { type: 'OBJECT', properties: { screen: { type: 'STRING', description: 'movies, tv, music, radio, photos, or home' } }, required: ['screen'] } },
            { name: 'select_genre', description: 'Filter the movie browser by genre, e.g. comedy or drama.', parameters: { type: 'OBJECT', properties: { genre: { type: 'STRING' } }, required: ['genre'] } },
            { name: 'scroll_screen', description: 'Scroll the currently open screen.', parameters: { type: 'OBJECT', properties: { direction: { type: 'STRING', description: 'up or down' } }, required: ['direction'] } },
            { name: 'go_back', description: 'Go back one level in the media browser, e.g. from a movie or series back to the list.', parameters: { type: 'OBJECT', properties: {} } },
            { name: 'main_menu', description: 'Close all overlays and return to the kiosk home screen.', parameters: { type: 'OBJECT', properties: {} } }
        ]
    }];

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
        return {
            setup: {
                model: 'models/gemini-3.1-flash-live-preview',
                generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Leda' } },
                        languageCode: 'en-GB'
                    }
                },
                systemInstruction: { parts: [{ text: instruction }] },
                tools: TOOLS,
                /* The kiosk mic hears the living-room TV all day. Without
                   this, every TV burst starts a "user turn" and barge-in
                   chops the model's answers to pieces. */
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

    function handleToolCall(toolCall) {
        calls.forEach(function (fc) { telemetry('tool ' + fc.name); });
        var calls = toolCall.functionCalls || [];
        Promise.all(calls.map(function (fc) {
            var exec = EXECUTORS[fc.name];
            var p;
            try {
                p = exec ? Promise.resolve(exec(fc.args || {}))
                         : Promise.resolve({ ok: false, result: 'Unknown tool: ' + fc.name });
            } catch (e) {
                p = Promise.resolve({ ok: false, result: 'That action failed.' });
            }
            /* A hung kiosk API (slow NFS, dead endpoint) must never wedge
               the model's turn — answer with a failure after 12s. */
            p = Promise.race([p, new Promise(function (resolve) {
                setTimeout(function () {
                    resolve({ ok: false, result: 'That took too long — the kiosk did not respond.' });
                }, 12000);
            })]);
            return p.then(function (res) {
                if (!res || typeof res !== 'object') res = { ok: true, result: String(res) };
                return { id: fc.id, name: fc.name, response: res };
            }).catch(function () {
                return { id: fc.id, name: fc.name, response: { ok: false, result: 'That action failed.' } };
            });
        })).then(function (responses) {
            if (!responses.length) return;
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
            }
        });
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
            }, 8000);
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
        if (replay && lastUserText) pendingReplay = lastUserText;
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
            var noInput = Date.now() - lastUserSpeechAt > SLEEP_NO_INPUT_MS;
            var modelIdle = Date.now() - lastModelOutputAt > SLEEP_MODEL_IDLE_MS;
            var modelSilentLong = Date.now() - lastModelOutputAt > SLEEP_AFTER_MS;
            if ((noInput && modelIdle) || modelSilentLong) {
                telemetry('sleep noinput-' + noInput + ' idle-' + modelIdle + ' long-' + modelSilentLong);
                stop();
                return;
            }
            var silence = Date.now() - lastRx;
            /* waitingForInput and other keepalives refresh lastRx even
               while the model is stuck — so the owes-an-answer arm keys
               off the user's speech vs the model's last real output. */
            var owesAnswer = lastUserSpeechAt > lastModelOutputAt
                && (Date.now() - lastUserSpeechAt) > 12000;
            var deafUpstream = silence > 30000 && (Date.now() - lastGateOpenAt) < 30000;
            if (deafUpstream) {
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

    function onLost() {
        telemetry('lost');
        chimeDown();
        teardownAudio();
        state = 'error';
        postState('error');
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
        isIdle: function () { return state === 'idle' || state === 'error'; }
    };
})();
