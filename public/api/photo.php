<?php
// Streams a single image from the photos directory.
// Only relative paths that resolve inside the photos root are served.

$config = require __DIR__ . '/../../config/config.php';

$rel = $_GET['f'] ?? '';
$rel = str_replace("\0", '', $rel);

$root = realpath($config['photos_dir']);
if ($root === false) {
    http_response_code(500);
    exit('photos directory missing');
}

$path = realpath($root . '/' . ltrim($rel, '/'));
if ($path === false || !str_starts_with($path . '/', $root . '/') && $path !== $root) {
    http_response_code(404);
    exit('not found');
}

$ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
$types = [
    'jpg'  => 'image/jpeg',
    'jpeg' => 'image/jpeg',
    'png'  => 'image/png',
    'webp' => 'image/webp',
];
if (!isset($types[$ext]) || !is_file($path)) {
    http_response_code(404);
    exit('not found');
}

header('Content-Type: ' . $types[$ext]);
header('Content-Length: ' . filesize($path));
header('Cache-Control: public, max-age=86400');
readfile($path);
