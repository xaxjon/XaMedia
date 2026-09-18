<?php
// Opens an arbitrary website fullscreen on the kiosk display via
// /usr/local/bin/kiosk-stream (the assistant's open_website tool).
// https is allowed anywhere; plain http only for LAN hosts.

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

$body = json_decode(file_get_contents('php://input'), true);
$url = (string) ($body['url'] ?? '');

if ($url === '' || strlen($url) > 2000) {
    http_response_code(400);
    echo json_encode(['error' => 'bad url']);
    exit;
}

$parts = parse_url($url);
$scheme = strtolower((string) ($parts['scheme'] ?? ''));
$host = (string) ($parts['host'] ?? '');

function browse_is_lan_host(string $host): bool
{
    $ip = gethostbyname($host);
    return (bool) filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)
        && (str_starts_with($ip, '192.168.')
            || str_starts_with($ip, '10.')
            || preg_match('/^172\.(1[6-9]|2\d|3[01])\./', $ip));
}

$allowed = ($scheme === 'https' && $host !== '')
    || ($scheme === 'http' && $host !== '' && browse_is_lan_host($host));

if (!$allowed) {
    http_response_code(400);
    echo json_encode(['error' => 'url not allowed']);
    exit;
}

exec('sudo -n -u user /usr/local/bin/kiosk-stream '
    . escapeshellarg($url) . ' >/dev/null 2>&1 &');

echo json_encode(['ok' => true]);
