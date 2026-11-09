"""Independent recount of Claude Code token usage, to check Atlas's numbers.

Plain Python, no dependencies. Reads transcripts READ-ONLY and never writes next to them.

    python tools/recount.py                         # ~/.claude/projects, bundled prices
    python tools/recount.py --projects <dir>        # another projects folder (fixtures)
    python tools/recount.py --compare <cache.sqlite> [--top 10] [--json out.json]

Own rules (written from the transcript format, not from Atlas's code):
- A usage line is an assistant line with message.usage. `<synthetic>` lines are not API calls.
- Claude Code writes one line per content block of a reply, all with the same message.id and
  requestId; only output_tokens grows across them. One reply = one key `id|requestId`; the line
  with the largest output_tokens is the reply's usage (a later tie wins). The same key in two
  files (a resumed chat copies history) is still one reply.
- A line whose four token counts are all zero adds nothing (API errors, aborted streams).
- Cache writes split by usage.cache_creation (5 minute / 1 hour); with no split, or an all-zero
  split next to real writes, the total is booked as 5 minute.
- The session is the line's sessionId (subagent lines carry the parent chat's id), else the
  folder name. Effort is perTurnEffort, else effort; absent stays absent.
- Est. cost: the same price list Atlas ships (exact id or alias, standard tier only, us = 1.1x,
  fast mode rates scale the cache rates, Haiku-style long context when prompt > threshold,
  web search per 1,000). Anything else is "not priced" and adds no dollars.
"""

import argparse
import json
import os
import sqlite3
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PRICES = os.path.join(HERE, "..", "crates", "core", "pricing", "pricing.default.json")
FIELDS = ("input", "output", "cw5m", "cw1h", "cr")


def projects_default():
    root = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(root, "projects")


def transcripts(projects):
    """`<proj>/<session>.jsonl` and `<proj>/<session>/subagents/*.jsonl`, in a stable order."""
    out = []
    for proj in sorted(os.listdir(projects)):
        pdir = os.path.join(projects, proj)
        if not os.path.isdir(pdir):
            continue
        for name in sorted(os.listdir(pdir)):
            p = os.path.join(pdir, name)
            if name.endswith(".jsonl") and os.path.isfile(p):
                out.append((p, name[:-6], False))
            elif os.path.isdir(p):
                sub = os.path.join(p, "subagents")
                if os.path.isdir(sub):
                    for f in sorted(os.listdir(sub)):
                        if f.endswith(".jsonl"):
                            out.append((os.path.join(sub, f), name, True))
    return out


def read_reply(raw):
    """One transcript line -> a reply dict, or a reason string."""
    if b'"assistant"' not in raw:
        return "other"
    try:
        d = json.loads(raw)
    except ValueError:
        return "unreadable"
    if not isinstance(d, dict) or d.get("type") != "assistant":
        return "other"
    m = d.get("message") or {}
    u = m.get("usage")
    model = m.get("model")
    if not isinstance(u, dict) or not model:
        return "no-usage"
    if model == "<synthetic>":
        return "synthetic"
    n = lambda v: v if isinstance(v, int) and v > 0 else 0
    total_cw = n(u.get("cache_creation_input_tokens"))
    split = u.get("cache_creation") if isinstance(u.get("cache_creation"), dict) else None
    a = n(split.get("ephemeral_5m_input_tokens")) if split else 0
    b = n(split.get("ephemeral_1h_input_tokens")) if split else 0
    if a + b == 0 and total_cw > 0:
        a, b = total_cw, 0
    r = {
        "input": n(u.get("input_tokens")),
        "output": n(u.get("output_tokens")),
        "cw5m": a,
        "cw1h": b,
        "cr": n(u.get("cache_read_input_tokens")),
    }
    if not any(r.values()):
        return "zero"
    if not m.get("id") or not d.get("requestId"):
        return "unkeyed"
    stu = u.get("server_tool_use") if isinstance(u.get("server_tool_use"), dict) else {}
    r.update(
        key=f'{m["id"]}|{d["requestId"]}',
        session=d.get("sessionId"),
        model=model,
        speed=u.get("speed") or "",
        geo=u.get("inference_geo") or "",
        tier=u.get("service_tier") or "",
        web_search=n(stu.get("web_search_requests")),
        effort=d.get("perTurnEffort") or d.get("effort") or None,
    )
    return r


