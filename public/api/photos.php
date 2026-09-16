<?php
// Returns a shuffled JSON list of all slideshow images (relative paths).
// Result is cached on disk to avoid rescanning large libraries every load.

$config = require __DIR__ . '/../../config/config.php';

$cacheFile = $config['cache_dir'] . '/photos.json';
$ttl = 300; // 5 minutes

header('Content-Type: application/json');

$forGrid = ($_GET['sort'] ?? '') === 'path';

if (!$forGrid && is_file($cacheFile) && time() - filemtime($cacheFile) < $ttl) {
    readfile($cacheFile);
    exit;
}

$root = $config['photos_dir'];
$photos = [];

if (is_dir($root)) {
    $it = new RecursiveIteratorIterator(
        new RecursiveCallbackFilterIterator(
            new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
            function ($file) {
                // Keep the trash out of the slideshow and the manager grid.
                return !$file->isDir() || $file->getFilename() !== '.trash';
            }
        )
    );
    foreach ($it as $file) {
        if (!$file->isFile()) {
            continue;
        }
        $ext = strtolower($file->getExtension());
        if (!in_array($ext, ['jpg', 'jpeg', 'png', 'webp'], true)) {
            continue;
        }
        $photos[] = substr($file->getPathname(), strlen($root) + 1);
    }
}

// ?sort=path serves the grid (stable order, no cache); default stays
// shuffled + cached for the slideshow.
if ($forGrid) {
    sort($photos);
    echo json_encode($photos, JSON_UNESCAPED_SLASHES);
    exit;
}

shuffle($photos);

$json = json_encode($photos, JSON_UNESCAPED_SLASHES);
if (is_dir($config['cache_dir'])) {
    file_put_contents($cacheFile, $json);
}
echo $json;
