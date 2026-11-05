<?php

function media_cache_refresh_async(string $type): void
{
    if (!in_array($type, ['movies', 'tv', 'music'], true)) {
        return;
    }

    $script = __DIR__ . '/../public/api/media.php';
    exec('/usr/bin/timeout 900 /usr/bin/php ' . escapeshellarg($script)
        . ' ' . escapeshellarg('--refresh=' . $type)
        . ' </dev/null >/dev/null 2>&1 &');
}
