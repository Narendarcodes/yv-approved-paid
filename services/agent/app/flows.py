"""Router + flows. Each flow gathers facts through Node tools, computes everything numeric in
code, then asks the LLM only to phrase it. Citations and data limits are attached in code."""
from __future__ import annotations
import re
from dataclasses import dataclass, field
from typing import AsyncIterator

from . import analysis as A
from .config import get_settings
from .contracts.AgentAnswer import AgentAnswer
from .contracts.Citation import Citation
from .contracts.Insight import Insight
from .llm import LLM
from .node_client import NodeClient
from .vector import BrandIndex

ROUTES = [
    ("review_digest", r"\breview|feedback|comments?\b|change request|reviewers?|digest"),
    ("insight", r"\bwhy\b|viral|spike|rewatch|retention|went|perform|analy[sz]e|blew up|did .* well|underperform"),
    ("planner", r"\bplan\b|next week|ideas?|suggest|what should we post|calendar|content plan"),
    ("brand_qa", r"brand|rule|tone|voice|allowed|can we|colou?r|disclaimer|cta|audience|purpose|resource|sheet"),
]


def route(message: str) -> str:
    m = message.lower()
    for name, rx in ROUTES:
        if re.search(rx, m):
            return name
    return "brand_qa"


@dataclass
class Ctx:
    org_id: str
    node: NodeClient
    index: BrandIndex
    llm: LLM


@dataclass
class Prepared:
    flow: str
    task: str
    facts: dict
    citations: list[Citation] = field(default_factory=list)
    data_limits: list[str] = field(default_factory=list)
    insight: Insight | None = None


def _resolve_post(message: str, posts, post_id: str | None):
    if post_id:
        return next((p for p in posts if p.id == post_id), None)
    words = set(re.findall(r"\w+", message.lower())) - {"the", "a", "why", "did", "our", "video", "post", "reel", "go", "viral", "what", "is", "of"}
    best, score = None, 0
    for p in posts:
        s = len(words & set(re.findall(r"\w+", p.title.lower())))
        if s > score:
            best, score = p, s
    return best if score >= 2 else None


async def _ensure_index(ctx: Ctx):
    if ctx.index.count(ctx.org_id) == 0:
        ctx.index.reindex(ctx.org_id, await ctx.node.get_brand_rules())


async def brand_qa(ctx: Ctx, message: str, post_id: str | None = None) -> Prepared:
    await _ensure_index(ctx)
    hits = ctx.index.search(ctx.org_id, message, k=3)
    facts = {
        "headline": f"From your brand hub ({len(hits)} most relevant entries):",
        "bullets": [f"{h['title']}: {h['body']}" for h in hits],
        "rules": [{"ruleId": h["ruleId"], "title": h["title"], "body": h["body"], "kind": h["kind"]} for h in hits],
    }
    cites = [Citation(postId="brand", metric="brandRule", value=h["ruleId"], note=h["title"]) for h in hits]
    limits = [f"Answered only from the organisation's brand knowledge hub ({ctx.index.count(ctx.org_id)} entries); anything not written there is unknown."]
    return Prepared("brand_qa", "Answer the brand question using only these brand-hub entries; name the entry titles you rely on.", facts, cites, limits)


