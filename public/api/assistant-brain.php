<?php
// Cascaded-assistant brain: text in, spoken reply or tool calls out.
// The page (assistant.js) sends the user's transcript; we call a text LLM
// with function declarations + long-term memory + recent conversation, and
// return either a reply to speak or a list of tool calls for the page to
// execute (which it then posts back as tool_results for the final reply).

require_once __DIR__ . '/../../lib/settings.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

function brain_fail(string $msg, int $code = 400): void
{
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) {
    brain_fail('bad request');
}
$text = trim((string) ($body['text'] ?? ''));
$toolResults = $body['tool_results'] ?? null;
if ($text === '' || strlen($text) > 1000) {
    brain_fail('bad text');
}

$settings = load_settings();
$key = (string) ($settings['gemini_api_key'] ?? '');
if ($key === '') {
    brain_fail('gemini_api_key not configured', 500);
}

$dir = __DIR__ . '/../../data/assistant';
$memory = trim((string) @file_get_contents($dir . '/memory.md'));
$summary = trim((string) @file_get_contents($dir . '/summary.md'));

$instruction = <<<'INSTR'
You are the friendly home assistant on a living-room kiosk. Always reply in natural spoken British English — your replies are read aloud, so keep them short (one to three sentences), warm and conversational, with no markdown, lists, or special formatting. You have tools to act on the kiosk: playing movies, TV episodes and music from the local library, driving the kiosk screens, the internet radio, streaming services, websites, web search, the weather, and remembering facts. When a tool does something, confirm briefly and naturally. The kiosk sits in a living room; if what you hear is clearly NOT a person addressing you — television dialogue, background chatter, or unintelligible fragments — reply with exactly the single word SILENT and nothing else. Several people use this kiosk and you cannot tell voices apart: your memory below has a People section with what you know about each person. When someone tells you their name, use it, and attribute what you learn to them via the remember tool. If knowing who is speaking would change your answer, politely ask who you are talking to. Never guess a speaker's identity from their voice alone.
INSTR;
if ($memory !== '') {
    $instruction .= "\n\nWhat you remember about this household:\n" . $memory;
}
if ($summary !== '') {
    $instruction .= "\n\nRecent conversations:\n" . $summary;
}

/* Recent conversation tail for within-chat continuity. */
$contents = [];
$lines = @file($dir . '/history.jsonl', FILE_IGNORE_NEW_LINES) ?: [];
$recent = [];
foreach (array_slice($lines, -40) as $line) {
    $e = json_decode($line, true);
    if (is_array($e) && isset($e['who'], $e['text'])
        && in_array($e['who'], ['user', 'model'], true)) {
        $recent[] = $e;
    }
}
foreach (array_slice($recent, -12) as $i => $e) {
    /* The page logs the current user turn before calling us — don't send
       it twice. */
    if ($i === count(array_slice($recent, -12)) - 1
        && $e['who'] === 'user' && trim($e['text']) === $text && !is_array($toolResults)) {
        continue;
    }
    $contents[] = [
        'role' => $e['who'] === 'user' ? 'user' : 'model',
        'parts' => [['text' => $e['text']]],
    ];
}

/* Current turn. */
$contents[] = ['role' => 'user', 'parts' => [['text' => $text]]];

/* Tool round-trip: replay the model's calls plus the page's results. */
if (is_array($toolResults)) {
    $fcParts = [];
    $frParts = [];
    foreach ($toolResults as $tr) {
        if (!is_array($tr)) {
            continue;
        }
        $name = preg_replace('/[^a-z_]/', '', (string) ($tr['name'] ?? ''));
        if ($name === '') {
            continue;
        }
        $fcPart = ['functionCall' => ['name' => $name, 'args' => $tr['args'] ?? new stdClass]];
        // Gemini 3.x signs its functionCall parts; the replay must echo the
        // original thought_signature or the API 400s the whole request.
        $ts = $tr['thought_signature'] ?? null;
        if (is_string($ts) && $ts !== '') {
            $fcPart['thoughtSignature'] = $ts;
        }
        $fcParts[] = $fcPart;
        $result = $tr['result'] ?? null;
        if (is_string($result)) {
            $result = ['result' => $result];
        }
        if (!is_array($result)) {
            $result = ['result' => 'done'];
        }
        $frParts[] = ['functionResponse' => ['name' => $name, 'response' => $result]];
    }
    if (!$fcParts) {
        brain_fail('bad tool_results');
    }
    $contents[] = ['role' => 'model', 'parts' => $fcParts];
    $contents[] = ['role' => 'user', 'parts' => $frParts];
}

function brain_decl(string $name, string $desc, array $props, array $required = []): array
{
    $d = ['name' => $name, 'description' => $desc,
          // Empty properties must serialize as {}, not [] — the API
          // rejects a JSON array here (400 on every model).
          'parameters' => ['type' => 'OBJECT', 'properties' => $props ?: new stdClass]];
    if ($required) {
        $d['parameters']['required'] = $required;
    }
    return $d;
}

