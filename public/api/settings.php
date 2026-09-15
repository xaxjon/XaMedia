<?php
// GET  → current settings (no pin_hash) plus photo_count and pin_default.
// POST → {"pin": "...", "changes": {...}} applies whitelisted changes.

require __DIR__ . '/../../lib/settings.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $settings = load_settings();

    $count = 0;
    if (is_dir($settings['photos_dir'])) {
        $it = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($settings['photos_dir'], FilesystemIterator::SKIP_DOTS)
        );
        foreach ($it as $file) {
            if ($file->isFile()
                && in_array(strtolower($file->getExtension()), ['jpg', 'jpeg', 'png', 'webp'], true)) {
                $count++;
            }
        }
    }

    $settings['photo_count'] = $count;
    $settings['pin_default'] = pin_ok(SETTINGS_DEFAULT_PIN);

    echo json_encode($settings, JSON_UNESCAPED_SLASHES);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

$body = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($body) || !isset($body['pin']) || !pin_ok((string) $body['pin'])) {
    http_response_code(403);
    echo json_encode(['error' => 'bad pin']);
    exit;
}

$in = $body['changes'] ?? [];
if (!is_array($in)) {
    http_response_code(400);
    echo json_encode(['error' => 'changes must be an object']);
    exit;
}

$changes = [];

if (isset($in['location']) && is_array($in['location'])) {
    $loc = [];
    if (isset($in['location']['lat']) && is_numeric($in['location']['lat'])) {
        $loc['lat'] = (float) $in['location']['lat'];
    }
    if (isset($in['location']['lon']) && is_numeric($in['location']['lon'])) {
        $loc['lon'] = (float) $in['location']['lon'];
    }
    if (isset($in['location']['label']) && is_string($in['location']['label'])) {
        $loc['label'] = $in['location']['label'];
    }
    if ($loc !== []) {
        $changes['location'] = $loc;
    }
}

if (isset($in['slideshow']) && is_array($in['slideshow'])) {
    $show = [];
    foreach (['interval', 'fade', 'idle_timeout'] as $key) {
        if (isset($in['slideshow'][$key]) && is_numeric($in['slideshow'][$key])) {
            $show[$key] = $in['slideshow'][$key] + 0;
        }
    }
    if ($show !== []) {
        $changes['slideshow'] = $show;
    }
}

if (isset($in['stations']) && is_array($in['stations'])) {
    $stations = [];
    foreach ($in['stations'] as $station) {
        if (is_array($station)
            && isset($station['name'], $station['url'])
            && is_string($station['name']) && is_string($station['url'])
            && $station['name'] !== '' && $station['url'] !== '') {
            $stations[] = ['name' => $station['name'], 'url' => $station['url']];
        }
    }
    $changes['stations'] = $stations;
}

if (isset($in['ums_url']) && is_string($in['ums_url']) && $in['ums_url'] !== '') {
    $changes['ums_url'] = $in['ums_url'];
}

if (isset($in['new_pin'])) {
    $newPin = (string) $in['new_pin'];
    if (!preg_match('/^\d{4,}$/', $newPin)) {
        http_response_code(400);
        echo json_encode(['error' => 'new_pin must be at least 4 digits']);
        exit;
    }
    $changes['pin_hash'] = hash('sha256', $newPin);
}

save_settings($changes);

// A location change invalidates the cached weather for the old location.
if (isset($changes['location'])) {
    $cfg = load_settings();
    @unlink($cfg['cache_dir'] . '/weather.json');
}

echo json_encode(['ok' => true]);
