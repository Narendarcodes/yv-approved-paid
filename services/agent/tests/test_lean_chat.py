"""Brand Brain on the lean deals service: POST /v1/chat with a pushed context and a locally verified
service JWT, same SSE contract as app.main; LLM timeouts fall back to a facts-only answer."""
import asyncio
import base64
import hashlib
import hmac
import json
import subprocess
import sys
import time

import pytest
from fastapi.testclient import TestClient

from app import deals_service, service_token
from app.flows import Ctx, answer_stream
from app.lite_index import LiteBrandIndex
from app.llm import LLM, TokenBudget
from app.pushed_context import PushedContext

SECRET = "s" * 40
ORG = "64b000000000000000000001"
RULES = [
    {"id": "r1", "title": "Logo placement", "body": "Logo sits bottom-right, never over faces.", "kind": "visual"},
    {"id": "r2", "title": "Colour palette", "body": "Use espresso brown and oat cream only.", "kind": "visual"},
    {"id": "r3", "title": "No hard sell", "body": "Avoid 'Buy now' in captions; say 'Try it' instead.", "kind": "dont"},
]


def _b64(obj) -> str:
    raw = json.dumps(obj, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def mint(secret=SECRET, **over):
    claims = {"orgId": ORG, "userId": "u1", "scopes": ["brand:read", "posts:read"], "iss": "yv-api", "aud": "yv-internal",
              "exp": int(time.time()) + 120, **over}
    h, p = _b64({"alg": "HS256", "typ": "JWT"}), _b64(claims)
    sig = hmac.new(secret.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()
    return f"{h}.{p}.{base64.urlsafe_b64encode(sig).decode().rstrip('=')}"


def events(text: str):
    out = []
    for blk in text.strip().split("\n\n"):
        lines = blk.split("\n")
        out.append((lines[0][len("event: "):], json.loads(lines[1][len("data: "):])))
    return out


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("SERVICE_JWT_SECRET", SECRET)
    monkeypatch.delenv("AGENT_SHARED_SECRET", raising=False)
    monkeypatch.setenv("LLM_MODEL", "stub")
    return TestClient(deals_service.app)


def test_chat_streams_brand_answer_with_titled_citations(client):
    r = client.post("/v1/chat", headers={"authorization": f"Bearer {mint()}"},
                    json={"message": "Where does the logo go?", "context": {"brandRules": RULES}})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    evs = events(r.text)
    assert [e for e, _ in evs][0] == "meta" and evs[0][1] == {"flow": "brand_qa"}
    assert [e for e, _ in evs][-2:] == ["answer", "done"]
    ans = evs[-2][1]
    assert ans["flow"] == "brand_qa" and "Logo placement" in ans["answer"]
    assert {c["metric"] for c in ans["citations"]} == {"brandRule"}
    assert all(c["note"] in {"Logo placement", "Colour palette", "No hard sell"} for c in ans["citations"])
    assert ans["citations"][0]["value"] == "r1"  # best match first


def test_chat_auth(client, monkeypatch):
    body = {"message": "logo?", "context": {"brandRules": RULES}}
    assert client.post("/v1/chat", json=body).status_code == 401
    assert client.post("/v1/chat", headers={"authorization": f"Bearer {mint('x' * 40)}"}, json=body).status_code == 401
    assert client.post("/v1/chat", headers={"authorization": f"Bearer {mint(exp=int(time.time()) - 600)}"}, json=body).status_code == 401
    assert client.post("/v1/chat", headers={"authorization": f"Bearer {mint(aud='other')}"}, json=body).status_code == 401
    assert client.post("/v1/chat", headers={"authorization": f"Bearer {mint(scopes=['posts:read'])}"}, json=body).status_code == 401
    assert client.post("/v1/chat", headers={"authorization": f"Bearer {mint()}"}, json={"message": "logo?"}).status_code == 400
    # shared secret, when configured, is required too
    monkeypatch.setenv("AGENT_SHARED_SECRET", "k" * 40)
    assert client.post("/v1/chat", headers={"authorization": f"Bearer {mint()}"}, json=body).status_code == 401
    ok = client.post("/v1/chat", headers={"authorization": f"Bearer {mint()}", "x-agent-secret": "k" * 40}, json=body)
    assert ok.status_code == 200
    # no secret on the agent -> not configured, never open
    monkeypatch.delenv("SERVICE_JWT_SECRET")
    assert client.post("/v1/chat", headers={"authorization": f"Bearer {mint()}", "x-agent-secret": "k" * 40}, json=body).status_code == 503


def test_org_comes_from_token_and_index_is_org_scoped():
    idx = LiteBrandIndex()
    ctx = PushedContext({"brandRules": RULES})
    asyncio.run(_reindex(idx, ctx))
    assert idx.count(ORG) == 3 and idx.count("other-org") == 0
    assert idx.search("other-org", "logo") == []
    with pytest.raises(ValueError):
        idx.search("", "logo")


async def _reindex(idx, ctx):
    idx.reindex(ORG, await ctx.get_brand_rules())


def test_verify_rejects_alg_none():
    h, p = _b64({"alg": "none"}), _b64({"orgId": ORG, "exp": time.time() + 60, "iss": "yv-api", "aud": "yv-internal"})
    with pytest.raises(service_token.TokenError):
        service_token.verify(f"{h}.{p}.", SECRET)


class _SlowLLM(LLM):
    """Every provider hangs: the first-token timeout and the deadline must still end the turn."""

    def _targets(self):
        return [("river", "openai/x", "http://river", "k", {}), ("nim", "openai/y", "http://nim", "k", {})]

    async def _provider_stream(self, *a, **k):
        await asyncio.sleep(30)
        yield "never"


def test_hanging_providers_fall_back_to_facts_within_deadline(monkeypatch):
    monkeypatch.setenv("LLM_FIRST_TOKEN_S", "0.3")
    monkeypatch.setenv("LLM_DEADLINE_S", "0.5")
    llm = _SlowLLM(TokenBudget(limit=10**9))
    llm.model = "chain"

    async def go():
        ctx = Ctx(org_id=ORG, node=PushedContext({"brandRules": RULES}), index=LiteBrandIndex(), llm=llm)
        return [ev async for ev in answer_stream(ctx, "Where does the logo go?")]

    t0 = time.monotonic()
    evs = asyncio.run(go())
    assert time.monotonic() - t0 < 3
    ans = evs[-1]["data"]
    assert ans["model"] == "facts-only" and "Logo placement" in ans["answer"]
    assert any("did not answer in time" in d for d in ans["dataLimits"])
    assert ans["citations"]


def test_httpx_stream_parses_openai_sse(monkeypatch):
    import httpx
    import respx

    from app import llm as llm_mod

    sse = 'data: {"choices":[{"delta":{"content":"<think>x</think>Logo "}}]}\n\ndata: {"choices":[{"delta":{"content":"bottom-right."}}]}\n\ndata: [DONE]\n\n'
    monkeypatch.setenv("LLM_CALLER", "httpx")
    monkeypatch.setenv("LLM_CHAIN", "nim")
    monkeypatch.setenv("NIM_API_BASE", "http://nim.test/v1")
    with respx.mock:
        route = respx.post("http://nim.test/v1/chat/completions").mock(return_value=httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"}))
        llm = llm_mod.LLM(TokenBudget(limit=10**9))
        llm.model = "chain"
        assert asyncio.run(llm.complete(ORG, "t", {}, "q")) == "Logo bottom-right."
        sent = json.loads(route.calls[0].request.content)
        assert sent["stream"] is True and sent["model"].startswith("nvidia/")
        assert sent["chat_template_kwargs"] == {"enable_thinking": False}


def test_lean_service_never_imports_heavy_deps():
    code = ("import sys, app.deals_service\n"
            "bad = [m for m in ('litellm', 'qdrant_client', 'numpy', 'redis', 'boto3', 'torch') if m in sys.modules]\n"
            "print(','.join(bad))")
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(__import__('pathlib').Path(__file__).parent.parent))
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == ""


class _StallLLM(_SlowLLM):
    """Starts answering, then goes silent: the turn must close with the partial text and a note."""

    async def _provider_stream(self, *a, **k):
        yield "No. 'Buy now' is hype, which the "
        await asyncio.sleep(30)
        yield "never"


def test_mid_answer_stall_closes_the_turn(monkeypatch):
    monkeypatch.setenv("LLM_STALL_S", "0.3")
    llm = _StallLLM(TokenBudget(limit=10**9))
    llm.model = "chain"

    async def go():
        ctx = Ctx(org_id=ORG, node=PushedContext({"brandRules": RULES}), index=LiteBrandIndex(), llm=llm)
        return [ev async for ev in answer_stream(ctx, "Can we say Buy now?")]

    t0 = time.monotonic()
    evs = asyncio.run(go())
    assert time.monotonic() - t0 < 3
    ans = evs[-1]["data"]
    assert ans["answer"].startswith("No. 'Buy now' is hype")
    assert any("stopped mid-answer" in d for d in ans["dataLimits"]) and ans["citations"]


def test_rule_ids_never_reach_the_model():
    seen = {}

    class _Spy(LLM):
        async def stream(self, org_id, task, facts, question):
            seen["msgs"] = json.dumps(self._messages(task, facts, question))
            yield "ok"

    async def go():
        ctx = Ctx(org_id=ORG, node=PushedContext({"brandRules": RULES}), index=LiteBrandIndex(), llm=_Spy(TokenBudget(limit=10**9)))
        return [ev async for ev in answer_stream(ctx, "logo rules?")]

    evs = asyncio.run(go())
    assert "Logo placement" in seen["msgs"] and '"r1"' not in seen["msgs"] and "ruleId" not in seen["msgs"]
    assert evs[-1]["data"]["citations"][0]["value"] == "r1"
