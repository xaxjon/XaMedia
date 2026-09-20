<?php
// Copy this file to config.php and edit for your installation.
// Everything except the absolute paths at the bottom can also be changed
// later from the kiosk's PIN-gated Settings UI (stored in
// data/settings.json, which overrides the matching values here).
return [
    // Geographic location for the weather widget.
    'location' => [
        'lat'   => -34.6037,
        'lon'   => -58.3816,
        'label' => 'Buenos Aires',
    ],

    // TMDB API key for movie info/correction endpoints.
    // Get one free at https://www.themoviedb.org/settings/api
    'tmdb_api_key' => '',

    // Gemini API key (voice assistant + TTS proxy).
    // Both keys can also be set in the kiosk Settings UI.
    'gemini_api_key' => '',

    // Universal Media Server web UI (used as an optional fallback link).
    'ums_url' => 'http://127.0.0.1:9001',

    // Internet radio stations. Direct stream URLs (Icecast/Shoutcast/HLS).
    'stations' => [
        [
            'name' => 'Groove Salad',
            'url'  => 'https://ice1.somafm.com/groovesalad-128-mp3',
        ],
        [
            'name' => 'Drone Zone',
            'url'  => 'https://ice1.somafm.com/dronezone-128-mp3',
        ],
    ],

    'slideshow' => [
        'interval'     => 20,   // seconds each photo stays on screen
        'fade'         => 3.0,  // crossfade duration in seconds
        'idle_timeout' => 120,  // seconds without mouse before attract mode
    ],

    // Absolute paths; no trailing slash.
    'photos_dir' => __DIR__ . '/../data/photos',
    'cache_dir'  => __DIR__ . '/../data/cache',
];
