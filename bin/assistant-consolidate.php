<?php
// Folds new assistant conversation transcripts into long-term memory.
// Spawned detached by api/assistant-log.php at the end of each voice
// session; also safe to run by hand or from cron:
//   php bin/assistant-consolidate.php
//
// Reads data/assistant/history.jsonl from the last cursor, asks Gemini
// (plain generateContent, not the Live API) for an updated memory.md and
// a narrative paragraph for summary.md, and stores the new cursor.

if (PHP_SAPI !== 'cli') {
    exit;
}

$root = dirname(__DIR__);
$config = require $root . '/config/config.php';
require_once $root . '/lib/settings.php';

$dir = $root . '/data/assistant';
$historyFile = $dir . '/history.jsonl';
$stateFile = $dir . '/state.json';
$memoryFile = $dir . '/memory.md';
$summaryFile = $dir . '/summary.md';
$logFile = $dir . '/consolidate.log';

function clog(string $msg): void
{
    global $logFile;
    file_put_contents($logFile, date('c') . ' ' . $msg . "\n", FILE_APPEND | LOCK_EX);
}

$key = (string) ($config['gemini_api_key'] ?? '');
if ($key === '' || !is_file($historyFile)) {
    exit;
}

$state = json_decode((string) @file_get_contents($stateFile), true);
$offset = (int) ($state['offset'] ?? 0);

$fh = fopen($historyFile, 'r');
if (!$fh) {
    exit;
}
fseek($fh, min($offset, filesize($historyFile)));
$new = [];
while (($line = fgets($fh)) !== false) {
    $entry = json_decode($line, true);
    if (is_array($entry) && isset($entry['who'], $entry['text'])) {
        $new[] = $entry;
    }
}
$cursor = ftell($fh);
fclose($fh);

if (!$new) {
    exit;
}

/* Group into readable transcript lines, oldest first. */
$transcript = '';
foreach ($new as $e) {
    $who = $e['who'] === 'user' ? 'User' : 'Assistant';
    $transcript .= $who . ': ' . $e['text'] . "\n";
}
if (strlen($transcript) > 12000) {
    $transcript = substr($transcript, -12000);
}

$memory = trim((string) @file_get_contents($memoryFile));
$summary = trim((string) @file_get_contents($summaryFile));
if (strlen($summary) > 4000) {
    $summary = substr($summary, -4000);
}

$settings = load_settings();
$primary = (string) ($settings['assistant']['text_model'] ?? 'gemini-3.6-flash');
// The primary occasionally 503s under demand spikes; walk the chain.
$models = array_values(array_unique([$primary, 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash']));

$prompt = <<<PROMPT
You maintain the long-term memory of a voice assistant on a family's living-room kiosk.

CURRENT MEMORY FILE (durable facts, may be empty):
{$memory}

RECENT-CONVERSATION SUMMARY SO FAR (may be empty):
{$summary}

NEW CONVERSATION TRANSCRIPTS:
{$transcript}

Produce:
1. "memory": the rewritten memory file — a concise bullet list of durable facts only: people and names, preferences, routines, things the household explicitly asked to remember. Preserve existing facts unless contradicted; drop trivia. Under 50 lines, plain text, bullets starting with "- ".
2. "summary_paragraph": one dated paragraph (start it with "(YYYY-MM-DD)" using today's date) of 2-4 narrative sentences capturing what these new conversations were about — topics, requests, anything worth recalling in future chats.

Respond with strict JSON only: {"memory": "...", "summary_paragraph": "..."}. No markdown fences, no commentary.
PROMPT;

$payload = [
    'contents' => [['parts' => [['text' => $prompt]]]],
    'generationConfig' => [
        'responseMimeType' => 'application/json',
        'temperature' => 0.2,
    ],
];

$raw = false;
$code = 0;
$usedModel = null;
foreach ($models as $model) {
    foreach ([1, 2] as $attempt) {
        $ch = curl_init('https://generativelanguage.googleapis.com/v1beta/models/'
            . rawurlencode($model) . ':generateContent?key=' . rawurlencode($key));
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_TIMEOUT => 60,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_POSTFIELDS => json_encode($payload),
        ]);
        $raw = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($raw !== false && $code === 200) {
            $usedModel = $model;
            break 2;
        }
        clog("generateContent via $model failed (HTTP $code, attempt $attempt): "
            . substr((string) $raw, 0, 200));
        if ($attempt === 1) {
            sleep(8);
        }
    }
}

if ($usedModel === null) {
    clog('all models unavailable; will retry on next session end');
    exit(1);
}

$resp = json_decode($raw, true);
$text = $resp['candidates'][0]['content']['parts'][0]['text'] ?? '';
$result = json_decode((string) $text, true);
if (!is_array($result) || !isset($result['memory'])) {
    clog('unexpected model output: ' . substr((string) $text, 0, 300));
    exit(1);
}

file_put_contents($memoryFile, trim((string) $result['memory']) . "\n", LOCK_EX);

$paragraph = trim((string) ($result['summary_paragraph'] ?? ''));
if ($paragraph !== '') {
    $summary = trim($summary . "\n\n" . $paragraph);
    if (strlen($summary) > 8000) {
        $summary = substr($summary, -8000);
        // Don't start mid-line.
        $nl = strpos($summary, "\n");
        if ($nl !== false) {
            $summary = substr($summary, $nl + 1);
        }
    }
    file_put_contents($summaryFile, $summary . "\n", LOCK_EX);
}

/* Rotate an oversized raw log once everything in it is consolidated. */
if (filesize($historyFile) > 256 * 1024) {
    rename($historyFile, $dir . '/history-' . date('Ym') . '.jsonl');
    $cursor = 0;
}

file_put_contents($stateFile, json_encode(['offset' => $cursor, 'run' => date('c')]) . "\n", LOCK_EX);
clog('consolidated ' . count($new) . ' entries via ' . $usedModel);
