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

    var BASE_INSTRUCTION = 'You are the friendly home assistant on a living-room kiosk. Always speak with a warm, natural British English accent (Received Pronunciation) and always respond in English, even if you hear another language in the room — only switch or translate when the user explicitly asks you to. The microphone also picks up the television and background chatter: if what you hear is not clearly a person addressing you, produce NO response at all — stay completely silent and never answer, repeat, or comment on the TV. Keep replies short and conversational — this is a voice conversation, not an essay. You can act on the kiosk with your tools: play movies, TV episodes and music from the local library, tune the internet radio, open streaming services and websites on the screen, look things up on the web, check the weather, and remember facts the household asks you to keep. When a tool does something, confirm it briefly and naturally. Several people use this kiosk and you cannot tell voices apart: your memory below has a People section with what you know about each person. When someone tells you their name, use it and attribute what you learn to them via the remember tool. If knowing who is speaking would change your answer — their preferences, their shows, their plans — politely ask who you are talking to. Never guess a speaker\'s identity from their voice alone.';

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
            { name: 'remember', description: 'Store a fact, preference or note in long-term memory. Use when the user asks you to remember something, or when you learn a durable preference. When the fact is about a specific person, include their name (e.g. "Emma prefers classical radio in the morning").', parameters: { type: 'OBJECT', properties: { fact: { type: 'STRING', description: 'One concise sentence' } }, required: ['fact'] } }
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
    var lastGateOpenAt = 0;    /* last time the mic heard real speech */
    var GATE_RMS = 0.030;      /* speech marker opens at this normalized RMS */
    var GATE_CLOSE_RMS = 0.020;/* hysteresis: closes below this */
    var GATE_HANGOVER = 0.8;   /* seconds held open after speech */
    var gateOpen = false;
    var gateOpenUntil = 0;
    var stallTimer = null;     /* silent-upstream watchdog */
    var restartTimes = [];     /* rebuild timestamps — churn budget */
    var MAX_RESTARTS_WINDOW = 3;
    var RESTART_WINDOW_MS = 600000; /* max 3 rebuilds per 10 min */
    var SLEEP_AFTER_MS = 300000;    /* auto-sleep after 5 min model silence */
    var sessionId = null;      /* conversation-log session id */
    var inBuf = '';            /* user transcription, current turn */
    var outBuf = '';           /* model transcription, current turn */
    var loggedAnything = false;

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

    function schedulePlayback(b64) {
        ensurePlaybackCtx();
        var pcm = int16FromBase64(b64);
        if (!pcm.length) return;
        var buf = playbackCtx.createBuffer(1, pcm.length, PLAY_RATE);
        var data = buf.getChannelData(0);
        for (var i = 0; i < pcm.length; i++) {
            data[i] = pcm[i] / 32768;
        }
        var src = playbackCtx.createBufferSource();
        src.buffer = buf;
        src.connect(playbackCtx.destination);
        var now = playbackCtx.currentTime;
        /* On underrun, rebuild a small jitter cushion instead of snapping
           each late chunk to "now" — snapping is what makes fragmented
           audio chunks audibly stutter. */
        if (nextStartTime < now + 0.04) nextStartTime = now + 0.25;
        src.start(nextStartTime);
        nextStartTime += buf.duration;
        playbackSources.push(src);
        src.onended = function () {
            var idx = playbackSources.indexOf(src);
            if (idx >= 0) playbackSources.splice(idx, 1);
        };
    }

    /* barge-in: drop everything queued or playing */
    function clearPlayback() {
        playbackSources.forEach(function (s) { try { s.stop(); } catch (e) {} });
        playbackSources = [];
        nextStartTime = 0;
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
            postLog({ who: 'user', text: inBuf.trim() });
            loggedAnything = true;
        }
        if (outBuf.trim()) {
            postLog({ who: 'model', text: outBuf.trim() });
            loggedAnything = true;
        }
        inBuf = '';
        outBuf = '';
    }

    /* ---------- tools ---------- */

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
        }
    };

    function handleToolCall(toolCall) {
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
            if (proactive) {
                /* Nobody answers the greeting → hang up quietly. */
                proactiveTimer = setTimeout(stop, 20000);
            }
            armStallWatchdog();
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
            lastModelOutputAt = Date.now();
            flushTurn();
        }
    }

    /* ---------- stall watchdog ---------- */

    /* Session rebuild, rate-limited: max 3 per 10 minutes, then error
       state and stop trying (the orb shows red; a click retries). The
       budget stops the watchdog from hammering an already-overloaded API
       during 503 waves. */
    function restartSession() {
        if (stallTimer) {
            clearInterval(stallTimer);
            stallTimer = null;
        }
        var cutoff = Date.now() - RESTART_WINDOW_MS;
        restartTimes = restartTimes.filter(function (t) { return t > cutoff; });
        if (restartTimes.length >= MAX_RESTARTS_WINDOW) {
            onLost();
            return;
        }
        restartTimes.push(Date.now());
        teardownAudio();
        state = 'idle';
        start({ proactive: proactive });
    }

    /* The Live API occasionally stalls under load: the socket stays open
       but the model goes silent while the mic keeps streaming. Rebuild the
       session when (a) the user spoke and nothing came back for 25s, or
       (b) someone is clearly speaking at the mic but not even a
       transcription has arrived for 30s — the upstream is deaf. A quiet
       room arms neither.
       Auto-sleep: no model output for 5 minutes → hang up quietly.
       Ambient 24/7 listening burns the API's rate budgets — which is
       exactly what the throttling feeds on. */
    function armStallWatchdog() {
        if (stallTimer) clearInterval(stallTimer);
        stallTimer = setInterval(function () {
            if (state !== 'live') return;
            if (Date.now() - lastModelOutputAt > SLEEP_AFTER_MS) {
                stop();
                return;
            }
            var silence = Date.now() - lastRx;
            var owesAnswer = lastUserSpeechAt > lastModelOutputAt;
            var deafUpstream = silence > 30000 && (Date.now() - lastGateOpenAt) < 30000;
            if (deafUpstream || (silence > 25000 && owesAnswer)) {
                restartSession();
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
        teardownAudio();
        state = 'error';
        postState('error');
    }

    /* ---------- lifecycle ---------- */

    function teardownAudio() {
        if (proactiveTimer) {
            clearTimeout(proactiveTimer);
            proactiveTimer = null;
        }
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
        state = 'connecting';
        var my = ++session;
        proactive = !!(opts && opts.proactive);
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
        flushTurn();
        if (loggedAnything && sessionId) postLog({ end: true });
        state = 'idle';
        session++;
        proactive = false;
        teardownAudio();
        postState('idle');
    }

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
