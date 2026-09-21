<?php
// PIN-gated USB photo import. The Settings UI browses removable drives
// under /media and harvests image files from a chosen folder (recursively)
// into the photo library. The heavy lifting runs as root through
// /usr/local/bin/kiosk-photo-import (udisks mount parents are
// ACL-restricted and unreadable by www-data).

require_once __DIR__ . '/../../lib/settings.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method not allowed']);
    exit;
}

$body = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($body) || !isset($body['pin']) || !pin_ok((string) $body['pin'])) {
    http_response_code(403);
    echo json_encode(['error' => 'bad pin']);
    exit;
}

$action = (string) ($body['action'] ?? '');
$path = (string) ($body['path'] ?? '');

function photo_import_run(array $args, int &$rc): array
{
    $cmd = 'sudo -n /usr/local/bin/kiosk-photo-import '
        . implode(' ', array_map('escapeshellarg', $args)) . ' 2>&1';
    exec($cmd, $out, $rc);
    return $out;
}

if ($action === 'browse') {
    if ($path === '') {
        $path = '/media/user';
    }
    if (!str_starts_with($path, '/media/')) {
        http_response_code(400);
        echo json_encode(['error' => 'bad path']);
        exit;
    }
    $rc = 0;
    $lines = photo_import_run(['list', $path], $rc);
    if ($rc !== 0) {
        http_response_code(400);
        echo json_encode(['error' => implode("\n", $lines)]);
        exit;
    }
    $images = 0;
    $dirs = [];
    foreach ($lines as $line) {
        $parts = explode("\t", $line);
        if ($parts[0] === 'IMAGES' && isset($parts[1])) {
            $images = (int) $parts[1];
        } elseif ($parts[0] === 'SUB' && isset($parts[1], $parts[2])) {
            $dirs[] = ['name' => $parts[1], 'images' => (int) $parts[2]];
        }
    }
    $parent = dirname($path);
    if (!str_starts_with($parent, '/media/')) {
        $parent = null;
    }
    echo json_encode([
        'path'   => $path,
        'parent' => $parent,
        'images' => $images,
        'dirs'   => $dirs,
    ], JSON_UNESCAPED_SLASHES);
    exit;
}

if ($action === 'import') {
    if (!str_starts_with($path, '/media/')) {
        http_response_code(400);
        echo json_encode(['error' => 'bad path']);
        exit;
    }
    $settings = load_settings();
    $dest = $settings['photos_dir'];
    $rc = 0;
    $lines = photo_import_run(['import', $path, $dest], $rc);
    if ($rc !== 0) {
        http_response_code(500);
        echo json_encode(['error' => implode("\n", $lines)]);
        exit;
    }
    $imported = 0;
    $skipped = 0;
    foreach ($lines as $line) {
        if (preg_match('/^IMPORTED\t(\d+)/', $line, $m)) {
            $imported = (int) $m[1];
        } elseif (preg_match('/^SKIPPED\t(\d+)/', $line, $m)) {
            $skipped = (int) $m[1];
        }
    }
    // Force the photo-list cache to rebuild on next request.
    @unlink($settings['cache_dir'] . '/photos.json');
    echo json_encode(['ok' => true, 'imported' => $imported, 'skipped' => $skipped]);
    exit;
}

http_response_code(400);
echo json_encode(['error' => 'unknown action']);
