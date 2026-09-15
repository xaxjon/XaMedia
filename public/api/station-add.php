<?php
// Adds a station to the saved list (data/settings.json). Deliberately
// PIN-free like movie-correct.php — it's additive and trivially reversible;
// inputs are validated strictly instead.

require_once __DIR__ . '/../../lib/settings.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

$body = json_decode(file_get_contents('php://input'), true);
$name = trim((string) ($body['name'] ?? ''));
$url  = trim((string) ($body['url'] ?? ''));

if ($name === '' || mb_strlen($name) > 80
    || !preg_match('#^https?://#i', $url) || strlen($url) > 500) {
    http_response_code(400);
    echo json_encode(['error' => 'bad name or url']);
    exit;
}

$settings = load_settings();
$stations = $settings['stations'] ?? [];
foreach ($stations as $s) {
    if (($s['url'] ?? '') === $url) {
        echo json_encode(['ok' => true, 'stations' => $stations, 'already' => true]);
        exit;
    }
}

$stations[] = ['name' => $name, 'url' => $url];
save_settings(['stations' => $stations]);

echo json_encode(['ok' => true, 'stations' => $stations]);
