#!/usr/bin/env python3
"""Dup detection + destinations + proposal.json / duplicates.txt / summary.txt."""
import json, os, re
from collections import defaultdict, Counter

BASE = "/home/nas/cleanup"
D = json.load(open(os.path.join(BASE, "items.json")))
items, skipped = D["items"], D["skipped"]

def key_of(s):
    k = re.sub(r'[^a-z0-9]', '', (s or '').lower())
    return re.sub(r'^the', '', k)

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

EXT_RANK = {".mp4": 5, ".mkv": 4, ".m4v": 3, ".avi": 2, ".divx": 2, ".ogm": 2,
            ".wmv": 2, ".flv": 1, ".vob": 1, ".mpg": 1, ".ts": 1, ".?": 0}
RES_RANK = {"4320p": 5, "2160p": 4, "1080p": 3, "720p": 2, "576p": 1, "480p": 0}

def pref_key(it):
    extras = 1 if (it.get("sidecars") or it.get("container")) else 0
    res = RES_RANK.get(it["parsed"].get("res") or "", -1)
    return (extras, it["size"], EXT_RANK.get(it["ext"], 0), res)

# ---- clean title / year / confidence per item ----
for it in items:
    cat = it["category"]
    if cat == "movie":
        t = it.get("tmdb", {})
        if t.get("id"):
            it["clean_title"] = t["title"]
            it["year"] = int(t["year"]) if t.get("year") else it.get("query_year")
            it["confidence"] = t["confidence"]
            it["tmdb_id"] = t["id"]
        else:
            it["clean_title"] = titlecase(it.get("query_title") or it["parsed"].get("title") or "")
            it["year"] = it.get("query_year")
            it["confidence"] = "low"
            it["tmdb_id"] = None
    elif cat == "tv":
        it["clean_title"] = it.get("series")
        it["year"] = None
        it["confidence"] = None
        it["tmdb_id"] = None
    elif cat in ("music", "personal"):
        it["clean_title"] = it.get("title")
        it["year"] = None
        it["confidence"] = None
        it["tmdb_id"] = None
    else:
        it["clean_title"] = it.get("title") or os.path.basename(it["relpath"])
        it["year"] = None
        it["confidence"] = None
        it["tmdb_id"] = None

# ---- destinations ----
for it in items:
    base = os.path.basename(it["relpath"])
    cat = it["category"]
    if cat == "movie":
        folder = f"{it['clean_title']} ({it['year']})" if it.get("year") else it["clean_title"]
        folder = re.sub(r'[\\/:*?"<>|]', '', folder).strip()
        it["dest_relpath"] = f"Movies/{folder}/{base}"
    elif cat == "tv":
        s = it.get("season")
        s = s if isinstance(s, int) else 0
        it["dest_relpath"] = f"TV/{it['clean_title']}/Season {s:02d}/{base}"
    elif cat == "music":
        it["dest_relpath"] = f"Music/{it['clean_title']}/{base}"
    elif cat == "personal":
        it["dest_relpath"] = f"Personal/{base}"
    else:
        it["dest_relpath"] = f"Unknown/{base}"

# ---- duplicates ----
groups = defaultdict(list)
for it in items:
    cat = it["category"]
    if cat == "movie":
        k = f"tmdb:{it['tmdb_id']}" if it.get("tmdb_id") else f"pt:{key_of(it['clean_title'])}:{it.get('year')}"
        groups[("movie", k)].append(it)
    elif cat == "tv":
        if it.get("episode") is not None:
            groups[("tv", f"{key_of(it['clean_title'])}:s{it.get('season') or 0:02d}e{it['episode']:02d}")].append(it)
    elif cat == "music":
        groups[("music", key_of(it["clean_title"]))].append(it)

dup_groups = []
for (cat, k), members in groups.items():
    if len(members) < 2:
        continue
    parts = [m for m in members if m.get("notes") and "multi-part" in m["notes"]]
    singles = [m for m in members if m not in parts]
    if not singles and parts:
        continue  # a lone multi-part set is one movie, not duplicates
    candidates = singles if singles else members
    keeper = max(candidates, key=pref_key)
    for m in members:
        m["dup_of"] = None if m is keeper else keeper["relpath"]
    dup_groups.append({"cat": cat, "key": k, "keeper": keeper["relpath"],
                       "members": sorted(members, key=pref_key, reverse=True)})
