<?php
// NAS-side HTTP bridge for the constrained movie-title purge worker.

header('Content-Type: application/json');

$allowedClients = ['192.168.10.144', '127.0.0.1', '::1'];
$clientFile = '/etc/xamedia/movie-delete-clients.json';
if (is_file($clientFile)) {
    $extraClients = json_decode((string) file_get_contents($clientFile), true);
    if (is_array($extraClients)) {
        foreach ($extraClients as $client) {
            if (is_string($client) && $client !== '') $allowedClients[] = $client;
        }
    }
}
$allowedClients = array_values(array_unique($allowedClients));
if (!in_array($_SERVER['REMOTE_ADDR'] ?? '', $allowedClients, true)) {
    http_response_code(403);
    echo json_encode(['error' => 'client not allowed']);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

$body = json_decode((string) file_get_contents('php://input'), true);
$dir = is_array($body) ? ($body['dir'] ?? null) : null;
if (!is_string($dir) || $dir === '' || $dir === '.' || $dir === '..'
    || str_contains($dir, '/') || str_contains($dir, '\\') || str_contains($dir, "\0")) {
    http_response_code(400);
    echo json_encode(['error' => 'bad dir']);
    exit;
}

exec('sudo -n -u nas /usr/local/bin/xamedia-movie-delete '
    . escapeshellarg($dir) . ' 2>&1', $out, $rc);
$output = trim(implode("\n", $out));
$result = json_decode($output, true);

if ($rc !== 0 || !is_array($result) || empty($result['ok'])) {
    http_response_code(500);
    echo json_encode([
        'error'  => 'delete failed',
        'detail' => is_array($result) ? ($result['error'] ?? 'worker rejected the request') : $output,
    ]);
    exit;
}

echo json_encode($result, JSON_UNESCAPED_SLASHES);
