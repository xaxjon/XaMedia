/* Cascaded voice assistant: ear → brain → mouth.
   Ear:   Chrome SpeechRecognition (only while a session is active).
   Brain: api/assistant-brain.php (text LLM + tools + long-term memory).
   Mouth: api/v1/audio/speech.php (Gemini TTS), sentence-streamed.
   There is no on-page UI: the desktop orb badge (deploy/kiosk-orb) is the
   control and the indicator, fed via api/assistant-ctl.php.
   State machine: off → listening → thinking → speaking → listening … → off. */
(function () {
    'use strict';

    var state = 'off'; /* off | listening | thinking | speaking | error */
    var generation = 0;      /* bumped on start/sleep; stale async work bails */
    var proactive = false;
    var proactiveTimer = null;
    var sessionId = null;
    var loggedAnything = false;
    var lastActivityAt = 0;    /* any heard speech (interim or final) */
    var sleepTimer = null;
    var SLEEP_NO_INPUT_MS = 30000;

    /* ---------- state channel (orb badge) ---------- */

    function postJson(url, body) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function (r) { return r.json(); });
    }

    function postState(s) {
        postJson('api/assistant-ctl.php', { state: s })
            .catch(function () { /* badge feedback is best-effort */ });
    }
    postState('idle');

    function toggle() {
        if (state === 'off' || state === 'error') start();
        else if (state !== 'off') sleep();
    }

    setInterval(function () {
        fetch('api/assistant-ctl.php?consume=1')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d && d.command === 'toggle') toggle();
            })
            .catch(function () { /* endpoint down — try again next tick */ });
    }, 1000);

    /* ---------- activation chimes ---------- */

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

    /* ---------- conversation log + telemetry ---------- */

    function postLog(body) {
        body.session = sessionId;
        fetch('api/assistant-log.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).catch(function () { /* logging must never break the session */ });
    }

    function logTurn(who, text) {
        if (!text || !text.trim()) return;
        loggedAnything = true;
        postLog({ who: who, text: text.trim() });
    }

    function telemetry(line) {
        postLog({ who: 'debug', text: line });
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

    function runTool(fc) {
        var exec = EXECUTORS[fc.name];
        var p;
        try {
            p = exec ? Promise.resolve(exec(fc.args || {}))
                     : Promise.resolve({ ok: false, result: 'Unknown tool: ' + fc.name });
        } catch (e) {
            p = Promise.resolve({ ok: false, result: 'That action failed.' });
        }
        return Promise.race([p, new Promise(function (resolve) {
            setTimeout(function () {
                resolve({ ok: false, result: 'That took too long — the kiosk did not respond.' });
            }, 12000);
        })]).then(function (res) {
            if (!res || typeof res !== 'object') res = { ok: true, result: String(res) };
            return { name: fc.name, args: fc.args || {}, thought_signature: fc.thought_signature || null, result: res };
        }).catch(function () {
            return { name: fc.name, args: fc.args || {}, thought_signature: fc.thought_signature || null, result: { ok: false, result: 'That action failed.' } };
        });
    }

    /* ---------- brain ---------- */

    var BRAIN_TIMEOUT_MS = 55000; /* the endpoint's model chain worst case is ~48s */
    var MAX_TOOL_ROUNDS = 3;

    function brainCall(body) {
        return Promise.race([
            postJson('api/assistant-brain.php', body),
            new Promise(function (_, reject) {
                setTimeout(function () { reject(new Error('brain timeout')); }, BRAIN_TIMEOUT_MS);
            })
        ]).then(function (res) {
            if (!res || res.error) throw new Error(res && res.error ? res.error : 'brain error');
            return res;
        });
    }

    /* ---------- mouth (TTS) ---------- */

    var speakCtx = null;

    function ensureSpeakCtx() {
        if (!speakCtx) {
            speakCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (speakCtx.state === 'suspended') speakCtx.resume();
        return speakCtx;
    }

    function ttsFetch(sentence) {
        /* 15s cap per sentence — the upstream TTS has slow phases, and a
           skipped sentence beats a stuck reply. */
        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, 15000);
        return fetch('api/v1/audio/speech.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'tts', input: sentence, voice: 'leda' }),
            signal: ctrl.signal
        }).then(function (r) {
            if (!r.ok) throw new Error('tts ' + r.status);
            return r.arrayBuffer();
        }).then(function (ab) {
            return ensureSpeakCtx().decodeAudioData(ab);
        }).finally(function () {
            clearTimeout(timer);
        });
    }

    function splitSentences(text) {
        var parts = text.match(/[^.!?]+[.!?]+["')\]]?\s*|[^.!?]+$/g);
        return (parts || [text]).map(function (s) { return s.trim(); }).filter(Boolean);
    }

    /* Speak the reply sentence by sentence, prefetching the next one while
       the current plays. Resolves with the number of sentences played. */
    function speak(text) {
        var my = generation;
        var sentences = splitSentences(text);
        if (!sentences.length) return Promise.resolve(1);
        state = 'speaking';
        var i = 0;
        var playedCount = 0;

        function playNext() {
            if (my !== generation || i >= sentences.length) return Promise.resolve();
            var sentence = sentences[i++];
            var t0 = Date.now();
            return ttsFetch(sentence).then(function (buf) {
                telemetry('tts ' + sentence.length + 'ch ' + (Date.now() - t0) + 'ms');
                if (my !== generation) return;
                playedCount++;
                var played = new Promise(function (resolve) {
                    var src = speakCtx.createBufferSource();
                    src.buffer = buf;
                    src.connect(speakCtx.destination);
                    src.onended = resolve;
                    src.start();
                });
                return played.then(playNext);
            }).catch(function (err) {
                telemetry('tts-fail ' + err.message);
                /* Skip the failed sentence, keep the rest of the reply. */
                return playNext();
            });
        }
        return playNext().then(function () { return playedCount; });
    }

    function speakFallback(text) {
        /* TTS endpoint failed entirely — try the browser's own voice. */
        try {
            if (window.speechSynthesis && window.SpeechSynthesisUtterance) {
                var u = new SpeechSynthesisUtterance(text);
                u.lang = 'en-GB';
                window.speechSynthesis.speak(u);
                return;
            }
        } catch (e) { /* no fallback voice either */ }
        telemetry('speak-fallback-unavailable');
    }

    /* ---------- ear (speech recognition) ---------- */

    var rec = null;
    var recRestartTimer = null;
    var interimText = '';
    var interimAt = 0;
    var SLEEP_PHRASE = /^(go to sleep|stop listening|never ?mind|goodbye|good ?night|bye|thank you\.?|thanks)\b/i;

    function stopRec() {
        clearTimeout(recRestartTimer);
        if (rec) {
            var r = rec;
            rec = null;
            r.onend = null;
            r.onerror = null;
            r.onresult = null;
            try { r.stop(); } catch (e) {}
        }
    }

    function startRec() {
        if (rec || state !== 'listening') return;
        var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            telemetry('no-speech-recognition');
            onError('speech recognition is not available in this browser');
            return;
        }
        try {
            rec = new SR();
        } catch (e) {
            rec = null;
            return;
        }
        rec.lang = 'en-US';
        rec.continuous = true;
        rec.interimResults = true;
        rec.onresult = function (ev) {
            if (state !== 'listening') return;
            for (var i = ev.resultIndex; i < ev.results.length; i++) {
                var alt = ev.results[i] && ev.results[i][0];
                if (!alt) continue;
                lastActivityAt = Date.now();
                if (ev.results[i].isFinal) {
                    var text = (alt.transcript || '').trim();
                    interimText = '';
                    if (text) onHeard(text);
                } else {
                    interimText = (alt.transcript || '').trim();
                    interimAt = Date.now();
                }
            }
        };
        rec.onerror = function (ev) {
            telemetry('rec-error ' + (ev && ev.error));
            if (ev && ev.error === 'not-allowed') {
                onError('microphone access denied');
            }
        };
        rec.onend = function () {
            rec = null;
            /* Chrome ends recognition on silence; keep it alive while
               the session is listening. */
            if (state === 'listening') {
                clearTimeout(recRestartTimer);
                recRestartTimer = setTimeout(startRec, 300);
            }
        };
        try {
            rec.start();
        } catch (e) {
            rec = null;
        }
    }

    /* Chrome sometimes holds a trailing interim forever — treat 2.5s of
       silence after interim text as the end of the turn. */
    setInterval(function () {
        if (state === 'listening' && interimText && Date.now() - interimAt > 2500) {
            var text = interimText;
            interimText = '';
            onHeard(text);
        }
    }, 1000);

    /* ---------- session flow ---------- */

    function startListening() {
        state = 'listening';
        lastActivityAt = Date.now();
        interimText = '';
        postState('live');
        startRec();
    }

    function onHeard(text) {
        if (state !== 'listening') return;
        telemetry('heard: ' + text);
        clearTimeout(proactiveTimer);
        proactiveTimer = null;
        proactive = false;
        if (SLEEP_PHRASE.test(text)) {
            sleep();
            return;
        }
        stopRec(); /* the recognizer must not hear the brain's answer */
        think(text, 0);
    }

    function think(text, round) {
        var my = generation;
        state = 'thinking';
        postState('connecting');
        if (round === 0) logTurn('user', text);
        var t0 = Date.now();
        brainCall({ text: text }).then(function (res) {
            if (my !== generation) return;
            telemetry('brain ' + (Date.now() - t0) + 'ms' + (res.tool_calls ? ' tools=' + res.tool_calls.length : ''));
            if (res.tool_calls && res.tool_calls.length && round < MAX_TOOL_ROUNDS) {
                return Promise.all(res.tool_calls.map(function (fc) {
                    telemetry('tool ' + fc.name);
                    return runTool(fc);
                })).then(function (results) {
                    if (my !== generation) return;
                    state = 'thinking';
                    return brainCall({ text: text, tool_results: results }).then(function (res2) {
                        if (my !== generation) return;
                        if (res2.tool_calls && res2.tool_calls.length && round + 1 < MAX_TOOL_ROUNDS) {
                            return thinkRound(text, results, res2.tool_calls, round + 1);
                        }
                        answer(res2.reply || 'Done.');
                    });
                });
            }
            answer(res.reply || 'Sorry, I did not quite follow. Could you say that again?');
        }).catch(function (err) {
            if (my !== generation) return;
            telemetry('brain-fail ' + err.message);
            answer('Sorry, my brain is being slow right now. Could you try that again?');
        });
    }

    function thinkRound(text, prevResults, calls, round) {
        var my = generation;
        return Promise.all(calls.map(function (fc) {
            telemetry('tool ' + fc.name);
            return runTool(fc);
        })).then(function (results) {
            if (my !== generation) return;
            return brainCall({ text: text, tool_results: results }).then(function (res) {
                if (my !== generation) return;
                if (res.tool_calls && res.tool_calls.length && round + 1 < MAX_TOOL_ROUNDS) {
                    return thinkRound(text, results, res.tool_calls, round + 1);
                }
                answer(res.reply || 'Done.');
            });
        });
    }

    function answer(reply) {
        logTurn('model', reply);
        speak(reply).then(function (playedCount) {
            if (playedCount === 0) speakFallback(reply);
            if (state === 'speaking') startListening();
        }).catch(function () {
            if (state === 'speaking') startListening();
        });
    }

    /* ---------- wake phrase ("Hi Computer") ---------- */

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
        if (!SR) return;
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
            if (state !== 'off' && state !== 'error') return;
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
            if (!wakeDenied && (state === 'off' || state === 'error')) {
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

    function start(opts) {
        if (state !== 'off' && state !== 'error') return;
        wakeStop();
        generation++;
        proactive = !!(opts && opts.proactive);
        sessionId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        loggedAnything = false;
        chimeUp();
        telemetry('start' + (proactive ? ' proactive' : ''));
        if (proactive) {
            /* Greet first, then listen. Ignored greeting → sleep. */
            think('(System note: someone just walked up to the kiosk. Greet the household warmly and briefly — you may reference something you remember.)', 0);
            proactiveTimer = setTimeout(function () {
                if (proactive && state === 'listening') sleep();
            }, 25000);
            return;
        }
        startListening();
    }

    function sleep() {
        if (state === 'off') return;
        generation++;
        clearTimeout(proactiveTimer);
        proactiveTimer = null;
        stopRec();
        var wasActive = state !== 'off';
        state = 'off';
        proactive = false;
        if (wasActive) chimeDown();
        postState('idle');
        telemetry('sleep');
        if (loggedAnything && sessionId) postLog({ end: true });
        wakeStart();
    }

    function onError(msg) {
        telemetry('error: ' + msg);
        generation++;
        stopRec();
        state = 'error';
        chimeDown();
        postState('error');
        wakeStart(); /* "Hi Computer" works as a retry from error too */
    }

    /* 30s without any heard speech while listening → sleep. */
    sleepTimer = setInterval(function () {
        if (state === 'listening' && Date.now() - lastActivityAt > SLEEP_NO_INPUT_MS) {
            telemetry('sleep noinput');
            sleep();
        }
    }, 5000);

    wakeStart();

    window.ASSISTANT = {
        start: start,
        stop: sleep,
        /* Playback is starting somewhere on the kiosk — hang up immediately
           so the film's audio doesn't pour into the mic. */
        kill: function () {
            if (state !== 'off') sleep();
        },
        isIdle: function () { return state === 'off' || state === 'error'; },
        /* Test hook: inject a transcript without a voice. */
        debugTurn: function (text) {
            if (state === 'off') start();
            setTimeout(function () { onHeard(String(text || '')); }, 300);
        }
    };
})();
