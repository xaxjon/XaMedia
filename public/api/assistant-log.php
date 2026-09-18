<?php
// Conversation log + explicit memory writes for the voice assistant.
// Transcripts append to data/assistant/history.jsonl; a session "end"
// marker spawns the consolidation pass (bin/assistant-consolidate.php),
// which folds new history into the long-term memory files.

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

$dir = __DIR__ . '/../../data/assistant';
if (!is_dir($dir) && !mkdir($dir, 0775, true)) {
    http_response_code(500);
    echo json_encode(['error' => 'storage unavailable']);
    exit;
}

$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) {
    http_response_code(400);
    echo json_encode(['error' => 'bad request']);
    exit;
}

/* Explicit "remember this" — straight into long-term memory. */
if (isset($body['remember'])) {
    $fact = trim((string) $body['remember']);
    if ($fact === '' || strlen($fact) > 500) {
        http_response_code(400);
        echo json_encode(['error' => 'bad fact']);
        exit;
    }
    $line = '- (' . date('Y-m-d') . ') ' . str_replace(["\r", "\n"], ' ', $fact) . "\n";
    file_put_contents($dir . '/memory.md', $line, FILE_APPEND | LOCK_EX);
    echo json_encode(['ok' => true]);
    exit;
}

$session = preg_replace('/[^a-z0-9-]/i', '', (string) ($body['session'] ?? ''));
$line = ['ts' => date('c'), 'session' => $session];

if (!empty($body['end'])) {
    $line['event'] = 'end';
    file_put_contents($dir . '/history.jsonl',
        json_encode($line, JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND | LOCK_EX);
    // Fold the new history into long-term memory, detached.
    $script = __DIR__ . '/../../bin/assistant-consolidate.php';
    if (is_file($script)) {
        exec('php ' . escapeshellarg($script) . ' >/dev/null 2>&1 &');
    }
    echo json_encode(['ok' => true]);
    exit;
}

$who = (string) ($body['who'] ?? '');
$text = trim((string) ($body['text'] ?? ''));
if (!in_array($who, ['user', 'model'], true) || $text === '' || strlen($text) > 4000) {
    http_response_code(400);
    echo json_encode(['error' => 'bad entry']);
    exit;
}

$line['who'] = $who;
$line['text'] = $text;
file_put_contents($dir . '/history.jsonl',
    json_encode($line, JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND | LOCK_EX);
echo json_encode(['ok' => true]);
