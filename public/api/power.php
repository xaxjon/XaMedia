<?php
// Reboot / power off the kiosk. Called from the Settings overlay
// (already PIN-gated client-side; the sudoers rule is the hard guard).

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

$body = json_decode(file_get_contents('php://input'), true);
$action = (string) ($body['action'] ?? '');

if (!in_array($action, ['reboot', 'shutdown'], true)) {
    http_response_code(400);
    echo json_encode(['error' => 'bad action']);
    exit;
}

exec('sudo -n /usr/bin/systemctl ' . ($action === 'reboot' ? 'reboot' : 'poweroff') . ' 2>&1', $out, $rc);
echo json_encode(['ok' => $rc === 0, 'detail' => $rc ? implode("\n", $out) : null]);
