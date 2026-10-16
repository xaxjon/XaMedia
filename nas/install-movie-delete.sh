#!/usr/bin/env bash
# Install the constrained NAS-side movie-title purge endpoint and worker.

set -Eeuo pipefail

KIOSK_IP="${KIOSK_IP:-192.168.10.144}"
NAS_USER="${NAS_USER:-nas}"
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENDPOINT=/var/www/html/api/xamedia-movie-delete.php
WORKER=/usr/local/bin/xamedia-movie-delete
SUDOERS=/etc/sudoers.d/xamedia-movie-delete

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root: sudo nas/install-movie-delete.sh"
[[ "$KIOSK_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "KIOSK_IP must be an IPv4 address."
[[ "$NAS_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "Invalid NAS_USER."
id "$NAS_USER" >/dev/null 2>&1 || die "User '$NAS_USER' does not exist."
[[ "$NAS_USER" != root ]] || die "NAS_USER must not be root."
[[ -f "$SOURCE_DIR/nas/movie-delete.php" && -f "$SOURCE_DIR/nas/movie-delete.py" ]] \
    || die "Run this script from inside the XaMedia repository."
command -v apache2ctl >/dev/null 2>&1 || die "Apache is not installed."
command -v visudo >/dev/null 2>&1 || die "sudo/visudo is not installed."

install -d -o www-data -g www-data -m 2775 /var/www/html/api
install -o www-data -g www-data -m 644 \
    "$SOURCE_DIR/nas/movie-delete.php" "$ENDPOINT"
sed -i "s/sudo -n -u nas /sudo -n -u $NAS_USER /" "$ENDPOINT"

install -d -o root -g www-data -m 750 /etc/xamedia
python3 - "$KIOSK_IP" <<'PY'
from pathlib import Path
import json
import sys

path = Path('/etc/xamedia/movie-delete-clients.json')
try:
    clients = json.loads(path.read_text()) if path.exists() else []
except (OSError, ValueError):
    clients = []
if not isinstance(clients, list):
    clients = []
client = sys.argv[1]
if client not in clients:
    clients.append(client)
tmp = path.with_suffix('.tmp')
tmp.write_text(json.dumps(clients, indent=2) + '\n')
tmp.replace(path)
PY
chown root:www-data /etc/xamedia/movie-delete-clients.json
chmod 640 /etc/xamedia/movie-delete-clients.json

install -o root -g root -m 755 "$SOURCE_DIR/nas/movie-delete.py" "$WORKER"
install -o root -g root -m 440 "$SOURCE_DIR/nas/movie-delete.sudoers" "$SUDOERS"
sed -i "s/(nas)/($NAS_USER)/" "$SUDOERS"
visudo -c
apache2ctl configtest

cat <<EOF
Movie purge endpoint installed.
Kiosk allowed at: $KIOSK_IP
Worker runs as:   $NAS_USER
No library directory was touched by this installer.
EOF
