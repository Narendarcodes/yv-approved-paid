"""LLM router fallback/cache/offline + agent contracts (AI never sets amounts or verdicts)."""
import asyncio
import json

import pytest

from app.deals.llm_router import LLMRouter, Provider, default_chain
from app.deals.agents import ReviewAgent, ScopeDisputeAgent, VideoQAAgent
from app.deals.identity import Redactor
from tests.deals_fixtures import TERMS

M = TERMS["milestones"][0]
P = [Provider("river", "r", "https://api.river.ai/v1"), Provider("nim", "n", "https://integrate.api.nvidia.com/v1"), Provider("omniroute", "o", "http://127.0.0.1:20128/v1")]


def scripted(answers):
    """answers: provider name -> str reply or Exception."""
    log = []

    async def caller(p, messages, max_tokens):
        log.append(p.name)
        a = answers[p.name]
        if isinstance(a, Exception):
            raise a
        return a

    return caller, log


def run(c):
    return asyncio.run(c)


def test_chain_order_and_omniroute_opt_in(monkeypatch):
    monkeypatch.delenv("OMNIROUTE_URL", raising=False)
    assert [p.name for p in default_chain()] == ["river", "nim"]
    monkeypatch.setenv("OMNIROUTE_URL", "http://127.0.0.1:20128/v1")
    assert [p.name for p in default_chain()] == ["river", "nim", "omniroute"]


def test_falls_through_on_error_and_bad_json_then_caches(tmp_path):
    caller, log = scripted({"river": TimeoutError("slow"), "nim": "not json", "omniroute": '```json\n{"ok": 1}\n```'})
    r = LLMRouter(chain=P, caller=caller, cache_dir=tmp_path, offline=False)
    assert run(r.json("t", "sys", {"a": 1})) == {"ok": 1}
    assert log == ["river", "nim", "omniroute"]
    # second identical ask: served from cache, no provider called (River credits saved)
    assert run(r.json("t", "sys", {"a": 1})) == {"ok": 1}
    assert log == ["river", "nim", "omniroute"] and r.calls[-1]["cached"]


def test_validate_rejects_and_falls_through(tmp_path):
    caller, log = scripted({"river": '{"x": 1}', "nim": '{"tags": []}', "omniroute": "{}"})
    r = LLMRouter(chain=P, caller=caller, cache_dir=tmp_path, offline=False)
    assert run(r.json("t", "s", {}, validate=lambda d: "tags" in d)) == {"tags": []}
    assert log == ["river", "nim"]


def test_offline_never_calls_and_all_down_returns_none(tmp_path):
    caller, log = scripted({"river": "{}", "nim": "{}", "omniroute": "{}"})
    assert run(LLMRouter(chain=P, caller=caller, cache_dir=tmp_path, offline=True).json("t", "s", {})) is None
    assert log == []
    caller, log = scripted({k: RuntimeError("down") for k in ("river", "nim", "omniroute")})
    assert run(LLMRouter(chain=P, caller=caller, cache_dir=tmp_path, offline=False).json("t", "s", {"b": 2})) is None


def test_router_redacts_before_sending(tmp_path):
    sent = []

    async def caller(p, messages, mt):
        sent.append(messages[1]["content"])
        return "{}"

    red = Redactor.for_deal(TERMS)
    run(LLMRouter(chain=P[:1], caller=caller, cache_dir=tmp_path, offline=False).json("t", "s", {"c": "John Miller, john@example.com"}, redactor=red))
    assert "John" not in sent[0] and "example.com" not in sent[0]


# ------------------------------------------------------------------ Review agent
def test_review_rule_tags_and_contradiction():
    comments = [
        {"reviewer": "A", "text": "The logo is missing in the first 3 seconds"},
        {"reviewer": "B", "text": "Logo missing in first 3 seconds!"},
        {"reviewer": "A", "text": "Make the audio louder"},
        {"reviewer": "B", "text": "Make the audio quieter"},
        {"reviewer": "B", "text": "I prefer a warmer vibe"},
    ]
    p = run(ReviewAgent(None).run("d1", M, comments, failed_checks=["c_logo"]))
    items = p.body["items"]
    assert len(items) == 4, "duplicate logo asks merged"
    assert items[0]["tag"] == "fix" and items[0]["checklistId"] == "c_logo"
    assert items[1]["tag"] == "fix" and items[1]["checklistId"] == "c_loud"
    assert items[-1]["tag"] == "taste" and items[-1]["checklistId"] is None
    assert p.body["contradictions"] == [{"a": 2, "b": 3, "why": "'louder' vs 'quieter'"}]
    assert items[1]["disputed"] and items[2]["disputed"]
    assert p.route.endswith("/milestones/m1/changes") and p.needs_human and p.policy_action is None


