/* Slideshow, clock, weather widget, idle attract mode, burn-in drift. */
(function () {
    'use strict';

    var cfg = window.APP_CONFIG || {};
    var slide = cfg.slideshow || { interval: 20, fade: 1.5, idle_timeout: 120 };

    /* ---------- background slideshow ---------- */

    var layers = [document.getElementById('bg-a'), document.getElementById('bg-b')];
    layers.forEach(function (l) { l.style.transitionDuration = (slide.fade || 1.5) + 's'; });
    var photos = [];
    var idx = 0;
    var front = 0;
    var kbFlip = false;
    var timer = null;

    function photoUrl(rel) {
        return 'api/photo.php?f=' + encodeURIComponent(rel);
    }

    function showNext() {
        if (!photos.length) return;
        var rel = photos[idx % photos.length];
        idx++;

        var back = layers[1 - front];
        var img = new Image();
        img.onload = function () {
            back.style.backgroundImage = 'url("' + photoUrl(rel) + '")';
            // Restart the Ken Burns animation (alternating direction) without
            // touching opacity state, then fade in over the previous slide.
            // The outgoing slide keeps its kb class so it drifts on while
            // fading instead of snapping back to unscaled.
            back.classList.remove('kb-a', 'kb-b');
            void back.offsetWidth;
            back.classList.add(kbFlip ? 'kb-a' : 'kb-b');
            kbFlip = !kbFlip;
            back.classList.add('visible');
            layers[front].classList.remove('visible');
            front = 1 - front;
        };
        img.src = photoUrl(rel);
    }

    function startSlideshow() {
        fetch('api/photos.php')
            .then(function (r) { return r.json(); })
            .then(function (list) {
                if (!Array.isArray(list) || !list.length) return;
                photos = list;
                showNext();
                timer = setInterval(showNext, slide.interval * 1000);
            })
            .catch(function () { /* no photos yet — dark background is fine */ });
    }

    // Pick up newly imported photos without a page reload: refetch the list
    // and merge if it changed. Runs on a timer and when photo mode opens.
    function refreshPhotos(advance) {
        fetch('api/photos.php')
            .then(function (r) { return r.json(); })
            .then(function (list) {
                if (!Array.isArray(list) || !list.length) return;
                if (list.length !== photos.length) {
                    photos = list;
                    if (idx > photos.length) idx = 0;
                    if (advance) showNext();
                } else if (advance) {
                    showNext();
                }
            })
            .catch(function () { /* keep current list */ });
    }
    setInterval(function () { refreshPhotos(false); }, 15 * 60 * 1000);

    // The media player pauses the background slideshow while a video plays:
    // the Ken Burns animation + crossfades still cost compositor time behind
    // the fullscreen player and can cause playback stutter.
    window.KIOSK_SLIDESHOW = {
        pause: function () {
            if (timer) { clearInterval(timer); timer = null; }
            document.body.classList.add('video-playing');
        },
        resume: function () {
            if (!timer && photos.length) {
                timer = setInterval(showNext, slide.interval * 1000);
            }
            document.body.classList.remove('video-playing');
        }
    };

    /* ---------- clock ---------- */

    var timeEl = document.getElementById('clock-time');
    var dateEl = document.getElementById('clock-date');

    function tickClock() {
        var now = new Date();
        var hh = String(now.getHours()).padStart(2, '0');
        var mm = String(now.getMinutes()).padStart(2, '0');
        timeEl.textContent = hh + ':' + mm;
        dateEl.textContent = now.toLocaleDateString(undefined, {
            weekday: 'long', day: 'numeric', month: 'long'
        });
    }
    tickClock();
    setInterval(tickClock, 10000);

    /* ---------- weather ---------- */

    var ICONS = {
        clear: '<svg viewBox="0 0 64 64"><g class="wi-sun"><circle cx="32" cy="32" r="12"/>' +
            sunRays() + '</g></svg>',
        partly: '<svg viewBox="0 0 64 64"><g class="wi-sun"><circle cx="24" cy="24" r="9"/>' +
            sunRays(24, 24, 14) + '</g>' +
            '<path class="wi-cloud" d="M20 44a9 9 0 0 1 1.5-17.9A13 13 0 0 1 46 29a8 8 0 0 1-1 16H20z"/></svg>',
        cloud: '<svg viewBox="0 0 64 64"><path class="wi-cloud" d="M18 46a10 10 0 0 1 1.7-19.8A14 14 0 0 1 47 29a9 9 0 0 1-1 18H18z"/></svg>',
        fog: '<svg viewBox="0 0 64 64"><path class="wi-cloud" d="M20 38a9 9 0 0 1 1.5-17.8A13 13 0 0 1 46 23a8 8 0 0 1-1 16H20z"/>' +
            '<rect class="wi-cloud" x="16" y="44" width="32" height="3" rx="1.5"/>' +
            '<rect class="wi-cloud" x="22" y="51" width="26" height="3" rx="1.5"/></svg>',
        drizzle: cloudWithPrecip('wi-drop', 3, 2.4),
        rain: cloudWithPrecip('wi-drop', 3, 3.4),
        snow: cloudWithPrecip('wi-flake', 3, 2.6),
        storm: '<svg viewBox="0 0 64 64"><path class="wi-cloud" d="M18 36a10 10 0 0 1 1.7-19.8A14 14 0 0 1 47 19a9 9 0 0 1-1 18H18z"/>' +
            '<path class="wi-bolt" d="M34 36l-8 12h6l-3 12 11-15h-6l4-9z"/></svg>'
    };

    function sunRays(cx, cy, r) {
        cx = cx || 32; cy = cy || 32; r = r || 19;
        var s = '';
        for (var i = 0; i < 8; i++) {
            var a = i * Math.PI / 4;
            var x1 = cx + Math.cos(a) * r, y1 = cy + Math.sin(a) * r;
            var x2 = cx + Math.cos(a) * (r + 5), y2 = cy + Math.sin(a) * (r + 5);
            s += '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) +
                 '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) +
                 '" stroke="#ffd45e" stroke-width="3" stroke-linecap="round"/>';
        }
        return s;
    }

    function cloudWithPrecip(cls, n, size) {
        var drops = '';
        for (var i = 0; i < n; i++) {
            drops += '<circle class="' + cls + '" cx="' + (24 + i * 8) + '" cy="48" r="' + size + '"/>';
        }
        return '<svg viewBox="0 0 64 64"><path class="wi-cloud" d="M18 40a10 10 0 0 1 1.7-19.8A14 14 0 0 1 47 23a9 9 0 0 1-1 18H18z"/>' + drops + '</svg>';
    }

    function icon(name) {
        return ICONS[name] || ICONS.cloud;
    }

    var weatherData = null;

    function renderWeather() {
        if (!weatherData || !weatherData.current) return;
        var c = weatherData.current;
        document.getElementById('weather-icon').innerHTML = icon(c.icon);
        document.getElementById('weather-temp').innerHTML =
            Math.round(c.temperature_2m) + '&deg;';
        var d = weatherData.daily;
        if (d && d.temperature_2m_max) {
            document.getElementById('weather-hilo').textContent =
                Math.round(d.temperature_2m_max[0]) + '° / ' +
                Math.round(d.temperature_2m_min[0]) + '°';
        }
        // Wind: meteorological direction is where the wind comes FROM;
        // the arrow shows where it blows TO, so rotate by direction + 180.
        var windEl = document.getElementById('weather-wind');
        if (c.wind_speed_10m !== undefined && c.wind_speed_10m !== null) {
            document.getElementById('wind-arrow').style.transform =
                'rotate(' + ((Number(c.wind_direction_10m) || 0) + 180) + 'deg)';
            document.getElementById('weather-wind-speed').textContent =
                Math.round(c.wind_speed_10m) + ' km/h';
            windEl.style.display = '';
        } else {
            windEl.style.display = 'none';
        }
        var pressEl = document.getElementById('weather-pressure');
        if (c.surface_pressure !== undefined && c.surface_pressure !== null) {
            var trend = { rising: '↑', falling: '↓', steady: '→' }[c.pressure_trend] || '';
            pressEl.textContent = Math.round(c.surface_pressure) + ' hPa ' + trend;
            pressEl.style.display = '';
        } else {
            pressEl.style.display = 'none';
        }
        document.getElementById('weather-label').textContent =
            weatherData.location_label || '';
    }

    function renderForecast() {
        var box = document.getElementById('forecast');
        var d = weatherData && weatherData.daily;
        if (!d || !d.time) return;
        var html = '';
        for (var i = 0; i < d.time.length; i++) {
            var day = new Date(d.time[i] + 'T12:00:00');
            html += '<div class="forecast-day">' +
                '<div class="fd-name">' + day.toLocaleDateString(undefined, { weekday: 'short' }) + '</div>' +
                '<div class="fd-icon">' + icon(d.icons ? d.icons[i] : 'cloud') + '</div>' +
                '<div class="fd-max">' + Math.round(d.temperature_2m_max[i]) + '°</div>' +
                '<div class="fd-min">' + Math.round(d.temperature_2m_min[i]) + '°</div>' +
                '</div>';
        }
        box.innerHTML = html;
    }

    function loadWeather() {
        fetch('api/weather.php')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.error) return;
                weatherData = data;
                renderWeather();
                renderForecast();
            })
            .catch(function () { /* keep previous render */ });
    }

    document.getElementById('weather').addEventListener('click', function () {
        var box = document.getElementById('forecast');
        box.hidden = !box.hidden;
    });

    loadWeather();
    setInterval(loadWeather, 15 * 60 * 1000);

    /* ---------- anti-burn-in drift ----------
       The clock and weather widgets stay on screen permanently (including
       attract mode), so they slowly wander around their base position to
       keep any single pixel from being lit the same way for hours. */

    var DRIFT_X = 60, DRIFT_Y = 24;

    function makeDrifter(el) {
        var pos = { x: 0, y: 0 };
        return function () {
            pos.x = Math.max(-DRIFT_X, Math.min(DRIFT_X, pos.x + (Math.random() * 40 - 20)));
            pos.y = Math.max(-DRIFT_Y, Math.min(DRIFT_Y, pos.y + (Math.random() * 16 - 8)));
            el.style.transform = 'translate(' + Math.round(pos.x) + 'px,' + Math.round(pos.y) + 'px)';
        };
    }

    var drifters = [
        makeDrifter(document.getElementById('clock')),
        makeDrifter(document.getElementById('weather'))
    ];
    setInterval(function () {
        drifters.forEach(function (d) { d(); });
    }, 60000);

    /* ---------- idle attract mode ---------- */

    var idleTimer = null;

    function enterAttract() {
        document.body.classList.add('attract');
        document.getElementById('forecast').hidden = true;
    }
    function exitAttract() {
        document.body.classList.remove('attract');
    }
    function resetIdle() {
        exitAttract();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(enterAttract, slide.idle_timeout * 1000);
    }

    ['mousemove', 'mousedown', 'wheel'].forEach(function (evt) {
        document.addEventListener(evt, resetIdle, { passive: true });
    });
    resetIdle();

    // Photos tile: dedicated photo-frame mode. Unlike attract mode it is NOT
    // cancelled by mouse movement — only by the ✕ button (which appears on
    // mouse move and fades after 2s). Fresh imports are picked up on entry.
    var photoExit = document.getElementById('photo-exit');
    var photoEdit = document.getElementById('photo-edit');
    var photoExitTimer = null;

    function showPhotoExit() {
        photoExit.hidden = false;
        photoEdit.hidden = false;
        clearTimeout(photoExitTimer);
        photoExitTimer = setTimeout(function () {
            photoExit.hidden = true;
            photoEdit.hidden = true;
        }, 2000);
    }

    function enterPhotoMode() {
        document.body.classList.add('photo-mode');
        refreshPhotos(true);
        showPhotoExit();
    }

    document.getElementById('tile-photos').addEventListener('click', enterPhotoMode);
    photoExit.addEventListener('click', function (e) {
        e.stopPropagation();
        document.body.classList.remove('photo-mode');
        photoExit.hidden = true;
        photoEdit.hidden = true;
    });
    document.addEventListener('mousemove', function () {
        if (document.body.classList.contains('photo-mode')) showPhotoExit();
    }, { passive: true });

    // photos.js drives this from the manager grid.
    window.KIOSK_PHOTOS = {
        show: function (rel) {
            enterPhotoMode();
            var i = photos.indexOf(rel);
            if (i >= 0) {
                idx = i;
                showNext();
            }
        }
    };

    // Streaming service tiles: fullscreen browser session on the kiosk
    // display; the kiosk stays underneath when the session exits.
    document.querySelectorAll('.stream-tile').forEach(function (tile) {
        tile.addEventListener('click', function () {
            var status = document.getElementById('stream-status');
            status.hidden = false;
            clearTimeout(status._t);
            status._t = setTimeout(function () { status.hidden = true; }, 8000);
            fetch('api/stream.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ service: tile.getAttribute('data-service') })
            }).catch(function () { /* session launch is fire-and-forget */ });
        });
    });

    startSlideshow();
})();
