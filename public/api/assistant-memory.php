<?php
// Returns the assistant's long-term memory + rolling conversation summary
// for injection into the Live session's system instruction.

header('Content-Type: application/json');

$dir = __DIR__ . '/../../data/assistant';

$read = function (string $file) use ($dir): string {
    $text = (string) @file_get_contents($dir . '/' . $file);
    return trim($text);
};

echo json_encode([
    'memory'  => $read('memory.md'),
    'summary' => $read('summary.md'),
], JSON_UNESCAPED_SLASHES);