$str = fn ($desc = '') => ['type' => 'STRING', 'description' => $desc];
$int = fn ($desc = '') => ['type' => 'INTEGER', 'description' => $desc];

$tools = [['functionDeclarations' => [
    brain_decl('play_movie', 'Play a movie from the local media library on the kiosk.', ['title' => $str('Movie title (approximate is fine)')], ['title']),
    brain_decl('play_tv', 'Play an episode of a TV series from the local media library.', ['show' => $str('Series name'), 'season' => $int('Season number (optional)'), 'episode' => $int('Episode number (optional)')], ['show']),
    brain_decl('play_music', 'Play music from the local library: an artist/album folder or a specific track.', ['query' => $str('Artist, album or track name')], ['query']),
    brain_decl('stop_playback', 'Stop whatever is currently playing (video, music or VLC).', []),
    brain_decl('play_radio', 'Tune the internet radio to a saved station.', ['station' => $str('Station name (omit to resume the last one)')]),
    brain_decl('stop_radio', 'Stop the internet radio.', []),
    brain_decl('open_streaming', 'Open a streaming service fullscreen on the kiosk.', ['service' => $str('One of: netflix, youtube, hbo, prime, cameras')], ['service']),
    brain_decl('show_photos', 'Start the photo-frame slideshow on the kiosk.', []),
    brain_decl('get_weather', 'Get the current weather and forecast for the household location.', []),
    brain_decl('open_website', 'Open a website fullscreen on the kiosk display.', ['url' => $str('Full URL, e.g. https://www.bbc.com')], ['url']),
    brain_decl('web_search', 'Search the web; returns titles, snippets and links.', ['query' => $str()], ['query']),
    brain_decl('read_webpage', 'Fetch a web page and read its text content.', ['url' => $str()], ['url']),
    brain_decl('remember', 'Store a fact, preference or note in long-term memory. Use when the user asks you to remember something, or when you learn a durable preference. When the fact is about a specific person, include their name (e.g. "Emma prefers classical radio in the morning").', ['fact' => $str('One concise sentence')], ['fact']),
    brain_decl('open_screen', 'Open a kiosk screen: the movies/TV/music browser, the radio, photos, or the home screen.', ['screen' => $str('movies, tv, music, radio, photos, or home')], ['screen']),
    brain_decl('select_genre', 'Filter the movie browser by genre, e.g. comedy or drama.', ['genre' => $str()], ['genre']),
    brain_decl('scroll_screen', 'Scroll the currently open screen.', ['direction' => $str('up or down')], ['direction']),
    brain_decl('go_back', 'Go back one level in the media browser, e.g. from a movie or series back to the list.', []),
    brain_decl('main_menu', 'Close all overlays and return to the kiosk home screen.', []),
]]];

$payload = [
    'systemInstruction' => ['parts' => [['text' => $instruction]]],
    'contents' => $contents,
    'tools' => $tools,
    'generationConfig' => [
        'temperature' => 0.4,
        // Thinking roughly triples latency on 3.x flash; a home kiosk
        // turn does not need it. (1.0s vs 2.5-3.5s measured.)
        'thinkingConfig' => ['thinkingBudget' => 0],
    ],
];

$primary = (string) ($settings['assistant']['text_model'] ?? 'gemini-3.6-flash');
$models = array_values(array_unique([$primary, 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash']));

$resp = null;
foreach ($models as $model) {
    /* One attempt per model — the chain itself is the retry. Keep the
       worst case bounded (4 models × 12s ≈ 48s) so the page isn't left
       waiting forever during Gemini slow phases. */
    $ch = curl_init('https://generativelanguage.googleapis.com/v1beta/models/'
        . rawurlencode($model) . ':generateContent?key=' . rawurlencode($key));
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_TIMEOUT => 12,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_SLASHES),
    ]);
    $raw = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($raw !== false && $code === 200) {
        $resp = json_decode($raw, true);
        break;
    }
    error_log('assistant-brain: ' . $model . ' HTTP ' . $code . ' ' . substr((string) $raw, 0, 300));
}

if ($resp === null) {
    brain_fail('the brain is unavailable right now', 502);
}

$parts = $resp['candidates'][0]['content']['parts'] ?? [];
$calls = [];
$reply = '';
foreach ($parts as $p) {
    if (isset($p['functionCall']['name'])) {
        $calls[] = ['name' => $p['functionCall']['name'],
                    'args' => $p['functionCall']['args'] ?? new stdClass,
                    'thought_signature' => $p['thoughtSignature'] ?? null];
    } elseif (isset($p['text'])) {
        $reply .= $p['text'];
    }
}

if ($calls) {
    echo json_encode(['tool_calls' => $calls], JSON_UNESCAPED_SLASHES);
    exit;
}

$reply = trim(preg_replace('/\s+/', ' ', $reply));
if (strlen($reply) > 1200) {
    $reply = substr($reply, 0, 1200);
}
echo json_encode(['reply' => $reply !== '' ? $reply : 'Sorry, I did not quite follow. Could you say that again?'],
    JSON_UNESCAPED_SLASHES);
