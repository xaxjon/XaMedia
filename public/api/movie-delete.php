<?php
// Permanently removes one movie title directory via the constrained NAS-side
// worker. Loopback-only: the kiosk UI runs on localhost, so LAN clients cannot
// use this machine as an open deletion proxy.

require_once __DIR__ . '/../../lib/settings.php';

header('Content-Type: application/json');

if (!in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true)) {
    http_response_code(403);
    echo json_encode(['error' => 'local kiosk only']);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

$body = json_decode((string) file_get_contents('php://input'), true);
$dir = is_array($body) ? ($body['dir'] ?? null) : null;
if (!is_string($dir) || $dir === '' || $dir === '.' || $dir === '..'
    || str_contains($dir, '/') || str_contains($dir, '\\') || str_contains($dir, "\0")) {
    http_response_code(400);
    echo json_encode(['error' => 'bad dir']);
    exit;
}

$settings = load_settings();
$nasUrl = rtrim((string) ($settings['nas_url'] ?? 'http://192.168.10.227'), '/');
$parts = parse_url($nasUrl);
if (!is_array($parts) || !in_array($parts['scheme'] ?? '', ['http', 'https'], true)
    || empty($parts['host'])) {
    http_response_code(500);
    echo json_encode(['error' => 'bad nas_url']);
    exit;
}

$ch = curl_init($nasUrl . '/api/xamedia-movie-delete.php');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => json_encode(['dir' => $dir], JSON_UNESCAPED_SLASHES),
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT        => 30,
]);
$response = curl_exec($ch);
$curlError = curl_error($ch);
$status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
curl_close($ch);

if ($response === false || $status < 200 || $status >= 300) {
    http_response_code(502);
    echo json_encode(['error' => 'NAS delete failed', 'detail' => $curlError ?: 'HTTP ' . $status]);
    exit;
}

$result = json_decode((string) $response, true);
if (!is_array($result) || empty($result['ok'])) {
    http_response_code(502);
    echo json_encode([
        'error'  => 'NAS delete failed',
        'detail' => is_array($result) ? ($result['detail'] ?? $result['error'] ?? 'unexpected response') : 'unexpected response',
    ]);
    exit;
}

function movie_delete_remove_map_entry(string $file, string $dir): void
{
    if (!is_file($file)) return;
    $map = json_decode((string) file_get_contents($file), true);
    if (!is_array($map) || !array_key_exists($dir, $map)) return;
    unset($map[$dir]);
    $tmp = $file . '.tmp';
    file_put_contents($tmp, json_encode($map, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
    rename($tmp, $file);
}

$dataDir = dirname($settings['cache_dir']);
movie_delete_remove_map_entry($dataDir . '/tmdb_map.json', $dir);
movie_delete_remove_map_entry($dataDir . '/genres.json', $dir);
@unlink($settings['cache_dir'] . '/media_movies.json');
@unlink($dataDir . '/posters/' . $dir . '.jpg');

echo json_encode([
    'ok'              => true,
    'dir'             => $dir,
    'already_missing' => !empty($result['already_missing']),
]);
