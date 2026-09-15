<?php
// Streams a poster override from data/posters/<dir>.jpg (written by
// movie-correct.php when the read-only library dir has no/wrong poster).

$dir = (string) ($_GET['dir'] ?? '');
if ($dir === ''
    || str_contains($dir, '/') || str_contains($dir, "\0") || str_contains($dir, '..')) {
    http_response_code(400);
    echo json_encode(['error' => 'bad dir']);
    exit;
}

$path = __DIR__ . '/../../data/posters/' . $dir . '.jpg';
if (!is_file($path)) {
    http_response_code(404);
    echo json_encode(['error' => 'no poster']);
    exit;
}

header('Content-Type: image/jpeg');
header('Content-Length: ' . filesize($path));
header('Cache-Control: public, max-age=86400');
readfile($path);
