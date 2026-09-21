<?php
// OpenAI-compatible /v1/audio/speech proxy backed by Gemini native TTS.
// Open WebUI's TTS engine "openai" posts {model, input, voice} here; we call
// Gemini's TTS model with a British-English style instruction and wrap the
// PCM16/24kHz/mono payload in a WAV container. Responses cached by content.

require_once __DIR__ . '/../../../../lib/settings.php';
$GEMINI_KEY = load_settings()['gemini_api_key'] ?? '';
if ($GEMINI_KEY === '') {
    http_response_code(500);
    exit('gemini_api_key not configured');
}

$body = json_decode(file_get_contents('php://input'), true);
$text = trim((string) ($body['input'] ?? ''));
$voice = preg_replace('/[^a-z]/', '', strtolower((string) ($body['voice'] ?? 'leda'))) ?: 'leda';

if ($text === '') {
    http_response_code(400);
    exit('empty input');
}

$cacheDir = __DIR__ . '/../../../../data/cache/tts';
if (!is_dir($cacheDir)) {
    mkdir($cacheDir, 0775, true);
}
$key = md5('3.1|' . $voice . '|' . $text);
$cacheFile = $cacheDir . '/' . $key . '.wav';
if (is_file($cacheFile)) {
    header('Content-Type: audio/wav');
    header('Content-Length: ' . filesize($cacheFile));
    readfile($cacheFile);
    exit;
}

$payload = json_encode([
    'contents' => [['parts' => [[
        'text' => 'Say in a warm, clear British English accent (en-GB): ' . $text,
    ]]]],
    'generationConfig' => [
        'responseModalities' => ['AUDIO'],
        'speechConfig' => [
            'voiceConfig' => ['prebuiltVoiceConfig' => ['voiceName' => ucfirst($voice)]],
            'languageCode' => 'en-GB',
        ],
    ],
], JSON_UNESCAPED_SLASHES);

$ch = curl_init('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 45,
    CURLOPT_HTTPHEADER     => [
        'x-goog-api-key: ' . $GEMINI_KEY,
        'Content-Type: application/json',
    ],
    CURLOPT_POSTFIELDS     => $payload,
]);
$resp = curl_exec($ch);
$ok = $resp !== false && curl_getinfo($ch, CURLINFO_RESPONSE_CODE) === 200;
curl_close($ch);

if (!$ok) {
    http_response_code(502);
    exit('tts upstream failed');
}

$data = json_decode($resp, true);
$pcm = null;
foreach ($data['candidates'][0]['content']['parts'] ?? [] as $part) {
    if (isset($part['inlineData']['data'])) {
        $pcm = base64_decode($part['inlineData']['data']);
        break;
    }
}
if (!$pcm) {
    http_response_code(502);
    exit('no audio in upstream response');
}

// Wrap raw PCM16 mono 24kHz in a WAV header.
$dataLen = strlen($pcm);
// fmt widths: size(V) format(v) channels(v) rate(V) byterate(V)
// align(v) bits(v) — the old pack string mismatched them and produced
// headers ffmpeg/python reject.
$wav = 'RIFF' . pack('V', 36 + $dataLen) . 'WAVE'
    . 'fmt ' . pack('VvvVVvv', 16, 1, 1, 24000, 48000, 2, 16)
    . 'data' . pack('V', $dataLen) . $pcm;

file_put_contents($cacheFile, $wav, LOCK_EX);

header('Content-Type: audio/wav');
header('Content-Length: ' . strlen($wav));
echo $wav;
