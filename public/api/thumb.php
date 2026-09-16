<?php
// On-demand 360px JPEG thumbnails for the photo manager grid.
// Cached forever under data/cache/thumbs/<md5>.jpg; invalidated on
// rotate/delete by file mtime mismatch.

require_once __DIR__ . '/photo-lib.php';

$config = load_settings();
$rel = (string) ($_GET['f'] ?? '');
$src = photo_path($rel);

$thumbDir = $config['cache_dir'] . '/thumbs';
if (!is_dir($thumbDir)) {
    mkdir($thumbDir, 0775, true);
}
$key = md5($rel);
$thumb = $thumbDir . '/' . $key . '.jpg';

if (is_file($thumb) && filemtime($thumb) >= filemtime($src)) {
    header('Content-Type: image/jpeg');
    header('Cache-Control: public, max-age=86400');
    readfile($thumb);
    exit;
}

$img = null;
$ext = strtolower(pathinfo($src, PATHINFO_EXTENSION));
if ($ext === 'png') {
    $img = @imagecreatefrompng($src);
} elseif ($ext === 'webp') {
    $img = @imagecreatefromwebp($src);
} else {
    $img = @imagecreatefromjpeg($src);
}
if (!$img) {
    http_response_code(415);
    exit('unsupported');
}

// Honor EXIF orientation so rotated phone shots display correctly.
if ($ext !== 'png' && function_exists('exif_read_data')) {
    $exif = @exif_read_data($src);
    $o = (int) ($exif['Orientation'] ?? 1);
    if ($o === 3) {
        $img = imagerotate($img, 180, 0);
    } elseif ($o === 6) {
        $img = imagerotate($img, -90, 0);
    } elseif ($o === 8) {
        $img = imagerotate($img, 90, 0);
    }
}

$w = imagesx($img);
$h = imagesy($img);
$tw = 360;
$th = max(1, (int) round($h * ($tw / $w)));
$out = imagecreatetruecolor($tw, $th);
imagecopyresampled($out, $img, 0, 0, 0, 0, $tw, $th, $w, $h);
imagejpeg($out, $thumb, 82);
imagedestroy($img);
imagedestroy($out);

header('Content-Type: image/jpeg');
header('Cache-Control: public, max-age=86400');
readfile($thumb);
