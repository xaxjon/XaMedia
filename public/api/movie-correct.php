<?php
// Fixes wrong TMDB matches. POST JSON, two modes:
//   {"dir": "...", "query": "..."}   → TMDB search, up to 6 simplified hits
//   {"dir": "...", "tmdb_id": N}     → apply: rewrite the map entry as
//     {tmdb_id, title, year}, download a w500 poster override to
//     data/posters/<dir>.jpg, drop the affected caches.
// No PIN required (frontend choice); inputs are validated strictly instead.

$config = require __DIR__ . '/../../config/config.php';
$TMDB_KEY = $config['tmdb_api_key'] ?? '';

header('Content-Type: application/json');

const MAP_FILE = __DIR__ . '/../../data/tmdb_map.json';
const POSTERS_DIR = __DIR__ . '/../../data/posters';
const MOVIES_DIR = '/mnt/library/Movies';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

function tmdb_get(string $url): ?array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_USERAGENT      => 'home-entertainment-kiosk/1.0',
    ]);
    $body = curl_exec($ch);
    $ok = $body !== false && curl_getinfo($ch, CURLINFO_RESPONSE_CODE) === 200;
    curl_close($ch);
    if (!$ok) {
        return null;
    }
    $data = json_decode($body, true);
    return is_array($data) ? $data : null;
}

function tmdb_year(array $movie): ?int
{
    $date = (string) ($movie['release_date'] ?? '');
    return strlen($date) >= 4 ? (int) substr($date, 0, 4) : null;
}

$body = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($body)) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid json']);
    exit;
}

$dir = $body['dir'] ?? null;
if (!is_string($dir) || $dir === ''
    || str_contains($dir, '/') || str_contains($dir, "\0") || str_contains($dir, '..')) {
    http_response_code(400);
    echo json_encode(['error' => 'bad dir']);
    exit;
}

// --- Search mode ---------------------------------------------------------
if (isset($body['query'])) {
    $query = trim((string) $body['query']);
    if ($query === '') {
        http_response_code(400);
        echo json_encode(['error' => 'empty query']);
        exit;
    }
    $data = tmdb_get('https://api.themoviedb.org/3/search/movie?' . http_build_query([
        'api_key' => $TMDB_KEY,
        'query'   => $query,
    ]));
    if (!is_array($data)) {
        http_response_code(502);
        echo json_encode(['error' => 'tmdb unavailable']);
        exit;
    }
    $results = [];
    foreach (array_slice($data['results'] ?? [], 0, 6) as $movie) {
        if (!isset($movie['id'])) {
            continue;
        }
        $results[] = [
            'tmdb_id'      => (int) $movie['id'],
            'title'        => $movie['title'] ?? '',
            'year'         => tmdb_year($movie),
            'poster_thumb' => !empty($movie['poster_path'])
                ? 'https://image.tmdb.org/t/p/w92' . $movie['poster_path']
                : null,
        ];
    }
    echo json_encode(['results' => $results], JSON_UNESCAPED_SLASHES);
    exit;
}

// --- Apply mode ----------------------------------------------------------
if (!isset($body['tmdb_id']) || !is_numeric($body['tmdb_id']) || (int) $body['tmdb_id'] <= 0) {
    http_response_code(400);
    echo json_encode(['error' => 'bad tmdb_id']);
    exit;
}
$tmdbId = (int) $body['tmdb_id'];

$map = json_decode((string) @file_get_contents(MAP_FILE), true);
// Unmapped dirs (auto-ingested without a TMDB match) can be corrected too:
// accept any real folder under the read-only movies tree.
if (!is_array($map)) $map = [];
if (!isset($map[$dir])) {
    if (str_contains($dir, '/') || str_contains($dir, '..') || str_contains($dir, "\0")
        || !is_dir(MOVIES_DIR . '/' . $dir)) {
        http_response_code(404);
        echo json_encode(['error' => 'unknown movie']);
        exit;
    }
}
$oldEntry = $map[$dir] ?? null;
$oldId = (int) (is_array($oldEntry) ? ($oldEntry['tmdb_id'] ?? 0) : $oldEntry);

$movie = tmdb_get('https://api.themoviedb.org/3/movie/' . $tmdbId . '?' . http_build_query([
    'api_key' => $TMDB_KEY,
]));
if (!is_array($movie) || isset($movie['success']) && $movie['success'] === false) {
    http_response_code(502);
    echo json_encode(['error' => 'tmdb unavailable']);
    exit;
}

$title = (string) ($movie['title'] ?? '');
$year = tmdb_year($movie);

// Atomic map update: write temp + rename.
$map[$dir] = ['tmdb_id' => $tmdbId, 'title' => $title, 'year' => $year];
$tmp = MAP_FILE . '.tmp.' . getmypid();
if (file_put_contents($tmp, json_encode($map, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n", LOCK_EX) === false
    || !rename($tmp, MAP_FILE)) {
    @unlink($tmp);
    http_response_code(500);
    echo json_encode(['error' => 'could not write map']);
    exit;
}

// Poster override (best effort; the correction stands even without one).
if (!empty($movie['poster_path'])) {
    $ch = curl_init('https://image.tmdb.org/t/p/w500' . $movie['poster_path']);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_USERAGENT      => 'home-entertainment-kiosk/1.0',
    ]);
    $poster = curl_exec($ch);
    $ok = $poster !== false && curl_getinfo($ch, CURLINFO_RESPONSE_CODE) === 200;
    curl_close($ch);
    if ($ok) {
        if (!is_dir(POSTERS_DIR)) {
            mkdir(POSTERS_DIR, 0775, true);
        }
        file_put_contents(POSTERS_DIR . '/' . $dir . '.jpg', $poster, LOCK_EX);
    }
}

// Genre map follows the corrected match.
if (!empty($movie['genres']) && is_array($movie['genres'])) {
    $genresFile = __DIR__ . '/../../data/genres.json';
    $gm = json_decode((string) @file_get_contents($genresFile), true);
    if (!is_array($gm)) $gm = [];
    $gm[$dir] = array_values(array_map(fn ($g) => (string) ($g['name'] ?? ''), $movie['genres']));
    $gtmp = $genresFile . '.tmp.' . getmypid();
    if (file_put_contents($gtmp, json_encode($gm, JSON_UNESCAPED_SLASHES), LOCK_EX) !== false) {
        rename($gtmp, $genresFile);
    } else {
        @unlink($gtmp);
    }
}

// Invalidate affected caches.
foreach (array_unique([$oldId, $tmdbId]) as $id) {
    if ($id > 0) {
        @unlink($config['cache_dir'] . '/movieinfo_' . $id . '.json');
    }
}
@unlink($config['cache_dir'] . '/media_movies.json');

echo json_encode(['ok' => true, 'title' => $title, 'year' => $year], JSON_UNESCAPED_SLASHES);
