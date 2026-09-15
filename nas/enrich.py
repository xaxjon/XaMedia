#!/usr/bin/env python3
"""Parse + classify + TMDB-enrich the inventory. Writes items.json and tmdb_cache.json.
Read-only on /mnt/sdb1."""
import json, os, re, sys, time, urllib.parse, urllib.request
from collections import defaultdict, Counter

BASE = "/home/nas/cleanup"
INV = json.load(open(os.path.join(BASE, "inventory.json")))
CACHE_PATH = os.path.join(BASE, "tmdb_cache.json")
from nasconfig import TMDB_KEY

VIDEO_EXT = {".mp4", ".m4v", ".avi", ".mkv", ".vob", ".mpg", ".mpeg", ".wmv",
             ".divx", ".ogm", ".flv", ".mov", ".ts", ".m2ts", ".rmvb"}
SIDECAR_EXT = {".srt", ".nfo", ".jpg", ".jpeg", ".png", ".txt", ".sub", ".idx",
               ".ass", ".ssa", ".vtt", ".xml", ".sfv"}

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
    k = re.sub(r'[^a-z0-9]', '', s.lower())
    k = re.sub(r'^the', '', k)
    return k

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

def split_brackets(s):
    return BRACKET_RE.findall(s), BRACKET_RE.sub(' ', s)

# ---------------- alias table ----------------
_raw_alias = json.load(open(os.path.join(BASE, "aliases.json")))
ALIAS = {norm(k): v for k, v in _raw_alias.items()}

# ---------------- TV rules ----------------
def _rx(pat, n):
    return re.search(pat, n)

