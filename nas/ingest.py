#!/usr/bin/env python3
"""Fully-automatic ingest watcher for /mnt/sdb1 dump.

Every cron run:
  - scan top level of /mnt/sdb1 for entries not in the seen-set
  - skip unsettled candidates (anything modified in the last SETTLE_S seconds)
  - classify (movie/tv/music/personal/unknown) with the audit parser + aliases
  - hardlink into /mnt/sdb1/library/** (originals stay in the dump)
  - fetch posters for TMDB-matched movies / new TV series
  - skip duplicates (title+year already in library) -> logged as "dup"
  - POST ingest-notify to the kiosk if anything was filed
Writes only under /mnt/sdb1/library and /home/nas/cleanup.
"""
import fcntl, json, os, re, sys, time, urllib.parse, urllib.request

ROOT = "/mnt/sdb1"
LIB = "/mnt/sdb1/library"
BASE = "/home/nas/cleanup"
SEEN_PATH = os.path.join(BASE, "ingest_seen.json")
LOCK_PATH = os.path.join(BASE, "ingest.lock")
CACHE_PATH = os.path.join(BASE, "tmdb_cache.json")
MAP_PATH = os.path.join(BASE, "tmdb_map.json")
from nasconfig import NOTIFY_URL
from nasconfig import TMDB_KEY
SETTLE_S = 600
EXCLUDE = {"library", "lost+found", ".Trash-1000", "movies"}

VIDEO_EXT = {".mp4", ".m4v", ".avi", ".mkv", ".vob", ".mpg", ".mpeg", ".wmv",
             ".divx", ".ogm", ".flv", ".mov", ".ts", ".m2ts", ".rmvb"}
SIDECAR_OK = {".srt", ".nfo"}

def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)

# ---------------- parser (same rules as the audit) ----------------
YEAR_RE = re.compile(r'(19[2-9]\d|20[0-2]\d)')
CUT_RE = re.compile(r'''(?ix)\b(
    480p|576p|720p|1080p|2160p|4320p|uhd|hdr|hdrip|hd-rip|hdtv|hdts|
    bluray|blu-ray|brrip|brip|bdrip|bdremux|bd-rip|dvdrip|dvd-rip|dvdscr|dvd|dvdr|dvd5|dvd9|r6|r5|
    webrip|web-rip|web-dl|webdl|telesync|telecine|tc|cam|camrip|screener|pdtv|hmax|amzn|atvp|
    x264|x265|h264|h\.264|h265|h\.265|hevc|xvid|divx|avc|vc-?1|
    aac2?\.?0?|ac3|eac3|dd5\.?1|ddp5?\.?1|dd\+5\.?1|dts|truehd|atmos|flac|
    10bit|10-bit|8bit|6ch|2ch|5\.1ch|dual[ .-]?audio|multi[ .-]?audio|
    uncut|unrated|extended|repack|proper|internal|limited|remastered|imax|incl|
    nlsubs?|swesub|engsub|esub|subbed|dubbed|deu|axxo|
    pal|ntsc|letterbox|complete|readnfo|retail|dc|
    yify|yts|etrg|evo|rarbg|galaxyrg|galaxytv|tgx|ettv|eztv|prime|
    anoxmous|mkvcage|sparks|jyk|cm8|killers|fum|playnow|resistance|target|diamond|nft|
    spooks|elite|neonoir|asiimov|splice|vppv|millenium|vicky|atlas|ganool|3lt0n|
    justice|dose|menaceiisociety|ion10|juggs|fxg|cnd|repopo|nickarad|bonsaihd|
    iextv|geekrg|scorp|sujaidr|hive|digital|offline|swaxxon|wrd|exvidint|2lt|coo7|jbr|
    pimp4003|dmk|jaybob|mobix|fov|minx|msd|xlf|tbs|phoenix|casstudio|me7alh|ggwp|glhf|
    ggez|silence|feranki1980|blackjesus|handjob|shaanig|arrows|hellraz0r|drt|extramina
    )\b''')
NUM_TAG_RE = re.compile(r'^\(?\d{1,2}\)?$')
MB_RE = re.compile(r'(?i)\b\d{3,4}\s?mb\b')
SXXEYY_RE = re.compile(r'(?i)\bs(\d{1,2})[ ._-]?e(\d{1,3})\b')
BRACKET_RE = re.compile(r'[\[\(\{]([^\[\]\(\)\{\}]*)[\]\)\}]')

