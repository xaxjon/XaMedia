#!/usr/bin/env bash
# Provision XaMedia on a dedicated Linux Mint kiosk from a cloned repository.

set -Eeuo pipefail

APP_DIR=/var/www/entertainment
PHOTOS_DIR="${PHOTOS_DIR:-$APP_DIR/data/photos}"
NAS_IP="${NAS_IP:-192.168.10.227}"
NAS_EXPORT="${NAS_EXPORT:-/mnt/sdb1/library}"
SKIP_NAS="${SKIP_NAS:-0}"
AUTOLOGIN="${AUTOLOGIN:-1}"
KIOSK_USER="${KIOSK_USER:-${SUDO_USER:-}}"
KIOSK_OUTPUT="${KIOSK_OUTPUT:-}"
KIOSK_MODE="${KIOSK_MODE:-}"

log() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root: sudo deploy/install-kiosk.sh"
command -v apt-get >/dev/null 2>&1 || die "This installer requires an APT-based Linux distribution."
[[ "$KIOSK_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "Set KIOSK_USER to the kiosk login (or run through sudo)."
id "$KIOSK_USER" >/dev/null 2>&1 || die "User '$KIOSK_USER' does not exist."
[[ "$KIOSK_USER" != root ]] || die "The kiosk user must not be root."
[[ "$SKIP_NAS" =~ ^[01]$ ]] || die "SKIP_NAS must be 0 or 1."
[[ "$AUTOLOGIN" =~ ^[01]$ ]] || die "AUTOLOGIN must be 0 or 1."
[[ "$NAS_IP" =~ ^[A-Za-z0-9._-]+$ ]] || die "NAS_IP must be an IPv4 address or hostname."
[[ "$NAS_EXPORT" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "NAS_EXPORT must be an absolute path without spaces."
[[ "$PHOTOS_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "PHOTOS_DIR must be an absolute path without spaces."

KIOSK_HOME="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"
KIOSK_GROUP="$(id -gn "$KIOSK_USER")"
[[ -d "$KIOSK_HOME" ]] || die "Home directory for '$KIOSK_USER' does not exist."

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ -f "$SOURCE_DIR/public/index.php" && -f "$SOURCE_DIR/deploy/entertainment.conf" ]] \
    || die "Run this script from inside the XaMedia repository."

export DEBIAN_FRONTEND=noninteractive
packages=(
    apache2 php php-cli libapache2-mod-php php-curl php-gd php-mbstring
    vlc nfs-common ffmpeg unzip rsync curl ca-certificates git sudo
    python3 python3-tk python3-websocket python3-websockets
    onboard xdotool pulseaudio-utils x11-xserver-utils
)

log "Installing system packages"
apt-get update
apt-get install -y "${packages[@]}"

if ! command -v google-chrome >/dev/null 2>&1; then
    [[ "$(dpkg --print-architecture)" == amd64 ]] \
        || die "Google Chrome's official package requires an amd64 system."
    log "Installing Google Chrome"
    chrome_deb="$(mktemp /tmp/google-chrome.XXXXXX.deb)"
    trap 'rm -f -- "${chrome_deb:-}"' EXIT
    curl -fL --retry 3 \
        https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
        -o "$chrome_deb"
    apt-get install -y "$chrome_deb"
    rm -f -- "$chrome_deb"
    chrome_deb=
    trap - EXIT
fi

log "Installing the application in $APP_DIR"
if [[ "$SOURCE_DIR" != "$APP_DIR" ]]; then
    install -d -o root -g root -m 755 "$APP_DIR"
    rsync -a --chown=root:root \
        --exclude='config/config.php' --exclude='data/' \
        "$SOURCE_DIR/" "$APP_DIR/"
fi

install -d -o www-data -g www-data -m 775 \
    "$APP_DIR/data" "$APP_DIR/data/cache" "$APP_DIR/data/posters" \
    "$APP_DIR/data/assistant"
if [[ "$PHOTOS_DIR" == "$APP_DIR/data/photos" ]]; then
    install -d -o www-data -g www-data -m 775 \
        "$PHOTOS_DIR" "$PHOTOS_DIR/landscapes"
else
    install -d -o "$KIOSK_USER" -g "$KIOSK_GROUP" -m 755 "$(dirname "$PHOTOS_DIR")"
    install -d -o www-data -g www-data -m 775 "$PHOTOS_DIR" "$PHOTOS_DIR/landscapes"
fi
rsync -a "$APP_DIR/backgrounds/" "$PHOTOS_DIR/landscapes/"

if [[ ! -f "$APP_DIR/config/config.php" ]]; then
    install -o root -g www-data -m 640 \
        "$APP_DIR/config/config.example.php" "$APP_DIR/config/config.php"
    if [[ "$PHOTOS_DIR" != "$APP_DIR/data/photos" ]]; then
        sed -i "s|__DIR__ . '/../data/photos'|'$PHOTOS_DIR'|" \
            "$APP_DIR/config/config.php"
    fi
    if [[ "$SKIP_NAS" == 0 ]]; then
        sed -i "s|http://127.0.0.1:9001|http://$NAS_IP:9001|" \
            "$APP_DIR/config/config.php"
        sed -i "s|http://192.168.10.227|http://$NAS_IP|" \
            "$APP_DIR/config/config.php"
    fi
fi
chown root:www-data "$APP_DIR/config/config.php"
chmod 640 "$APP_DIR/config/config.php"
chown -R www-data:www-data "$APP_DIR/data"
chown -R www-data:www-data "$PHOTOS_DIR"
if [[ -f "$APP_DIR/data/settings.json" ]]; then
    chmod 660 "$APP_DIR/data/settings.json"
fi
# The browser and the login-user Live proxy both need read access to settings.
usermod -a -G www-data "$KIOSK_USER"

log "Installing kiosk wrappers"
wrappers=(
    kiosk-play kiosk-stream kiosk-browser-close kiosk-volume kiosk-osk
    kiosk-oskbd kiosk-vol kiosk-orb kiosk-photo-import
)
for name in "${wrappers[@]}"; do
    install -o root -g root -m 755 "$APP_DIR/deploy/$name" "/usr/local/bin/$name"
done
install -o root -g root -m 755 \
    "$APP_DIR/deploy/live-proxy.py" /usr/local/bin/kiosk-live-proxy

for name in kiosk-play kiosk-stream kiosk-volume kiosk-osk; do
    sed -i "s/^KIOSK_USER=user$/KIOSK_USER=$KIOSK_USER/" "/usr/local/bin/$name"
done
if [[ "$PHOTOS_DIR" != "$APP_DIR/data/photos" ]]; then
    sed -i "s|/var/www/entertainment/data/photos|$PHOTOS_DIR|g" \
        /usr/local/bin/kiosk-photo-import
fi
sed -i 's|XAUTHORITY=/home/user/.Xauthority|XAUTHORITY=$HOME/.Xauthority|' \
    /usr/local/bin/kiosk-osk

for name in browse.php osk.php play-local.php stream.php volume.php; do
    sed -i "s/sudo -n -u user /sudo -n -u $KIOSK_USER /g" \
        "$APP_DIR/public/api/$name"
done
if [[ "$SKIP_NAS" == 0 ]]; then
    sed -i "s|http://192\.168\.10\.227/index\.html|http://$NAS_IP/index.html|" \
        "$APP_DIR/public/api/stream.php"
fi

log "Installing constrained sudoers rules"
install -o root -g root -m 440 \
    "$APP_DIR/deploy/kiosk-vlc.sudoers" /etc/sudoers.d/kiosk-vlc
install -o root -g root -m 440 \
    "$APP_DIR/deploy/kiosk-assistant.sudoers" /etc/sudoers.d/kiosk-assistant
install -o root -g root -m 440 \
    "$APP_DIR/deploy/kiosk-photo-import.sudoers" /etc/sudoers.d/kiosk-photo-import
sed -i "s/(user)/($KIOSK_USER)/g" \
    /etc/sudoers.d/kiosk-vlc /etc/sudoers.d/kiosk-assistant

cat > /etc/sudoers.d/kiosk-stream <<EOF
www-data ALL=($KIOSK_USER) NOPASSWD: /usr/local/bin/kiosk-stream
EOF
cat > /etc/sudoers.d/kiosk-osk <<EOF
www-data ALL=($KIOSK_USER) NOPASSWD: /usr/local/bin/kiosk-osk
EOF
cat > /etc/sudoers.d/kiosk-power <<'EOF'
www-data ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff
EOF
chown root:root /etc/sudoers.d/kiosk-stream /etc/sudoers.d/kiosk-osk \
    /etc/sudoers.d/kiosk-power
chmod 440 /etc/sudoers.d/kiosk-stream /etc/sudoers.d/kiosk-osk \
    /etc/sudoers.d/kiosk-power
visudo -c

log "Configuring the NAS mount"
install -d -o root -g root -m 755 /mnt/library
if [[ "$SKIP_NAS" == 0 ]]; then
    [[ -f /etc/fstab.xamedia.pre-install ]] \
        || cp -a /etc/fstab /etc/fstab.xamedia.pre-install
    python3 - "$NAS_IP" "$NAS_EXPORT" <<'PY'
from pathlib import Path
import sys

path = Path('/etc/fstab')
lines = path.read_text().splitlines(keepends=True)
kept = []
for line in lines:
    fields = line.split()
    if line.strip() == '# XaMedia NAS library':
        continue
    if fields and not fields[0].startswith('#') and len(fields) > 1 and fields[1] == '/mnt/library':
        continue
    kept.append(line)

nas_ip, nas_export = sys.argv[1:]
entry = (
    f'{nas_ip}:{nas_export} /mnt/library nfs '
    'ro,rsize=1048576,wsize=1048576,actimeo=60,_netdev,'
    'x-systemd.automount,x-systemd.idle-timeout=600 0 0\n'
)
text = ''.join(kept).rstrip()
path.write_text(text + '\n\n# XaMedia NAS library\n' + entry)
PY
    systemctl daemon-reload
    if ! mountpoint -q /mnt/library && ! timeout 20 mount /mnt/library; then
        warn "The NAS could not be mounted now; systemd will retry on demand."
    fi
fi

log "Configuring Apache"
install -o root -g root -m 644 \
    "$APP_DIR/deploy/entertainment.conf" /etc/apache2/sites-available/entertainment.conf
a2enmod alias >/dev/null
a2ensite entertainment >/dev/null
if a2query -s 000-default >/dev/null 2>&1; then
    a2dissite 000-default >/dev/null
fi
apache2ctl configtest
systemctl enable apache2
systemctl restart apache2

log "Configuring kiosk autostart"
if [[ -z "$KIOSK_OUTPUT" || -z "$KIOSK_MODE" ]]; then
    xrandr_query="$(runuser -u "$KIOSK_USER" -- env DISPLAY=:0 \
        XAUTHORITY="$KIOSK_HOME/.Xauthority" xrandr --query 2>/dev/null || true)"
fi
if [[ -z "$KIOSK_OUTPUT" ]]; then
    KIOSK_OUTPUT="$(awk '$2 == "connected" && $3 == "primary" { print $1; exit }' \
        <<< "$xrandr_query")"
fi
if [[ -z "$KIOSK_OUTPUT" ]]; then
    KIOSK_OUTPUT="$(awk '$2 == "connected" { print $1; exit }' <<< "$xrandr_query")"
fi
if [[ -z "$KIOSK_MODE" ]]; then
    KIOSK_MODE="$(awk '/\*/ { print $1; exit }' <<< "$xrandr_query")"
fi
KIOSK_OUTPUT="${KIOSK_OUTPUT:-eDP-1}"
KIOSK_MODE="${KIOSK_MODE:-1920x1080}"
[[ "$KIOSK_OUTPUT" =~ ^[A-Za-z0-9._+-]+$ ]] || die "Invalid KIOSK_OUTPUT."
[[ "$KIOSK_MODE" =~ ^[0-9]+x[0-9]+$ ]] || die "KIOSK_MODE must look like 1920x1080."

autostart_dir="$KIOSK_HOME/.config/autostart"
install -d -o "$KIOSK_USER" -g "$KIOSK_GROUP" -m 755 \
    "$KIOSK_HOME/.config" "$autostart_dir"
desktop_files=(
    entertainment-kiosk.desktop kiosk-live-proxy.desktop kiosk-orb.desktop
    kiosk-oskbd.desktop kiosk-vol.desktop
)
for name in "${desktop_files[@]}"; do
    install -o "$KIOSK_USER" -g "$KIOSK_GROUP" -m 644 \
        "$APP_DIR/deploy/$name" "$autostart_dir/$name"
done
sed -i "s/--output eDP-1/--output $KIOSK_OUTPUT/; s/1920x1080/$KIOSK_MODE/g" \
    "$autostart_dir/entertainment-kiosk.desktop"

if [[ "$AUTOLOGIN" == 1 && -d /etc/lightdm ]]; then
    install -d -o root -g root -m 755 /etc/lightdm/lightdm.conf.d
    cat > /etc/lightdm/lightdm.conf.d/90-xamedia-autologin.conf <<EOF
[Seat:*]
autologin-user=$KIOSK_USER
autologin-user-timeout=0
EOF
    chown root:root /etc/lightdm/lightdm.conf.d/90-xamedia-autologin.conf
    chmod 644 /etc/lightdm/lightdm.conf.d/90-xamedia-autologin.conf
fi

log "Running local smoke checks"
http_ok=0
for _ in {1..10}; do
    if curl -fsS --max-time 3 http://127.0.0.1/ \
        | grep -q '<title>Home Entertainment</title>'; then
        http_ok=1
        break
    fi
    sleep 1
done
[[ "$http_ok" == 1 ]] || die "Apache did not serve the XaMedia home page."
photo_count="$(curl -fsS --max-time 10 http://127.0.0.1/api/photos.php \
    | php -r '$p = json_decode(stream_get_contents(STDIN), true); echo is_array($p) ? count($p) : 0;')"
[[ "$photo_count" =~ ^[0-9]+$ && "$photo_count" -gt 0 ]] \
    || die "The photo API did not return the curated slideshow."

cat <<EOF

XaMedia is installed for '$KIOSK_USER'.
Home page: http://localhost/  ($photo_count curated photos available)

Remaining personal setup:
  1. Open Settings (default PIN: 1234), change the PIN, and set the location/API keys.
  2. Reboot to start the kiosk session and apply group/autologin changes.
  3. Import personal photos through Settings > Photos, or copy them into
     $PHOTOS_DIR/ and run: chown -R www-data:www-data $PHOTOS_DIR
  4. Sign into streaming services on first use.
EOF
if [[ "$SKIP_NAS" == 1 ]]; then
    printf 'NAS setup was skipped (SKIP_NAS=1).\n'
else
    printf 'NAS source: %s:%s -> /mnt/library\n' "$NAS_IP" "$NAS_EXPORT"
fi
