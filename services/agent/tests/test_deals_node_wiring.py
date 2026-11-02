"""Agent proposals -> Node deal routes: dry-run first, blocked proposals never posted; STT is a stub offline."""
import asyncio
import json
import os
import shutil

import httpx
import pytest

from app.deals import stt
from app.deals.agents import ReviewAgent, ScopeDisputeAgent, VideoQAAgent
from app.deals.node_deals import AMOUNT_KEY, DealsNode, dispute_body, review_body
from app.node_client import NodeClient
from tests.deals_fixtures import CHECKLIST, SCRIPT, TERMS, TRANSCRIPT_OK, logo_png, make_video

M = TERMS["milestones"][0]


class FakeDeals:
    def __init__(self, allow=True):
        self.calls, self.allow = [], allow

    def handler(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content or b"{}")
        self.calls.append((req.method, req.url.path, body))
        if req.headers.get("authorization") != "Bearer svc":
            return httpx.Response(401, json={"error": {"code": "invalid_service_token"}})
        if req.url.path.endswith("/policy-check"):
            ok = self.allow
            return httpx.Response(200, json={"data": {"allowed": ok, "needsHumanApproval": False,
                                                      "violations": [] if ok else [{"rule": "P3_amount", "message": "no"}]}})
        if req.url.path.endswith("/checks"):
            return httpx.Response(201, json={"data": {"reportId": "chk_1", "passed": body["passed"], "failed": body["failed"]}})
        if req.url.path.endswith("/review"):
            return httpx.Response(201, json={"data": {"id": "rvw_1", "agent": "review", **body,
                                                      "decision": {"allowed": True, "violations": []}}})
        if req.url.path.endswith("/dispute-proposal"):
            # Node computes the split; the fake answers like it (80% of 30000)
            return httpx.Response(201, json={"data": {"id": "dsp_1", "agent": "scope_dispute", "workerMinor": 24000,
                                                      "decision": {"allowed": True, "violations": []}}})
        if req.url.path.endswith("/change-orders"):
            return httpx.Response(201, json={"data": {"changeOrder": {"id": "co_1", "status": "draft", **body}}})
        return httpx.Response(404, json={"error": {"code": "not_found"}})


def client(fake):
    return DealsNode(NodeClient("svc", base_url="http://node/internal", transport=httpx.MockTransport(fake.handler)))


def test_change_order_is_dry_run_then_drafted():
    fake = FakeDeals()
    p = asyncio.run(ScopeDisputeAgent(None).scope("deal_1", TERMS, M, "also make a 15 second cut-down version"))
    if not p.body.get("priced"):  # rule pass alone may not price it; force the rate-card pick the LLM would make
        from app.deals.agents import Proposal
        item = TERMS["rateCard"][0]
        p = Proposal("scope_dispute", "change_order", "POST /internal/deals/deal_1/change-orders",
                     {"ask": "cut-down", "in_scope": False, "priced": True, "rateCardItemId": item["id"], "quantity": 1, "amountMinor": item["unitPriceMinor"]},
                     policy_action={"kind": "invoice", "milestoneKey": M["key"], "rateCardItemId": item["id"], "quantity": 1, "amountMinor": item["unitPriceMinor"]})
    s = asyncio.run(client(fake).submit("deal_1", p))
    assert s.status == "posted"
    paths = [c[1] for c in fake.calls]
    assert paths == ["/internal/deals/deal_1/policy-check", "/internal/deals/deal_1/change-orders"]
    assert fake.calls[0][2]["kind"] == "money" and fake.calls[0][2]["action"]["kind"] == "invoice"


def test_blocked_proposal_is_never_posted():
    fake = FakeDeals(allow=False)
    ev, split = ScopeDisputeAgent(None).dispute("deal_1", TERMS, M, {"capturedMinor": 0}, [])
    s = asyncio.run(client(fake).submit("deal_1", split))
    assert s.status == "blocked"
    assert [c[1] for c in fake.calls] == ["/internal/deals/deal_1/policy-check"]


def test_review_changes_are_dry_run_and_left_for_the_client():
    fake = FakeDeals()
    p = asyncio.run(ReviewAgent(None).run("deal_1", M, [{"text": "The audio is too quiet", "reviewer": "r1"}], failed_checks=["c_loud"]))
    s = asyncio.run(client(fake).submit("deal_1", p))
    assert s.status == "for_human" and s.decision["allowed"]  # the client sends it, not the agent
    assert fake.calls[0][2]["kind"] == "request_changes" and fake.calls[0][2]["milestoneKey"] == M["key"]
    # ...but the merge is stored on the milestone so the deal page can show it
    assert [c[1] for c in fake.calls] == ["/internal/deals/deal_1/policy-check", f"/internal/deals/deal_1/milestones/{M['key']}/review"]
    stored = fake.calls[1][2]
    assert set(stored) <= {"items", "contradictions", "rationale", "versionId"}
    assert stored["items"] and all(set(i) <= {"text", "tag", "checklistId", "disputed"} for i in stored["items"])
    assert s.posted["id"] == "rvw_1"
    assert not any(c[1].endswith("/changes") for c in fake.calls)


