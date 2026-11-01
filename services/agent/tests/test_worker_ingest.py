import base64
import io
import json
import wave

import fakeredis.aioredis
import httpx
import pytest

from app.config import Settings
from app.contracts.JobEnvelope import JobEnvelope
from app.worker import Worker
from app.ingest import transcribe as T
from app.ingest.connectors import InstagramGraph, YouTubeAnalytics, Postiz
from tests.fake_node import FakeNode, ORG, P


def env(type_, payload, token="good"):
    return JobEnvelope(jobId="job-1", type=type_, orgId=ORG, userId="u1", payload=payload, attempt=0, createdAt="2026-10-15T00:00:00Z", serviceToken=token)


async def setup(fake, max_attempts=3):
    r = fakeredis.aioredis.FakeRedis(decode_responses=True)
    s = Settings(max_attempts=max_attempts, claim_idle_ms=60000)
    w = Worker(r, node_factory=lambda tok: fake.client(tok), settings=s, backoff_base_s=0)
    await w.ensure_group()
    return r, w, s


async def test_analyze_job_stores_insight_and_reports():
    fake = FakeNode()
    r, w, s = await setup(fake)
    await r.xadd(s.jobs_stream, {"type": "insights.analyze_post.v1", "envelope": env("insights.analyze_post.v1", {"postId": P["breath"]}).model_dump_json()})
    assert await w.run_once(block_ms=10) == 1
    assert fake.insights[0]["kind"] == "retention_spike" and fake.insights[0]["atSecond"] == 42
    assert fake.results[0]["status"] == "succeeded" and fake.results[0]["result"]["insightId"] == "ins1"
    assert (await r.xpending(s.jobs_stream, s.consumer_group))["pending"] == 0


async def test_failing_job_retries_then_dead_letters():
    fake = FakeNode()
    r, w, s = await setup(fake, max_attempts=2)
    # forged token -> Node 401 on every call
    await r.xadd(s.jobs_stream, {"type": "insights.analyze_post.v1", "envelope": env("insights.analyze_post.v1", {"postId": P["breath"]}, token="forged").model_dump_json()})
    await w.run_once(block_ms=10)  # attempt 1 -> re-enqueued
    await w.run_once(block_ms=10)  # attempt 2 -> DLQ
    dead = await r.xrange(s.dlq_stream)
    assert len(dead) == 1 and "401" in dead[0][1]["error"]
    assert (await r.xpending(s.jobs_stream, s.consumer_group))["pending"] == 0


async def test_review_digest_job():
    fake = FakeNode()
    r, w, s = await setup(fake)
    await r.xadd(s.jobs_stream, {"type": "review.digest.v1", "envelope": env("review.digest.v1", {"postId": P["dads"]}).model_dump_json()})
    await w.run_once(block_ms=10)
    assert fake.insights[0]["kind"] == "review_digest" and fake.results[0]["result"]["changes"] >= 3


def _wav(path, seconds=13, rate=16000):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(b"\x00\x00" * rate * seconds)


def test_chunk_wav(tmp_path):
    p = tmp_path / "a.wav"; _wav(p)
    chunks = T.chunk_wav(str(p), 6)
    assert [(a, b) for a, b, _ in chunks] == [(0.0, 6.0), (6.0, 12.0), (12.0, 13.0)]


async def test_transcribe_via_stt_url(tmp_path, monkeypatch):
    p = tmp_path / "a.wav"; _wav(p)
    monkeypatch.setenv("STT_URL", "http://stt/v1/transcribe")
    seen = []

    def h(req):
        body = json.loads(req.content); seen.append(body)
        assert body["engine"] == "whisper-turbo" and base64.b64decode(body["audio_b64"])[:4] == b"RIFF"
        return httpx.Response(200, json={"text": f"chunk {len(seen)}", "model": "openai/whisper-large-v3-turbo"})

    segs, engine = await T.transcribe(str(p), "en", transport=httpx.MockTransport(h))
    assert [s["start"] for s in segs] == [0.0, 6.0, 12.0] and segs[1]["text"] == "chunk 2"
    assert "whisper-large-v3-turbo" in engine


async def test_transcribe_job_with_fixture(tmp_path, monkeypatch):
    fake = FakeNode()
    p = tmp_path / "dads.wav"; _wav(p, 2)
    fake.media[P["dads"]]["storageKey"] = f"file://{p}"
    r, w, s = await setup(fake)
    await r.xadd(s.jobs_stream, {"type": "ingest.transcribe.v1", "envelope": env("ingest.transcribe.v1", {"postId": P["dads"]}).model_dump_json()})
    await w.run_once(block_ms=10)
    assert fake.media_puts[0][1]["transcriptEngine"] == "fixture" and len(fake.media_puts[0][1]["transcript"]) == 2


def test_connectors_normalise_fixtures():
    ret = YouTubeAnalytics(token="").retention("vid", "p1", 58)
    assert len(ret) == 101 and max(ret, key=lambda x: x.audienceWatchRatio).second == pytest.approx(41.76, abs=1)
    ig = {m.metric.value: m.value for m in InstagramGraph(token="").reel_metrics("m", "p2", "2026-10-15T00:00:00Z")}
    assert ig["saves"] == 6400 and ig["views"] == 96000
    assert Postiz().posts()[0]["id"] == "pz_1"


def test_scene_detection_on_synthetic_video(tmp_path):
    cv2 = pytest.importorskip("cv2")
    pytest.importorskip("scenedetect")
    import numpy as np
    from app.ingest.scenes import detect_cuts

    path = str(tmp_path / "v.mp4")
    out = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), 10, (64, 64))
    for i in range(40):
        out.write(np.full((64, 64, 3), 0 if i < 20 else 255, dtype=np.uint8))
    out.release()
    cuts = detect_cuts(path)
    assert any(abs(c["second"] - 2.0) < 0.3 for c in cuts)
