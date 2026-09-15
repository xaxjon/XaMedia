#!/usr/bin/env python3
"""Fetch TMDB posters for the clean library tree. Resumable: skips existing
poster.jpg, caches all API responses in tmdb_cache.json."""
import json, os, sys, time, urllib.parse, urllib.request

from nasconfig import TMDB_KEY as KEY
BASE = "/mnt/sdb1/library"
CLEANUP = "/home/nas/cleanup"
PROPOSAL = os.path.join(CLEANUP, "proposal.json")
CACHE_PATH = os.path.join(CLEANUP, "tmdb_cache.json")
NO_POSTER = os.path.join(CLEANUP, "no_poster.txt")

with open(CACHE_PATH) as f:
    cache = json.load(f)
cache_dirty = 0

last_api = 0.0
last_img = 0.0

def rl_api():
    global last_api
    wait = 0.34 - (time.time() - last_api)
    if wait > 0:
        time.sleep(wait)
    last_api = time.time()

def rl_img():
    global last_img
    wait = 0.21 - (time.time() - last_img)
    if wait > 0:
        time.sleep(wait)
    last_img = time.time()

def save_cache():
    global cache_dirty
    tmp = CACHE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cache, f, indent=1)
    os.replace(tmp, CACHE_PATH)
    cache_dirty = 0

def api_get(url, cache_key):
    """Return parsed JSON, using/updating cache."""
    global cache_dirty
    if cache_key in cache:
        return cache[cache_key]
    rl_api()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "cleanup-poster/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
    except Exception as e:
        print(f"  API ERROR {url}: {e}", flush=True)
        return None
    cache[cache_key] = data
    cache_dirty += 1
    if cache_dirty >= 25:
        save_cache()
    return data

def download(url, dest):
    rl_img()
    tmp = dest + ".tmp"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "cleanup-poster/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
            while True:
                chunk = r.read(65536)
                if not chunk:
                    break
                f.write(chunk)
        os.replace(tmp, dest)
        return True
    except Exception as e:
        print(f"  IMG ERROR {url}: {e}", flush=True)
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False

no_poster = []
stats = {"fetched": 0, "present": 0, "failed": 0, "null_poster": 0}

# ---- Movies ----
with open(PROPOSAL) as f:
    proposal = json.load(f)

seen_dirs = set()
movie_dirs = []  # (dir_relpath, tmdb_id)
for e in proposal:
    if e.get("category") != "movie":
        continue
    if not e.get("tmdb_id") or e.get("dup_of") is not None:
        continue
    d = os.path.dirname(e["dest_relpath"])
    if d in seen_dirs:
        continue
    seen_dirs.add(d)
    movie_dirs.append((d, e["tmdb_id"]))

print(f"Movie dirs to consider: {len(movie_dirs)}", flush=True)

for i, (drel, tid) in enumerate(movie_dirs, 1):
    dabs = os.path.join(BASE, drel)
    poster = os.path.join(dabs, "poster.jpg")
    if os.path.exists(poster):
        stats["present"] += 1
        continue
    if not os.path.isdir(dabs):
        print(f"  MISSING DIR {drel}", flush=True)
        stats["failed"] += 1
        no_poster.append(drel)
        continue
    data = api_get(
        f"https://api.themoviedb.org/3/movie/{tid}?api_key={KEY}",
        f"detail/movie/{tid}",
    )
    if data is None:
        stats["failed"] += 1
        no_poster.append(drel)
        continue
    pp = data.get("poster_path")
    if not pp:
        print(f"  NULL poster_path: {drel} (tmdb {tid})", flush=True)
        stats["null_poster"] += 1
        no_poster.append(drel)
        continue
    if download(f"https://image.tmdb.org/t/p/w500{pp}", poster):
        stats["fetched"] += 1
    else:
        stats["failed"] += 1
        no_poster.append(drel)
    if i % 100 == 0:
        print(f"  movies {i}/{len(movie_dirs)} fetched={stats['fetched']}", flush=True)

save_cache()

# ---- TV series ----
tv_root = os.path.join(BASE, "TV")
series_dirs = sorted(
    d for d in os.listdir(tv_root) if os.path.isdir(os.path.join(tv_root, d))
)
tv_stats = {"fetched": 0, "present": 0, "failed": 0}
print(f"Series dirs: {len(series_dirs)}", flush=True)

for name in series_dirs:
    poster = os.path.join(tv_root, name, "poster.jpg")
    if os.path.exists(poster):
        tv_stats["present"] += 1
        continue
    q = urllib.parse.quote(name)
    data = api_get(
        f"https://api.themoviedb.org/3/search/tv?api_key={KEY}&query={q}",
        f"search/tv/{name}",
    )
    results = (data or {}).get("results") or []
    best = None
    for r in results:
        if r.get("name", "").lower() == name.lower():
            best = r
            break
    if best is None and results:
        best = results[0]
    pp = best.get("poster_path") if best else None
    if not pp:
        print(f"  TV no poster: {name} (results={len(results)})", flush=True)
        tv_stats["failed"] += 1
        no_poster.append(f"TV/{name}")
        continue
    if download(f"https://image.tmdb.org/t/p/w500{pp}", poster):
        tv_stats["fetched"] += 1
    else:
        tv_stats["failed"] += 1
        no_poster.append(f"TV/{name}")

save_cache()

with open(NO_POSTER, "w") as f:
    for d in no_poster:
        f.write(d + "\n")

print("MOVIES: " + json.dumps(stats), flush=True)
print("TV: " + json.dumps(tv_stats), flush=True)
print(f"NO POSTER ({len(no_poster)}):", flush=True)
for d in no_poster:
    print("  " + d, flush=True)
print("DONE", flush=True)
