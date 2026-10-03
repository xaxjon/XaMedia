<?php
// The Scout: fresh-facts lookup for the chatbot's "Let me check…" moments.
// Free-tier reality (verified 2026-10-03): this key has NO Google-Search
// grounding quota (plain text 200, googleSearch 429 always), and DuckDuckGo
// scraping now returns the bot-check homepage. So facts come from free,
// keyless, reliable sources and a plain cheap text call does the voice:
//   weather → the kiosk's own api/weather.php (Open-Meteo)
//   news    → BBC News RSS
//   general → Wikipedia opensearch + page summary
// assistant-live.js injects the reply into the Live session as a system note.

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

function scout_get(string $url, int $timeout = 10): string|false
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_USERAGENT => 'XaMedia-Kiosk/1.0 (home entertainment)',
    ]);
    $data = curl_exec($ch);
    curl_close($ch);
    return $data;
}

/* ---------- 1. gather facts from free sources ---------- */

$facts = '';

if (preg_match('/\b(weather|forecast|temperature|raining|sunny|cloudy)\b/i', $q)) {
    $raw = scout_get('http://localhost/api/weather.php');
    $w = json_decode((string) $raw, true);
    if (is_array($w)) {
        $cur = $w['current'] ?? [];
        $daily = $w['daily'] ?? [];
        $parts = [];
        if (isset($cur['temperature_2m'])) {
            $parts[] = 'now ' . round((float) $cur['temperature_2m']) . '°C';
        }
        if (isset($cur['weather_code'])) {
            $parts[] = 'weather code ' . $cur['weather_code'];
        }
        if (isset($cur['wind_speed_10m'])) {
            $parts[] = 'wind ' . round((float) $cur['wind_speed_10m']) . ' km/h';
        }
        if (isset($daily['temperature_2m_max'][0], $daily['temperature_2m_min'][0])) {
            $parts[] = 'today ' . round((float) $daily['temperature_2m_min'][0])
                . '–' . round((float) $daily['temperature_2m_max'][0]) . '°C';
        }
        if ($parts) {
            $facts = "Current weather for the household location:\n- " . implode("\n- ", $parts);
        }
    }
} elseif (preg_match('/\b(news|headlines|latest|happening|current events|today\'?s news)\b/i', $q)) {
    $raw = scout_get('https://feeds.bbci.co.uk/news/rss.xml');
    if ($raw !== false && $raw !== '') {
        $items = [];
        if (preg_match_all('#<item>.*?<title>(.*?)</title>.*?<description>(.*?)</description>#s', $raw, $m, PREG_SET_ORDER)) {
            foreach (array_slice($m, 0, 6) as $hit) {
                $clean = function ($s) {
                    $s = preg_replace('#<!\[CDATA\[|\]\]>#', '', (string) $s);
                    return trim(html_entity_decode(strip_tags($s), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
                };
                $items[] = '- ' . $clean($hit[1]) . ' — ' . $clean($hit[2]);
            }
        }
        if ($items) {
            $facts = "Top BBC News headlines right now:\n" . implode("\n", $items);
        }
    }
} else {
    /* Full-text search (opensearch is title-prefix and useless for
       natural-language questions) → summary of the top hit. */
    $raw = scout_get('https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=3&format=json&srsearch=' . rawurlencode($q));
    $hits = json_decode((string) $raw, true);
    $title = $hits['query']['search'][0]['title'] ?? null;
    if ($title) {
        $raw2 = scout_get('https://en.wikipedia.org/api/rest_v1/page/summary/' . rawurlencode($title));
        $sum = json_decode((string) $raw2, true);
        $extract = trim((string) ($sum['extract'] ?? ''));
        if ($extract !== '') {
            if (strlen($extract) > 1200) {
                $extract = substr($extract, 0, 1200);
            }
            $facts = "From Wikipedia ({$title}):\n" . $extract;
        }
    }
}

/* ---------- 2. summarize with a plain (grounding-free) text call ---------- */

$instruction = 'You answer questions for a voice assistant on a home kiosk. '
    . 'Answer in one to three short spoken-style sentences, natural and warm, '
    . 'no markdown, no lists, no URLs. Base your answer ONLY on the provided '
    . 'information; if it does not answer the question, say honestly that you '
    . 'could not find it. Never mention "the provided information" or sources.';

/* No facts at all? The results are already on the kiosk screen — say so
   instead of a bare "couldn't find". */
if ($facts === '') {
    echo json_encode(['reply' => 'I have put the results on the screen for you — have a look while we chat.'],
        JSON_UNESCAPED_SLASHES);
    exit;
}

$userText = "Question: {$q}\n\nInformation:\n{$facts}";

$payload = [
    'systemInstruction' => ['parts' => [['text' => $instruction]]],
    'contents' => [['role' => 'user', 'parts' => [['text' => $userText]]]],
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
