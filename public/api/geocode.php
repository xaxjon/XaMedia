<?php
// Proxies the Open-Meteo geocoding API (no key required) and returns a
// simplified list of matches for the location picker.

header('Content-Type: application/json');

$q = trim((string) ($_GET['q'] ?? ''));
if ($q === '') {
    echo '[]';
    exit;
}

$url = 'https://geocoding-api.open-meteo.com/v1/search?' . http_build_query([
    'name'     => $q,
    'count'    => 6,
    'language' => 'en',
    'format'   => 'json',
]);

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
    http_response_code(502);
    echo json_encode(['error' => 'geocoding unavailable']);
    exit;
}

$data = json_decode($body, true);
$results = [];
foreach ($data['results'] ?? [] as $r) {
    if (!isset($r['latitude'], $r['longitude'])) {
        continue;
    }
    $results[] = [
        'name'    => $r['name'] ?? '',
        'lat'     => (float) $r['latitude'],
        'lon'     => (float) $r['longitude'],
        'country' => $r['country'] ?? null,
        'admin1'  => $r['admin1'] ?? null,
    ];
}

echo json_encode($results, JSON_UNESCAPED_SLASHES);