class Prices:
    def __init__(self, path):
        with open(path, encoding="utf-8") as f:
            t = json.load(f)
        self.t = t
        self.alias = {a: k for k, m in t["models"].items() for a in m.get("aliases", [])}

    def model(self, mid):
        m = self.t["models"].get(mid)
        if m is None and mid in self.alias:
            m = self.t["models"][self.alias[mid]]
        return m

    def cost(self, r):
        m = self.model(r["model"])
        if m is None:
            return None
        tier = r["tier"] or "standard"
        if tier not in self.t["serviceTiers"]:
            return None
        geo = "global" if r["geo"] in ("", "not_available") else r["geo"]
        if geo not in self.t["geoMultipliers"]:
            return None
        gm = self.t["geoMultipliers"][geo]
        lc = m.get("longContext")
        threshold = lc["thresholdTokens"] if lc else 100_000
        prompt = r["input"] + r["cr"] + r["cw5m"] + r["cw1h"]
        src = lc if (lc and prompt > threshold) else m
        pin, pout, w5, w1, pr = src["input"], src["output"], src["cacheWrite5m"], src["cacheWrite1h"], src["cacheRead"]
        if r["speed"] == "fast":
            f = m.get("fast")
            if not f:
                return None
            ratio = f["input"] / pin if pin else 1.0
            pin, pout, w5, w1, pr = f["input"], f["output"], w5 * ratio, w1 * ratio, pr * ratio
        elif r["speed"] not in ("", "standard"):
            return None
        tok = (r["input"] * pin + r["output"] * pout + r["cw5m"] * w5 + r["cw1h"] * w1 + r["cr"] * pr) / 1e6 * gm
        return tok + r["web_search"] * self.t["webSearchPerThousand"] / 1000.0


def recount(projects):
    best = {}
    skips = defaultdict(int)
    files = transcripts(projects)
    for order, (path, folder, is_sub) in enumerate(files):
        with open(path, "rb") as fh:
            for ln, raw in enumerate(fh):
                r = read_reply(raw)
                if isinstance(r, str):
                    skips[r] += 1
                    continue
                r["session"] = r["session"] or folder
                r["file"] = path
                old = best.get(r["key"])
                if old is None or r["output"] >= old["output"]:
                    if old is not None and old["file"] != path:
                        skips["same reply in two files"] += 1
                    best[r["key"]] = r
                else:
                    skips["older line of a reply"] += 1
    return best, skips, len(files)


def summarize(replies, prices):
    total = defaultdict(int)
    total_cost = 0.0
    unpriced = defaultdict(int)
    by_session = defaultdict(lambda: defaultdict(int))
    by_model = defaultdict(lambda: defaultdict(int))
    cost_session = defaultdict(float)
    effort_session = defaultdict(lambda: defaultdict(int))
    for r in replies.values():
        c = prices.cost(r)
        for f in FIELDS:
            total[f] += r[f]
            by_session[r["session"]][f] += r[f]
            by_model[r["model"]][f] += r[f]
        total["replies"] += 1
        by_session[r["session"]]["replies"] += 1
        by_model[r["model"]]["replies"] += 1
        if r["effort"]:
            effort_session[r["session"]][r["effort"]] += 1
        if c is None:
            unpriced[r["model"]] += 1
        else:
            total_cost += c
            cost_session[r["session"]] += c
    return total, total_cost, unpriced, by_session, by_model, cost_session, effort_session


def atlas_sessions(cache):
    """Per-session sums from Atlas's cache: the raw `messages` rows and the `session_model` roll-up."""
    con = sqlite3.connect(f"file:{cache}?mode=ro", uri=True)
    q = "SELECT session_id, SUM(input), SUM(output), SUM(cw5m), SUM(cw1h), SUM(cr), {n} FROM {t} GROUP BY session_id"
    raw = {r[0]: dict(zip(FIELDS + ("replies",), r[1:])) for r in con.execute(q.format(n="COUNT(*)", t="messages"))}
    roll = {r[0]: dict(zip(FIELDS + ("replies",), r[1:])) for r in con.execute(q.format(n="SUM(messages)", t="session_model"))}
    hour = dict(zip(FIELDS + ("replies",), con.execute(
        "SELECT SUM(input), SUM(output), SUM(cw5m), SUM(cw1h), SUM(cr), SUM(messages) FROM usage_hour").fetchone()))
    eff = {}
    try:
        for sid, e, k in con.execute("SELECT session_id, effort, COUNT(*) FROM messages WHERE effort IS NOT NULL GROUP BY 1, 2"):
            eff.setdefault(sid, {})[e] = k
    except sqlite3.OperationalError:
        eff = None  # an older cache with no effort column
    con.close()
    return raw, roll, hour, eff


