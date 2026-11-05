<?php
// Browses the media library mounted at /mnt/library (read-only NFS).
// Existing indexes return immediately; stale indexes refresh in the background.

$config = require __DIR__ . '/../../config/config.php';

set_time_limit(0);
header('Content-Type: application/json');

const LIBRARY_ROOT = '/mnt/library';
const POSTERS_DIR = __DIR__ . '/../../data/posters';
const TMDB_MAP_FILE = __DIR__ . '/../../data/tmdb_map.json';
const GENRES_FILE = __DIR__ . '/../../data/genres.json';

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

function media_extensionless_mp4(string $path): bool
{
    $fh = @fopen($path, 'rb');
    if (!$fh) {
        return false;
    }
    $header = fread($fh, 12);
    fclose($fh);
    return strlen($header) >= 12 && substr($header, 4, 4) === 'ftyp';
}

function media_files(string $dir, array $urlBase, array $scanExt, array $playableExt): array
{
    $files = [];
    foreach (glob($dir . '/*', GLOB_NOSORT) ?: [] as $path) {
        if (!is_file($path)) {
            continue;
        }
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        $extensionlessVideo = $ext === '' && filesize($path) > 100_000_000;
        if (!$extensionlessVideo && !in_array($ext, $scanExt, true)) {
            continue;
        }
        $name = basename($path);
        $files[] = [
            'name'     => $name,
            'url'      => media_url([...$urlBase, $name]),
            'playable' => in_array($ext, $playableExt, true)
                || ($extensionlessVideo && media_extensionless_mp4($path)),
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

function media_genre_map(): array
{
    $map = json_decode((string) @file_get_contents(GENRES_FILE), true);
    return is_array($map) ? $map : [];
}

function media_movies(): array
{
    $root = LIBRARY_ROOT . '/Movies';
    $map = media_tmdb_map();
    $genres = media_genre_map();
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
            'genres'     => $genres[$dir] ?? [],
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

require_once __DIR__ . '/../../lib/media-cache.php';

$cliRefresh = PHP_SAPI === 'cli';
$type = $cliRefresh ? '' : (string) ($_GET['type'] ?? '');
if ($cliRefresh) {
    foreach ($argv ?? [] as $arg) {
        if (str_starts_with($arg, '--refresh=')) {
            $type = substr($arg, strlen('--refresh='));
        }
    }
}

$builders = ['movies' => 'media_movies', 'tv' => 'media_tv', 'music' => 'media_music'];
$libraryDirs = ['movies' => 'Movies', 'tv' => 'TV', 'music' => 'Music'];
if (!isset($builders[$type])) {
    http_response_code(400);
    echo json_encode(['error' => 'unknown type']);
    exit(1);
}

$cacheDir = $config['cache_dir'];
$cacheFile = $cacheDir . '/media_' . $type . '.json';
$ttl = 21600;

// A stale index is more useful than a loading screen. Return it immediately
// while one CLI worker rebuilds the replacement in the background.
if (!$cliRefresh && is_file($cacheFile)) {
    if (time() - filemtime($cacheFile) >= $ttl) {
        media_cache_refresh_async($type);
    }
    readfile($cacheFile);
    exit;
}

$lock = @fopen($cacheFile . '.refresh.lock', 'c');
if ($lock === false) {
    if (!$cliRefresh && is_file($cacheFile)) {
        readfile($cacheFile);
        exit;
    }
    http_response_code(500);
    echo json_encode(['error' => 'could not open media refresh lock']);
    exit(1);
}

// Initial scans wait for each other; background workers never pile up.
if (!flock($lock, $cliRefresh ? LOCK_EX | LOCK_NB : LOCK_EX)) {
    fclose($lock);
    if ($cliRefresh) {
        exit(0);
    }
    if (is_file($cacheFile)) {
        readfile($cacheFile);
    } else {
        http_response_code(503);
        echo json_encode(['error' => 'media refresh already running']);
    }
    exit;
}

// Another initial request may have populated the cache while this one waited.
if (!$cliRefresh && is_file($cacheFile)) {
    readfile($cacheFile);
    flock($lock, LOCK_UN);
    fclose($lock);
    exit;
}

$tmp = null;
$json = null;
$error = null;
try {
    $libraryRoot = LIBRARY_ROOT . '/' . $libraryDirs[$type];
    if (!is_dir($libraryRoot)) {
        throw new RuntimeException('media library is unavailable');
    }

    $json = json_encode($builders[$type](), JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        throw new RuntimeException('could not encode media index');
    }
    if (!is_dir($libraryRoot)) {
        throw new RuntimeException('media library disappeared during refresh');
    }
    if (!is_dir($cacheDir) && !@mkdir($cacheDir, 0775, true) && !is_dir($cacheDir)) {
        throw new RuntimeException('could not create media cache directory');
    }

    $tmp = @tempnam($cacheDir, '.media_' . $type . '_');
    if ($tmp === false || @file_put_contents($tmp, $json, LOCK_EX) === false) {
        throw new RuntimeException('could not write media cache');
    }
    @chmod($tmp, 0664);
    if (!@rename($tmp, $cacheFile)) {
        throw new RuntimeException('could not replace media cache');
    }
    $tmp = null;
} catch (Throwable $e) {
    $error = $e;
    if ($tmp !== null) {
        @unlink($tmp);
    }
    error_log('media refresh (' . $type . '): ' . $e->getMessage());
}

flock($lock, LOCK_UN);
fclose($lock);

if ($cliRefresh) {
    exit($error === null ? 0 : 1);
}
if ($error !== null) {
    if (is_file($cacheFile)) {
        readfile($cacheFile);
    } else {
        http_response_code(503);
        echo json_encode(['error' => 'media library is unavailable']);
    }
    exit;
}
echo $json;