for (cat, k), members in groups.items():
    if len(members) < 2:
        for m in members: m.setdefault("dup_of", None)
for it in items:
    it.setdefault("dup_of", None)

dup_groups.sort(key=lambda g: -sum(m["size"] for m in g["members"]))

# ---- proposal.json ----
proposal = []
for it in items:
    proposal.append({
        "src_relpath": it["relpath"],
        "category": it["category"],
        "clean_title": it["clean_title"],
        "year": it.get("year"),
        "tmdb_id": it.get("tmdb_id"),
        "confidence": it.get("confidence"),
        "dest_relpath": it["dest_relpath"],
        "dup_of": it["dup_of"],
        "sidecars": it.get("sidecars", []),
        "size_bytes": it["size"],
        "notes": "; ".join(it.get("notes", [])) or None,
    })
json.dump(proposal, open(os.path.join(BASE, "proposal.json"), "w"), indent=1)

# ---- duplicates.txt ----
def human(n):
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024: return f"{n:.0f}{u}"
        n /= 1024
    return f"{n:.1f}TB"
lines = [f"DUPLICATE GROUPS: {len(dup_groups)}", ""]
for i, g in enumerate(dup_groups, 1):
    tot = sum(m["size"] for m in g["members"])
    title = g["members"][0]["clean_title"]
    yr = g["members"][0].get("year")
    lines.append(f"[{i}] {title}" + (f" ({yr})" if yr else "") +
                 f"  [{g['cat']}]  {len(g['members'])} copies, {human(tot)} total")
    for m in g["members"]:
        keep = "KEEP  " if m["dup_of"] is None else "dup   "
        lines.append(f"    {keep} {human(m['size']):>9}  {m['relpath']}")
    lines.append("")
open(os.path.join(BASE, "duplicates.txt"), "w").write("\n".join(lines))

# ---- summary.txt ----
cats = Counter(p["category"] for p in proposal)
confs = Counter(p["confidence"] for p in proposal if p["category"] == "movie")
unknowns = [p["src_relpath"] for p in proposal if p["category"] == "unknown"]
no_tmdb = [p["src_relpath"] for p in proposal if p["category"] == "movie" and not p["tmdb_id"]]
weak = [p["src_relpath"] for p in proposal if p["category"] == "movie" and p["tmdb_id"] and p["confidence"] == "low"]
multipart = [p["src_relpath"] for p in proposal if p["notes"] and "multi-part" in p["notes"]]
tmdb_cache = json.load(open(os.path.join(BASE, "tmdb_cache.json")))
api_errs = {k: v for k, v in tmdb_cache.items() if v.get("error")}

s = []
s.append("NAS MEDIA LIBRARY AUDIT — /mnt/sdb1 (READ-ONLY audit, nothing moved/deleted)")
s.append("")
s.append(f"Video items in proposal: {len(proposal)}")
s.append("By category: " + ", ".join(f"{k}={v}" for k, v in sorted(cats.items())))
s.append("Movie TMDB confidence: " + ", ".join(f"{k}={v}" for k, v in sorted(confs.items())))
s.append(f"Duplicate groups: {len(dup_groups)} "
         f"({sum(len(g['members']) - 1 for g in dup_groups)} redundant copies, "
         f"{human(sum(sum(m['size'] for m in g['members'] if m['dup_of']) for g in dup_groups))} in duplicates)")
s.append(f"Multi-part film entries: {len(multipart)}")
s.append(f"TMDB cache entries: {len(tmdb_cache)}; API errors: {len(api_errs)}")
s.append("")
s.append(f"UNKNOWN ITEMS ({len(unknowns)}):")
for u in unknowns: s.append(f"  {u}")
s.append("")
s.append(f"MOVIES WITH NO TMDB RESULT ({len(no_tmdb)}):")
for u in no_tmdb: s.append(f"  {u}")
s.append("")
s.append(f"MOVIES WITH WEAK TMDB MATCH ({len(weak)}):")
for u in weak: s.append(f"  {u}")
s.append("")
s.append(f"SKIPPED / NON-ITEM FILES ({len(skipped)}):")
for rel, why in skipped: s.append(f"  {rel}  — {why}")
open(os.path.join(BASE, "summary.txt"), "w").write("\n".join(s) + "\n")
print("\n".join(s[:8]))
print(f"unknown={len(unknowns)} no_tmdb={len(no_tmdb)} weak={len(weak)} skipped={len(skipped)}")
