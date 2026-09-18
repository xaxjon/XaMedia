<?php
// Server-side web lookup for the assistant: search (DuckDuckGo HTML) and
// page reading (tag-stripped text). The model speaks the results, so
// responses are compact and plain.

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

$body = json_decode(file_get_contents('php://input'), true);
$action = (string) ($body['action'] ?? '');

function lookup_fetch(string $url): string|false
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 3,
        CURLOPT_TIMEOUT        => 8,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_MAXFILESIZE    => 1024 * 1024,
        CURLOPT_USERAGENT      => 'Mozilla/5.0 (X11; Linux x86_64) XaMedia-Kiosk/1.0',
    ]);
    $data = curl_exec($ch);
    curl_close($ch);
    return $data;
}

function lookup_bad(string $msg, int $code = 400): void
{
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $msg]);
    exit;
}

/* ---------- search ---------- */

if ($action === 'search') {
    $q = trim((string) ($body['q'] ?? ''));
    if ($q === '' || strlen($q) > 300) {
        lookup_bad('bad query');
    }
    $html = lookup_fetch('https://html.duckduckgo.com/html/?q=' . rawurlencode($q));
    if ($html === false || $html === '') {
        lookup_bad('search failed', 502);
    }
    $results = [];
    if (preg_match_all(
        '#<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>.*?'
        . '<a[^>]+class="result__snippet"[^>]*>(.*?)</a>#s',
        $html, $m, PREG_SET_ORDER
    )) {
        foreach (array_slice($m, 0, 5) as $hit) {
            $href = html_entity_decode($hit[1], ENT_QUOTES | ENT_HTML5, 'UTF-8');
            // DuckDuckGo wraps outbound links in a redirect; unwrap uddg=.
            if (preg_match('/[?&]uddg=([^&]+)/', $href, $u)) {
                $href = rawurldecode($u[1]);
            }
            $clean = fn ($s) => trim(html_entity_decode(
                strip_tags($s), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
            $results[] = [
                'title'   => $clean($hit[2]),
                'snippet' => $clean($hit[3]),
                'url'     => $href,
            ];
        }
    }
    echo json_encode(['ok' => true, 'results' => $results], JSON_UNESCAPED_SLASHES);
    exit;
}

/* ---------- read ---------- */

if ($action === 'read') {
    $url = (string) ($body['url'] ?? '');
    $parts = parse_url($url);
    $scheme = strtolower((string) ($parts['scheme'] ?? ''));
    if (!in_array($scheme, ['http', 'https'], true) || empty($parts['host'])) {
        lookup_bad('url not allowed');
    }
    $host = $parts['host'];
    // Never fetch link-local / cloud-metadata addresses.
    if (str_starts_with($host, '169.254.') || $host === 'metadata.google.internal') {
        lookup_bad('url not allowed');
    }
    $html = lookup_fetch($url);
    if ($html === false || $html === '') {
        lookup_bad('could not fetch that page', 502);
    }
    $title = '';
    if (preg_match('#<title[^>]*>(.*?)</title>#si', $html, $t)) {
        $title = trim(html_entity_decode(strip_tags($t[1]), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    }
    $text = preg_replace('#<(script|style|noscript|nav|footer|header|form)[^>]*>.*?</\1>#si', ' ', $html);
    $text = strip_tags((string) $text);
    $text = html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $text = preg_replace('/\s+/u', ' ', $text);
    $text = trim((string) $text);
    if (strlen($text) > 4000) {
        $text = substr($text, 0, 4000) . '…';
    }
    echo json_encode([
        'ok'    => true,
        'title' => $title,
        'text'  => $text !== '' ? $text : '(no readable text on that page)',
    ], JSON_UNESCAPED_SLASHES);
    exit;
}

lookup_bad('unknown action');
