"""Pure analysis functions (no I/O): baselines, retention spikes, what was spoken/on screen,
past winners, review-comment clustering. Deterministic, so flows can cite exact values."""
from __future__ import annotations
import re
from statistics import median

INSTAGRAM_LIMIT = ("Instagram Graph API gives aggregate reel metrics only (plays/views, reach, likes, comments, shares, saves); "
                   "there is no per-second retention, so Instagram answers cannot explain a specific moment.")
YOUTUBE_LIMIT = ("YouTube Analytics retention is an audienceWatchRatio curve (about 100 samples per video; per second for shorts); "
                 "a value above 1.0 means rewatches, but it cannot say who rewatched or why.")
FIXTURE_LIMIT = "These metrics are synthetic demo fixtures, not live platform data."
TRANSCRIPT_LIMIT = "Spoken text comes from a stored transcript; on-screen text comes from scene-cut labels, not frame-level OCR."

ENGAGE_KEYS = ("likes", "comments", "shares", "saves")


def metrics_by_post(metrics) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    for m in metrics:
        metric = getattr(m.metric, "value", m.metric)
        out.setdefault(m.postId, {})[metric] = m.value
    return out


def sources(metrics) -> set[str]:
    return {m.source for m in metrics if getattr(m, "source", None)}


def engagement_rate(m: dict) -> float:
    v = m.get("views") or 0
    return round(sum(m.get(k, 0) for k in ENGAGE_KEYS) / v, 4) if v else 0.0


def org_baseline(by_post: dict, posts) -> dict[str, dict[str, float]]:
    """Median views / engagement rate per platform across the org's posts."""
    plat = {p.id: getattr(p.platform, "value", p.platform) for p in posts}
    buckets: dict[str, list[dict]] = {}
    for pid, m in by_post.items():
        buckets.setdefault(plat.get(pid, "unknown"), []).append(m)
    base = {}
    for platform, ms in buckets.items():
        base[platform] = {
            "medianViews": median([m.get("views", 0) for m in ms]),
            "medianEngagementRate": round(median([engagement_rate(m) for m in ms]), 4),
            "posts": len(ms),
        }
    return base


def find_spikes(retention, min_lift: float, neighbour_s: tuple[float, float] = (4, 9)) -> list[dict]:
    """Retention spikes = local maxima rising >= min_lift above the mean of neighbouring samples
    (taken neighbour_s seconds away on both sides), i.e. above the curve's own decay trend."""
    pts = sorted(((p.second, p.audienceWatchRatio) for p in retention))
    if len(pts) < 5:
        return []
    out = []
    for i, (s, r) in enumerate(pts):
        left = [rr for ss, rr in pts if neighbour_s[0] <= s - ss <= neighbour_s[1]]
        right = [rr for ss, rr in pts if neighbour_s[0] <= ss - s <= neighbour_s[1]]
        if not left or not right:  # needs curve on both sides (skips the intro drop-off and the outro)
            continue
        neigh = left + right
        expected = sum(neigh) / len(neigh)
        lift = r - expected
        is_peak = (i == 0 or r >= pts[i - 1][1]) and (i == len(pts) - 1 or r >= pts[i + 1][1])
        if is_peak and lift >= min_lift:
            out.append({"second": s, "ratio": round(r, 3), "expected": round(expected, 3), "lift": round(lift, 3)})
    out.sort(key=lambda x: -x["lift"])
    # keep one peak per 5 s window
    kept: list[dict] = []
    for sp in out:
        if all(abs(sp["second"] - k["second"]) > 5 for k in kept):
            kept.append(sp)
    return kept


def context_at(second: float, transcript: list[dict], scenes: list[dict], window: float) -> dict:
    spoken = [seg["text"] for seg in transcript if seg["start"] <= second + window and seg["end"] >= second - window]
    near = [c for c in scenes if abs(c["second"] - second) <= window]
    near.sort(key=lambda c: abs(c["second"] - second))
    return {"spokenText": " ".join(spoken).strip(), "onScreen": (near[0].get("label") or "") if near else "",
            "sceneCutAt": near[0]["second"] if near else None}


def winners(by_post: dict, posts, baseline: dict, top: int = 3) -> list[dict]:
    rows = []
    for p in posts:
        m = by_post.get(p.id)
        platform = getattr(p.platform, "value", p.platform)
        if not m or platform not in baseline:
            continue
        b = baseline[platform]
        lift = round((m.get("views", 0) / b["medianViews"]) if b["medianViews"] else 0, 2)
        rows.append({"postId": p.id, "title": p.title, "platform": platform, "views": m.get("views", 0),
                     "engagementRate": engagement_rate(m), "viewsVsMedian": lift, "tags": list(p.tags or []),
                     "format": p.format, "durationSec": p.durationSec})
    rows.sort(key=lambda r: (-r["viewsVsMedian"], -r["engagementRate"]))
    return rows[:top]


THEMES = [
    ("audio", r"music|audio|voice|sound|volume|loud"),
    ("disclaimer", r"disclaimer|medical advice"),
    ("caption", r"caption|typo|spelling|subtitle"),
    ("cta", r"cta|end card|book now|join the next workshop|call to action"),
    ("opening", r"open|hook|start with|first shot"),
]


def cluster_comments(comments) -> list[dict]:
    groups: dict[str, dict] = {}
    for c in comments:
        body = c.body.lower()
        theme = next((t for t, rx in THEMES if re.search(rx, body)), "other")
        g = groups.setdefault(theme, {"theme": theme, "comments": [], "authors": set(), "timecodes": []})
        g["comments"].append({"commentId": c.id, "author": c.author, "body": c.body, "timecodeSec": c.timecodeSec})
        g["authors"].add(c.author)
        if c.timecodeSec is not None:
            g["timecodes"].append(c.timecodeSec)
    out = []
    for g in groups.values():
        g["authors"] = sorted(g["authors"])
        g["duplicates"] = len(g["comments"]) - 1
        out.append(g)
    order = [t for t, _ in THEMES] + ["other"]
    out.sort(key=lambda g: order.index(g["theme"]))
    return out


def fmt_ts(sec: float) -> str:
    sec = int(round(sec))
    return f"{sec // 60}:{sec % 60:02d}"
