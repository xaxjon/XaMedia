<?php
$settingsFile = __DIR__ . '/../lib/settings.php';
if (!is_file($settingsFile)) {
    // Backend layouts where lib/ sits one level above the app root.
    $settingsFile = __DIR__ . '/../../lib/settings.php';
}
require_once $settingsFile;

$settings = load_settings();

// Versioned asset URLs so deploys bypass stale browser caches.
$v = function (string $rel): string {
    $f = __DIR__ . '/' . $rel;
    return $rel . '?v=' . (is_file($f) ? filemtime($f) : time());
};

$jsConfig = [
    'slideshow' => $settings['slideshow'],
    'stations'  => $settings['stations'],
    'assistant' => $settings['assistant'],
    'ums_url'   => $settings['ums_url'] ?? '',
];
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Home Entertainment</title>
<link rel="stylesheet" href="<?= $v('assets/css/app.css') ?>">
</head>
<body>

<div id="bg-a" class="bg-layer"></div>
<div id="bg-b" class="bg-layer"></div>
<div id="bg-vignette"></div>

<header id="topbar">
    <div id="clock">
        <div id="clock-time">--:--</div>
        <div id="clock-date"></div>
    </div>
    <button id="weather" type="button" aria-label="Weather forecast">
        <span id="weather-icon"></span>
        <span id="weather-body">
            <span id="weather-temp">--&deg;</span>
            <span id="weather-hilo"></span>
            <span id="weather-extra">
                <span id="weather-wind">
                    <svg id="wind-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21V4m0 0l-6 6m6-6l6 6"/></svg>
                    <span id="weather-wind-speed"></span>
                </span>
                <span id="weather-pressure"></span>
            </span>
            <span id="weather-label"></span>
        </span>
    </button>
</header>

<div id="forecast" hidden></div>

<div id="chrome">
    <main id="stream-tiles">
        <button class="tile stream-tile" id="tile-netflix" type="button" data-service="netflix">
            <span class="stream-logo stream-logo-netflix">N</span>
            <span class="tile-name">Netflix</span>
        </button>
        <button class="tile stream-tile" id="tile-youtube" type="button" data-service="youtube">
            <span class="stream-logo stream-logo-youtube">&#9654;</span>
            <span class="tile-name">YouTube</span>
        </button>
        <button class="tile stream-tile" id="tile-hbo" type="button" data-service="hbo">
            <span class="stream-logo stream-logo-hbo">MAX</span>
            <span class="tile-name">HBO Max</span>
        </button>
        <button class="tile stream-tile" id="tile-prime" type="button" data-service="prime">
            <span class="stream-logo stream-logo-prime">prime</span>
            <span class="tile-name">Prime TV</span>
        </button>
    </main>
    <div id="stream-status" hidden>Opening browser session…</div>
    <main id="tiles">
        <button class="tile" id="tile-radio" type="button">
            <span class="tile-icon">&#9835;</span>
            <span class="tile-name">Radio</span>
        </button>
        <button class="tile" id="tile-photos" type="button">
            <span class="tile-icon">&#128247;</span>
            <span class="tile-name">Photos</span>
        </button>
        <button class="tile" id="tile-movies" type="button">
            <span class="tile-icon">&#127909;</span>
            <span class="tile-name">Movies</span>
        </button>
        <button class="tile" id="tile-cameras" type="button" data-service="cameras">
            <span class="tile-icon">&#128064;</span>
            <span class="tile-name">Cameras</span>
        </button>
        <button class="tile" id="tile-assistant" type="button" data-service="assistant">
            <span class="tile-icon">&#127908;</span>
            <span class="tile-name">Assistant</span>
        </button>
        <button class="tile" id="tile-settings" type="button">
            <span class="tile-icon">&#9881;</span>
            <span class="tile-name">Settings</span>
        </button>
    </main>
</div>

