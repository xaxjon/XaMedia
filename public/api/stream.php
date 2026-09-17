<?php
// Launches a fullscreen streaming browser session (Netflix/YouTube/HBO/Prime)
// on the kiosk display via /usr/local/bin/kiosk-stream.

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

$services = [
    'netflix' => 'https://www.netflix.com/browse',
    'youtube' => 'https://www.youtube.com/tv',
    'hbo'     => 'https://www.max.com/',
    'prime'   => 'https://www.primevideo.com/',
    'cameras' => 'http://192.168.10.227/index.html',
    'assistant' => 'https://gemini.google.com/app',
];

$body = json_decode(file_get_contents('php://input'), true);
$service = (string) ($body['service'] ?? '');

if (!isset($services[$service])) {
    http_response_code(400);
    echo json_encode(['error' => 'unknown service']);
    exit;
}

exec('sudo -n -u user /usr/local/bin/kiosk-stream '
    . escapeshellarg($services[$service]) . ' >/dev/null 2>&1 &');

echo json_encode(['ok' => true]);
