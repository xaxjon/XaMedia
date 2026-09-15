/* Internet radio overlay. */
(function () {
    'use strict';

    var cfg = window.APP_CONFIG || {};
    var stations = cfg.stations || [];

    var overlay = document.getElementById('radio-overlay');
    var listEl = document.getElementById('radio-stations');
    var controls = document.getElementById('radio-controls');
    var nowEl = document.getElementById('radio-now');
    var eqEl = document.getElementById('radio-eq');
    var playBtn = document.getElementById('radio-play');
    var audio = document.getElementById('radio-audio');

    var current = null; // index into stations
    var playing = false;

    audio.volume = 0.8;

    function setPlaying(on) {
        playing = on;
        eqEl.classList.toggle('playing', on);
        playBtn.textContent = on ? 'Stop' : 'Play';
    }

    function tuneIn(i) {
        current = i;
        var st = stations[i];
        audio.src = st.url;
        audio.play().catch(function () {
            nowEl.textContent = 'Could not play this stream';
            setPlaying(false);
        });
        nowEl.textContent = st.name;
        controls.hidden = false;
        var btns = listEl.querySelectorAll('.station-btn');
        btns.forEach(function (b, j) {
            b.classList.toggle('active', j === i);
        });
    }

    stations.forEach(function (st, i) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'station-btn';
        btn.innerHTML = '<span class="station-dot">&#9835;</span><span></span>';
        btn.querySelector('span:last-child').textContent = st.name;
        btn.addEventListener('click', function () { tuneIn(i); });
        listEl.appendChild(btn);
    });

    playBtn.addEventListener('click', function () {
        if (current === null) {
            if (stations.length) tuneIn(0);
            return;
        }
        if (audio.paused) {
            // Re-set the source so live streams resume at the live edge.
            audio.src = stations[current].url;
            audio.play();
        } else {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
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
        if (current !== null) nowEl.textContent = stations[current].name;
    });
    audio.addEventListener('pause', function () { setPlaying(false); });
    audio.addEventListener('error', function () {
        if (current !== null) {
            nowEl.textContent = 'Stream error — try again';
        }
        setPlaying(false);
    });

    document.getElementById('tile-radio').addEventListener('click', function () {
        overlay.hidden = false;
    });
    document.getElementById('radio-close').addEventListener('click', function () {
        overlay.hidden = true;
    });
    // Click on the dimmed backdrop (not the panel) also closes.
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) overlay.hidden = true;
    });
})();