def test_review_llm_cannot_invent_a_checklist_line(tmp_path):
    caller, _ = scripted({"river": json.dumps({"tags": [{"i": 0, "tag": "fix", "checklistId": "made_up"}]})})
    r = LLMRouter(chain=P[:1], caller=caller, cache_dir=tmp_path, offline=False)
    p = run(ReviewAgent(r).run("d1", M, [{"text": "the transition at the middle is off"}]))
    assert p.body["items"][0] == {"text": "the transition at the middle is off", "tag": "taste", "checklistId": None, "disputed": False}


# ------------------------------------------------------------------ Scope & Dispute
def test_scope_prices_only_from_rate_card(tmp_path):
    caller, _ = scripted({"river": json.dumps({"in_scope": False, "rateCardItemId": "rc_extra_cut", "quantity": 2, "why": "two cut-downs", "amountMinor": 1})})
    r = LLMRouter(chain=P[:1], caller=caller, cache_dir=tmp_path, offline=False)
    p = run(ScopeDisputeAgent(r).scope("d1", TERMS, M, "Can you also make a 15s and a 6s cut-down?"))
    assert p.body["amountMinor"] == 16000, "2 x 8000 from the signed rate card; the LLM's own number is ignored"
    assert p.policy_action == {"kind": "invoice", "milestoneKey": "m1", "rateCardItemId": "rc_extra_cut", "quantity": 2, "amountMinor": 16000}
    assert p.needs_human


def test_scope_unknown_rate_item_is_not_priced(tmp_path):
    caller, _ = scripted({"river": json.dumps({"in_scope": False, "rateCardItemId": "rc_dance", "quantity": 1})})
    r = LLMRouter(chain=P[:1], caller=caller, cache_dir=tmp_path, offline=False)
    p = run(ScopeDisputeAgent(r).scope("d1", TERMS, M, "add a dance scene"))
    assert p.body["priced"] is False and p.policy_action is None and "amountMinor" not in p.body


def test_dispute_split_is_checklist_arithmetic_and_capped():
    checks = [c for c in M["checklist"] if c["kind"] == "check"]
    results = [{"checklist_id": c["id"], "passed": i < 8, "evidence": [{"t_start": 0, "t_end": 1}]} for i, c in enumerate(checks)]
    ev, split = ScopeDisputeAgent(None).dispute("d1", TERMS, M, {"capturedMinor": 0, "revisionRoundsUsed": 2}, results)
    assert split.body == {"workerMinor": 40000}  # 8/10 checks -> 80% of 50000
    assert split.policy_action["kind"] == "partial_capture" and split.policy_action["reason"] == "dispute_split"
    assert split.needs_human and "BOTH" in split.rationale
    assert "verdict" not in json.dumps(ev.body).lower()
    _, split2 = ScopeDisputeAgent(None).dispute("d1", TERMS, M, {"capturedMinor": 45000}, results)
    assert split2.body["workerMinor"] == 5000, "never more than what is still held"


def test_video_qa_llm_note_cannot_flip_a_result(tmp_path, monkeypatch):
    from app.deals import agents as ag
    from app.deals.media import CheckResult

    class FakeChecker:
        def __init__(self, *a, **k):
            pass

        def run(self, checklist):
            return [CheckResult("c_len", "duration_s", 9.5, {}, False), CheckResult("c_res", "resolution_p", 1080, {}, True)]

    monkeypatch.setattr(ag, "VideoChecker", FakeChecker)
    caller, _ = scripted({"river": json.dumps({"notes": {"c_len": "Trim 1.5 s.", "c_res": "actually this failed"}, "passed": True})})
    r = LLMRouter(chain=P[:1], caller=caller, cache_dir=tmp_path, offline=False)
    _, prop = run(VideoQAAgent(r).run("d1", M, {"id": "v1", "sha256": "x" * 64}, "f.mp4", str(tmp_path)))
    assert prop.body["passed"] is False and prop.body["failed"] == ["c_len"]
    assert prop.body["notes"] == {"c_len": "Trim 1.5 s."}
