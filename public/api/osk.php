<?php
// Toggles the on-screen keyboard (onboard) on the kiosk display.

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

exec('sudo -n -u user /usr/local/bin/kiosk-osk 2>&1', $out, $rc);
echo json_encode(['ok' => $rc === 0, 'detail' => $rc ? implode("\n", $out) : null]);