async def insight(ctx: Ctx, message: str, post_id: str | None = None, store: bool = False, job_id: str | None = None) -> Prepared:
    s = get_settings()
    posts = await ctx.node.get_posts()
    metrics = await ctx.node.get_metrics()
    by_post = A.metrics_by_post(metrics)
    base = A.org_baseline(by_post, posts)
    post = _resolve_post(message, posts, post_id)
    if post is None:  # default: the org's top outperformer
        top = A.winners(by_post, posts, base, top=1)
        post = next(p for p in posts if p.id == top[0]["postId"]) if top else None
    if post is None:
        return Prepared("insight", "Say there is no post data yet.", {"headline": "No posts with metrics yet."}, [], ["No metrics ingested for this organisation."])
    platform = getattr(post.platform, "value", post.platform)
    m = by_post.get(post.id, {})
    b = base.get(platform, {})
    views_lift = round(m.get("views", 0) / b["medianViews"], 2) if b.get("medianViews") else None
    er = A.engagement_rate(m)
    cites = [Citation(postId=post.id, metric="views", value=m.get("views", 0)),
             Citation(postId=post.id, metric="engagementRate", value=er)]
    if views_lift is not None:
        cites.append(Citation(postId=post.id, metric="viewsVsOrgMedian", value=views_lift, note=f"{platform} median {b['medianViews']:.0f} views over {b['posts']} posts"))
    bullets = [f"[post:{post.id}] \"{post.title}\" ({platform} {post.format}) has {m.get('views', 0):,.0f} views, "
               f"{views_lift}x the org's {platform} median of {b.get('medianViews', 0):,.0f}; engagement rate {er:.1%} vs median {b.get('medianEngagementRate', 0):.1%}."]
    limits = []
    facts: dict = {"post": {"id": post.id, "title": post.title, "platform": platform, "format": post.format, "durationSec": post.durationSec},
                   "metrics": m, "orgBaseline": b}
    spike_ctx = {}
    top_spike = None
    if platform == "youtube":
        limits.append(A.YOUTUBE_LIMIT)
        ret = await ctx.node.get_retention(post.id)
        spikes = A.find_spikes(ret, s.spike_min_lift)
        facts["retentionSpikes"] = spikes
        if spikes:
            top_spike = spikes[0]
            media = await ctx.node.get_media(post.id) or {}
            spike_ctx = A.context_at(top_spike["second"], media.get("transcript") or [], media.get("sceneCuts") or [], s.spike_window_s)
            facts["atSpike"] = spike_ctx
            cites.append(Citation(postId=post.id, metric=f"retention@{A.fmt_ts(top_spike['second'])}", value=top_spike["ratio"],
                                  note=f"expected {top_spike['expected']} from the surrounding curve, lift +{top_spike['lift']}"))
            bullets.append(f"Retention spikes at {A.fmt_ts(top_spike['second'])}: audienceWatchRatio {top_spike['ratio']} vs {top_spike['expected']} expected (+{top_spike['lift']}), i.e. viewers rewind to this moment.")
            if spike_ctx.get("spokenText"):
                bullets.append(f"Spoken there: \"{spike_ctx['spokenText']}\"")
            if spike_ctx.get("onScreen"):
                bullets.append(f"On screen: {spike_ctx['onScreen']} (cut at {A.fmt_ts(spike_ctx['sceneCutAt'])}).")
            if media.get("transcriptEngine"):
                limits.append(A.TRANSCRIPT_LIMIT + f" Transcript engine: {media['transcriptEngine']}.")
        else:
            bullets.append("No retention spike above the curve's own trend was found.")
    elif platform == "instagram":
        limits.append(A.INSTAGRAM_LIMIT)
        if m.get("views"):
            sr = round(m.get("saves", 0) / m["views"], 4)
            cites.append(Citation(postId=post.id, metric="saveRate", value=sr))
            bullets.append(f"Save rate {sr:.1%} and {m.get('shares', 0):,.0f} shares are the strongest available signal.")
    if any(getattr(x, "source", "") == "fixture" for x in metrics):
        limits.append(A.FIXTURE_LIMIT)
    facts["headline"] = f"Why \"{post.title}\" performed the way it did:"
    facts["bullets"] = bullets
    ins = None
    if store:
        summary = " ".join(bullets)
        ins = Insight(postId=post.id, kind="retention_spike" if top_spike else ("outperformer" if (views_lift or 0) >= 1 else "underperformer"),
                      summary=summary[:1500], atSecond=top_spike["second"] if top_spike else None,
                      spokenText=spike_ctx.get("spokenText") or None, onScreen=spike_ctx.get("onScreen") or None,
                      liftVsBaseline=views_lift, citations=cites, dataLimits=limits, jobId=job_id)
    return Prepared("insight", "Explain why this post performed as it did versus the org baseline; if there is a retention spike, tie it to what is spoken and shown at that second, then give one actionable takeaway.",
                    facts, cites, limits, ins)


