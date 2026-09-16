<?php
// Blank-photo scan results + trigger.
// GET  → current scan state (finished/done/total/flagged)
// POST → spawn a background rescan (bin/scan-blanks.php)

require_once __DIR__ . '/../../lib/settings.php';

header('Content-Type: application/json');
$config = load_settings();
$outFile = $config['cache_dir'] . '/blank-scan.json';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $script = __DIR__ . '/../../bin/scan-blanks.php';
    if (!is_file($script)) {
        http_response_code(500);
        echo json_encode(['error' => 'scanner missing']);
        exit;
    }
    exec('nohup php ' . escapeshellarg($script) . ' > /dev/null 2>&1 &');
    echo json_encode(['ok' => true]);
    exit;
}

if (!is_file($outFile)) {
    echo json_encode(['finished' => false, 'done' => 0, 'total' => 0, 'flagged' => []]);
    exit;
}
readfile($outFile);
