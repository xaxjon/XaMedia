/* Shared media-playback state used to suppress accidental voice activation. */
(function () {
    'use strict';

    var external = false;
    var active = false;
    var listeners = [];

    function localPlayback() {
        var player = document.getElementById('player-overlay');
        var browserMedia = player && !player.hidden;
        var radio = window.RADIO && window.RADIO.isPlaying && window.RADIO.isPlaying();
        return !!(browserMedia || radio);
    }

    function update() {
        var next = external || localPlayback();
        if (next === active) return;
        active = next;
        listeners.slice().forEach(function (listener) { listener(active); });
    }

    function refresh() {
        return fetch('api/playback-state.php', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (state) {
                external = !!state.playing;
                update();
            })
            .catch(function () { /* preserve the last external state */ });
    }

    window.KIOSK_PLAYBACK = {
        isActive: function () { return active; },
        onChange: function (listener) {
            listeners.push(listener);
            listener(active);
        },
        refresh: refresh
    };

    setInterval(update, 1000);
    refresh();
    setInterval(refresh, 2000);
})();
