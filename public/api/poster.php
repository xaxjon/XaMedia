<?php
// Serves movie posters from local storage. NAS posters are cached on first
// use; a sequential CLI worker can warm the same cache in the background.

require_once __DIR__ . '/../../lib/poster-cache.php';

set_time_limit(0);

if (PHP_SAPI === 'cli') {
    $part = null;
    $parts = 1;
    foreach ($argv ?? [] as $arg) {
        if (str_starts_with($arg, '--warm=')) {
            $part = (int) substr($arg, strlen('--warm='));
        } elseif (str_starts_with($arg, '--parts=')) {
            $parts = max(1, (int) substr($arg, strlen('--parts=')));
        }
    }
    if ($part === null || $part < 0 || $part >= $parts) {
        fwrite(STDERR, "Usage: php poster.php --warm=N --parts=4\n");
        exit(1);
    }

    $index = load_settings()['cache_dir'] . '/media_movies.json';
    $data = json_decode((string) @file_get_contents($index), true);
    foreach (array_values($data['movies'] ?? []) as $i => $movie) {
        if ($i % $parts === $part && isset($movie['dir'])) {
            poster_cache_local((string) $movie['dir']);
        }
    }
    exit;
}

$dir = (string) ($_GET['dir'] ?? '');
if (!poster_cache_valid_dir($dir)) {
    http_response_code(400);
    echo json_encode(['error' => 'bad dir']);
    exit;
}

$path = poster_cache_local($dir);
if ($path === null) {
    http_response_code(404);
    echo json_encode(['error' => 'no poster']);
    exit;
}

poster_cache_serve($path);
