<?php

require_once __DIR__ . '/settings.php';

function poster_cache_valid_dir(string $dir): bool
{
    return $dir !== '' && !str_contains($dir, '/') && !str_contains($dir, '\\')
        && !str_contains($dir, "\0") && !str_contains($dir, '..');
}

function poster_cache_override(string $dir): string
{
    return __DIR__ . '/../data/posters/' . $dir . '.jpg';
}

function poster_cache_file(string $dir): string
{
    static $cacheDir = null;
    if ($cacheDir === null) {
        $cacheDir = load_settings()['cache_dir'] . '/movie-posters';
    }
    return $cacheDir . '/' . md5($dir) . '.jpg';
}

function poster_cache_local(string $dir): ?string
{
    if (!poster_cache_valid_dir($dir)) {
        return null;
    }

    $override = poster_cache_override($dir);
    if (is_file($override)) {
        return $override;
    }

    $cached = poster_cache_file($dir);
    if (is_file($cached)) {
        return $cached;
    }

    $cacheDir = dirname($cached);
    if (!is_dir($cacheDir) && !@mkdir($cacheDir, 0775, true) && !is_dir($cacheDir)) {
        return null;
    }

    // Serialize and pace NAS reads so poster loading cannot overwhelm it.
    $lock = @fopen($cacheDir . '/fetch.lock', 'c');
    if ($lock === false || !flock($lock, LOCK_EX)) {
        if (is_resource($lock)) fclose($lock);
        return is_file($cached) ? $cached : null;
    }

    $path = null;
    $tmp = null;
    try {
        if (is_file($override)) {
            $path = $override;
        } elseif (is_file($cached)) {
            $path = $cached;
        } else {
            $source = '/mnt/library/Movies/' . $dir . '/poster.jpg';
            if (!is_file($source)) {
                return null;
            }

            $tmp = @tempnam($cacheDir, '.poster_');
            if ($tmp === false || !@copy($source, $tmp) || filesize($tmp) === 0) {
                if ($tmp !== null) @unlink($tmp);
                return null;
            }
            @chmod($tmp, 0664);
            if (!@rename($tmp, $cached)) {
                @unlink($tmp);
                return null;
            }
            $tmp = null;
            $path = $cached;
            usleep(100000);
        }
    } finally {
        if ($tmp !== null) @unlink($tmp);
        flock($lock, LOCK_UN);
        fclose($lock);
    }

    return $path;
}

function poster_cache_serve(string $path): void
{
    header('Content-Type: image/jpeg');
    header('Content-Length: ' . filesize($path));
    header('Cache-Control: public, max-age=604800');
    header('X-Content-Type-Options: nosniff');
    readfile($path);
}