def clean_stem(name):
    return re.sub(r'\.(mp4|m4v|avi|mkv|vob|mpg|mpeg|wmv|divx|ogm|flv|mov|ts)$', '', name, flags=re.I)

def norm(s):
    s = s.lower()
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    s = re.sub(r'^the ', '', s)
    return s.strip()

def key_of(s):
    k = re.sub(r'[^a-z0-9]', '', (s or '').lower())
    return re.sub(r'^the', '', k)

def split_brackets(s):
    return BRACKET_RE.findall(s), BRACKET_RE.sub(' ', s)

def parse(name, dir_hint=None):
    stem = clean_stem(name)
    stem = re.sub(r'(?i)^\s*\[\s*www\.[^\]]+\]\s*-?\s*', '', stem)
    stem = re.sub(r'(?i)\bwww\.[a-z0-9-]+\.(?:com|in|net|org|to|ws)\b\.?\s*', ' ', stem)
    if re.search(r'(?i)(dupedb|xscr|exvid|wrd-)', stem) and dir_hint:
        p = parse(dir_hint, None)
        p["_from_dir"] = True
        return p
    res = None
    m = re.search(r'(?i)\b(480p|576p|720p|1080p|2160p|4320p)\b', stem)
    if m: res = m.group(1).lower()
    season = episode = None
    m = SXXEYY_RE.search(stem)
    if m:
        season, episode = int(m.group(1)), int(m.group(2))
    brackets, nobr = split_brackets(stem)
    year = None
    kept_paren = []
    for b in brackets:
        bs = b.strip()
        if re.fullmatch(r'(19[2-9]\d|20[0-2]\d)', bs):
            year = year or int(bs)
        elif NUM_TAG_RE.fullmatch(bs):
            pass
        elif CUT_RE.search(bs) or re.search(r'(?i)\b(yts|yify|tgx|ettv|eztv|hd|blu-?ray|web-?rip|prime|dsp|themuppetarchive|engsub|eng|h264|5\.1|bbc|criterion|etmovies|etrg|evo|rarbg|ion10|repopo|sn)\b', bs):
            pass
        elif re.search(r'[A-Za-z]', bs):
            kept_paren.append(bs)
    text = re.sub(r'[._\[\]\{\}\(\)]', ' ', nobr)
    tokens = text.split()
    cut = len(tokens)
    for i, t in enumerate(tokens):
        if i >= 1 and re.fullmatch(YEAR_RE, t):
            year = year or int(t); cut = i; break
        if i >= 1 and (CUT_RE.fullmatch(t) or MB_RE.fullmatch(t)):
            cut = i; break
        if i >= 1 and '-' in t and any(CUT_RE.fullmatch(pp) for pp in t.split('-')):
            cut = i; break
    title = ' '.join(tokens[:cut])
    title = re.sub(r'\s+-\s+\S+$', '', title)
    part = None
    pm = re.search(r'(?i)\b(cd|disc|disk|part|pt|dvd|side)\s*\.?\s*([1-9ab])\s*$', title)
    if pm:
        part = pm.group(0).strip().lower()
    title = re.sub(r'\s+', ' ', title).strip(' -.,')
    for kp in kept_paren:
        if kp.lower() not in title.lower() and not YEAR_RE.search(kp):
            title += f" ({kp})"
    m = re.match(r'(?i)^(.*\S)\s+(the|a|an)$', title)
    if m:
        title = f"{m.group(2).title()} {m.group(1)}"
    if year is None:
        ym = YEAR_RE.search(stem)
        if ym and not re.fullmatch(r'\d{4}', title or ''):
            year = int(ym.group(1))
    generic = (not re.search(r'[a-zA-Z]{3}', title)) or \
              re.fullmatch(r'(?i)[.\s]*(vts|video|sample)[\s\d]*', title or '') is not None
    if generic and dir_hint:
        p = parse(dir_hint, None)
        p["_from_dir"] = True
        p["season"], p["episode"] = season, episode
        return p
    return {"title": title, "year": year, "season": season, "episode": episode,
            "part": part, "res": res}

PART_TAG_RE = re.compile(r'(?i)\s*\b(?:cd|disc|disk|part|pt|dvd|side\s?[ab]|sidea|sideb|0[12])\s*\.?\s*[1-9ab]?\s*$')
def strip_part(t):
    return PART_TAG_RE.sub('', t or '').strip()

def titlecase(s):
    small = {'a','an','the','and','or','but','of','on','in','at','to','for','with','from','by','vs','de','la','el','y'}
    out = []
    words = s.split()
    for i, w in enumerate(words):
        if w.lower() in small and i not in (0, len(words)-1):
            out.append(w.lower())
        else:
            out.append(w[:1].upper() + w[1:])
    return ' '.join(out)