<div id="radio-overlay" hidden>
    <div id="radio-panel">
        <div id="radio-head">
            <span id="radio-title">Internet Radio</span>
            <button id="radio-close" type="button" aria-label="Close">&times;</button>
        </div>
        <div id="radio-tabs">
            <button class="radio-tab active" data-rtab="my" type="button">My Stations</button>
            <button class="radio-tab" data-rtab="browse" type="button">Browse</button>
        </div>
        <div id="radio-my">
            <div id="radio-stations"></div>
        </div>
        <div id="radio-browse" hidden>
            <div id="radio-genres"></div>
            <div id="radio-browse-list"><div class="radio-hint">Pick a genre above — stations load from the radio-browser.info directory.</div></div>
        </div>
        <div id="radio-controls" hidden>
            <div id="radio-eq"><span></span><span></span><span></span><span></span></div>
            <div id="radio-now">Stopped</div>
            <div id="radio-buttons">
                <button id="radio-vol-down" type="button" aria-label="Volume down">&#8722;</button>
                <button id="radio-play" type="button">Play</button>
                <button id="radio-vol-up" type="button" aria-label="Volume up">+</button>
            </div>
        </div>
    </div>
</div>

<div id="media-overlay" hidden>
    <div id="media-panel">
        <div id="media-head">
            <div id="media-tabs">
                <button class="media-tab active" type="button" data-tab="movies">Movies</button>
                <button class="media-tab" type="button" data-tab="tv">TV</button>
                <button class="media-tab" type="button" data-tab="music">Music</button>
            </div>
            <button id="media-close" type="button" aria-label="Close">&times;</button>
        </div>
        <div id="media-body">
            <div id="media-scroll">
                <div id="media-view"></div>
            </div>
            <button id="media-scroll-up" type="button" aria-label="Scroll up">&#9650;</button>
            <button id="media-scroll-down" type="button" aria-label="Scroll down">&#9660;</button>
        </div>
    </div>
</div>

<div id="player-overlay" hidden>
    <video id="player-video" preload="auto"></video>
    <div id="player-controls">
        <button id="player-play" type="button" aria-label="Play or pause">&#10074;&#10074;</button>
        <span id="player-time-cur">0:00</span>
        <div id="player-progress"><div id="player-progress-fill"></div></div>
        <span id="player-time-total">0:00</span>
        <button id="player-vlc-alt" type="button" title="Play with VLC instead">VLC</button>
        <button id="player-close" type="button" aria-label="Close">&times;</button>
    </div>
    <div id="player-vlc" hidden>
        <p id="player-vlc-msg">This file cannot be played in the browser.</p>
        <button id="player-vlc-btn" type="button">&#9654; Play with VLC</button>
        <p id="player-vlc-status"></p>
        <button id="player-vlc-close" type="button">Back</button>
    </div>
</div>

<div id="assistant-overlay" hidden>
    <canvas id="assistant-orb"></canvas>
    <div id="assistant-status">Connecting&hellip;</div>
    <div id="assistant-caption"></div>
    <button id="assistant-close" type="button" aria-label="Close">&times;</button>
</div>

<div id="pin-overlay" hidden></div>
<div id="settings-overlay" hidden></div>
<div id="radio-mini" hidden><span id="radio-mini-name"></span><button id="radio-mini-stop" type="button">■</button></div>
<button id="photo-exit" hidden aria-label="Exit photo mode">&times;</button>
<button id="photo-edit" hidden aria-label="Manage photos">&#9881;</button>

<div id="photos-overlay" hidden>
    <div id="photos-panel">
        <div id="photos-head">
            <span>Manage Photos</span>
            <span id="photos-status"></span>
            <button id="photos-find-blank" type="button">Find blanks</button>
            <button id="photos-purge-blank" type="button" hidden></button>
            <button id="photos-close" type="button" aria-label="Close">&times;</button>
        </div>
        <div id="photos-hint">&#10007; moves to trash (recoverable) &nbsp;·&nbsp; &#8635; rotates 90&deg; clockwise &nbsp;·&nbsp; click a photo to view it</div>
        <div id="photos-grid"></div>
    </div>
</div>

<audio id="radio-audio" preload="none"></audio>

<script>
window.APP_CONFIG = <?= json_encode($jsConfig, JSON_UNESCAPED_SLASHES) ?>;
</script>
<script src="<?= $v('assets/js/app.js') ?>"></script>
<script src="<?= $v('assets/js/assistant.js') ?>"></script>
<script src="<?= $v('assets/js/radio.js') ?>"></script>
<script src="<?= $v('assets/js/media.js') ?>"></script>
<script src="<?= $v('assets/js/settings.js') ?>"></script>
<script src="<?= $v('assets/js/photos.js') ?>"></script>
</body>
</html>
