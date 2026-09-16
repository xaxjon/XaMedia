<?php
// Shared photo-path validation for the photo manager endpoints.

require_once __DIR__ . '/../../lib/settings.php';

function photo_path(string $rel): string
{
    $config = load_settings();
    $root = realpath($config['photos_dir']);
    if ($root === false) {
        http_response_code(500);
        echo json_encode(['error' => 'photos directory missing']);
        exit;
    }
    $path = realpath($root . '/' . ltrim(str_replace("\0", '', $rel), '/'));
    $ok = $path !== false
        && ($path === $root || str_starts_with($path, $root . '/'))
        && is_file($path)
        && preg_match('/\.(jpe?g|png|webp)$/i', $path);
    if (!$ok) {
        http_response_code(404);
        echo json_encode(['error' => 'not found']);
        exit;
    }
    return $path;
}

function photos_bust_cache(): void
{
    $config = load_settings();
    @unlink($config['cache_dir'] . '/photos.json');
}
