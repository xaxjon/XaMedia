<?php
// Reports external playback processes so the voice assistant can suppress
// wake activation while media is on screen. Read-only; no sudo required.

header('Content-Type: application/json');

exec('pgrep -x vlc 2>/dev/null', $vlcOut, $vlcRc);
exec("pgrep -f '[c]hrome.*xamedia-chrome' 2>/dev/null", $streamOut, $streamRc);

$vlc = $vlcRc === 0;
$stream = $streamRc === 0;

echo json_encode([
    'playing' => $vlc || $stream,
    'vlc'     => $vlc,
    'stream'  => $stream,
]);
