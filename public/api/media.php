<?php
// Browses the media library mounted at /mnt/library (read-only NFS).
// Responses are cached on disk for 5 minutes per type, photos.php style.

$config = require __DIR__ . '/../../config/config.php';

header('Content-Type: application/json');

const LIBRARY_ROOT = '/mnt/library';
const POSTERS_DIR = __DIR__ . '/../../data/posters';
const TMDB_MAP_FILE = __DIR__ . '/../../data/tmdb_map.json';

// Extensions scanned as "files"; PLAYABLE marks what browsers can stream.
const VIDEO_EXT = ['mp4', 'm4v', 'mkv', 'mov', 'webm', 'avi', 'mpg', 'mpeg', 'ts', 'm2ts', 'wmv'];
const VIDEO_PLAYABLE = ['mp4', 'm4v', 'mkv', 'mov', 'webm'];
const AUDIO_EXT = ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav'];
// Music dirs can hold both audio and concert videos.
const MUSIC_EXT = ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav',
                   'mp4', 'm4v', 'mkv', 'mov', 'webm', 'avi', 'mpg'];

function media_url(array $segments): string
{
    return 'media/' . implode('/', array_map('rawurlencode', $segments));
}

function media_files(string $dir, array $urlBase, array $scanExt, array $playableExt): array
{
    $files = [];
    foreach (glob($dir . '/*', GLOB_NOSORT) ?: [] as $path) {
        if (!is_file($path)) {
            continue;
        }
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        if (!in_array($ext, $scanExt, true)) {
            continue;
        }
        $name = basename($path);
        $files[] = [
            'name'     => $name,
            'url'      => media_url([...$urlBase, $name]),
            'playable' => in_array($ext, $playableExt, true),
        ];
    }
    usort($files, fn ($a, $b) => strnatcasecmp($a['name'], $b['name']));
    return $files;
}

function media_subdirs(string $dir): array
{
    $dirs = [];
    foreach (glob($dir . '/*', GLOB_ONLYDIR | GLOB_NOSORT) ?: [] as $path) {
        $dirs[] = basename($path);
    }
    return $dirs;
}

// Recursive variant for music: name is the path relative to $dir and the
// playable rule accepts any audio extension plus browser-playable video.
function media_files_recursive(string $dir, array $urlBase): array
{
    $files = [];
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS)
    );
    foreach ($it as $file) {
        if (!$file->isFile()) {
            continue;
        }
        $ext = strtolower($file->getExtension());
        if (!in_array($ext, MUSIC_EXT, true)) {
            continue;
        }
        $rel = str_replace('\\', '/', substr($file->getPathname(), strlen($dir) + 1));
        $files[] = [
            'name'     => $rel,
            'url'      => media_url([...$urlBase, ...explode('/', $rel)]),
            'playable' => in_array($ext, VIDEO_PLAYABLE, true) || in_array($ext, AUDIO_EXT, true),
        ];
    }
    usort($files, fn ($a, $b) => strnatcasecmp($a['name'], $b['name']));
    return $files;
}

function media_tmdb_map(): array
{
    $map = json_decode((string) @file_get_contents(TMDB_MAP_FILE), true);
    return is_array($map) ? $map : [];
}

function media_movies(): array
{
    $root = LIBRARY_ROOT . '/Movies';
    $map = media_tmdb_map();
    $movies = [];
    foreach (media_subdirs($root) as $dir) {
        $title = $dir;
        $year = null;
        if (preg_match('/^(.*?)\s*\((\d{4})\)\s*$/', $dir, $m)) {
            $title = $m[1];
            $year = (int) $m[2];
        }
        // User-corrected map entries override the parsed title/year.
        $override = $map[$dir] ?? null;
        if (is_array($override)) {
            $title = (string) ($override['title'] ?? $title);
            $year = isset($override['year']) ? (int) $override['year'] : $year;
        }
        // Poster overrides (kiosk-local) win over the library poster.jpg.
        $posterUrl = null;
        if (is_file(POSTERS_DIR . '/' . $dir . '.jpg')) {
            $posterUrl = 'api/poster.php?dir=' . rawurlencode($dir);
        } elseif (is_file($root . '/' . $dir . '/poster.jpg')) {
            $posterUrl = media_url(['Movies', $dir, 'poster.jpg']);
        }
        $movies[] = [
            'title'      => $title,
            'year'       => $year,
            'dir'        => $dir,
            'poster'     => $posterUrl !== null,
            'poster_url' => $posterUrl,
            'files'      => media_files($root . '/' . $dir, ['Movies', $dir], VIDEO_EXT, VIDEO_PLAYABLE),
        ];
    }
    usort($movies, fn ($a, $b) => strnatcasecmp($a['title'], $b['title']));
    return ['movies' => $movies];
}

function media_tv(): array
{
    $root = LIBRARY_ROOT . '/TV';
    $series = [];
    foreach (media_subdirs($root) as $dir) {
        $seasons = [];
        foreach (media_subdirs($root . '/' . $dir) as $seasonDir) {
            if (preg_match('/^Season\s+(\d+)$/i', $seasonDir, $m)) {
                $seasons[(int) $m[1]] = media_files(
                    $root . '/' . $dir . '/' . $seasonDir,
                    ['TV', $dir, $seasonDir],
                    VIDEO_EXT,
                    VIDEO_PLAYABLE
                );
            }
        }
        ksort($seasons);
        $series[] = [
            'name'    => $dir,
            'poster'  => is_file($root . '/' . $dir . '/poster.jpg'),
            'seasons' => $seasons,
        ];
    }
    usort($series, fn ($a, $b) => strnatcasecmp($a['name'], $b['name']));
    return ['series' => $series];
}

function media_music(): array
{
    $root = LIBRARY_ROOT . '/Music';
    $items = [];
    foreach (media_subdirs($root) as $dir) {
        $items[] = [
            'title'  => $dir,
            'dir'    => $dir,
            'poster' => is_file($root . '/' . $dir . '/poster.jpg'),
            'files'  => media_files_recursive($root . '/' . $dir, ['Music', $dir]),
        ];
    }
    usort($items, fn ($a, $b) => strnatcasecmp($a['title'], $b['title']));
    return ['items' => $items];
}

$type = (string) ($_GET['type'] ?? '');
$builders = ['movies' => 'media_movies', 'tv' => 'media_tv', 'music' => 'media_music'];
if (!isset($builders[$type])) {
    http_response_code(400);
    echo json_encode(['error' => 'unknown type']);
    exit;
}

$cacheFile = $config['cache_dir'] . '/media_' . $type . '.json';
$ttl = 21600; // 6 hours — the library rarely changes; corrections bust this cache explicitly

if (is_file($cacheFile) && time() - filemtime($cacheFile) < $ttl) {
    readfile($cacheFile);
    exit;
}

$payload = $builders[$type]();
$json = json_encode($payload, JSON_UNESCAPED_SLASHES);
if (is_dir($config['cache_dir']) && is_dir(LIBRARY_ROOT)) {
    file_put_contents($cacheFile, $json);
}
echo $json;