_raw_alias = json.load(open(os.path.join(BASE, "aliases.json")))
ALIAS = {norm(k): v for k, v in _raw_alias.items()}

def _rx(pat, n):
    return re.search(pat, n)

TV_RULES = [
    (r'black\s?adder\s*(?:ii|2)\s*(\d)', lambda n: ("Blackadder", 2, int(_rx(r'black\s?adder\s*(?:ii|2)\s*(\d)', n).group(1)), None)),
    (r'black\s?adder\s*4\s*(\d)?', lambda n: ("Blackadder", 4, int(_rx(r'black\s?adder\s*4\s*(\d)', n).group(1)) if _rx(r'black\s?adder\s*4\s*(\d)', n) and _rx(r'black\s?adder\s*4\s*(\d)', n).group(1) else 1, None)),
    (r'blackadder\s*1\s*(\d)?', lambda n: ("Blackadder", 1, int(_rx(r'blackadder\s*1\s*(\d)', n).group(1)) if _rx(r'blackadder\s*1\s*(\d)', n) and _rx(r'blackadder\s*1\s*(\d)', n).group(1) else 1, None)),
    (r'fawlty towers prop\s*(\d)\s*disc\s*(\d)', lambda n: ("Fawlty Towers", 1, (int(_rx(r'prop\s*(\d)', n).group(1))-1)*2 + int(_rx(r'disc\s*(\d)', n).group(1)), "PropN/DiscM mapped to episode number")),
    (r'dads army\s*(\d)', lambda n: ("Dad's Army", 1, int(_rx(r'dads army\s*(\d)', n).group(1)), "season inferred")),
    (r'ripping yarns\s*(\d)\s*(\d)?', lambda n: ("Ripping Yarns", int(_rx(r'ripping yarns\s*(\d)', n).group(1)), int(_rx(r'ripping yarns\s*\d\s*(\d)', n).group(1)) if _rx(r'ripping yarns\s*\d\s*(\d)', n) else 1, None)),
    (r'mujeres asesinas\s*(\d+)', lambda n: ("Mujeres Asesinas", 1, int(_rx(r'mujeres asesinas\s*(\d+)', n).group(1)), "season inferred")),
    (r'foundation', lambda n: ("Foundation", None, None, None)),
    (r'south\s?park(?!.*post\s?covid)', lambda n: ("South Park", None, None, None)),
    (r'star\s?trek\s?picard|^picard', lambda n: ("Star Trek: Picard", None, None, None)),
    (r'muppet show', lambda n: ("The Muppet Show", None, None, None)),
    (r'house of cards', lambda n: ("House of Cards (UK)", None, None, None)),
    (r'box of delights', lambda n: ("The Box of Delights", None, None, None)),
    (r'langoliers', lambda n: ("The Langoliers", 1, 1, "miniseries, single file")),
    (r'childhoods?\s?end', lambda n: ("Childhood's End", 1, int(_rx(r'part\s*(\d)', n).group(1)) if _rx(r'part\s*(\d)', n) else None, "miniseries part")),
    (r'top gear.*patagonia part one', lambda n: ("Top Gear", 0, 1, "Patagonia special part 1")),
    (r'top gear.*patagonia part two', lambda n: ("Top Gear", 0, 2, "Patagonia special part 2")),
    (r'mr bates vs the post office', lambda n: ("Mr Bates vs The Post Office", None, None, None)),
    (r'the reckoning 2023', lambda n: ("The Reckoning", None, None, None)),
    (r'our flag means death', lambda n: ("Our Flag Means Death", None, None, None)),
    (r'frozen\s?planet', lambda n: ("Frozen Planet", None, None, None)),
    (r'sherlock.*abominable bride', lambda n: ("Sherlock", 0, 1, "The Abominable Bride special")),
    (r'saturday night live 40th', lambda n: ("Saturday Night Live", 40, 0, "40th Anniversary Special")),
    (r'^longitude', lambda n: ("Longitude", 1, 1, "miniseries; only part 1 present")),
    (r'^tinktail\s*(\d)', lambda n: ("Tinker Tailor Soldier Spy", 1, int(_rx(r'tinktail\s*(\d)', n).group(1)), "cryptic filename; part number used as episode")),
    (r'day of the triffids.*disc\s*(\d)\s*of\s*3', lambda n: ("The Day of the Triffids", 1, int(_rx(r'disc\s*(\d)\s*of\s*3', n).group(1)), "BBC 1981; disc number used as episode")),
    (r'^triffids d1\s*(\d)?', lambda n: ("The Day of the Triffids", 1, int(_rx(r'triffids d1\s*(\d)', n).group(1)) if _rx(r'triffids d1\s*(\d)', n) else 1, "cryptic filename; disc/ep inferred")),
    (r'sea wolf\s*(\d)', lambda n: ("The Sea Wolf", 1, int(_rx(r'sea wolf\s*(\d)', n).group(1)), "ambiguous: miniseries episodes or 2-part film")),
    (r'not9oclock', lambda n: ("Not the Nine O'Clock News", 1, None, "cryptic filename")),
]

