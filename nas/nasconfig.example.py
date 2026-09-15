# NAS-side secrets for the ingest/cleanup scripts.
# Copy to nasconfig.py (same directory) and fill in real values.
# nasconfig.py is gitignored — never commit it.

# TMDB API key: https://www.themoviedb.org/settings/api
TMDB_KEY = ""

# Kiosk endpoint that receives new-title notifications.
NOTIFY_URL = "http://KIOSK_IP/api/ingest-notify.php"
