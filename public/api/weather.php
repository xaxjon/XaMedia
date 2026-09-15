<?php
// Proxies Open-Meteo (no API key required) with a 15-minute file cache.
// Adds a simple "icon" key mapped from each WMO weather code and a
// "pressure_trend" key derived from the hourly surface pressure series.

require_once __DIR__ . '/../../lib/settings.php';
$config = load_settings();

header('Content-Type: application/json');

$cacheFile = $config['cache_dir'] . '/weather.json';
$ttl = 900; // 15 minutes

function weather_icon(int $code): string
{
    return match (true) {
        $code === 0                     => 'clear',
        $code === 1, $code === 2        => 'partly',
        $code === 3                     => 'cloud',
        $code === 45, $code === 48      => 'fog',
        $code >= 51 && $code <= 57      => 'drizzle',
        $code >= 61 && $code <= 67,
        $code >= 80 && $code <= 82      => 'rain',
        $code >= 71 && $code <= 77,
        $code === 85, $code === 86      => 'snow',
        $code >= 95                     => 'storm',
        default                         => 'cloud',
    };
}

// Compares current surface pressure to the hourly reading ~3 hours back.
function pressure_trend(array $data): string
{
    $current = $data['current']['surface_pressure'] ?? null;
    $times = $data['hourly']['time'] ?? [];
    $pressures = $data['hourly']['surface_pressure'] ?? [];
    $now = $data['current']['time'] ?? null;

    if (!is_numeric($current) || !is_string($now) || !$times || !$pressures) {
        return 'steady';
    }

    $target = strtotime($now . ' -3 hours');
    if ($target === false) {
        return 'steady';
    }

    $past = null;
    foreach ($times as $i => $t) {
        $ts = strtotime((string) $t);
        if ($ts !== false && $ts <= $target && isset($pressures[$i]) && is_numeric($pressures[$i])) {
            $past = (float) $pressures[$i]; // keep the latest hour at or before the target
        }
    }
    if ($past === null && isset($pressures[0]) && is_numeric($pressures[0])) {
        $past = (float) $pressures[0];
    }
    if ($past === null) {
        return 'steady';
    }

    $diff = (float) $current - $past;
    if ($diff > 0.5) {
        return 'rising';
    }
    if ($diff < -0.5) {
        return 'falling';
    }
    return 'steady';
}

function add_derived(array $data): array
{
    if (isset($data['current']['weather_code'])) {
        $data['current']['icon'] = weather_icon((int) $data['current']['weather_code']);
    }
    if (isset($data['daily']['weather_code'])) {
        $data['daily']['icons'] = array_map(
            fn ($c) => weather_icon((int) $c),
            $data['daily']['weather_code']
        );
    }
    if (isset($data['current']) && is_array($data['current'])) {
        $data['current']['pressure_trend'] = pressure_trend($data);
    }
    return $data;
}

if (is_file($cacheFile) && time() - filemtime($cacheFile) < $ttl) {
    readfile($cacheFile);
    exit;
}

$loc = $config['location'];
$url = 'https://api.open-meteo.com/v1/forecast?' . http_build_query([
    'latitude'       => $loc['lat'],
    'longitude'      => $loc['lon'],
    'current'        => 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure',
    'hourly'         => 'surface_pressure',
    'daily'          => 'weather_code,temperature_2m_max,temperature_2m_min',
    'forecast_days'  => 5,
    'timezone'       => 'auto',
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

if ($ok) {
    $data = json_decode($body, true);
    if (is_array($data)) {
        $data['location_label'] = $loc['label'];
        $out = json_encode(add_derived($data), JSON_UNESCAPED_SLASHES);
        if (is_dir($config['cache_dir'])) {
            file_put_contents($cacheFile, $out);
        }
        echo $out;
        exit;
    }
}

// Upstream failed: fall back to stale cache if we have one.
if (is_file($cacheFile)) {
    readfile($cacheFile);
    exit;
}

http_response_code(502);
echo json_encode(['error' => 'weather unavailable']);
