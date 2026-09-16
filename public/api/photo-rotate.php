<?php
// Rotates a photo 90° clockwise in place (real file edit).

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

$ext = strtolower(pathinfo($src, PATHINFO_EXTENSION));
$img = null;
if ($ext === 'png') {
    $img = @imagecreatefrompng($src);
} elseif ($ext === 'webp') {
    $img = @imagecreatefromwebp($src);
} else {
    $img = @imagecreatefromjpeg($src);
}
if (!$img) {
    http_response_code(415);
    echo json_encode(['error' => 'unsupported image']);
    exit;
}

$img = imagerotate($img, -90, 0); // clockwise
$ok = false;
if ($ext === 'png') {
    $ok = imagepng($img, $src, 6);
} elseif ($ext === 'webp') {
    $ok = imagewebp($img, $src, 88);
} else {
    $ok = imagejpeg($img, $src, 90);
}
imagedestroy($img);

if (!$ok) {
    http_response_code(500);
    echo json_encode(['error' => 'write failed']);
    exit;
}

$config = load_settings();
@unlink($config['cache_dir'] . '/thumbs/' . md5($rel) . '.jpg');
touch($src); // bump mtime so the thumb cache regenerates
photos_bust_cache();

echo json_encode(['ok' => true]);
