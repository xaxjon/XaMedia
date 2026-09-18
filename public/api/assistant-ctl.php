<?php
// State channel between the kiosk web page (assistant.js) and the desktop
// orb badge (deploy/kiosk-orb). The page POSTs its session state; the badge
// polls it and POSTs a "toggle" command when clicked; the page polls with
// ?consume=1 to pick up and clear pending commands.
// Stored in data/assistant/control.json.

header('Content-Type: application/json');

$dir = __DIR__ . '/../../data/assistant';
$file = $dir . '/control.json';
if (!is_dir($dir)) {
    mkdir($dir, 0775, true);
}

function ctl_read(string $file): array
{
    $data = json_decode((string) @file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

function ctl_write(string $file, array $data): void
{
    file_put_contents($file, json_encode($data, JSON_UNESCAPED_SLASHES) . "\n", LOCK_EX);
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $data = ctl_read($file);
    $command = $data['command'] ?? null;
    if (isset($_GET['consume']) && $command !== null) {
        $data['command'] = null;
        ctl_write($file, $data);
    }
    echo json_encode([
        'state'   => (string) ($data['state'] ?? 'idle'),
        'command' => $command,
    ]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) {
    http_response_code(400);
    echo json_encode(['error' => 'bad request']);
    exit;
}

$data = ctl_read($file);

if (isset($body['state'])) {
    $state = (string) $body['state'];
    if (!in_array($state, ['idle', 'connecting', 'live', 'error'], true)) {
        http_response_code(400);
        echo json_encode(['error' => 'bad state']);
        exit;
    }
    $data['state'] = $state;
    $data['stateTs'] = time();
}

if (array_key_exists('command', $body)) {
    $command = $body['command'];
    if ($command !== null && $command !== 'toggle') {
        http_response_code(400);
        echo json_encode(['error' => 'bad command']);
        exit;
    }
    $data['command'] = $command;
}

ctl_write($file, $data);
echo json_encode(['ok' => true]);
