<?php
// The Scout: fresh-facts lookup for the chatbot's "Let me check…" moments.
// One grounded text call (Google Search) → a short spoken-style answer.
// Called by assistant-live.js when the Live model routes a lookup here;
// the answer is injected back into the Live session as a system note.

require_once __DIR__ . '/../../lib/settings.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

$body = json_decode(file_get_contents('php://input'), true);
$q = trim((string) ($body['q'] ?? ''));
if ($q === '' || strlen($q) > 500) {
    http_response_code(400);
    echo json_encode(['error' => 'bad query']);
    exit;
}

$settings = load_settings();
$key = (string) ($settings['gemini_api_key'] ?? '');
if ($key === '') {
    http_response_code(500);
    echo json_encode(['error' => 'gemini_api_key not configured']);
    exit;
}

$instruction = 'You answer factual questions for a voice assistant on a home kiosk. '
    . 'Use Google Search for anything current (news, weather, prices, dates). '
    . 'Answer in one to three short spoken-style sentences, natural and warm, '
    . 'no markdown, no lists, no URLs, no formal citations.';

$payload = [
    'systemInstruction' => ['parts' => [['text' => $instruction]]],
    'contents' => [['role' => 'user', 'parts' => [['text' => $q]]]],
    'tools' => [['googleSearch' => new stdClass]],
    'generationConfig' => [
        'temperature' => 0.3,
        'thinkingConfig' => ['thinkingBudget' => 0],
    ],
];

$primary = (string) ($settings['assistant']['text_model'] ?? 'gemini-3.6-flash');
$models = array_values(array_unique([$primary, 'gemini-3.5-flash', 'gemini-3.1-flash-lite']));

foreach ($models as $model) {
    $ch = curl_init('https://generativelanguage.googleapis.com/v1beta/models/'
        . rawurlencode($model) . ':generateContent?key=' . rawurlencode($key));
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_SLASHES),
    ]);
    $raw = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($raw !== false && $code === 200) {
        $data = json_decode($raw, true);
        $text = '';
        foreach ($data['candidates'][0]['content']['parts'] ?? [] as $p) {
            if (isset($p['text'])) {
                $text .= $p['text'];
            }
        }
        $text = trim(preg_replace('/\s+/', ' ', $text));
        if ($text !== '') {
            if (strlen($text) > 900) {
                $text = substr($text, 0, 900);
            }
            echo json_encode(['reply' => $text], JSON_UNESCAPED_SLASHES);
            exit;
        }
    }
    error_log('assistant-scout: ' . $model . ' HTTP ' . $code . ' ' . substr((string) $raw, 0, 200));
}

http_response_code(502);
echo json_encode(['error' => 'lookup unavailable right now']);
