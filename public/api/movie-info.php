<?php
// Movie detail for the kiosk overlay. Looks up the TMDB id for a library
// directory in data/tmdb_map.json, fetches TMDB (7-day per-id cache of the
// raw response) and returns a simplified JSON document. Map entries that
// were corrected by a user are objects {tmdb_id, title, year}; their
// title/year override TMDB's in the response.

require_once __DIR__ . '/../../lib/settings.php';
$TMDB_KEY = load_settings()['tmdb_api_key'] ?? '';

header('Content-Type: application/json');

const MAP_FILE = __DIR__ . '/../../data/tmdb_map.json';

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

$dir = (string) ($_GET['dir'] ?? '');
if ($dir === '') {
    http_response_code(400);
    echo json_encode(['error' => 'missing dir']);
    exit;
}

$map = json_decode((string) @file_get_contents(MAP_FILE), true);
if (!is_array($map) || !isset($map[$dir])) {
    http_response_code(404);
    echo json_encode(['error' => 'unknown movie']);
    exit;
}

$entry = $map[$dir];
$corrected = is_array($entry);
$tmdbId = (int) ($corrected ? ($entry['tmdb_id'] ?? 0) : $entry);
if ($tmdbId <= 0) {
    http_response_code(404);
    echo json_encode(['error' => 'unknown movie']);
    exit;
}

$cacheFile = $config['cache_dir'] . '/movieinfo_' . $tmdbId . '.json';
$ttl = 7 * 86400; // 7 days

$data = null;
if (is_file($cacheFile) && time() - filemtime($cacheFile) < $ttl) {
    $data = json_decode((string) file_get_contents($cacheFile), true);
} else {
    $data = tmdb_get('https://api.themoviedb.org/3/movie/' . $tmdbId . '?' . http_build_query([
        'api_key'           => $TMDB_KEY,
        'append_to_response' => 'credits',
    ]));
    if (is_array($data) && is_dir($config['cache_dir'])) {
        file_put_contents($cacheFile, json_encode($data), LOCK_EX);
    } elseif (!is_array($data) && is_file($cacheFile)) {
        // Upstream failed: fall back to the stale cache if we have one.
        $data = json_decode((string) file_get_contents($cacheFile), true);
    }
}

if (!is_array($data)) {
    http_response_code(502);
    echo json_encode(['error' => 'tmdb unavailable']);
    exit;
}

$director = null;
foreach ($data['credits']['crew'] ?? [] as $crew) {
    if (($crew['job'] ?? '') === 'Director') {
        $director = $crew['name'] ?? null;
        break;
    }
}

$cast = [];
foreach (array_slice($data['credits']['cast'] ?? [], 0, 8) as $member) {
    $cast[] = [
        'name'      => $member['name'] ?? '',
        'character' => $member['character'] ?? '',
    ];
}

$title = $data['title'] ?? '';
$year = isset($data['release_date']) && strlen((string) $data['release_date']) >= 4
    ? (int) substr((string) $data['release_date'], 0, 4)
    : null;
if ($corrected) {
    $title = (string) ($entry['title'] ?? $title);
    $year = isset($entry['year']) ? (int) $entry['year'] : $year;
}

echo json_encode([
    'tmdb_id'   => $tmdbId,
    'title'     => $title,
    'year'      => $year,
    'overview'  => $data['overview'] ?? '',
    'rating'    => isset($data['vote_average']) ? round((float) $data['vote_average'], 1) : null,
    'runtime'   => $data['runtime'] ?? null,
    'genres'    => array_values(array_map(fn ($g) => $g['name'] ?? '', $data['genres'] ?? [])),
    'director'  => $director,
    'cast'      => $cast,
    'corrected' => $corrected,
], JSON_UNESCAPED_SLASHES);
