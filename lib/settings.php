<?php
// Shared settings loader. Base config comes from config/config.php and is
// overlaid with anything stored in data/settings.json (written through the
// settings API). pin_hash is stored in the JSON file but never returned
// by load_settings().

const SETTINGS_FILE = __DIR__ . '/../data/settings.json';
const SETTINGS_DEFAULT_PIN = '1234';

// Sub-arrays that are merged key-by-key instead of replaced wholesale.
const SETTINGS_MERGE_SECTIONS = ['location', 'slideshow', 'assistant'];

const ASSISTANT_DEFAULTS = [
    'proactive_enabled'        => true,
    'proactive_idle_minutes'   => 45,
    'proactive_cooldown_hours' => 4,
    'text_model'               => 'gemini-3.6-flash',
    'live_model'               => 'gemini-3.1-flash-live-preview',
];

function settings_read_file(): array
{
    if (!is_file(SETTINGS_FILE)) {
        return [];
    }
    $decoded = json_decode((string) file_get_contents(SETTINGS_FILE), true);
    return is_array($decoded) ? $decoded : [];
}

function load_settings(): array
{
    $config = require __DIR__ . '/../config/config.php';
    $stored = settings_read_file();

    unset($stored['pin_hash'], $stored['new_pin']);

    foreach (SETTINGS_MERGE_SECTIONS as $section) {
        if (isset($stored[$section], $config[$section])
            && is_array($stored[$section]) && is_array($config[$section])) {
            $stored[$section] = array_merge($config[$section], $stored[$section]);
        }
    }

    $merged = array_merge($config, $stored);
    $merged['ums_url'] = $merged['ums_url'] ?? 'http://127.0.0.1:9001';

    return [
        'location'   => $merged['location'],
        'slideshow'  => $merged['slideshow'],
        'assistant'  => array_merge(ASSISTANT_DEFAULTS,
            is_array($merged['assistant'] ?? null) ? $merged['assistant'] : []),
        'stations'   => $merged['stations'] ?? [],
        'photos_dir' => $merged['photos_dir'],
        'cache_dir'  => $merged['cache_dir'],
        'ums_url'    => $merged['ums_url'],
        // API keys: base values from config.php, overridable via the
        // Settings UI (stored in settings.json). Server-side use only —
        // api/settings.php masks these in its GET response.
        'tmdb_api_key'   => (string) ($merged['tmdb_api_key'] ?? ''),
        'gemini_api_key' => (string) ($merged['gemini_api_key'] ?? ''),
    ];
}

function save_settings(array $changes): void
{
    $stored = settings_read_file();

    foreach (SETTINGS_MERGE_SECTIONS as $section) {
        if (isset($changes[$section], $stored[$section])
            && is_array($changes[$section]) && is_array($stored[$section])) {
            $changes[$section] = array_merge($stored[$section], $changes[$section]);
        }
    }

    $merged = array_merge($stored, $changes);

    $dir = dirname(SETTINGS_FILE);
    if (!is_dir($dir)) {
        mkdir($dir, 0775, true);
    }
    file_put_contents(
        SETTINGS_FILE,
        json_encode($merged, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n",
        LOCK_EX
    );
}

function pin_ok(string $pin): bool
{
    $stored = settings_read_file();
    $hash = $stored['pin_hash'] ?? null;
    if (!is_string($hash) || $hash === '') {
        $hash = hash('sha256', SETTINGS_DEFAULT_PIN);
    }
    return hash_equals($hash, hash('sha256', $pin));
}
