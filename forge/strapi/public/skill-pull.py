#!/usr/bin/env python3
"""Skill pull — syncs skills from Strapi to local directory."""
import base64, hashlib, json, sys, urllib.request
from pathlib import Path

API = __API__
SKILLS_DIR = Path(__SKILLS_DIR__)
MANIFEST = __MANIFEST__


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "skill-pull/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def local_hash(skill_dir):
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return None
    h = hashlib.sha256()
    h.update(skill_md.read_text("utf-8").encode())
    for f in sorted(skill_dir.rglob("*")):
        if f.is_dir() or f == skill_md:
            continue
        rel = str(f.relative_to(skill_dir))
        if any(s in rel for s in ("__pycache__", ".pyc", "Zone.Identifier", ".DS_Store")):
            continue
        h.update(rel.encode())
        h.update(f.read_bytes())
    return h.hexdigest()[:16]


def remote_hash(data):
    h = hashlib.sha256()
    h.update((data.get("skillMd") or "").encode())
    for f in sorted(data.get("files") or [], key=lambda x: x["path"]):
        h.update(f["path"].encode())
        h.update(f["content"].encode())
    return h.hexdigest()[:16]


pulled, skipped, unchanged = 0, 0, 0
for entry in MANIFEST:
    name = entry["n"]
    skill_dir = SKILLS_DIR / name

    try:
        resp = fetch("{}/api/skills/{}".format(API, entry["d"]))
    except Exception as e:
        print("  {}: fetch error: {}".format(name, e))
        skipped += 1
        continue
    data = resp.get("data", resp)

    rh = remote_hash(data)
    lh = local_hash(skill_dir)
    if lh == rh:
        print("  {}: unchanged".format(name))
        unchanged += 1
        continue

    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(data.get("skillMd", ""), encoding="utf-8")

    for f in (data.get("files") or []):
        fp = skill_dir / f["path"]
        fp.parent.mkdir(parents=True, exist_ok=True)
        if f.get("encoding") == "base64":
            fp.write_bytes(base64.b64decode(f["content"]))
        else:
            fp.write_text(f["content"], encoding="utf-8")

    print("  {}: pulled (local={}, remote={})".format(name, lh or "new", rh))
    pulled += 1

print("\nDone: {} pulled, {} unchanged, {} skipped".format(pulled, unchanged, skipped))