MUSIC = {
    "beethoven9": "Beethoven - Symphony No. 9",
    "tosca": "Puccini - Tosca",
    "swan lake": "Tchaikovsky - Swan Lake",
    "rheingold": "Wagner - Das Rheingold",
    "carmina burana1": "Orff - Carmina Burana",
    "der rosenkavalier": "R. Strauss - Der Rosenkavalier",
    "meistersinger 1": "Wagner - Die Meistersinger (part 1)",
    "meistersinger 2": "Wagner - Die Meistersinger (part 2)",
    "roger waters": "Roger Waters (concert)",
    "daveallen": "Dave Allen (comedy performance)",
    "war requiem": "Britten - War Requiem",
    "mahler": "Mahler (classical)",
    "verdi requiem": "Verdi - Requiem",
    "bizets carmen": "Bizet - Carmen",
    "dgg nabucco main feature": "Verdi - Nabucco",
    "faust dvd1 ntsc main feature": "Gounod - Faust (part 1)",
    "faust dvd2 ntsc main feature": "Gounod - Faust (part 2)",
    "faust roh": "Gounod - Faust (Royal Opera House)",
    "emi triple concerto": "Beethoven - Triple Concerto (EMI)",
    "tannhauser": "Wagner - Tannhäuser",
    "mdm butrfly": "Puccini - Madama Butterfly",
    "the cunning little vixen": "Janáček - The Cunning Little Vixen",
    "sbrightman": "Sarah Brightman (concert)",
    "pinkflpom": "Pink Floyd - Live at Pompeii (concert film)",
}
PERSONAL = {
    "palo s wedding": "Palo's Wedding",
    "daddys flight": "Daddy's Flight",
    "isle of man": "Isle of Man (home video)",
    "aroundcapehorn": "Around Cape Horn (home video)",
}
UNKNOWN_JUNK = {"cartoon", "nm78", "rrunknown", "360"}

def classify(name, dir_hint, parsed):
    n = norm(clean_stem(name))
    nd = norm(dir_hint or "")
    for k, v in PERSONAL.items():
        if n == k:
            return ("personal", {"title": v})
    if n in UNKNOWN_JUNK:
        return ("unknown", {"title": clean_stem(name)})
    for k, v in MUSIC.items():
        if n == norm(k):
            return ("music", {"title": v})
    for pat, fn in TV_RULES:
        if re.search(pat, n):
            r = fn(n)
            if r:
                series, s, e, note = r
                if s is None and parsed.get("season") is not None:
                    s, e = parsed["season"], parsed["episode"]
                if s is None:
                    s = 0 if re.search(r'(?i)docu|real story|reunion|featurette', n) else 1
                if e is None:
                    tm = re.search(r'(\d{1,2})\s*$', n)
                    if tm and int(tm.group(1)) < 40:
                        e = int(tm.group(1))
                return ("tv", {"series": series, "season": s, "episode": e, "note": note})
    if parsed.get("season") is not None and nd:
        for pat, fn in TV_RULES:
            if re.search(pat, nd):
                series, s, e, note = fn(nd)
                return ("tv", {"series": series, "season": parsed["season"],
                               "episode": parsed["episode"], "note": note})
    if nd:
        for pat, fn in TV_RULES:
            if re.search(pat, nd):
                series, s, e, note = fn(nd)
                toks = [w for w in norm(series).split()[:3] if len(w) > 2]
                if toks and all(w in n for w in toks[:2]):
                    if s is None and parsed.get("season") is not None:
                        s, e = parsed["season"], parsed["episode"]
                    return ("tv", {"series": series, "season": s if s is not None else 0,
                                   "episode": e, "note": (note or "classified via parent directory")})
    if parsed.get("season") is not None:
        return ("tv", {"series": parsed["title"], "season": parsed["season"],
                       "episode": parsed["episode"], "note": "generic SxxEyy parse"})
    return ("movie", {})