def fmt(n):
    return f"{n:,}"


def pct(a, b):
    return 0.0 if b == 0 else (a - b) / b * 100


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--projects", default=projects_default())
    ap.add_argument("--prices", default=DEFAULT_PRICES)
    ap.add_argument("--compare", help="an Atlas cache.sqlite built from the same files")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--json", help="write the per-session recount here")
    a = ap.parse_args()

    prices = Prices(a.prices)
    replies, skips, nfiles = recount(a.projects)
    total, cost, unpriced, by_s, by_m, cost_s, eff_s = summarize(replies, prices)

    print(f"Recount of {a.projects}")
    print(f"  files {fmt(nfiles)}, replies {fmt(total['replies'])}, sessions {fmt(len(by_s))}")
    print("  " + ", ".join(f"{k} {fmt(v)}" for k, v in sorted(skips.items())))
    print("  " + ", ".join(f"{f} {fmt(total[f])}" for f in FIELDS))
    print(f"  est. cost ${cost:,.2f} (prices {prices.t.get('updated')}); not priced: "
          + (", ".join(f"{m} x{n}" for m, n in sorted(unpriced.items())) or "none"))
    print("  by model:")
    for m, v in sorted(by_m.items(), key=lambda kv: -sum(kv[1][f] for f in FIELDS)):
        print(f"    {m:28} replies {fmt(v['replies']):>9}  " + "  ".join(f"{f} {fmt(v[f])}" for f in FIELDS))

    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump({"total": total, "cost": cost, "sessions": by_s, "effort": eff_s}, f, indent=1)

    if not a.compare:
        return 0
    raw, roll, hour, eff = atlas_sessions(a.compare)
    print(f"\nAtlas cache {a.compare}")
    ok = True
    for name, src in (("messages", raw), ("session_model", roll)):
        t = {f: sum(s.get(f) or 0 for s in src.values()) for f in FIELDS + ("replies",)}
        line = ", ".join(f"{f} {fmt(t[f])} ({t[f] - total[f]:+,}, {pct(t[f], total[f]):+.3f}%)" for f in FIELDS + ("replies",))
        print(f"  {name:13}: {line}")
        ok &= all(abs(pct(t[f], total[f])) <= 0.5 for f in FIELDS)
    line = ", ".join(f"{f} {fmt(hour[f] or 0)} ({(hour[f] or 0) - total[f]:+,})" for f in FIELDS + ("replies",))
    print(f"  {'usage_hour':13}: {line}")

    sids = set(by_s) | set(raw)
    diffs = []
    for sid in sids:
        mine, theirs = by_s.get(sid, {}), raw.get(sid, {})
        d = {f: (theirs.get(f) or 0) - (mine.get(f) or 0) for f in FIELDS + ("replies",)}
        if any(d.values()):
            diffs.append((sum(abs(d[f]) for f in FIELDS), sid, d))
    diffs.sort(reverse=True)
    print(f"  sessions with any token difference: {len(diffs)} of {len(sids)}")
    for _, sid, d in diffs[: a.top]:
        print(f"    {sid}  " + "  ".join(f"{f} {d[f]:+,}" for f in FIELDS + ("replies",) if d[f]))
    if eff is not None:
        bad = [s for s in set(eff_s) | set(eff) if dict(eff_s.get(s, {})) != eff.get(s, {})]
        print(f"  sessions whose effort mix differs: {len(bad)}")
        for s in bad[: a.top]:
            print(f"    {s}  recount {dict(eff_s.get(s, {}))}  atlas {eff.get(s, {})}")
    print("RESULT:", "PASS" if ok and not diffs else "DIFF")
    return 0 if ok and not diffs else 1


if __name__ == "__main__":
    sys.exit(main())
