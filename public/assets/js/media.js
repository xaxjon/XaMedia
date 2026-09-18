/* Movies / TV / Music overlay with fullscreen player. */
(function () {
    'use strict';

    var cfg = window.APP_CONFIG || {};

    var overlay = document.getElementById('media-overlay');
    var view = document.getElementById('media-view');
    var scrollBox = document.getElementById('media-scroll');
    var mediaBody = document.getElementById('media-body');
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.media-tab'));

    var cache = {};        // per-tab API responses
    var currentTab = 'movies';

    /* ---------- helpers ---------- */

    function el(tag, className, text) {
        var e = document.createElement(tag);
        if (className) e.className = className;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function loadTab(tab, force) {
        if (cache[tab] && !force) return Promise.resolve(cache[tab]);
        return fetch('api/media.php?type=' + tab)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                cache[tab] = data;
                return data;
            });
    }

    function showMessage(msg) {
        removeAzBar();
        view.innerHTML = '';
        view.appendChild(el('div', 'media-message', msg));
    }

    function posterCard(posterUrl, title, sub) {
        var card = el('button', 'media-card');
        card.type = 'button';
        if (posterUrl) {
            var img = el('img', 'media-card-img');
            img.loading = 'lazy';
            img.src = posterUrl;
            img.alt = '';
            card.appendChild(img);
        } else {
            card.appendChild(el('div', 'media-card-fallback', title));
        }
        var caption = el('div', 'media-card-title', title);
        if (sub) caption.appendChild(el('span', 'media-card-sub', sub));
        card.appendChild(caption);
        return card;
    }

    function backButton(onClick) {
        var b = el('button', 'media-back', '‹ Back');
        b.type = 'button';
        b.addEventListener('click', onClick);
        return b;
    }

    function playButton(file, label, title) {
        var b = el('button', 'media-play-btn', label || '▶ Play');
        b.type = 'button';
        b.addEventListener('click', function () { openPlayer(file, title || file.name); });
        return b;
    }

    // Every file can be handed to VLC on the kiosk display — containers lie
    // about their codecs (e.g. XviD inside .mp4), so extension checks are
    // not enough.
    function playInVlc(file, statusEl) {
        if (!file) return;
        if (window.ASSISTANT && window.ASSISTANT.kill) window.ASSISTANT.kill();
        if (statusEl) statusEl.textContent = 'Starting VLC…';
        fetch('api/play-local.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: file.url })
        })
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (statusEl) {
                    statusEl.textContent = res.ok
                        ? 'Playing in VLC — right-click the video for controls, or quit VLC to return here.'
                        : 'VLC failed to start' + (res.detail ? ': ' + res.detail : '');
                }
            })
            .catch(function () {
                if (statusEl) statusEl.textContent = 'Could not reach the player service.';
            });
    }

    function vlcButton(file, label) {
        var b = el('button', 'media-vlc-btn', label || 'VLC');
        b.type = 'button';
        b.title = 'Play with VLC on the kiosk display';
        b.addEventListener('click', function (e) {
            e.stopPropagation();
            video.pause();
            playInVlc(file, null);
        });
        return b;
    }

    function fileRows(files, contextTitle) {
        var wrap = el('div', 'media-files');
        files.forEach(function (f) {
            var row = el('div', 'media-file-row');
            if (files.length > 1) row.appendChild(el('span', 'media-file-name', f.name));
            row.appendChild(playButton(f, '▶ Play', contextTitle && files.length === 1 ? contextTitle :
                (contextTitle ? contextTitle + ' — ' + f.name : f.name)));
            row.appendChild(vlcButton(f));
            wrap.appendChild(row);
        });
        return wrap;
    }

    /* ---------- A–Z index bar (movies grid) ---------- */

    function sortKey(title) {
        var c = String(title || '').trim().charAt(0).toUpperCase();
        return /[A-Z]/.test(c) ? c : '#';
    }

    function removeAzBar() {
        var old = document.getElementById('media-az');
        if (old) old.remove();
    }

    function buildAzBar(keys) {
        removeAzBar();
        var bar = el('div');
        bar.id = 'media-az';
        var letters = ['#'];
        for (var i = 65; i <= 90; i++) letters.push(String.fromCharCode(i));
        letters.forEach(function (L) {
            var b = el('button', 'az-letter', L);
            b.type = 'button';
            if (!keys[L]) {
                b.classList.add('dim');
                b.disabled = true;
            } else {
                b.addEventListener('click', function () {
                    var card = view.querySelector('.media-card[data-sort-key="' + L + '"]');
                    if (card) card.scrollIntoView({ block: 'start', behavior: 'smooth' });
                });
            }
            bar.appendChild(b);
        });
        mediaBody.appendChild(bar);
    }

    /* ---------- movies ---------- */

    function moviePosterUrl(m) {
        if (m.poster_url) return m.poster_url;
        return m.poster ? 'media/Movies/' + m.dir + '/poster.jpg' : null;
    }

    var activeGenre = null; // null = All

    function genreBar(movies) {
        var counts = {};
        movies.forEach(function (m) {
            (m.genres || []).forEach(function (g) { counts[g] = (counts[g] || 0) + 1; });
        });
        var bar = el('div', 'genre-bar');
        Object.keys(counts).sort(function (a, b) {
            return counts[b] - counts[a] || a.localeCompare(b);
        }).forEach(function (g) {
            var chip = el('button', 'genre-chip' + (activeGenre === g ? ' active' : ''),
                g + ' · ' + counts[g]);
            chip.type = 'button';
            chip.addEventListener('click', function () {
                activeGenre = (activeGenre === g) ? null : g;
                renderMovies();
            });
            bar.appendChild(chip);
        });
        // "All" is always the last option.
        var all = el('button', 'genre-chip genre-chip-all' + (activeGenre === null ? ' active' : ''), 'All');
        all.type = 'button';
        all.addEventListener('click', function () { activeGenre = null; renderMovies(); });
        bar.appendChild(all);
        return bar;
    }

    function renderMovies() {
        removeAzBar();
        view.innerHTML = '';
        showMessage('Loading…');
        loadTab('movies').then(function (data) {
            var movies = (data.movies || []).slice().sort(function (a, b) {
                return String(a.title).localeCompare(String(b.title));
            });
            if (!movies.length) { showMessage('No movies found.'); return; }
            view.innerHTML = '';
            view.appendChild(genreBar(movies));
            var shown = activeGenre
                ? movies.filter(function (m) { return (m.genres || []).indexOf(activeGenre) >= 0; })
                : movies;
            var grid = el('div', 'media-grid');
            var keys = {};
            shown.forEach(function (m) {
                var card = posterCard(moviePosterUrl(m), m.title, m.year ? String(m.year) : '');
                var k = sortKey(m.title);
                keys[k] = true;
                card.setAttribute('data-sort-key', k);
                card.addEventListener('click', function () { renderMovieDetail(m); });
                grid.appendChild(card);
            });
            view.appendChild(grid);
            buildAzBar(keys);
        }).catch(function () { showMessage('Could not load movies.'); });
    }

    function fmtRuntime(mins) {
        mins = Math.round(Number(mins));
        if (!mins) return '';
        var h = Math.floor(mins / 60), m = mins % 60;
        return h ? h + 'h ' + m + 'm' : m + 'm';
    }

    function fetchMovieInfo(m, titleEl, yearEl, box) {
        fetch('api/movie-info.php?dir=' + encodeURIComponent(m.dir))
            .then(function (r) {
                if (!r.ok) throw new Error('no info');
                return r.json();
            })
            .then(function (d) {
                if (!d || d.error) return;
                if (d.title) titleEl.textContent = d.title;
                if (d.year) yearEl.textContent = String(d.year);
                box.innerHTML = '';
                var meta = [];
                if (d.rating) meta.push('★ ' + Number(d.rating).toFixed(1));
                var rt = fmtRuntime(d.runtime);
                if (rt) meta.push(rt);
                if (meta.length) box.appendChild(el('div', 'media-meta', meta.join('  ·  ')));
                if (d.genres && d.genres.length) {
                    var chips = el('div', 'media-genres');
                    d.genres.forEach(function (g) {
                        chips.appendChild(el('span', 'media-genre', g));
                    });
                    box.appendChild(chips);
                }
                if (d.director) {
                    box.appendChild(el('div', 'media-director', 'Directed by ' + d.director));
                }
                if (d.overview) {
                    box.appendChild(el('p', 'media-overview', d.overview));
                }
                if (d.cast && d.cast.length) {
                    var cast = el('div', 'media-cast');
                    d.cast.slice(0, 8).forEach(function (c) {
                        cast.appendChild(el('div', 'media-cast-line',
                            c.name + (c.character ? ' — ' + c.character : '')));
                    });
                    box.appendChild(cast);
                }
                if (d.corrected) {
                    box.appendChild(el('div', 'media-corrected', 'corrected match'));
                }
            })
            .catch(function () { /* no info — plain title/year stay */ });
    }

    /* ----- fix-match correction flow ----- */

    function toggleCorrection(detail, m) {
        var existing = detail.querySelector('.correct-row');
        if (existing) { existing.remove(); return; }

        var row = el('div', 'correct-row');
        var input = el('input', 'set-input correct-input');
        input.type = 'text';
        input.placeholder = 'Correct movie title…';
        input.value = m.title || '';
        var searchBtn = el('button', 'set-btn', 'Search');
        searchBtn.type = 'button';
        var cancelBtn = el('button', 'set-btn correct-cancel', 'Cancel');
        cancelBtn.type = 'button';
        var results = el('div', 'correct-results');

        row.appendChild(input);
        row.appendChild(searchBtn);
        row.appendChild(cancelBtn);
        row.appendChild(results);
        detail.insertBefore(row, detail.children[1]); // right under the head

        cancelBtn.addEventListener('click', function () { row.remove(); });

        searchBtn.addEventListener('click', function () {
            var q = input.value.trim();
            if (!q) return;
            results.innerHTML = '';
            results.appendChild(el('div', 'set-hint', 'Searching…'));
            fetch('api/movie-correct.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dir: m.dir, query: q })
            })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    results.innerHTML = '';
                    var list = (data.results || []).slice(0, 6);
                    if (!list.length) {
                        results.appendChild(el('div', 'set-hint', 'No matches.'));
                        return;
                    }
                    list.forEach(function (cand) {
                        var b = el('button', 'correct-result');
                        b.type = 'button';
                        if (cand.poster_thumb) {
                            var img = el('img', 'correct-thumb');
                            img.loading = 'lazy';
                            img.src = cand.poster_thumb;
                            img.alt = '';
                            b.appendChild(img);
                        }
                        var txt = el('span', 'correct-result-text');
                        txt.appendChild(el('span', 'correct-result-title', cand.title || '?'));
                        if (cand.year) {
                            txt.appendChild(el('span', 'correct-result-year', String(cand.year)));
                        }
                        b.appendChild(txt);
                        b.addEventListener('click', function () { applyCorrection(m, cand, row); });
                        results.appendChild(b);
                    });
                })
                .catch(function () {
                    results.innerHTML = '';
                    results.appendChild(el('div', 'set-hint', 'Search failed.'));
                });
        });
    }

    function applyCorrection(m, cand, row) {
        row.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
        fetch('api/movie-correct.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir: m.dir, tmdb_id: cand.tmdb_id })
        })
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res || !res.ok) throw new Error('not ok');
                // Update the in-memory movies list entry.
                m.title = res.title || m.title;
                m.year = res.year || m.year;
                m.poster = true;
                m.poster_url = 'api/poster.php?dir=' + encodeURIComponent(m.dir);
                var list = cache.movies && cache.movies.movies;
                if (list) {
                    list.forEach(function (x) {
                        if (x.dir === m.dir) {
                            x.title = m.title;
                            x.year = m.year;
                            x.poster = true;
                            x.poster_url = m.poster_url;
                        }
                    });
                }
                // Re-render the detail panel in place (re-fetches movie-info too).
                renderMovieDetail(m);
            })
            .catch(function () {
                row.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
                var results = row.querySelector('.correct-results');
                results.innerHTML = '';
                results.appendChild(el('div', 'set-hint', 'Could not save the correction.'));
            });
    }

    function renderMovieDetail(m) {
        removeAzBar();
        view.innerHTML = '';
        var detail = el('div', 'media-detail');
        var head = el('div', 'media-detail-head');
        head.appendChild(backButton(renderMovies));
        var fixBtn = el('button', 'media-fix-btn', '✎ Fix match');
        fixBtn.type = 'button';
        fixBtn.addEventListener('click', function () { toggleCorrection(detail, m); });
        head.appendChild(fixBtn);
        detail.appendChild(head);

        var body = el('div', 'media-detail-body');
        var posterUrl = moviePosterUrl(m);
        if (posterUrl) {
            var img = el('img', 'media-detail-poster');
            img.loading = 'lazy';
            img.src = posterUrl;
            img.alt = '';
            body.appendChild(img);
        }
        var info = el('div', 'media-detail-info');
        var titleEl = el('h2', 'media-detail-title', m.title);
        var yearEl = el('div', 'media-detail-year', m.year ? String(m.year) : '');
        info.appendChild(titleEl);
        info.appendChild(yearEl);
        var tmdbBox = el('div', 'media-tmdb');
        info.appendChild(tmdbBox);
        info.appendChild(fileRows(m.files || [], m.title));
        body.appendChild(info);
        detail.appendChild(body);
        view.appendChild(detail);

        fetchMovieInfo(m, titleEl, yearEl, tmdbBox);
    }

    /* ---------- tv ---------- */

    function renderTv() {
        removeAzBar();
        view.innerHTML = '';
        showMessage('Loading…');
        loadTab('tv').then(function (data) {
            var series = (data.series || []).slice().sort(function (a, b) {
                return String(a.name).localeCompare(String(b.name));
            });
            if (!series.length) { showMessage('No TV series found.'); return; }
            view.innerHTML = '';
            var grid = el('div', 'media-grid');
            series.forEach(function (s) {
                var poster = s.poster ? 'media/TV/' + s.name + '/poster.jpg' : null;
                var card = posterCard(poster, s.name, '');
                card.addEventListener('click', function () { renderSeries(s); });
                grid.appendChild(card);
            });
            view.appendChild(grid);
        }).catch(function () { showMessage('Could not load TV series.'); });
    }

    function renderSeries(s) {
        removeAzBar();
        view.innerHTML = '';
        var wrap = el('div', 'media-detail');
        var head = el('div', 'media-detail-head');
        head.appendChild(backButton(renderTv));
        head.appendChild(el('h2', 'media-detail-title', s.name));
        wrap.appendChild(head);

        var seasons = s.seasons || {};
        Object.keys(seasons).sort(function (a, b) { return Number(a) - Number(b); })
            .forEach(function (num) {
                var sec = el('div', 'media-season');
                sec.appendChild(el('h3', 'media-season-title', 'Season ' + num));
                var list = el('div', 'media-episodes');
                seasons[num].forEach(function (ep) {
                    var row = el('button', 'media-episode');
                    row.type = 'button';
                    row.appendChild(el('span', 'media-episode-name', ep.name));
                    row.appendChild(el('span', 'media-episode-play', '▶'));
                    row.addEventListener('click', function () {
                        openPlayer(ep, s.name + ' — ' + ep.name);
                    });
                    list.appendChild(row);
                });
                sec.appendChild(list);
                wrap.appendChild(sec);
            });
        view.appendChild(wrap);
    }

    /* ---------- music ---------- */

    function musicPosterUrl(it) {
        if (it.poster_url) return it.poster_url;
        return it.poster ? 'media/Music/' + it.dir + '/poster.jpg' : null;
    }

    function renderMusic() {
        removeAzBar();
        view.innerHTML = '';
        showMessage('Loading…');
        loadTab('music').then(function (data) {
            var items = (data.items || []).slice().sort(function (a, b) {
                return String(a.title).localeCompare(String(b.title));
            });
            if (!items.length) { showMessage('No music found.'); return; }
            view.innerHTML = '';
            var grid = el('div', 'media-grid');
            items.forEach(function (it) {
                var card = posterCard(musicPosterUrl(it), it.title, '');
                card.addEventListener('click', function () {
                    var files = it.files || [];
                    if (files.length === 1) {
                        openPlayer(files[0], it.title);
                    } else {
                        renderMusicDetail(it);
                    }
                });
                grid.appendChild(card);
            });
            view.appendChild(grid);
        }).catch(function () { showMessage('Could not load music.'); });
    }

    function renderMusicDetail(it) {
        removeAzBar();
        view.innerHTML = '';
        var wrap = el('div', 'media-detail');
        var head = el('div', 'media-detail-head');
        head.appendChild(backButton(renderMusic));
        head.appendChild(el('h2', 'media-detail-title', it.title));
        wrap.appendChild(head);
        wrap.appendChild(fileRows(it.files || [], it.title));
        view.appendChild(wrap);
    }

    /* ---------- tabs ---------- */

    var renderers = { movies: renderMovies, tv: renderTv, music: renderMusic };

    function selectTab(tab) {
        currentTab = tab;
        tabs.forEach(function (t) {
            t.classList.toggle('active', t.getAttribute('data-tab') === tab);
        });
        scrollBox.scrollTop = 0;
        renderers[tab]();
    }

    tabs.forEach(function (t) {
        t.addEventListener('click', function () { selectTab(t.getAttribute('data-tab')); });
    });

    /* ---------- scroll buttons ---------- */

    function scrollByPage(dir) {
        scrollBox.scrollBy({ top: dir * scrollBox.clientHeight * 0.8, behavior: 'smooth' });
    }
    document.getElementById('media-scroll-up').addEventListener('click', function () { scrollByPage(-1); });
    document.getElementById('media-scroll-down').addEventListener('click', function () { scrollByPage(1); });

    /* ---------- player ---------- */

    var playerOverlay = document.getElementById('player-overlay');
    var video = document.getElementById('player-video');
    var playBtn = document.getElementById('player-play');
    var progress = document.getElementById('player-progress');
    var progressFill = document.getElementById('player-progress-fill');
    var timeCur = document.getElementById('player-time-cur');
    var timeTotal = document.getElementById('player-time-total');
    var vlcPanel = document.getElementById('player-vlc');
    var vlcMsg = document.getElementById('player-vlc-msg');
    var vlcStatus = document.getElementById('player-vlc-status');
    var currentFile = null;

    // Title shown over the (picture-less) player when an audio file is playing.
    var audioTitle = el('div', 'player-audio-title');
    audioTitle.hidden = true;
    playerOverlay.appendChild(audioTitle);

    var AUDIO_EXT = /\.(mp3|flac|ogg|oga|opus|m4a|aac|wav|wma)(\?|#|$)/i;

    function isAudioFile(f) {
        return AUDIO_EXT.test(f.url || '') || AUDIO_EXT.test(f.name || '');
    }

    function fmtTime(sec) {
        if (!isFinite(sec) || sec < 0) sec = 0;
        sec = Math.floor(sec);
        var h = Math.floor(sec / 3600);
        var m = Math.floor((sec % 3600) / 60);
        var s = sec % 60;
        var mm = h ? String(m).padStart(2, '0') : String(m);
        return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
    }

    function showVlc(msg) {
        video.pause();
        audioTitle.hidden = true;
        vlcMsg.textContent = msg || 'This file cannot be played in the browser.';
        vlcStatus.textContent = '';
        vlcPanel.hidden = false;
    }

    function openPlayer(file, title) {
        currentFile = file;
        if (window.ASSISTANT && window.ASSISTANT.kill) window.ASSISTANT.kill();
        if (window.KIOSK_SLIDESHOW) window.KIOSK_SLIDESHOW.pause();
        vlcPanel.hidden = true;
        playerOverlay.hidden = false;
        if (isAudioFile(file)) {
            audioTitle.textContent = title || file.name || '';
            audioTitle.hidden = false;
        } else {
            audioTitle.hidden = true;
        }
        if (file.playable === false) {
            showVlc();
            return;
        }
        video.src = file.url;
        video.play().catch(function () { /* error event covers codecs; play() rejection is usually autoplay policy */ });
        updatePlayBtn();
    }

    function closePlayer() {
        video.pause();
        video.removeAttribute('src');
        video.load();
        playerIdleStop();
        vlcPanel.hidden = true;
        audioTitle.hidden = true;
        playerOverlay.hidden = true;
        if (window.KIOSK_SLIDESHOW) window.KIOSK_SLIDESHOW.resume();
    }

    function updatePlayBtn() {
        playBtn.innerHTML = video.paused ? '▶' : '&#10074;&#10074;';
    }

    playBtn.addEventListener('click', function () {
        if (!video.src) return;
        if (video.paused) video.play(); else video.pause();
    });
    video.addEventListener('play', updatePlayBtn);
    video.addEventListener('pause', updatePlayBtn);

    video.addEventListener('timeupdate', function () {
        timeCur.textContent = fmtTime(video.currentTime);
        if (video.duration) {
            progressFill.style.width = (video.currentTime / video.duration * 100) + '%';
        }
    });
    video.addEventListener('loadedmetadata', function () {
        timeTotal.textContent = fmtTime(video.duration);
    });
    video.addEventListener('error', function () {
        if (video.getAttribute('src')) showVlc('This file could not be played (unsupported format).');
    });
    video.addEventListener('ended', updatePlayBtn);

    /* Hide cursor + controls after 2s without mouse movement while playing. */
    var playerIdleTimer = null;

    function playerActive() {
        playerOverlay.classList.remove('player-idle');
        clearTimeout(playerIdleTimer);
        if (!video.paused && !video.ended) {
            playerIdleTimer = setTimeout(function () {
                playerOverlay.classList.add('player-idle');
            }, 2000);
        }
    }

    function playerIdleStop() {
        clearTimeout(playerIdleTimer);
        playerOverlay.classList.remove('player-idle');
    }

    playerOverlay.addEventListener('mousemove', playerActive);
    video.addEventListener('play', playerActive);
    video.addEventListener('pause', playerIdleStop);
    video.addEventListener('ended', playerIdleStop);

    progress.addEventListener('click', function (e) {
        if (!video.duration) return;
        var rect = progress.getBoundingClientRect();
        var frac = (e.clientX - rect.left) / rect.width;
        video.currentTime = Math.max(0, Math.min(1, frac)) * video.duration;
    });

    document.getElementById('player-close').addEventListener('click', closePlayer);

    document.getElementById('player-vlc-btn').addEventListener('click', function () {
        if (!currentFile) return;
        playInVlc(currentFile, vlcStatus);
    });
    document.getElementById('player-vlc-close').addEventListener('click', function () {
        vlcPanel.hidden = true;
    });

    // In-player VLC handoff: for files that "play" but show no picture
    // (e.g. XviD inside an .mp4 container), or any other reason.
    document.getElementById('player-vlc-alt').addEventListener('click', function () {
        if (!currentFile) return;
        video.pause();
        playInVlc(currentFile, null);
    });

    // Click on the dimmed backdrop (outside the controls) closes the player.
    playerOverlay.addEventListener('click', function (e) {
        if (e.target === playerOverlay) closePlayer();
    });

    /* ---------- voice assistant hooks ---------- */

    function normTitle(s) {
        return String(s || '').toLowerCase()
            .replace(/&/g, ' and ')
            .replace(/[^a-z0-9 ]+/g, ' ')
            .replace(/\b(the|a|an)\b/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function titleScore(query, candidate) {
        var q = normTitle(query);
        var c = normTitle(candidate);
        if (!q || !c) return 0;
        if (c === q) return 100;
        if (c.indexOf(q) >= 0 || q.indexOf(c) >= 0) return 80;
        var qTokens = q.split(' ');
        var cTokens = c.split(' ');
        var hits = 0;
        qTokens.forEach(function (t) {
            if (cTokens.some(function (ct) { return ct === t || (t.length > 3 && ct.indexOf(t) === 0); })) hits++;
        });
        return hits / qTokens.length * 60;
    }

    function bestMatch(query, items, labelOf) {
        var best = null;
        var bestScore = 40; /* below this, don't guess */
        items.forEach(function (it) {
            var s = titleScore(query, labelOf(it));
            if (s > bestScore) {
                best = it;
                bestScore = s;
            }
        });
        return best;
    }

    function firstPlayable(files) {
        for (var i = 0; i < files.length; i++) {
            if (files[i].playable !== false) return files[i];
        }
        return files[0] || null;
    }

    function hookPlay(file, label) {
        if (file.playable === false) {
            playInVlc(file, null);
            return { ok: true, result: 'Playing ' + label + ' with VLC.' };
        }
        openPlayer(file, label);
        return { ok: true, result: 'Playing ' + label + '.' };
    }

    window.MEDIA = {
        playMovie: function (title) {
            return loadTab('movies').then(function (data) {
                var m = bestMatch(title, data.movies || [], function (x) { return x.title; });
                if (!m) return { ok: false, result: 'No movie matching "' + title + '" in the library.' };
                var f = firstPlayable(m.files || []);
                if (!f) return { ok: false, result: 'Found ' + m.title + ' but it has no video files.' };
                return hookPlay(f, m.title + (m.year ? ' (' + m.year + ')' : ''));
            });
        },
        playTv: function (show, season, episode) {
            return loadTab('tv').then(function (data) {
                var s = bestMatch(show, data.series || [], function (x) { return x.name; });
                if (!s) return { ok: false, result: 'No series matching "' + show + '" in the library.' };
                var seasons = s.seasons || {};
                var nums = Object.keys(seasons).map(Number).sort(function (a, b) { return a - b; });
                if (!nums.length) return { ok: false, result: 'No episodes found for ' + s.name + '.' };
                var sn = (season && seasons[season]) ? Number(season) : nums[0];
                var eps = seasons[sn];
                var f = null;
                if (episode) {
                    var tag = 's' + String(sn).padStart(2, '0') + 'e' + String(episode).padStart(2, '0');
                    eps.forEach(function (ep) {
                        if (!f && ep.name.toLowerCase().indexOf(tag) >= 0) f = ep;
                    });
                    if (!f && eps[episode - 1]) f = eps[episode - 1];
                    if (!f) return { ok: false, result: 'Could not find season ' + sn + ' episode ' + episode + ' of ' + s.name + '.' };
                } else {
                    f = firstPlayable(eps);
                }
                if (!f) return { ok: false, result: 'No playable episodes found for ' + s.name + '.' };
                return hookPlay(f, s.name + ' — ' + f.name);
            });
        },
        playMusic: function (query) {
            return loadTab('music').then(function (data) {
                var items = data.items || [];
                var trackHit = null;
                var trackItem = null;
                items.forEach(function (x) {
                    (x.files || []).forEach(function (f) {
                        if (!trackHit && titleScore(query, f.name.replace(/\.[^.]+$/, '')) >= 80) {
                            trackHit = f;
                            trackItem = x;
                        }
                    });
                });
                if (trackHit) {
                    return hookPlay(trackHit, trackItem.title + ' — ' + trackHit.name.replace(/\.[^.]+$/, ''));
                }
                var it = bestMatch(query, items, function (x) { return x.title; });
                if (!it) return { ok: false, result: 'No music matching "' + query + '" in the library.' };
                var f = firstPlayable(it.files || []);
                if (!f) return { ok: false, result: 'Found ' + it.title + ' but it has no playable files.' };
                return hookPlay(f, it.title + ' — ' + f.name.replace(/\.[^.]+$/, ''));
            });
        },
        stop: function () {
            closePlayer();
            return fetch('api/play-local.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'stop' })
            }).then(function () { return { ok: true, result: 'Playback stopped.' }; })
              .catch(function () { return { ok: true, result: 'Playback stopped.' }; });
        }
    };

    /* ---------- open/close ---------- */

    document.getElementById('tile-movies').addEventListener('click', function () {
        overlay.hidden = false;
        selectTab(currentTab);
    });
    document.getElementById('media-close').addEventListener('click', function () {
        overlay.hidden = true;
    });
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) overlay.hidden = true;
    });
})();