# ---------------- TMDB (cached, rate-limited, atomic) ----------------
cache = json.load(open(CACHE_PATH))
cache_dirty = 0
last_api = 0.0
last_img = 0.0

def rl_api():
    global last_api
    w = 0.34 - (time.time() - last_api)
    if w > 0: time.sleep(w)
    last_api = time.time()

def rl_img():
    global last_img
    w = 0.21 - (time.time() - last_img)
    if w > 0: time.sleep(w)
    last_img = time.time()

def save_cache():
    global cache_dirty
    tmp = CACHE_PATH + ".tmp"
    json.dump(cache, open(tmp, "w"), indent=1)
    os.replace(tmp, CACHE_PATH)
    cache_dirty = 0

def api_get(url, ckey):
    global cache_dirty
    if ckey in cache:
        return cache[ckey]
    rl_api()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "nas-ingest/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode())
    except Exception as e:
        log(f"  TMDB API error: {e}")
        return None
    cache[ckey] = data
    cache_dirty += 1
    if cache_dirty >= 10:
        save_cache()
    return data

def tmdb_search_movie(title, year):
    q = {"api_key": TMDB_KEY, "query": title}
    if year: q["year"] = str(year)
    url = "https://api.themoviedb.org/3/search/movie?" + urllib.parse.urlencode(q)
    return api_get(url, f"{title}|{year}")

def resolve_movie(qt, qy):
    """Return dict(id,title,year,confidence) or None."""
    res = tmdb_search_movie(qt, qy)
    results = (res or {}).get("results") or []
    chosen, conf = None, "low"
    for r in results:
        ry = int(r["release_date"][:4]) if r.get("release_date") else None
        if (key_of(r.get("title") or "") == key_of(qt) or key_of(r.get("original_title") or "") == key_of(qt)) and qy and ry == qy:
            chosen, conf = r, "high"; break
    if not chosen:
        for r in results:
            if key_of(r.get("title") or "") == key_of(qt) or key_of(r.get("original_title") or "") == key_of(qt):
                chosen, conf = r, "medium"; break
    if not chosen and qy:
        for r in results:
            ry = int(r["release_date"][:4]) if r.get("release_date") else None
            if ry == qy:
                chosen, conf = r, "medium"; break
    if not chosen and qy:
        res2 = tmdb_search_movie(qt, None)
        results = (res2 or {}).get("results") or []
        for r in results:
            if key_of(r.get("title") or "") == key_of(qt) or key_of(r.get("original_title") or "") == key_of(qt):
                chosen, conf = r, "medium"; break
    if not chosen:
        return None
    ry = chosen["release_date"][:4] if chosen.get("release_date") else None
    return {"id": chosen["id"], "title": chosen["title"],
            "year": int(ry) if ry else qy, "confidence": conf}

def fetch_movie_poster(tid, dest_dir):
    poster = os.path.join(dest_dir, "poster.jpg")
    if os.path.exists(poster):
        return True
    data = api_get(f"https://api.themoviedb.org/3/movie/{tid}?api_key={TMDB_KEY}",
                   f"detail/movie/{tid}")
    pp = (data or {}).get("poster_path")
    if not pp:
        log(f"  no poster_path for tmdb {tid}")
        return False
    return download(f"https://image.tmdb.org/t/p/w500{pp}", poster)

def movie_genres(tid):
    # Cache-hit after fetch_movie_poster: same detail document.
    data = api_get(f"https://api.themoviedb.org/3/movie/{tid}?api_key={TMDB_KEY}",
                   f"detail/movie/{tid}")
    return [g["name"] for g in (data or {}).get("genres", []) if g.get("name")]

def fetch_series_poster(series, dest_dir):
    poster = os.path.join(dest_dir, "poster.jpg")
    if os.path.exists(poster):
        return True
    q = urllib.parse.quote(series)
    data = api_get(f"https://api.themoviedb.org/3/search/tv?api_key={TMDB_KEY}&query={q}",
                   f"search/tv/{series}")
    results = (data or {}).get("results") or []
    best = None
    for r in results:
        if (r.get("name") or "").lower() == series.lower():
            best = r; break
    if best is None and results:
        best = results[0]
    pp = best.get("poster_path") if best else None
    if not pp:
        return False
    return download(f"https://image.tmdb.org/t/p/w500{pp}", poster)

