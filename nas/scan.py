#!/usr/bin/env python3
"""Scan /mnt/sdb1 (read-only) and write /home/nas/cleanup/inventory.json."""
import json, os, sys

ROOT = "/mnt/sdb1"
OUT = "/home/nas/cleanup/inventory.json"
VIDEO_EXT = {".mp4", ".m4v", ".avi", ".mkv", ".vob", ".mpg", ".mpeg", ".wmv",
             ".divx", ".ogm", ".flv", ".mov", ".ts", ".m2ts", ".rmvb", ".3gp"}
SIDECAR_EXT = {".srt", ".nfo", ".jpg", ".jpeg", ".png", ".txt", ".sub", ".idx",
               ".ass", ".ssa", ".vtt", ".xml", ".db", ".sfv", ".md5"}
SKIP_DIRS = {"lost+found"}

inventory = []
errors = []

for entry in sorted(os.listdir(ROOT)):
    if entry in SKIP_DIRS:
        continue
    full = os.path.join(ROOT, entry)
    try:
        if os.path.isfile(full) or os.path.islink(full):
            st = os.lstat(full)
            ext = os.path.splitext(entry)[1].lower()
            inventory.append({
                "kind": "file", "name": entry, "size": st.st_size,
                "ext": ext, "mtime": int(st.st_mtime),
            })
        elif os.path.isdir(full):
            children = []
            for dirpath, dirnames, filenames in os.walk(full):
                dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
                for fn in sorted(filenames):
                    fp = os.path.join(dirpath, fn)
                    rel = os.path.relpath(fp, ROOT)
                    try:
                        st = os.lstat(fp)
                    except OSError as e:
                        errors.append(f"stat {rel}: {e}")
                        continue
                    ext = os.path.splitext(fn)[1].lower()
                    children.append({
                        "rel": rel, "name": fn, "size": st.st_size,
                        "ext": ext, "mtime": int(st.st_mtime),
                    })
            total = sum(c["size"] for c in children)
            inventory.append({
                "kind": "dir", "name": entry, "size": total,
                "n_files": len(children), "children": children,
            })
    except OSError as e:
        errors.append(f"{entry}: {e}")

with open(OUT, "w") as f:
    json.dump({"entries": inventory, "errors": errors}, f, indent=1)

nvid = 0
nsc = 0
for e in inventory:
    if e["kind"] == "file":
        if e["ext"] in VIDEO_EXT: nvid += 1
        elif e["ext"] in SIDECAR_EXT: nsc += 1
    else:
        for c in e["children"]:
            if c["ext"] in VIDEO_EXT: nvid += 1
            elif c["ext"] in SIDECAR_EXT: nsc += 1
print(f"top-level entries: {len(inventory)}  video files: {nvid}  sidecars: {nsc}  errors: {len(errors)}")
for er in errors[:20]:
    print("ERR", er)
