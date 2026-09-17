/* Gemini Live API voice assistant overlay.
   Connects to deploy/live-proxy.py on the kiosk (ws://127.0.0.1:8787), which
   relays to the Live API upstream — the API key never touches the browser.
   Mic: 16 kHz Int16 PCM out; model audio: 24 kHz Int16 PCM in. */
(function () {
    'use strict';

    var WS_URL = 'ws://127.0.0.1:8787';
    var MIC_RATE = 16000;
    var PLAY_RATE = 24000;
    var SEND_CHUNK = MIC_RATE * 0.15; /* ~150 ms of audio per realtimeInput */

    var SETUP_MESSAGE = {
        setup: {
            model: 'models/gemini-3.8-live',
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Leda' } },
                    languageCode: 'en-GB'
                }
            },
            systemInstruction: { parts: [{ text: 'You are the friendly home assistant on a living-room kiosk. Always speak with a warm, natural British English accent (Received Pronunciation). Keep replies short and conversational — this is a voice conversation, not an essay.' }] },
            outputAudioTranscription: {},
            inputAudioTranscription: {}
        }
    };

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
        if (nextStartTime < now + 0.04) nextStartTime = now + 0.04;
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

    /* ---------- server messages ---------- */

    function handleServer(msg) {
        if (msg.setupComplete) {
            setupDone = true;
            state = 'live';
            setStatus('Listening\u2026');
            return;
        }
        var sc = msg.serverContent;
        if (!sc) return;
        if (sc.interrupted) clearPlayback();
        var parts = sc.modelTurn && sc.modelTurn.parts;
        if (parts) {
            for (var i = 0; i < parts.length; i++) {
                var inline = parts[i] && parts[i].inlineData;
                if (inline && inline.data && /^audio\/pcm/.test(inline.mimeType || '')) {
                    schedulePlayback(inline.data);
                }
            }
        }
        var inText = sc.inputTranscription && sc.inputTranscription.text;
        if (inText) captionEl.textContent = 'You: ' + inText;
        var outText = sc.outputTranscription && sc.outputTranscription.text;
        if (outText) captionEl.textContent = 'AI: ' + outText;
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
            ws.send(JSON.stringify(SETUP_MESSAGE));
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
        setStatus('Connection lost \u2014 tap to retry');
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
        if (ws) {
            try { ws.close(); } catch (e) {}
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

    function start() {
        if (state === 'connecting' || state === 'live') return;
        state = 'connecting';
        var my = ++session;
        captionEl.textContent = '';
        setStatus('Connecting\u2026');
        startOrb();

        navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
        }).then(function (stream) {
            if (state !== 'connecting' || my !== session) {
                stream.getTracks().forEach(function (t) { t.stop(); });
                return;
            }
            micStream = stream;
            return setupCapture(stream).then(function () {
                if (state !== 'connecting' || my !== session) {
                    teardownAudio();
                    return;
                }
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
        });
    }

    function stop() {
        state = 'idle';
        session++;
        teardownAudio();
        stopOrb();
        captionEl.textContent = '';
        setStatus('');
    }

    /* tap anywhere except the close button retries after a failure */
    overlay.addEventListener('click', function () {
        if (state === 'error') start();
    });

    window.ASSISTANT = { start: start, stop: stop };
})();