def download(url, dest):
    rl_img()
    tmp = dest + ".tmp"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "nas-ingest/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
            while True:
                chunk = r.read(65536)
                if not chunk: break
                f.write(chunk)
        os.replace(tmp, dest)
        return True
    except Exception as e:
        log(f"  poster download error: {e}")
        try: os.unlink(tmp)
        except OSError: pass
        return False

# ---------------- filing ----------------
def safe_dest(rel):
    p = os.path.normpath(os.path.join(LIB, rel))
    if not (p == LIB or p.startswith(LIB + os.sep)):
        raise ValueError(f"dest escapes library: {rel}")
    return p

def hardlink(src_abs, dest_abs):
    """Idempotent hardlink. Returns (final_path, status: linked/exists/collision)."""
    src_ino = os.stat(src_abs).st_ino
    if os.path.exists(dest_abs):
        if os.stat(dest_abs).st_ino == src_ino:
            return dest_abs, "exists"
        base, ext = os.path.splitext(dest_abs)
        n = 2
        while os.path.exists(f"{base} ({n}){ext}"):
            if os.stat(f"{base} ({n}){ext}").st_ino == src_ino:
                return f"{base} ({n}){ext}", "exists"
            n += 1
        dest_abs = f"{base} ({n}){ext}"
        os.link(src_abs, dest_abs)
        if os.stat(dest_abs).st_ino != src_ino:
            raise OSError("inode mismatch after link")
        return dest_abs, "collision"
    os.link(src_abs, dest_abs)
    if os.stat(dest_abs).st_ino != src_ino:
        raise OSError("inode mismatch after link")
    return dest_abs, "linked"

def existing_movie_keys():
    """key_of(title)|year for every dir currently in library/Movies + NAS tmdb_map."""
    keys = set()
    mdir = os.path.join(LIB, "Movies")
    if os.path.isdir(mdir):
        for d in os.listdir(mdir):
            m = re.match(r'^(.*?)(?:\s*\((\d{4})\))?$', d)
            if m:
                keys.add(f"{key_of(m.group(1))}|{m.group(2) or ''}")
    try:
        m = json.load(open(MAP_PATH))
        for k in m:
            mm = re.match(r'^(.*?)(?:\s*\((\d{4})\))?$', k)
            if mm:
                keys.add(f"{key_of(mm.group(1))}|{mm.group(2) or ''}")
    except Exception:
        pass
    return keys

def is_sample(name, size):
    nm = name.lower()
    return (("sample" in nm or "trailer" in nm) and size < 200e6) or \
           size < 5e6 or nm.endswith(".flv") or nm == "etrg.mp4" or \
           re.match(r'(?i)^(rarbg\.com|www\.)', nm) is not None

def sidecars_for(video_abs, dir_files, video_count):
    vstem = norm(clean_stem(os.path.basename(video_abs)))
    out = []
    for f in dir_files:
        ext = os.path.splitext(f)[1].lower()
        if ext not in SIDECAR_OK or f == os.path.basename(video_abs):
            continue
        fstem = norm(clean_stem(f))
        if video_count == 1 or vstem.startswith(fstem) or fstem.startswith(vstem):
            out.append(f)
    return out

def settled(path):
    now = time.time()
    if now - os.lstat(path).st_mtime < SETTLE_S:
        return False
    if os.path.isdir(path):
        for dp, dn, fn in os.walk(path):
            for f in fn:
                try:
                    if now - os.lstat(os.path.join(dp, f)).st_mtime < SETTLE_S:
                        return False
                except OSError:
                    return False
            for d in dn:
                if now - os.lstat(os.path.join(dp, d)).st_mtime < SETTLE_S:
                    return False
    return True

# ---------------- main ----------------
lock_fd = open(LOCK_PATH, "w")
try:
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    log("another ingest run holds the lock; exiting")
    sys.exit(0)

if not os.path.exists(SEEN_PATH):
    seed = sorted(os.listdir(ROOT))
    tmp = SEEN_PATH + ".tmp"
    json.dump(seed, open(tmp, "w"), indent=1)
    os.replace(tmp, SEEN_PATH)
    log(f"seeded seen-set with {len(seed)} existing top-level entries; 0 new")
    save_cache()
    sys.exit(0)

seen = set(json.load(open(SEEN_PATH)))
candidates = [e for e in sorted(os.listdir(ROOT)) if e not in EXCLUDE and e not in seen]
log(f"run start: {len(candidates)} new candidate(s)")

