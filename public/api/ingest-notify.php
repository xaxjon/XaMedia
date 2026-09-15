<?php
// Receives ingest notifications from the NAS watcher: merges new TMDB map
// entries and busts media-list caches so new titles appear immediately.
// LAN-only housekeeping endpoint; no filesystem paths are accepted.

header('Content-Type: application/json');

require_once __DIR__ . '/../../lib/settings.php';
$config = load_settings();
$dataDir = dirname($config['cache_dir']); // .../data
$mapFile = $dataDir . '/tmdb_map.json';

$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) {
    http_response_code(400);
    echo json_encode(['error' => 'bad request']);
    exit;
}

$merged = 0;
if (isset($body['merge']) && is_array($body['merge'])) {
    $map = is_file($mapFile) ? json_decode(file_get_contents($mapFile), true) : [];
    if (!is_array($map)) $map = [];
    foreach ($body['merge'] as $dir => $val) {
        if (!is_string($dir) || $dir === '' || str_contains($dir, '/') || str_contains($dir, '..') || str_contains($dir, "\0")) {
            continue;
        }
        if (is_int($val)) {
            $map[$dir] = $val;
        } elseif (is_array($val) && isset($val['tmdb_id']) && is_int($val['tmdb_id'])) {
            $map[$dir] = [
                'tmdb_id' => $val['tmdb_id'],
                'title'   => (string) ($val['title'] ?? ''),
                'year'    => (int) ($val['year'] ?? 0),
            ];
        } else {
            continue;
        }
        $merged++;
    }
    $tmp = $mapFile . '.tmp';
    file_put_contents($tmp, json_encode($map, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
    rename($tmp, $mapFile);
}

$busted = [];
if (isset($body['bust']) && is_array($body['bust'])) {
    foreach ($body['bust'] as $type) {
        if (!in_array($type, ['movies', 'tv', 'music'], true)) continue;
        $f = $config['cache_dir'] . '/media_' . $type . '.json';
        if (is_file($f) && unlink($f)) $busted[] = $type;
    }
}

echo json_encode(['ok' => true, 'merged' => $merged, 'busted' => $busted]);
