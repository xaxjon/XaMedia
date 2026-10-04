<?php
// Voice commands for kiosk hardware: volume control and closing the
// fullscreen browser/streaming session. Both run as the login user via
// tight sudoers wrappers (deploy/kiosk-volume, deploy/kiosk-browser-close).

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

$body = json_decode(file_get_contents('php://input'), true);
$action = (string) ($body['action'] ?? '');

if ($action === 'close_browser') {
    exec('sudo -n -u user /usr/local/bin/kiosk-browser-close >/dev/null 2>&1 &');
    echo json_encode(['ok' => true, 'result' => 'Browser closed.']);
    exit;
}

if (in_array($action, ['up', 'down', 'mute', 'unmute'], true)) {
    exec('sudo -n -u user /usr/local/bin/kiosk-volume ' . escapeshellarg($action) . ' 2>&1', $out, $rc);
    if ($rc !== 0 || !preg_match('/VOLUME (\d+) MUTE (\w+)/', implode(' ', $out), $m)) {
        http_response_code(500);
        echo json_encode(['error' => 'volume control failed']);
        exit;
    }
    $vol = (int) $m[1];
    $muted = $m[2] === 'yes';
    $text = $muted ? 'Muted.' : 'Volume ' . $vol . ' percent.';
    echo json_encode(['ok' => true, 'result' => $text, 'volume' => $vol, 'muted' => $muted]);
    exit;
}

if ($action === 'set' && isset($body['value']) && is_numeric($body['value'])) {
    $v = max(0, min(100, (int) $body['value']));
    exec('sudo -n -u user /usr/local/bin/kiosk-volume set ' . $v . ' 2>&1', $out, $rc);
    if ($rc !== 0) {
        http_response_code(500);
        echo json_encode(['error' => 'volume control failed']);
        exit;
    }
    echo json_encode(['ok' => true, 'result' => 'Volume ' . $v . ' percent.', 'volume' => $v, 'muted' => false]);
    exit;
}

http_response_code(400);
echo json_encode(['error' => 'unknown action']);