filed = []          # dicts: category, dest_dir_rel, tmdb info
dups = []
bust = set()
map_merge = {}
genre_merge = {}
nas_map_changed = False
nas_map = json.load(open(MAP_PATH)) if os.path.exists(MAP_PATH) else {}
movie_keys = existing_movie_keys()
newly_seen = []

for entry in candidates:
    path = os.path.join(ROOT, entry)
    if not os.path.lexists(path):
        newly_seen.append(entry); continue
    if not settled(path):
        log(f"  SKIP unsettled: {entry}")
        continue
    # collect video files
    if os.path.isfile(path):
        ext = os.path.splitext(entry)[1].lower()
        if ext not in VIDEO_EXT and not (ext == "" and os.lstat(path).st_size > 100e6):
            log(f"  SKIP non-video: {entry}")
            newly_seen.append(entry); continue
        videos = [(path, entry)]
        dir_hint = None
        dir_files = []
        # root-level sidecars with matching stem ride along with the video
        vstem = norm(clean_stem(entry))
        root_sidecars = [f for f in os.listdir(ROOT)
                         if os.path.isfile(os.path.join(ROOT, f))
                         and os.path.splitext(f)[1].lower() in SIDECAR_OK
                         and (norm(clean_stem(f)).startswith(vstem) or vstem.startswith(norm(clean_stem(f))))]
        dir_files = [(ROOT, f) for f in root_sidecars]
    else:
        dir_hint = entry
        dir_files = []
        videos = []
        for dp, dn, fn in os.walk(path):
            for f in sorted(fn):
                dir_files.append((dp, f))
        for dp, f in dir_files:
            ext = os.path.splitext(f)[1].lower()
            if ext in VIDEO_EXT and not is_sample(f, os.lstat(os.path.join(dp, f)).st_size):
                videos.append((os.path.join(dp, f), f))
        if not videos:
            log(f"  SKIP dir with no usable video: {entry}")
            newly_seen.append(entry); continue

    for vabs, vname in videos:
        p = parse(vname, dir_hint=dir_hint)
        cat, extra = classify(vname, dir_hint, p)
        vsize = os.lstat(vabs).st_size
        vdir = os.path.dirname(vabs)
        vdir_files = [f for _, f in dir_files if _ == vdir]
        vcount = len([1 for _, f in dir_files if _ == vdir and os.path.splitext(f)[1].lower() in VIDEO_EXT]) if dir_hint else 2

        if cat == "movie":
            t = norm(p.get("title") or "")
            stem_n = norm(clean_stem(vname))
            alias = ALIAS.get(t)
            if alias is None and strip_part(p.get("title") or "") != (p.get("title") or ""):
                alias = ALIAS.get(norm(strip_part(p.get("title") or "")))
            if alias is None:
                alias = ALIAS.get(stem_n)
            if alias is not None:
                qt, qy = alias
                if qt is None:
                    cat, extra = "unknown", {"title": clean_stem(vname)}
                else:
                    query_title, query_year = qt, (qy if qy is not None else p.get("year"))
            else:
                query_title = strip_part(p["title"]) if p.get("part") else p.get("title")
                query_year = p.get("year")
        if cat == "movie":
            info = resolve_movie(query_title, query_year)
            if info:
                folder = f"{info['title']} ({info['year']})" if info.get("year") else info["title"]
            else:
                folder = f"{titlecase(strip_part(p['title']) if p.get('part') else p['title'])}" + \
                         (f" ({p['year']})" if p.get("year") else "")
                info = None
            folder = re.sub(r'[\\/:*?"<>|]', '', folder).strip()
            # duplicate?
            m = re.match(r'^(.*?)(?:\s*\((\d{4})\))?$', folder)
            fkey = f"{key_of(m.group(1))}|{m.group(2) or ''}"
            if fkey in movie_keys:
                log(f"  DUP movie: {vname if not dir_hint else entry + '/' + vname} -> existing {folder}")
                dups.append(entry)
                continue
            dest_dir = safe_dest(f"Movies/{folder}")
            os.makedirs(dest_dir, exist_ok=True)
            try:
                final, status = hardlink(vabs, os.path.join(dest_dir, os.path.basename(vabs)))
            except OSError as e:
                log(f"  ERROR linking {vabs}: {e}")
                continue
            log(f"  FILED movie{'' if info else ' (no TMDB match)'}: {os.path.basename(final)}" +
                (f" [collision-renamed]" if status == "collision" else "") +
                (f" tmdb={info['id']} conf={info['confidence']}" if info else ""))
            for sc in sidecars_for(vabs, vdir_files, vcount):
                try:
                    hardlink(os.path.join(vdir, sc), os.path.join(dest_dir, sc))
                    log(f"    sidecar: {sc}")
                except OSError as e:
                    log(f"    sidecar ERROR {sc}: {e}")
            if info:
                fetch_movie_poster(info["id"], dest_dir)
                map_merge[folder] = {"tmdb_id": info["id"], "title": info["title"],
                                     "year": info.get("year") or 0}
                genre_merge[folder] = movie_genres(info["id"])
                if folder not in nas_map:
                    nas_map[folder] = info["id"]
                    nas_map_changed = True
                movie_keys.add(fkey)
            else:
                movie_keys.add(fkey)
            bust.add("movies")
            filed.append(entry)

        elif cat == "tv":
            series = extra.get("series") or titlecase(p.get("title") or "Unknown Series")
            s = extra.get("season"); s = s if isinstance(s, int) else 0
            season_dir = safe_dest(f"TV/{series}/Season {s:02d}")
            series_dir = safe_dest(f"TV/{series}")
            new_series = not os.path.isdir(series_dir)
            os.makedirs(season_dir, exist_ok=True)
            dest = os.path.join(season_dir, os.path.basename(vabs))
            if os.path.exists(dest):
                log(f"  DUP tv episode (file exists): {series} S{s:02d} {os.path.basename(vabs)}")
                dups.append(entry)
                continue
            try:
                final, status = hardlink(vabs, dest)
            except OSError as e:
                log(f"  ERROR linking {vabs}: {e}")
                continue
            log(f"  FILED tv: {series} Season {s:02d}" +
                (f"E{extra['episode']:02d}" if isinstance(extra.get('episode'), int) else "") +
                f" <- {os.path.basename(vabs)}" +
                (f" [collision-renamed]" if status == "collision" else ""))
            if new_series:
                fetch_series_poster(series, series_dir)
            bust.add("tv")
            filed.append(entry)

        elif cat == "music":
            title = extra.get("title") or titlecase(p.get("title") or clean_stem(vname))
            dest_dir = safe_dest(f"Music/{title}")
            os.makedirs(dest_dir, exist_ok=True)
            try:
                final, status = hardlink(vabs, os.path.join(dest_dir, os.path.basename(vabs)))
            except OSError as e:
                log(f"  ERROR linking {vabs}: {e}")
                continue
            log(f"  FILED music: {title} <- {os.path.basename(vabs)}")
            bust.add("music")
            filed.append(entry)

        elif cat == "personal":
            dest_dir = safe_dest("Personal")
            os.makedirs(dest_dir, exist_ok=True)
            try:
                final, status = hardlink(vabs, os.path.join(dest_dir, os.path.basename(vabs)))
            except OSError as e:
                log(f"  ERROR linking {vabs}: {e}")
                continue
            log(f"  FILED personal: {os.path.basename(vabs)}")
            filed.append(entry)

        else:  # unknown
            if dir_hint and len(videos) > 1:
                dest_dir = safe_dest(f"Unknown/{dir_hint}")
            else:
                dest_dir = safe_dest("Unknown")
            os.makedirs(dest_dir, exist_ok=True)
            try:
                final, status = hardlink(vabs, os.path.join(dest_dir, os.path.basename(vabs)))
            except OSError as e:
                log(f"  ERROR linking {vabs}: {e}")
                continue
            log(f"  FILED unknown: {os.path.basename(vabs)}")
            filed.append(entry)

    newly_seen.append(entry)

# persist seen-set atomically
seen |= set(newly_seen)
tmp = SEEN_PATH + ".tmp"
json.dump(sorted(seen), open(tmp, "w"), indent=1)
os.replace(tmp, SEEN_PATH)

if nas_map_changed:
    tmp = MAP_PATH + ".tmp"
    json.dump(nas_map, open(tmp, "w"), indent=4)
    os.replace(tmp, MAP_PATH)
    log("NAS tmdb_map.json updated")

save_cache()

# kiosk notification
if filed:
    body = {"merge": map_merge, "genres": genre_merge, "bust": sorted(bust)}
    try:
        req = urllib.request.Request(
            NOTIFY_URL, data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "User-Agent": "nas-ingest/1.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            resp = r.read().decode()
        log(f"kiosk notified: POST {json.dumps(body)} -> {resp}")
    except Exception as e:
        log(f"kiosk notify FAILED: {e} (body was {json.dumps(body)})")

log(f"run done: filed={len(filed)} dup={len(dups)} bust={sorted(bust)} merge={len(map_merge)}")
