<?php
// CLI: scans the photo library and scores "blankness" for each photo.
// Loads each image downscaled to 64px, computes luminance mean and standard
// deviation. Solid-color / black-frame shots have near-zero stddev.
// Writes data/cache/blank-scan.json (progress + flagged list).
// Run:  php bin/scan-blanks.php     (or via api/photo-blanks.php POST)

ini_set('memory_limit', '512M');
set_time_limit(0);

$config = require __DIR__ . '/../config/config.php';
$root = $config['photos_dir'];
$outFile = $config['cache_dir'] . '/blank-scan.json';

$photos = [];
$it = new RecursiveIteratorIterator(
    new RecursiveCallbackFilterIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
        fn ($f) => !$f->isDir() || $f->getFilename() !== '.trash'
    )
);
foreach ($it as $file) {
    if ($file->isFile() && preg_match('/\.(jpe?g|png|webp)$/i', $file->getFilename())) {
        $photos[] = substr($file->getPathname(), strlen($root) + 1);
    }
}
sort($photos);
$total = count($photos);

$flagged = [];
$scores = [];
$done = 0;

$write = function (bool $finished) use ($outFile, &$flagged, &$done, $total) {
    file_put_contents($outFile, json_encode([
        'finished' => $finished,
        'done'     => $done,
        'total'    => $total,
        'flagged'  => $flagged,
    ], JSON_UNESCAPED_SLASHES), LOCK_EX);
};

foreach ($photos as $rel) {
    $done++;
    $src = $root . '/' . $rel;

    // ffmpeg decodes far faster than GD on multi-megapixel files; we only
    // need 64×64 gray pixels to judge blankness.
    $raw = shell_exec('ffmpeg -v error -i ' . escapeshellarg($src)
        . ' -vf scale=64:64 -frames:v 1 -f rawvideo -pix_fmt gray - 2>/dev/null');
    if (!is_string($raw) || strlen($raw) < 4096) {
        continue; // undecodable — leave it alone
    }

    $sum = 0.0;
    $sum2 = 0.0;
    $n = 4096;
    for ($i = 0; $i < $n; $i++) {
        $lum = ord($raw[$i]);
        $sum += $lum;
        $sum2 += $lum * $lum;
    }

    $mean = $sum / $n;
    $std = sqrt(max(0, $sum2 / $n - $mean * $mean));
    $scores[$rel] = [round($mean, 1), round($std, 1)];

    // Blank: almost no variation, or near-solid black/white.
    if ($std < 6.0 || ($mean < 8 && $std < 12) || ($mean > 247 && $std < 12)) {
        $flagged[] = $rel;
    }

    if ($done % 200 === 0) {
        $write(false);
    }
}

$write(true);
file_put_contents($config['cache_dir'] . '/blank-scores.json', json_encode($scores, JSON_UNESCAPED_SLASHES), LOCK_EX);
echo "scanned $done / $total, flagged " . count($flagged) . "\n";
