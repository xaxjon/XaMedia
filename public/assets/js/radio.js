/* Internet radio overlay: My Stations + Browse (radio-browser.info). */
(function () {
    'use strict';

    var cfg = window.APP_CONFIG || {};
    var stations = (cfg.stations || []).slice();

    var overlay = document.getElementById('radio-overlay');
    var listEl = document.getElementById('radio-stations');
    var controls = document.getElementById('radio-controls');
    var nowEl = document.getElementById('radio-now');
    var eqEl = document.getElementById('radio-eq');
    var playBtn = document.getElementById('radio-play');
    var audio = document.getElementById('radio-audio');

    var current = null;      // station object {name, url}
    var currentIdx = null;   // index into stations when playing a saved one
    var playing = false;

    audio.volume = 0.8;

    function setPlaying(on) {
        playing = on;
        eqEl.classList.toggle('playing', on);
        playBtn.textContent = on ? 'Stop' : 'Play';
    }

    function tuneIn(st, idx) {
        current = st;
        currentIdx = (typeof idx === 'number') ? idx : null;
        audio.src = st.url;
        audio.play().catch(function () {
            nowEl.textContent = 'Could not play this stream';
            setPlaying(false);
        });
        nowEl.textContent = st.name;
        controls.hidden = false;
        markActive();
    }

    function markActive() {
        var btns = listEl.querySelectorAll('.station-btn');
        btns.forEach(function (b, j) {
            b.classList.toggle('active', j === currentIdx);
        });
        var rows = document.querySelectorAll('#radio-browse-list .browse-station');
        rows.forEach(function (r) {
            r.classList.toggle('active',
                current !== null && r.dataset.url === current.url);
        });
    }

    function renderMyStations() {
        listEl.innerHTML = '';
        stations.forEach(function (st, i) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'station-btn';
            btn.innerHTML = '<span class="station-dot">&#9835;</span><span></span>';
            btn.querySelector('span:last-child').textContent = st.name;
            btn.addEventListener('click', function () { tuneIn(st, i); });
            listEl.appendChild(btn);
        });
        markActive();
    }
    renderMyStations();

    playBtn.addEventListener('click', function () {
        if (current === null) {
            if (stations.length) tuneIn(stations[0], 0);
            return;
        }
        if (audio.paused) {
            // Re-set the source so live streams resume at the live edge.
            audio.src = current.url;
            audio.play();
        } else {
            audio.pause();
            audio.removeAttribute('src');
            // load() discards the pending 'pause' event, so update the UI
            // directly — otherwise the button stays stuck on "Stop".
            audio.load();
            setPlaying(false);
            nowEl.textContent = 'Stopped';
        }
    });

    document.getElementById('radio-vol-up').addEventListener('click', function () {
        audio.volume = Math.min(1, audio.volume + 0.1);
    });
    document.getElementById('radio-vol-down').addEventListener('click', function () {
        audio.volume = Math.max(0, audio.volume - 0.1);
    });

    audio.addEventListener('playing', function () {
        setPlaying(true);
        if (current !== null) nowEl.textContent = current.name;
        updateMini();
    });
    audio.addEventListener('pause', function () { setPlaying(false); updateMini(); });
    audio.addEventListener('error', function () {
        // Ignore the synthetic error that follows an intentional stop/unload.
        if (audio.getAttribute('src') && current !== null) {
            nowEl.textContent = 'Stream error — try another station';
            setPlaying(false);
        }
    });

    /* ---------- tabs ---------- */

    var myView = document.getElementById('radio-my');
    var browseView = document.getElementById('radio-browse');
    document.querySelectorAll('.radio-tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
            document.querySelectorAll('.radio-tab').forEach(function (t) {
                t.classList.toggle('active', t === tab);
            });
            var isMy = tab.getAttribute('data-rtab') === 'my';
            myView.hidden = !isMy;
            browseView.hidden = isMy;
        });
    });

    /* ---------- browse by genre ---------- */

    // Curated tags known to be well-populated in radio-browser.info.
    var GENRES = [
        'jazz', 'classical', 'rock', 'pop', 'news', 'talk', 'dance',
        'electronic', 'oldies', 'blues', 'country', 'latin', 'tango',
        'cumbia', 'chillout', 'ambient', 'reggae', 'metal', 'folk', '80s', '90s'
    ];
    var browseList = document.getElementById('radio-browse-list');
    var activeGenre = null;

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function saveStation(st, btn) {
        btn.disabled = true;
        btn.textContent = '…';
        fetch('api/station-add.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: st.name, url: st.url })
        })
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (res.ok) {
                    stations.length = 0;
                    (res.stations || []).forEach(function (s) { stations.push(s); });
                    cfg.stations = stations;
                    renderMyStations();
                    btn.textContent = res.already ? 'Saved' : '✓ Saved';
                } else {
                    btn.textContent = 'Error';
                    btn.disabled = false;
                }
            })
            .catch(function () {
                btn.textContent = 'Error';
                btn.disabled = false;
            });
    }

    function loadGenre(tag) {
        browseList.innerHTML = '';
        browseList.appendChild(el('div', 'radio-hint', 'Loading ' + tag + ' stations…'));
        fetch('api/radio-browser.php?tag=' + encodeURIComponent(tag))
            .then(function (r) { return r.json(); })
            .then(function (data) {
                browseList.innerHTML = '';
                var list = (data.stations || []);
                if (!list.length) {
                    browseList.appendChild(el('div', 'radio-hint', 'No stations found for ' + tag + '.'));
                    return;
                }
                list.forEach(function (st) {
                    var row = el('div', 'browse-station');
                    row.dataset.url = st.url;

                    var play = el('button', 'browse-play', '▶');
                    play.type = 'button';
                    play.addEventListener('click', function () { tuneIn(st); });

                    var meta = el('div', 'browse-meta');
                    meta.appendChild(el('div', 'browse-name', st.name));
                    var badges = [st.country, st.codec && st.bitrate ? st.codec + ' ' + st.bitrate + 'k' : st.codec]
                        .filter(Boolean).join(' · ');
                    meta.appendChild(el('div', 'browse-badges', badges));

                    var save = el('button', 'browse-save', '+');
                    save.type = 'button';
                    save.title = 'Save to My Stations';
                    save.addEventListener('click', function () { saveStation(st, save); });

                    row.appendChild(play);
                    row.appendChild(meta);
                    row.appendChild(save);
                    browseList.appendChild(row);
                });
                markActive();
            })
            .catch(function () {
                browseList.innerHTML = '';
                browseList.appendChild(el('div', 'radio-hint', 'Directory unavailable — try again later.'));
            });
    }

    var genreBox = document.getElementById('radio-genres');
    GENRES.forEach(function (g) {
        var chip = el('button', 'genre-chip radio-genre-chip', g);
        chip.type = 'button';
        chip.addEventListener('click', function () {
            activeGenre = g;
            genreBox.querySelectorAll('.radio-genre-chip').forEach(function (c) {
                c.classList.toggle('active', c.textContent === g);
            });
            loadGenre(g);
        });
        genreBox.appendChild(chip);
    });

    /* ---------- voice assistant hooks ---------- */

    // The station list may have changed in Settings since page load —
    // radio.js holds its own array, so refresh from the server on demand.
    function refreshStations() {
        return fetch('api/settings.php')
            .then(function (r) { return r.json(); })
            .then(function (s) {
                if (Array.isArray(s.stations)) {
                    stations.length = 0;
                    s.stations.forEach(function (st) { stations.push(st); });
                    cfg.stations = stations;
                    renderMyStations();
                }
            })
            .catch(function () { /* keep last known list */ });
    }

    function normName(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function stopStream() {
        audio.pause();
        audio.removeAttribute('src');
        // load() discards the pending 'pause' event, so update the UI
        // directly — otherwise the button stays stuck on "Stop".
        audio.load();
        setPlaying(false);
        nowEl.textContent = 'Stopped';
        updateMini();
    }

    window.RADIO = {
        play: function (name) {
            return refreshStations().then(function () {
                if (!stations.length) return { ok: false, result: 'No radio stations are configured.' };
                if (!name) {
                    if (current !== null) {
                        audio.src = current.url;
                        audio.play().catch(function () {});
                        return { ok: true, result: 'Playing ' + current.name + '.' };
                    }
                    tuneIn(stations[0], 0);
                    return { ok: true, result: 'Playing ' + stations[0].name + '.' };
                }
                var q = normName(name);
                var best = -1;
                var bestScore = 0;
                stations.forEach(function (st, i) {
                    var c = normName(st.name);
                    var s = 0;
                    if (c === q) s = 100;
                    else if (c.indexOf(q) >= 0 || q.indexOf(c) >= 0) s = 80;
                    else {
                        var tokens = q.split(' ');
                        var hits = 0;
                        tokens.forEach(function (t) { if (c.indexOf(t) >= 0) hits++; });
                        s = hits / tokens.length * 60;
                    }
                    if (s > bestScore) { bestScore = s; best = i; }
                });
                if (best < 0 || bestScore < 40) {
                    return { ok: false, result: 'No station matching "' + name + '". Available: ' + stations.map(function (s) { return s.name; }).join(', ') + '.' };
                }
                tuneIn(stations[best], best);
                return { ok: true, result: 'Playing ' + stations[best].name + '.' };
            });
        },
        stop: function () {
            stopStream();
            return Promise.resolve({ ok: true, result: 'Radio stopped.' });
        },
        names: function () {
            return stations.map(function (s) { return s.name; });
        }
    };

    /* ---------- open/close + idle auto-hide ---------- */

    var mini = document.getElementById('radio-mini');
    var miniName = document.getElementById('radio-mini-name');
    var idleHide = null;

    function updateMini() {
        var show = playing && overlay.hidden && current !== null;
        mini.hidden = !show;
        if (show) miniName.textContent = '♪ ' + current.name;
    }

    function resetRadioIdle() {
        clearTimeout(idleHide);
        if (!overlay.hidden) {
            idleHide = setTimeout(function () {
                // 10s without mouse movement → back to the slideshow;
                // the stream keeps playing, the mini chip stays visible.
                overlay.hidden = true;
                updateMini();
            }, 10000);
        }
    }

    document.addEventListener('mousemove', function () {
        if (!overlay.hidden) resetRadioIdle();
    }, { passive: true });

    mini.addEventListener('click', function (e) {
        if (e.target && e.target.id === 'radio-mini-stop') return;
        overlay.hidden = false;
        resetRadioIdle();
        updateMini();
    });
    document.getElementById('radio-mini-stop').addEventListener('click', function (e) {
        e.stopPropagation();
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        setPlaying(false);
        nowEl.textContent = 'Stopped';
        updateMini();
    });

    document.getElementById('tile-radio').addEventListener('click', function () {
        overlay.hidden = false;
        resetRadioIdle();
        updateMini();
        refreshStations();
    });
    document.getElementById('radio-close').addEventListener('click', function () {
        overlay.hidden = true;
        clearTimeout(idleHide);
        updateMini();
    });
    // Click on the dimmed backdrop (not the panel) also closes.
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) {
            overlay.hidden = true;
            clearTimeout(idleHide);
            updateMini();
        }
    });
})();
