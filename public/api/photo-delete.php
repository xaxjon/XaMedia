<?php
// Moves a photo into data/photos/.trash/ (recoverable) instead of deleting.

require_once __DIR__ . '/photo-lib.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

$body = json_decode(file_get_contents('php://input'), true);
$rel = (string) ($body['f'] ?? '');
$src = photo_path($rel);

$config = load_settings();
$root = realpath($config['photos_dir']);
$trash = $root . '/.trash/' . $rel;
if (!is_dir(dirname($trash))) {
    mkdir(dirname($trash), 0775, true);
}
if (!rename($src, $trash)) {
    http_response_code(500);
    echo json_encode(['error' => 'move failed']);
    exit;
}

@unlink($config['cache_dir'] . '/thumbs/' . md5($rel) . '.jpg');
photos_bust_cache();

echo json_encode(['ok' => true]);
