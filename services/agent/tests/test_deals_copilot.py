"""Live deal copilot: the model only picks cards and ids the deal offered; never money."""
import json

import pytest
from fastapi.testclient import TestClient

from app import deals_service
from app.deals import copilot
from app.deals.llm_router import LLMRouter, Provider

SECRET = "s" * 40
DEAL = {
    "id": "deal_demo",
    "title": "Diwali reels",
    "myRole": "client",
    "milestones": [{"key": "reel1", "title": "Reel 1", "state": "IN_REVIEW"}, {"key": "reel2", "title": "Reel 2", "state": "DISPUTED"}],
    "changeOrders": [{"id": "co_1", "milestoneKey": "reel1", "status": "draft"}],
}


def router_with(reply, tmp_path):
    async def caller(p, messages, max_tokens):
        caller.seen = messages
        if isinstance(reply, Exception):
            raise reply
        return reply if isinstance(reply, str) else json.dumps(reply)

    return LLMRouter(chain=[Provider("river", "m", "http://x")], caller=caller, cache_dir=tmp_path, offline=False), caller


def test_sanitize_drops_unknown_names_ids_and_amounts():
    out = copilot.sanitize(
        {
            "actions": [
                {"name": "moveMoney", "milestoneKey": "reel1"},
                {"name": "showChecks", "milestoneKey": "reel9"},
                {"name": "proposeCapture", "milestoneKey": "reel1", "amountMinor": 99999, "versionId": "v1"},
                {"name": "showChangeOrder", "changeOrderId": "co_404"},
                {"name": "showMoneyTimeline"},
            ],
            "note": "Capture $999 now",
        },
        DEAL,
    )
    assert out["actions"] == [{"name": "proposeCapture", "milestoneKey": "reel1"}, {"name": "showMoneyTimeline"}]
    assert out["note"] is None  # money in the note -> dropped


def test_sanitize_nothing_usable_is_none():
    assert copilot.sanitize({"actions": [{"name": "pay", "milestoneKey": "reel1"}]}, DEAL) is None


@pytest.mark.asyncio
async def test_answer_strips_identity_and_reports_provider(tmp_path):
    r, caller = router_with({"actions": [{"name": "showDisputeSplit", "milestoneKey": "reel2"}], "note": "Here is the split card."}, tmp_path)
    ans = await copilot.answer(r, "Asha Rao asks: show the dispute on reel 2", DEAL, redact=["Asha Rao"])
    assert ans["actions"] == [{"name": "showDisputeSplit", "milestoneKey": "reel2"}]
    assert ans["provider"] == "river" and ans["model"] == "m" and ans["cached"] is False
    sent = json.dumps(caller.seen)
    assert "Asha" not in sent and "Rao" not in sent


@pytest.mark.asyncio
async def test_answer_none_when_provider_fails(tmp_path):
    r, _ = router_with(RuntimeError("down"), tmp_path)
    assert await copilot.answer(r, "where is the money", DEAL) is None


def test_service_health_and_auth(monkeypatch, tmp_path):
    c = TestClient(deals_service.app)
    monkeypatch.delenv("AGENT_SHARED_SECRET", raising=False)
    h = c.get("/health").json()
    assert h["ok"] is True and h["configured"] is False
    body = {"question": "show the deal", "deal": DEAL}
    assert c.post("/v1/deals/copilot", json=body).status_code == 503  # not configured -> refuse
    monkeypatch.setenv("AGENT_SHARED_SECRET", SECRET)
    assert c.post("/v1/deals/copilot", json=body, headers={"X-Agent-Secret": "wrong"}).status_code == 401

    async def fake_answer(router, q, deal, redact):
        return {"actions": [{"name": "showDeal"}], "note": None, "provider": "nim", "model": "x", "cached": False}

    monkeypatch.setattr(copilot, "answer", fake_answer)
    r = c.post("/v1/deals/copilot", json=body, headers={"X-Agent-Secret": SECRET})
    assert r.status_code == 200 and r.json()["source"] == "live" and r.json()["actions"] == [{"name": "showDeal"}]

    async def no_answer(router, q, deal, redact):
        return None

    monkeypatch.setattr(copilot, "answer", no_answer)
    assert c.post("/v1/deals/copilot", json=body, headers={"X-Agent-Secret": SECRET}).status_code == 503