TV_RULES = [
    (r'black\s?adder\s*(?:ii|2)\s*(\d)', lambda n: ("Blackadder", 2, int(_rx(r'black\s?adder\s*(?:ii|2)\s*(\d)', n).group(1)), None)),
    (r'black\s?adder\s*4\s*(\d)?', lambda n: ("Blackadder", 4, int(_rx(r'black\s?adder\s*4\s*(\d)', n).group(1)) if _rx(r'black\s?adder\s*4\s*(\d)', n) and _rx(r'black\s?adder\s*4\s*(\d)', n).group(1) else 1, None)),
    (r'blackadder\s*1\s*(\d)?', lambda n: ("Blackadder", 1, int(_rx(r'blackadder\s*1\s*(\d)', n).group(1)) if _rx(r'blackadder\s*1\s*(\d)', n) and _rx(r'blackadder\s*1\s*(\d)', n).group(1) else 1, None)),
    (r'fawlty towers prop\s*(\d)\s*disc\s*(\d)', lambda n: ("Fawlty Towers", 1, (int(_rx(r'prop\s*(\d)', n).group(1))-1)*2 + int(_rx(r'disc\s*(\d)', n).group(1)), "PropN/DiscM mapped to episode number")),
    (r'dads army\s*(\d)', lambda n: ("Dad's Army", 1, int(_rx(r'dads army\s*(\d)', n).group(1)), "single-disc rips; season/episode inferred from file number")),
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
    # 1) TV rule on the file name itself
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
    # 2) SxxEyy in file + series from dir name
    if parsed.get("season") is not None and nd:
        for pat, fn in TV_RULES:
            if re.search(pat, nd):
                series, s, e, note = fn(nd)
                return ("tv", {"series": series, "season": parsed["season"],
                               "episode": parsed["episode"], "note": note})
    # 3) dir is a TV pack and the file name shares series tokens
    if nd:
        for pat, fn in TV_RULES:
            m = re.search(pat, nd)
            if m:
                series, s, e, note = fn(nd)
                toks = [w for w in norm(series).split()[:3] if len(w) > 2]
                if toks and all(w in n for w in toks[:2]):
                    if s is None and parsed.get("season") is not None:
                        s, e = parsed["season"], parsed["episode"]
                    return ("tv", {"series": series, "season": s if s is not None else 0,
                                   "episode": e, "note": (note or "classified via parent directory")})
    # 4) generic SxxEyy
    if parsed.get("season") is not None:
        return ("tv", {"series": parsed["title"], "season": parsed["season"],
                       "episode": parsed["episode"], "note": "generic SxxEyy parse"})
    return ("movie", {})

# ---------------- build items ----------------
items, skipped = [], []
VIDEO_TS_RE = re.compile(r'(?i)(^|/)video_ts(/|$)')

def is_sample(c):
    nm = c["name"].lower()
    return (("sample" in nm or "trailer" in nm) and c["size"] < 200e6) or \
           c["size"] < 5e6 or nm.endswith(".flv") or nm == "etrg.mp4" or \
           re.match(r'(?i)^(rarbg\.com|www\.)', nm) is not None

def sidecars_for(video_rel, children, dir_video_count):
    vdir = video_rel.rsplit('/', 1)[0] if '/' in video_rel else ''
    vstem = norm(clean_stem(os.path.basename(video_rel)))
    out = []
    for c in children:
        if c["rel"] == video_rel or c["ext"] not in SIDECAR_EXT:
            continue
        cdir = c["rel"].rsplit('/', 1)[0] if '/' in c["rel"] else ''
        cstem = norm(clean_stem(c["name"]))
        if cdir == vdir and (vstem.startswith(cstem) or cstem.startswith(vstem)):
            out.append(c["rel"])
        elif dir_video_count == 1:
            out.append(c["rel"])
    return sorted(set(out))

for e in INV["entries"]:
    if e["kind"] == "file":
        nm = e["name"]
        if e["ext"] in VIDEO_EXT or (e["ext"] == "" and e["size"] > 100e6):
            if e["size"] < 1e6:
                skipped.append((nm, "near-empty file")); continue
            items.append({"relpath": nm, "container": "", "size": e["size"],
                          "ext": e["ext"] or ".?", "parsed": parse(nm), "sidecars": []})
        elif e["ext"] not in SIDECAR_EXT:
            skipped.append((nm, "non-media file"))
    else:
        children = e["children"]
        vids = [c for c in children if c["ext"] in VIDEO_EXT and not is_sample(c)]
        for c in children:
            if c["ext"] in VIDEO_EXT and is_sample(c):
                skipped.append((c["rel"], "sample/trailer/near-empty"))
        if not vids:
            skipped.append((e["name"] + "/", "empty directory" if e["n_files"] == 0
                            else "directory with no usable video (archives/fake/empty)"))
            continue
        vts = [c for c in vids if VIDEO_TS_RE.search(c["rel"]) or re.match(r'(?i)\.?\s*vts \d+ \d', c["name"])]
        if vts and len(vts) == len(vids):
            main = max(vts, key=lambda c: c["size"])
            p = parse(e["name"]); p["_from_dir"] = True
            sc = [c["rel"] for c in children if c["rel"] != main["rel"]]
            items.append({"relpath": main["rel"], "container": e["name"], "size": main["size"],
                          "ext": main["ext"], "parsed": p, "sidecars": sorted(sc),
                          "dvd_split": [c["rel"] for c in vts if c["rel"] != main["rel"]]})
            continue
        for c in vids:
            p = parse(c["name"], dir_hint=e["name"])
            items.append({"relpath": c["rel"], "container": e["name"], "size": c["size"],
                          "ext": c["ext"], "parsed": p,
                          "sidecars": sidecars_for(c["rel"], children, len(vids))})

for it in items:
    cat, extra = classify(os.path.basename(it["relpath"]), it["container"] or None, it["parsed"])
    it["category"] = cat
    for k, v in extra.items():
        it[k] = v
    if extra.get("note"):
        it.setdefault("notes", []).append(extra["note"])
    if it["parsed"].get("_from_dir"):
        it.setdefault("notes", []).append("title parsed from directory name")
    if it.get("dvd_split"):
        it.setdefault("notes", []).append("DVD split structure; primary file listed, %d more parts" % len(it["dvd_split"]))

# multi-part flags
PART_TAG_RE = re.compile(r'(?i)\s*\b(?:cd|disc|disk|part|pt|dvd|side\s?[ab]|sidea|sideb|0[12])\s*\.?\s*[1-9ab]?\s*$')
def strip_part(t):
    return PART_TAG_RE.sub('', t or '').strip()

groups = defaultdict(list)
for it in items:
    groups[(key_of(strip_part(it["parsed"].get("title", ""))), it["parsed"].get("year"))].append(it)
for it in items:
    p = it["parsed"]
    nm = norm(clean_stem(os.path.basename(it["relpath"])))
    looks_mp = p.get("part") or re.search(r'\b(cd|disc|part|pt|dvd)\s*[12]\b|side\s?[ab]\b|\b0[12]\s*$', nm)
    if looks_mp:
        others = [o for o in groups[(key_of(strip_part(p.get("title", ""))), p.get("year"))] if o is not it]
        if others:
            it.setdefault("notes", []).append("multi-part")
            it["_mp"] = True

# movie aliases
for it in items:
    if it["category"] != "movie":
        continue
    p = it["parsed"]
    t = norm(p.get("title") or "")
    stem_n = norm(clean_stem(os.path.basename(it["relpath"])))
    alias = ALIAS.get(t)
    if alias is None and strip_part(p.get("title") or "") != (p.get("title") or ""):
        alias = ALIAS.get(norm(strip_part(p.get("title") or "")))
    if alias is None:
        alias = ALIAS.get(stem_n)
    if alias is not None:
        qt, qy = alias
        if qt is None:
            it["category"] = "unknown"
            it["title"] = clean_stem(os.path.basename(it["relpath"]))
            it.setdefault("notes", []).append("unidentifiable filename")
            continue
        it["query_title"], it["query_year"] = qt, (qy if qy is not None else p.get("year"))
        if norm(qt) != t:
            it.setdefault("notes", []).append("title via manual alias")
    else:
        qt = strip_part(p.get("title")) if it.get("_mp") else p.get("title")
        it["query_title"] = qt
        it["query_year"] = p.get("year")

# trailing-digit part detection: "Lawrence1"/"Lawrence2" style split files
qg = defaultdict(list)
for it in items:
    if it["category"] == "movie" and it.get("query_title"):
        qg[(norm(it["query_title"]), it.get("query_year"))].append(it)
for mem in qg.values():
    if len(mem) < 2:
        continue
    bynum = defaultdict(list)
    for m in mem:
        nm = norm(clean_stem(os.path.basename(m["relpath"])))
        mm = re.search(r'0?([12])$', nm)
        if mm and not re.search(r'(?i)part|cd|disc|side', nm):
            bynum[re.sub(r'\s*0?[12]$', '', nm)].append((mm.group(1), m))
    for b, lst in bynum.items():
        if len(lst) > 1 and len({n for n, _ in lst}) > 1:
            for _, m in lst:
                if "multi-part" not in m.get("notes", []):
                    m.setdefault("notes", []).append("multi-part")

# ---------------- TMDB ----------------
try:
    cache = json.load(open(CACHE_PATH))
except Exception:
    cache = {}

def tmdb_search(title, year):
    q = {"api_key": TMDB_KEY, "query": title}
    if year: q["year"] = str(year)
    url = "https://api.themoviedb.org/3/search/movie?" + urllib.parse.urlencode(q)
    key = f"{title}|{year}"
    if key in cache:
        return cache[key], True
    req = urllib.request.Request(url, headers={"User-Agent": "nas-audit/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode())
    except Exception as ex:
        cache[key] = {"error": str(ex)}
        return cache[key], False
    out = {"results": [{"id": x.get("id"), "title": x.get("title"),
                        "original_title": x.get("original_title"),
                        "release_date": x.get("release_date")}
                       for x in data.get("results", [])[:5]]}
    cache[key] = out
    return out, False

movies = [it for it in items if it["category"] == "movie" and it.get("query_title")]
if os.environ.get("DRYRUN"):
    json.dump({"items": items, "skipped": skipped},
              open(os.path.join(BASE, "items_dry.json"), "w"), indent=1)
    print("DRYRUN items:", len(items), dict(Counter(it["category"] for it in items)))
    sys.exit(0)
n_calls = 0
for i, it in enumerate(movies):
    qt, qy = it["query_title"], it.get("query_year")
    res, hit = tmdb_search(qt, qy)
    if not hit:
        n_calls += 1
        time.sleep(0.34)
        if n_calls % 100 == 0:
            print(f"  ... {n_calls} API calls, {i+1}/{len(movies)} movies", flush=True)
            json.dump(cache, open(CACHE_PATH, "w"))
    results = res.get("results", [])
    chosen, conf = None, "low"
    if res.get("error"):
        it["tmdb"] = {"id": None, "confidence": "low", "error": res["error"]}
        it.setdefault("notes", []).append("TMDB error: " + res["error"])
        continue
    if results:
        for r in results:
            ry = int(r["release_date"][:4]) if r.get("release_date") else None
            if (key_of(r["title"] or "") == key_of(qt) or key_of(r.get("original_title") or "") == key_of(qt)) and qy and ry == qy:
                chosen, conf = r, "high"; break
        if not chosen:
            for r in results:
                if key_of(r["title"] or "") == key_of(qt) or key_of(r.get("original_title") or "") == key_of(qt):
                    chosen, conf = r, "medium"; break
        if not chosen and qy:
            for r in results:
                ry = int(r["release_date"][:4]) if r.get("release_date") else None
                if ry == qy:
                    chosen, conf = r, "medium"
                    it.setdefault("notes", []).append("year matched, title differs")
                    break
        if not chosen:
            chosen, conf = results[0], "medium" if len(results) == 1 else "low"
            if conf == "low":
                it.setdefault("notes", []).append("weak TMDB match")
    if not chosen and qy:
        res2, hit2 = tmdb_search(qt, None)
        if not hit2:
            n_calls += 1; time.sleep(0.34)
        results = res2.get("results", [])
        for r in results:
            if key_of(r["title"] or "") == key_of(qt) or key_of(r.get("original_title") or "") == key_of(qt):
                chosen, conf = r, "medium"; break
    if not chosen and '(' in qt:
        qt2 = qt.split('(')[0].strip()
        res3, hit3 = tmdb_search(qt2, qy)
        if not hit3:
            n_calls += 1; time.sleep(0.34)
        results = res3.get("results", [])
        for r in results:
            ry = int(r["release_date"][:4]) if r.get("release_date") else None
            if key_of(r["title"] or "") == key_of(qt2) and (not qy or ry == qy):
                chosen, conf = r, "high" if qy and ry == qy else "medium"; break
    if chosen:
        ry = chosen["release_date"][:4] if chosen.get("release_date") else None
        it["tmdb"] = {"id": chosen["id"], "title": chosen["title"],
                      "original_title": chosen.get("original_title"),
                      "year": ry, "confidence": conf}
    else:
        it["tmdb"] = {"id": None, "confidence": "low"}
        it.setdefault("notes", []).append("no TMDB result")

json.dump(cache, open(CACHE_PATH, "w"), indent=1)
json.dump({"items": items, "skipped": skipped},
          open(os.path.join(BASE, "items.json"), "w"), indent=1)

cats = Counter(it["category"] for it in items)
confs = Counter(it.get("tmdb", {}).get("confidence") for it in items if it["category"] == "movie")
print("items:", len(items), dict(cats))
print("movie TMDB confidence:", dict(confs), "| API calls:", n_calls, "| cache:", len(cache))
print("skipped:", len(skipped))
errs = Counter(it["tmdb"].get("error") for it in items if it.get("tmdb", {}).get("error"))
for k, v in errs.items(): print("TMDB error:", k, v)