def test_review_contradictions_map_onto_merged_items():
    comments = [{"text": "make the music louder", "reviewer": "a"}, {"text": "make the music louder please", "reviewer": "b"},
                {"text": "make the music quieter", "reviewer": "c"}]
    p = asyncio.run(ReviewAgent(None).run("deal_1", M, comments))
    body = review_body(p)
    n = len(body["items"])
    assert n == len(p.body["merged_from"])
    for c in body["contradictions"]:
        assert 0 <= c["a"] < n and 0 <= c["b"] < n and c["a"] != c["b"]


def test_dispute_proposal_is_stored_with_no_amount():
    fake = FakeDeals()
    ev, split = ScopeDisputeAgent(None).dispute("deal_1", TERMS, M, {"capturedMinor": 0}, [])
    s = asyncio.run(client(fake).submit("deal_1", split))
    assert s.status == "for_human"  # both parties still accept it in the UI
    method, path, body = fake.calls[-1]
    assert (method, path) == ("POST", f"/internal/deals/deal_1/milestones/{M['key']}/dispute-proposal")
    assert "workerMinor" not in body
    assert not any(AMOUNT_KEY.search(k) for k in body), body
    assert set(body) <= {"versionId", "notes"}
    assert s.posted["workerMinor"] == 24000  # the number comes back from Node


def test_store_dispute_body_refuses_amounts_and_sends_only_ids():
    assert dispute_body() == {}
    assert dispute_body("v2", "4 of 5 lines met") == {"versionId": "v2", "notes": "4 of 5 lines met"}
    fake = FakeDeals()
    asyncio.run(client(fake).store_dispute("deal_1", "reel2", version_id="v1"))
    assert fake.calls == [("POST", "/internal/deals/deal_1/milestones/reel2/dispute-proposal", {"versionId": "v1"})]


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_video_qa_uses_stt_stub_and_posts_evidence(tmp_path):
    logo = logo_png(tmp_path / "logo.pgm")
    good = make_video(tmp_path / "good.mp4", volume_db=7.0, logo=logo, logo_window=(0.0, 3.0))
    heard = []

    def fake_stt(path):
        heard.append(path)
        return TRANSCRIPT_OK

    ms = {**M, "checklist": CHECKLIST}
    results, p = asyncio.run(VideoQAAgent(None).run("deal_1", ms, {"id": "v1", "sha256": "a" * 64}, str(good), str(tmp_path / "ev"),
                                                    script=SCRIPT, assets={"logo": str(logo)}, stt=fake_stt))
    assert heard == [str(good)]
    assert p.body["passed"], p.body["failed"]
    fake = FakeDeals()
    s = asyncio.run(client(fake).submit("deal_1", p))
    assert s.status == "posted"
    method, path, body = fake.calls[-1]
    assert path == f"/internal/deals/deal_1/milestones/{M['key']}/checks"
    assert all(r["evidence"] for r in body["results"])
    assert set(body) == {"versionId", "sha256", "passed", "failed", "results", "notes"}


def test_stt_not_called_when_no_check_needs_words(tmp_path):
    ms = {**M, "checklist": [c for c in CHECKLIST if c["measure"]["metric"] in ("duration_s",)] if False else []}
    called = []
    # no checks at all -> nothing to transcribe, no file needed beyond probe; use a tiny video only if ffmpeg exists
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not installed")
    v = make_video(tmp_path / "v.mp4", dur=1.0)
    asyncio.run(VideoQAAgent(None).run("d", ms, {"id": "v1", "sha256": "a" * 64}, str(v), str(tmp_path / "ev"), stt=lambda p: called.append(p) or []))
    assert called == []


@pytest.mark.skipif(os.environ.get("RUN_WHISPER") != "1", reason="real faster-whisper run is opt-in (RUN_WHISPER=1, downloads the small model)")
def test_real_whisper_transcribes_speech():
    sample = os.environ.get("WHISPER_SAMPLE")
    assert sample and os.path.exists(sample), "set WHISPER_SAMPLE to a short speech clip"
    segs = stt.transcribe(sample)
    assert segs and all(s["end"] >= s["start"] for s in segs)
    assert len(" ".join(s["text"] for s in segs).split()) >= 2
