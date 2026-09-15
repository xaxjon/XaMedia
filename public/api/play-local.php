<?php
// Launches VLC fullscreen on the kiosk display for files the browser
// cannot play. Only paths under the read-only NFS media mount are accepted.

header('Content-Type: application/json');

$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) {
    http_response_code(400);
    echo json_encode(['error' => 'bad request']);
    exit;
}

if (($body['action'] ?? '') === 'stop') {
    exec('sudo -n -u user /usr/local/bin/kiosk-play --stop 2>&1', $out, $rc);
    echo json_encode(['ok' => $rc === 0]);
    exit;
}

$url = $body['path'] ?? '';
if (!is_string($url) || !str_starts_with($url, 'media/')) {
    http_response_code(400);
    echo json_encode(['error' => 'bad path']);
    exit;
}

$rel = implode('/', array_map('rawurldecode', explode('/', substr($url, 6))));
$full = realpath('/mnt/library/' . $rel);
if ($full === false || !str_starts_with($full, '/mnt/library/') || !is_file($full)) {
    http_response_code(404);
    echo json_encode(['error' => 'not found']);
    exit;
}

exec('sudo -n -u user /usr/local/bin/kiosk-play ' . escapeshellarg($full) . ' 2>&1', $out, $rc);
echo json_encode(['ok' => $rc === 0, 'detail' => $rc ? implode("\n", $out) : null]);