async def planner(ctx: Ctx, message: str, post_id: str | None = None) -> Prepared:
    posts = await ctx.node.get_posts()
    metrics = await ctx.node.get_metrics()
    by_post = A.metrics_by_post(metrics)
    base = A.org_baseline(by_post, posts)
    wins = A.winners(by_post, posts, base, top=3)
    await _ensure_index(ctx)
    rules = ctx.index.search(ctx.org_id, "hook call to action voice visual dont medical advice", k=4)
    cites = [Citation(postId=w["postId"], metric="viewsVsOrgMedian", value=w["viewsVsMedian"], note=w["title"]) for w in wins]
    cites += [Citation(postId="brand", metric="brandRule", value=r["ruleId"], note=r["title"]) for r in rules]
    bullets = [f"Past winner [post:{w['postId']}] \"{w['title']}\": {w['views']:,.0f} views ({w['viewsVsMedian']}x {w['platform']} median), tags {', '.join(w['tags'])}." for w in wins]
    bullets += [f"Brand rule to keep: {r['title']} - {r['body']}" for r in rules[:2]]
    limits = [A.INSTAGRAM_LIMIT, "Plans extrapolate from this org's past winners; they are suggestions, not forecasts."]
    if any(getattr(x, "source", "") == "fixture" for x in metrics):
        limits.append(A.FIXTURE_LIMIT)
    facts = {"headline": "Plan built from your past winners and brand rules:", "bullets": bullets, "winners": wins, "brandRules": rules, "baseline": base}
    return Prepared("planner", "Propose a 1-week content plan (3-4 posts) that reuses what made the winners work and obeys the brand rules. Cite the winner post IDs.", facts, cites, limits)


async def review_digest(ctx: Ctx, message: str, post_id: str | None = None, store: bool = False, job_id: str | None = None) -> Prepared:
    posts = await ctx.node.get_posts()
    post = _resolve_post(message, posts, post_id)
    if post is None:
        # pick the post with review comments: try each until one has comments
        for p in posts:
            if await ctx.node.get_review_comments(p.id):
                post = p
                break
    if post is None:
        return Prepared("review_digest", "Say there are no review comments.", {"headline": "No review comments found."}, [], [])
    comments = await ctx.node.get_review_comments(post.id)
    clusters = A.cluster_comments(comments)
    await _ensure_index(ctx)
    rules = ctx.index.search(ctx.org_id, " ".join(c.body for c in comments)[:500], k=3)
    bullets = []
    for g in clusters:
        tc = f" at {', '.join(A.fmt_ts(t) for t in sorted(set(g['timecodes'])))}" if g["timecodes"] else ""
        bullets.append(f"{g['theme'].title()}{tc}: {g['comments'][0]['body']} (raised by {', '.join(g['authors'])}; {g['duplicates']} duplicate(s) merged)")
    cites = [Citation(postId=post.id, metric="reviewComments", value=len(comments), note=f"{len(clusters)} distinct changes")]
    cites += [Citation(postId="brand", metric="brandRule", value=r["ruleId"], note=r["title"]) for r in rules]
    facts = {"headline": f"Final change list for \"{post.title}\" ({len(comments)} comments -> {len(clusters)} changes):", "bullets": bullets,
             "post": {"id": post.id, "title": post.title},
             "clusters": clusters, "brandRules": rules}
    limits = ["Digest covers only comments stored in yv. for this post; verbal feedback is not included."]
    ins = None
    if store:
        ins = Insight(postId=post.id, kind="review_digest", summary="\n".join(bullets)[:1500], citations=cites, dataLimits=limits, jobId=job_id)
    return Prepared("review_digest", "Merge these reviewers' comments into ONE numbered final change list for the editor, deduplicated, with timecodes; flag any request that conflicts with a brand rule.", facts, cites, limits, ins)


FLOWS = {"brand_qa": brand_qa, "insight": insight, "planner": planner, "review_digest": review_digest}


async def answer_stream(ctx: Ctx, message: str, post_id: str | None = None) -> AsyncIterator[dict]:
    flow = route(message)
    yield {"event": "meta", "data": {"flow": flow}}
    prep = await FLOWS[flow](ctx, message, post_id)
    parts = []
    async for piece in ctx.llm.stream(ctx.org_id, prep.task, prep.facts, message):
        parts.append(piece)
        yield {"event": "token", "data": {"text": piece}}
    ans = AgentAnswer(flow=prep.flow, answer="".join(parts).strip(), citations=prep.citations, dataLimits=prep.data_limits, model=ctx.llm.model)
    yield {"event": "answer", "data": ans.model_dump(mode="json", exclude_none=True)}


async def answer(ctx: Ctx, message: str, post_id: str | None = None) -> AgentAnswer:
    final = None
    async for ev in answer_stream(ctx, message, post_id):
        if ev["event"] == "answer":
            final = ev["data"]
    return AgentAnswer.model_validate(final)
