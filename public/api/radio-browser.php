<?php
// Cached proxy to radio-browser.info — the free community database of
// internet radio stations (no API key required). Polite UA per their docs.

require_once __DIR__ . '/../../lib/settings.php';
$config = load_settings();

header('Content-Type: application/json');

$tag = trim((string) ($_GET['tag'] ?? ''));
if ($tag === '' || strlen($tag) > 40 || !preg_match('/^[\w .#+-]+$/u', $tag)) {
    http_response_code(400);
    echo json_encode(['error' => 'bad tag']);
    exit;
}

$cacheFile = $config['cache_dir'] . '/radio_' . md5(mb_strtolower($tag)) . '.json';
$ttl = 21600; // 6 hours

if (is_file($cacheFile) && time() - filemtime($cacheFile) < $ttl) {
    readfile($cacheFile);
    exit;
}

$stations = [];
// The all.api round-robin host stalls sometimes; try mirrors in order.
$mirrorHosts = ['de1', 'de2', 'nl1', 'fi1'];
foreach ($mirrorHosts as $m) {
    $url = "https://{$m}.api.radio-browser.info/json/stations/search?" . http_build_query([
        'tag'        => $tag,
        'order'      => 'votes',
        'reverse'    => 'true',
        'limit'      => 24,
        'hidebroken' => 'true',
    ]);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 12,
        CURLOPT_USERAGENT      => 'XaMedia-kiosk/1.0 (home entertainment)',
    ]);
    $body = curl_exec($ch);
    $ok = $body !== false && curl_getinfo($ch, CURLINFO_RESPONSE_CODE) === 200;
    curl_close($ch);
    if (!$ok) continue;
    foreach (json_decode($body, true) ?: [] as $s) {
        if (empty($s['name']) || empty($s['url_resolved'])) continue;
        $stations[] = [
            'name'    => mb_substr(trim($s['name']), 0, 60),
            'url'     => $s['url_resolved'],
            'codec'   => $s['codec'] ?? '',
            'bitrate' => (int) ($s['bitrate'] ?? 0),
            'country' => $s['countrycode'] ?? '',
            'votes'   => (int) ($s['votes'] ?? 0),
        ];
    }
    break;
}

if ($stations) {
    $out = json_encode(['stations' => $stations], JSON_UNESCAPED_SLASHES);
    file_put_contents($cacheFile, $out, LOCK_EX);
    echo $out;
    exit;
}

// Upstream failed or empty: serve stale cache if we have one.
if (is_file($cacheFile)) {
    readfile($cacheFile);
    exit;
}

http_response_code(502);
echo json_encode(['error' => 'radio directory unavailable']);
