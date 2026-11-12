#!/usr/bin/env python3
"""Builds a scratch config folder + data folder for driving the Library's "most installed first" order
in the real app, without touching the real ~/.claude.

    python tools/make-library-popular-fixture.py <out>
    atlas.exe --config-dir <out>/config --data-dir <out>/data

What it writes (nothing outside <out>):
  config/plugins/plugin-catalog-cache.json   Claude Code's cache shape: catalog.plugins["name@claude-plugins-official"].unique_installs
  config/plugins/known_marketplaces.json     the official marketplace and one added one
  data/library/catalog.json                  Atlas's saved catalog (fresh, so no command runs): the captured directory
                                             (fixtures/library/catalog-available.json.gz) with the first 300 plugins moved to
                                             claude-plugins-official, which is where Claude Code keeps the counts

Counts are deterministic and cover the cases the sort must handle: a spread from 12 to 1.3M, some ties,
a zero, a null, a count in a wrong shape, and about a quarter of the official plugins with no count at all.
"""
import gzip
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "..", "fixtures", "library", "catalog-available.json.gz")
OFFICIAL = "claude-plugins-official"
MOVED = 300


def github(url):
    rest = url.removeprefix("https://github.com/").removesuffix(".git").strip("/")
    parts = rest.split("/")
    return "/".join(parts) if len(parts) == 2 and all(parts) else None


def source_of(s):
    if isinstance(s, str):
        return {"kind": "local", "path": s}
    if isinstance(s, dict):
        kind = s.get("source")
        if kind in ("url", "git-subdir") and github(s.get("url", "")):
            out = {"kind": "github", "repo": github(s["url"])}
        elif kind == "github" and s.get("repo"):
            out = {"kind": "github", "repo": s["repo"]}
        elif kind in ("npm", "command"):
            return {"kind": "command"}
        else:
            return {"kind": "other", "url": s.get("url", "")}
        if s.get("sha"):
            out["sha"] = s["sha"]
        if s.get("path"):
            out["path"] = s["path"].lstrip("./")
        return out
    return {"kind": "other", "url": ""}


def main(out):
    raw = json.loads(gzip.open(FIXTURE).read().decode("utf8"))["available"]
    entries = []
    for i, e in enumerate(raw):
        mp = OFFICIAL if i < MOVED else e["marketplaceName"]
        entries.append(
            {
                "pluginId": f"{e['name']}@{mp}",
                "name": e["name"],
                "description": e.get("description") or "",
                "marketplace": mp,
                "version": e.get("version") or "",
                "source": source_of(e.get("source")),
            }
        )
    plugins = {}
    for i in range(MOVED):
        e = entries[i]
        n = i % 12
        if n == 0:
            continue  # no count at all
        elif n == 1:
            value = None
        elif n == 2:
            value = "lots"
        elif n == 3:
            value = 0
        elif n in (4, 5):
            value = 4200  # a tie
        else:
            # A long tail like the real one: a few huge counts, most of them small, each different.
            k = (i * 7919) % MOVED
            value = round(1_266_133 * ((MOVED - k) / MOVED) ** 5) + 12
        plugins[e["pluginId"]] = {"plugin": e["name"], "unique_installs": value, "version": "1.0.0"}
    cfg = os.path.join(out, "config", "plugins")
    data = os.path.join(out, "data", "library")
    os.makedirs(cfg, exist_ok=True)
    os.makedirs(data, exist_ok=True)
    with open(os.path.join(cfg, "plugin-catalog-cache.json"), "w", encoding="utf8") as f:
        json.dump({"version": 1, "fetchedAt": "2026-11-11T04:11:45.471Z", "catalog": {"installs_generated_at": "2026-10-16T06:00:26+00:00", "plugins": plugins}}, f)
    with open(os.path.join(cfg, "known_marketplaces.json"), "w", encoding="utf8") as f:
        json.dump(
            {
                OFFICIAL: {"source": {"source": "github", "repo": "anthropics/claude-plugins-official"}, "installLocation": os.path.join(out, "none", OFFICIAL), "lastUpdated": "2026-11-11T00:00:00Z"},
                "impeccable": {"source": {"source": "github", "repo": "pbakaus/impeccable"}, "installLocation": os.path.join(out, "none", "impeccable"), "lastUpdated": "2026-10-09T00:00:00Z"},
            },
            f,
        )
    with open(os.path.join(data, "catalog.json"), "w", encoding="utf8") as f:
        json.dump({"schemaVersion": 1, "fetchedMs": int(time.time() * 1000) - 5 * 60_000, "entries": entries}, f)
    print(f"{len(entries)} plugins, {sum(isinstance(v['unique_installs'], int) for v in plugins.values())} with a usable count -> {out}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(os.path.abspath(sys.argv[1]))
