#!/usr/bin/env python3
"""Localhost WebSocket relay between the kiosk browser and the Gemini Live API.

The assistant overlay (public/assets/js/assistant.js) connects to
ws://127.0.0.1:8787; for each browser connection this opens one upstream
connection to the Live API and shuttles messages both ways until either
side closes. Keeping the relay local means the API key never reaches the
browser JavaScript.

Install: install -m755 -o root deploy/live-proxy.py /usr/local/bin/kiosk-live-proxy
Autostart: copy deploy/kiosk-live-proxy.desktop to ~/.config/autostart/
"""
import asyncio
import json
import re
import sys

import websockets

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 8787
CONFIG_PATH = "/var/www/entertainment/config/config.php"
SETTINGS_PATH = "/var/www/entertainment/data/settings.json"
UPSTREAM_URL = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
    "?key={key}"
)


def load_api_key():
    # The Settings UI stores overrides in data/settings.json; config.php is
    # the base. The UI value wins when both are set.
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as fh:
            stored = json.load(fh)
        key = str(stored.get("gemini_api_key", "")).strip()
        if key:
            return key
    except (OSError, ValueError):
        pass
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        print(f"live-proxy: cannot read {CONFIG_PATH}: {exc}", file=sys.stderr)
        sys.exit(1)
    m = re.search(r"'gemini_api_key'\s*=>\s*'([^']*)'", text)
    if not m or not m.group(1).strip():
        print(f"live-proxy: 'gemini_api_key' missing or empty in "
              f"{SETTINGS_PATH} and {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    return m.group(1).strip()


async def pump(src, dst, decode_text=False, counter=None, label=""):
    try:
        async for message in src:
            # Gemini Live sends binary frames; browsers expect text for
            # JSON.parse. Decode bytes when forwarding toward the browser.
            if decode_text and isinstance(message, bytes):
                message = message.decode("utf-8", "replace")
            await dst.send(message)
            if counter is not None:
                counter[label] = counter.get(label, 0) + len(message)
    except websockets.ConnectionClosed:
        pass
    finally:
        # One side went away: closing the peer ends the other pump too.
        try:
            await dst.close()
        except Exception:
            pass


async def handle(browser_ws, *args):
    # *args absorbs the legacy (ws, path) handler signature on older
    # python3-websockets versions; newer ones pass only (ws).
    peer = getattr(browser_ws, "remote_address", None)
    print(f"live-proxy: browser connected from {peer}", flush=True)
    counter = {}
    done = asyncio.Event()

    async def meter():
        while not done.is_set():
            await asyncio.sleep(3)
            print(f"live-proxy: traffic up={counter.get('up', 0)}B down={counter.get('down', 0)}B", flush=True)

    try:
        async with websockets.connect(UPSTREAM_URL.format(key=API_KEY),
                                      max_size=None) as gemini_ws:
            print("live-proxy: upstream connected to Gemini Live API", flush=True)
            # The meter runs alongside, NOT inside the gather: gather would
            # wait for it forever (it only stops when `done` is set, which
            # happens after the pumps finish). Gathering it here used to
            # leak every session — upstream connection and meter task both
            # — until the API's concurrent-session limit refused new setups.
            meter_task = asyncio.ensure_future(meter())
            await asyncio.gather(
                pump(browser_ws, gemini_ws, counter=counter, label="up"),
                pump(gemini_ws, browser_ws, decode_text=True, counter=counter, label="down"),
            )
            done.set()
            await meter_task
    except Exception as exc:
        print(f"live-proxy: session ended with error: {exc}", flush=True)
    finally:
        done.set()
        print(f"live-proxy: browser {peer} disconnected", flush=True)


async def main():
    async with websockets.serve(handle, LISTEN_HOST, LISTEN_PORT, max_size=None):
        print(f"live-proxy: listening on ws://{LISTEN_HOST}:{LISTEN_PORT}",
              flush=True)
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    API_KEY = load_api_key()
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
