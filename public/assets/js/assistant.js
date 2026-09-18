/* Gemini Live API voice assistant overlay.
   Connects to deploy/live-proxy.py on the kiosk (ws://127.0.0.1:8787), which
   relays to the Live API upstream — the API key never touches the browser.
   Mic: 16 kHz Int16 PCM out; model audio: 24 kHz Int16 PCM in.
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

    var BASE_INSTRUCTION = 'You are the friendly home assistant on a living-room kiosk. Always speak with a warm, natural British English accent (Received Pronunciation) and always respond in English, even if you hear another language in the room — only switch or translate when the user explicitly asks you to. The microphone also picks up the television and background chatter: ignore anything not clearly addressed to you, and never answer the TV. Keep replies short and conversational — this is a voice conversation, not an essay. You can act on the kiosk with your tools: play movies, TV episodes and music from the local library, tune the internet radio, open streaming services and websites on the screen, look things up on the web, check the weather, and remember facts the household asks you to keep. When a tool does something, confirm it briefly and naturally. Several people use this kiosk and you cannot tell voices apart: your memory below has a People section with what you know about each person. When someone tells you their name, use it and attribute what you learn to them via the remember tool. If knowing who is speaking would change your answer — their preferences, their shows, their plans — politely ask who you are talking to. Never guess a speaker\'s identity from their voice alone.';

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
                   these, every TV burst starts a "user turn" and barge-in
                   chops the model's answers to pieces. */
                realtimeInputConfig: {
                    activityHandling: 'NO_INTERRUPTION'
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

    var overlay = document.getElementById('assistant-overlay');
    var canvas = document.getElementById('assistant-orb');
    var statusEl = document.getElementById('assistant-status');
    var captionEl = document.getElementById('assistant-caption');

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
    var rafId = null;
    var micLevel = 0;
    var modelLevel = 0;
    var orbLevel = 0;
    var orbPhase = 0;
    var proactive = false;
    var proactiveTimer = null;
    var pendingMemory = null;  /* memory payload awaiting the ws open */
    var lastRx = 0;            /* last downstream message timestamp */
    var lastUserSpeechAt = 0;  /* last input transcription */
    var lastModelOutputAt = 0; /* last model audio/transcription */
    var stallTimer = null;     /* silent-upstream watchdog */
    var restarts = 0;          /* consecutive auto-restarts this session */
    var MAX_RESTARTS = 2;
    var sessionId = null;      /* conversation-log session id */
    var inBuf = '';            /* user transcription, current turn */
    var outBuf = '';           /* model transcription, current turn */
    var loggedAnything = false;

    function setStatus(text) { statusEl.textContent = text; }

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
        var sum = 0;
        for (var i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
        micLevel = Math.min(1, Math.sqrt(sum / Math.max(1, pcm.length)) / 32768 * 4);
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
        var sum = 0;
        for (var i = 0; i < pcm.length; i++) {
            var s = pcm[i] / 32768;
            data[i] = s;
            sum += s * s;
        }
        modelLevel = Math.min(1, Math.sqrt(sum / pcm.length) * 3);
        var src = playbackCtx.createBufferSource();
        src.buffer = buf;
        src.connect(playbackCtx.destination);
        var now = playbackCtx.currentTime;
        /* On underrun, rebuild a small jitter cushion instead of snapping
           each late chunk to "now" — snapping is what makes fragmented
           audio chunks audibly stutter. */
        if (nextStartTime < now + 0.04) nextStartTime = now + 0.12;
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
        modelLevel = 0;
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

    function postJson(url, body) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function (r) { return r.json(); });
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
        }
    };

    var statusRevertTimer = null;

    function showToolStatus(res) {
        if (!res || !res.ok || typeof res.result !== 'string' || res.result.length > 80) return;
        setStatus(res.result);
        clearTimeout(statusRevertTimer);
        statusRevertTimer = setTimeout(function () {
            if (state === 'live') setStatus('Listening…');
        }, 4000);
    }

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
                showToolStatus(res);
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
            setStatus('Listening\u2026');
            if (proactive) {
                /* Nobody answers the greeting → close quietly. */
                proactiveTimer = setTimeout(function () {
                    stop();
                    window.dispatchEvent(new Event('assistant-autoclose'));
                }, 20000);
            }
            armStallWatchdog();
            return;
        }
        if (msg.toolCall) {
            handleToolCall(msg.toolCall);
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
                    restarts = 0; /* proof of life: the model is producing */
                    schedulePlayback(inline.data);
                }
            }
        }
        var inText = sc.inputTranscription && sc.inputTranscription.text;
        if (inText) {
            captionEl.textContent = 'You: ' + inText;
            inBuf = absorbTranscription(inBuf, inText);
            lastUserSpeechAt = Date.now();
            if (proactiveTimer) {
                clearTimeout(proactiveTimer);
                proactiveTimer = null;
            }
        }
        var outText = sc.outputTranscription && sc.outputTranscription.text;
        if (outText) {
            captionEl.textContent = 'AI: ' + outText;
            outBuf = absorbTranscription(outBuf, outText);
            lastModelOutputAt = Date.now();
        }
        if (sc.turnComplete) {
            lastModelOutputAt = Date.now();
            flushTurn();
        }
    }

    /* ---------- stall watchdog ---------- */

    /* The Live API occasionally stalls under load: the socket stays open
       but the model goes silent while the mic keeps streaming. Rebuild the
       session when the user spoke and nothing came back for 25s; only
       surface an error after repeated failures. Quiet rooms are fine —
       the watchdog only arms when the model owes an answer. */
    function armStallWatchdog() {
        if (stallTimer) clearInterval(stallTimer);
        stallTimer = setInterval(function () {
            if (state !== 'live') return;
            if (Date.now() - lastRx < 25000) return;
            if (lastUserSpeechAt <= lastModelOutputAt) return;
            clearInterval(stallTimer);
            stallTimer = null;
            if (restarts >= MAX_RESTARTS) {
                onLost();
                return;
            }
            restarts++;
            setStatus('Reconnecting…');
            teardownAudio();
            state = 'idle';
            start({ proactive: proactive });
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
        var wasProactive = proactive;
        teardownAudio();
        state = 'error';
        setStatus('Connection lost \u2014 tap to retry');
        if (wasProactive) window.dispatchEvent(new Event('assistant-autoclose'));
    }

    /* ---------- orb ---------- */

    function startOrb() {
        if (rafId) return;
        var dpr = window.devicePixelRatio || 1;
        var size = 400;
        canvas.width = size * dpr;
        canvas.height = size * dpr;
        var ctx2d = canvas.getContext('2d');
        var last = performance.now();

        function frame(now) {
            rafId = requestAnimationFrame(frame);
            var dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            orbPhase += dt;

            var target = Math.max(micLevel, modelLevel);
            micLevel *= 0.92;
            modelLevel *= 0.92;
            orbLevel += (target - orbLevel) * 0.15;

            ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx2d.clearRect(0, 0, size, size);
            var cx = size / 2, cy = size / 2;
            var breathe = 1 + 0.05 * Math.sin(orbPhase * 1.6);
            var r = 92 * breathe + orbLevel * 105;

            var glow = ctx2d.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 2.1);
            glow.addColorStop(0, 'rgba(140,190,255,' + (0.7 + orbLevel * 0.3) + ')');
            glow.addColorStop(0.45, 'rgba(95,156,240,' + (0.32 + orbLevel * 0.55) + ')');
            glow.addColorStop(1, 'rgba(95,156,240,0)');
            ctx2d.fillStyle = glow;
            ctx2d.beginPath();
            ctx2d.arc(cx, cy, r * 2.1, 0, Math.PI * 2);
            ctx2d.fill();

            ctx2d.fillStyle = 'rgba(185,216,255,' + (0.5 + orbLevel * 0.45) + ')';
            ctx2d.beginPath();
            ctx2d.arc(cx, cy, r, 0, Math.PI * 2);
            ctx2d.fill();
        }
        rafId = requestAnimationFrame(frame);
    }

    function stopOrb() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
        var ctx2d = canvas.getContext('2d');
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
        orbLevel = 0;
        orbPhase = 0;
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
        clearTimeout(statusRevertTimer);
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
        micLevel = 0;
        modelLevel = 0;
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
        captionEl.textContent = '';
        setStatus('Connecting\u2026');
        startOrb();

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
            if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
                setStatus('Microphone access denied');
            } else {
                setStatus('Microphone unavailable');
            }
            if (proactive) window.dispatchEvent(new Event('assistant-autoclose'));
        });
    }

    function stop() {
        flushTurn();
        if (loggedAnything && sessionId) postLog({ end: true });
        state = 'idle';
        session++;
        proactive = false;
        teardownAudio();
        stopOrb();
        captionEl.textContent = '';
        setStatus('');
    }

    /* tap anywhere except the close button retries after a failure */
    overlay.addEventListener('click', function () {
        if (state === 'error') start();
    });

    window.ASSISTANT = {
        start: start,
        stop: stop,
        isIdle: function () { return state === 'idle' || state === 'error'; }
    };
})();
