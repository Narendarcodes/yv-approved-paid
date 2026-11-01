"""Redis Streams consumer: versioned jobs from Node -> handlers -> results POSTed to Node.
Retries with backoff by re-enqueueing attempt+1; after JOBS_MAX_ATTEMPTS the envelope goes to
the dead-letter stream and Node is told `dead_lettered`. Stale pending messages from crashed
consumers are reclaimed with XAUTOCLAIM."""
from __future__ import annotations
import asyncio
import json
import logging
import os

from . import telemetry
from .config import get_settings
from .contracts.JobEnvelope import JobEnvelope
from .contracts.JobResult import JobResult
from .deps import brand_index, llm
from .flows import Ctx, insight, review_digest
from .node_client import NodeClient

log = logging.getLogger("yv.worker")


async def _handle_analyze(env: JobEnvelope, ctx: Ctx) -> dict:
    prep = await insight(ctx, "", env.payload.get("postId"), store=True, job_id=env.jobId)
    text = await ctx.llm.complete(ctx.org_id, prep.task, prep.facts, "Why did this post perform this way?")
    if prep.insight is None:
        return {"insightId": None, "note": "no data"}
    prep.insight.summary = (text or prep.insight.summary)[:1500]
    iid = await ctx.node.create_insight(prep.insight)
    return {"insightId": iid, "postId": prep.insight.postId, "kind": prep.insight.kind.value, "atSecond": prep.insight.atSecond}


async def _handle_digest(env: JobEnvelope, ctx: Ctx) -> dict:
    prep = await review_digest(ctx, "", env.payload.get("postId"), store=True, job_id=env.jobId)
    text = await ctx.llm.complete(ctx.org_id, prep.task, prep.facts, "Merge the review comments into one final change list.")
    if prep.insight is None:
        return {"insightId": None}
    prep.insight.summary = (text or prep.insight.summary)[:1500]
    return {"insightId": await ctx.node.create_insight(prep.insight), "changes": len(prep.facts.get("clusters", []))}


async def _handle_transcribe(env: JobEnvelope, ctx: Ctx) -> dict:
    from .ingest import storage, transcribe

    post_id = env.payload["postId"]
    media = await ctx.node.get_media(post_id)
    if not media or not media.get("storageKey"):
        raise RuntimeError("post has no media asset to transcribe")
    local = await asyncio.to_thread(storage.download, media["storageKey"])
    segs, engine = await transcribe.transcribe(local, env.payload.get("language", "en"))
    body = {"transcript": segs, "transcriptEngine": engine}
    if local.lower().endswith((".mp4", ".mov", ".webm", ".mkv")):
        try:
            from .ingest.scenes import detect_cuts

            body["sceneCuts"] = await asyncio.to_thread(detect_cuts, local)
        except RuntimeError as e:
            log.warning("scene detection skipped: %s", e)
    await ctx.node.put_media(post_id, **body)
    return {"segments": len(segs), "engine": engine, "preview": " ".join(s["text"] for s in segs)[:200]}


async def _handle_index(env: JobEnvelope, ctx: Ctx) -> dict:
    rules = await ctx.node.get_brand_rules()
    return {"indexed": ctx.index.reindex(ctx.org_id, rules)}


HANDLERS = {
    "insights.analyze_post.v1": _handle_analyze,
    "review.digest.v1": _handle_digest,
    "ingest.transcribe.v1": _handle_transcribe,
    "brand.index.v1": _handle_index,
}


class Worker:
    def __init__(self, redis, node_factory=NodeClient, settings=None, backoff_base_s: float | None = None):
        self.r = redis
        self.s = settings or get_settings()
        self.node_factory = node_factory
        self.backoff = backoff_base_s if backoff_base_s is not None else float(os.environ.get("JOBS_BACKOFF_BASE_S", "0.5"))

    async def ensure_group(self):
        try:
            await self.r.xgroup_create(self.s.jobs_stream, self.s.consumer_group, id="0", mkstream=True)
        except Exception as e:
            if "BUSYGROUP" not in str(e):
                raise

    async def process(self, msg_id: str, fields: dict) -> str:
        raw = fields.get("envelope") or fields.get(b"envelope")
        raw = raw.decode() if isinstance(raw, bytes) else raw
        env = JobEnvelope.model_validate_json(raw)
        node = self.node_factory(env.serviceToken)
        ctx = Ctx(org_id=env.orgId, node=node, index=brand_index(), llm=llm())
        outcome = "succeeded"
        try:
            handler = HANDLERS.get(env.type.value)
            if handler is None:
                raise RuntimeError(f"no handler for {env.type.value}")
            with telemetry.span("agent.job", job_type=env.type.value, org_id=env.orgId):
                result = await handler(env, ctx)
            await node.post_job_result(JobResult(jobId=env.jobId, type=env.type.value, status="succeeded", result=result, attempts=env.attempt + 1))
        except Exception as e:
            log.warning("job %s (%s) attempt %s failed: %s", env.jobId, env.type.value, env.attempt + 1, e)
            if env.attempt + 1 < self.s.max_attempts:
                outcome = "retried"
                await asyncio.sleep(self.backoff * (2 ** env.attempt))
                nxt = env.model_copy(update={"attempt": env.attempt + 1})
                await self.r.xadd(self.s.jobs_stream, {"type": env.type.value, "envelope": nxt.model_dump_json()})
            else:
                outcome = "dead_lettered"
                await self.r.xadd(self.s.dlq_stream, {"type": env.type.value, "envelope": raw, "error": str(e)[:500]})
                try:
                    await node.post_job_result(JobResult(jobId=env.jobId, type=env.type.value, status="dead_lettered", error=str(e)[:500], attempts=env.attempt + 1))
                except Exception as e2:  # token may have expired; DLQ still holds it
                    log.error("could not report dead letter for %s: %s", env.jobId, e2)
        finally:
            await self.r.xack(self.s.jobs_stream, self.s.consumer_group, msg_id)
            await node.aclose()
        return outcome

    async def run_once(self, block_ms: int = 2000) -> int:
        n = 0
        claimed = await self.r.xautoclaim(self.s.jobs_stream, self.s.consumer_group, self.s.consumer_name, min_idle_time=self.s.claim_idle_ms, start_id="0-0", count=10)
        for msg_id, fields in (claimed[1] if claimed else []):
            if fields:
                await self.process(msg_id, fields)
                n += 1
        resp = await self.r.xreadgroup(self.s.consumer_group, self.s.consumer_name, {self.s.jobs_stream: ">"}, count=5, block=block_ms)
        for _stream, msgs in resp or []:
            for msg_id, fields in msgs:
                await self.process(msg_id, fields)
                n += 1
        return n

    async def run_forever(self):
        await self.ensure_group()
        log.info("worker %s consuming %s", self.s.consumer_name, self.s.jobs_stream)
        while True:
            try:
                await self.run_once()
            except Exception:
                log.exception("worker loop error")
                await asyncio.sleep(1)


def main():
    import redis.asyncio as aioredis

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    telemetry.init("yv-worker")
    r = aioredis.from_url(get_settings().redis_url, decode_responses=True)
    asyncio.run(Worker(r).run_forever())


if __name__ == "__main__":
    main()
