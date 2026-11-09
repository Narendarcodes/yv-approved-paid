"""Lean deal-agent web service (the Render free instance: 512 MB, no Redis/Qdrant/torch/litellm).

Only Node calls it, server to server, with the shared secret in X-Agent-Secret
(AGENT_SHARED_SECRET on both sides). It holds no user data and no signing keys:
Node sends an identity-free view of one deal and gets back render actions.

  GET  /health               liveness for Render (no auth, no LLM call)
  POST /v1/deals/copilot     {question, deal, redact?} -> {source:"live", actions, note, provider, model}
                             503 when no provider answered (Node then serves the offline replay)
  POST /v1/chat              Brand Brain, same SSE contract as the full agent (app.main):
                             meta -> token* -> answer -> done (or error -> done). Node sends a
                             service JWT (verified HERE with SERVICE_JWT_SECRET: Render cannot reach
                             Node's loopback /internal listener) and pushes the org's brand rules,
                             posts, metrics and review comments in `context`. LLM_MODEL=chain streams
                             River -> NIM over plain httpx; brand memory is an in-process index.

AI checks facts, people own taste, the deal decides the money: nothing here sets
an amount or a verdict (see app/deals/copilot.py).
"""
from __future__ import annotations
import hmac
import json
import logging
import os

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import service_token, telemetry
from .deals import copilot
from .deals.identity import IdentityLeak
from .deals.llm_router import LLMRouter, default_chain
from .flows import Ctx, answer_stream
from .lite_index import LiteBrandIndex
from .llm import LLM, BudgetExceeded, TokenBudget
from .pushed_context import LEAN_LIMIT, PushedContext

log = logging.getLogger("yv.deals.service")
telemetry.init("yv-deals-agent")
app = FastAPI(title="yv. deal agent", version="1.0.0", docs_url=None, redoc_url=None, openapi_url=None)


class CopilotIn(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    deal: dict
    redact: list[str] = Field(default_factory=list, max_length=20)


def _secret() -> str:
    return os.environ.get("AGENT_SHARED_SECRET", "")


def _check(given: str) -> None:
    want = _secret()
    if len(want) < 32:  # refuse to run open: an unset/weak secret means "not configured"
        raise HTTPException(503, "AGENT_SHARED_SECRET is not configured")
    if not given or not hmac.compare_digest(given.encode(), want.encode()):
        raise HTTPException(401, "bad agent secret")


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    postId: str | None = None
    history: list[dict] = Field(default_factory=list)
    context: dict | None = None  # pushed by Node: brandRules, posts, metrics, reviewComments


_budget = TokenBudget()  # in-process per-org daily budget (one worker, no Redis on the lean image)


def _chat_claims(authorization: str, x_agent_secret: str) -> dict:
    if len(_secret()) >= 32:  # the shared secret Node already sends to the copilot: checked when set
        _check(x_agent_secret)
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing service token")
    secret = os.environ.get("SERVICE_JWT_SECRET", "")
    if not secret:
        raise HTTPException(503, "SERVICE_JWT_SECRET is not configured on the agent")
    try:
        return service_token.verify(authorization[7:], secret, scope="brand:read")
    except service_token.TokenError as e:
        raise HTTPException(401, f"service token rejected: {e}") from e


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@app.post("/v1/chat")
async def chat(body: ChatIn, authorization: str = Header(default=""), x_agent_secret: str = Header(default="")):
    claims = _chat_claims(authorization, x_agent_secret)
    org_id = str(claims["orgId"])
    if body.context is None:
        raise HTTPException(400, "context is required (this agent does not call back into Node)")
    if len(json.dumps(body.context, default=str)) > 400_000:
        raise HTTPException(413, "context too large")
    try:
        node = PushedContext(body.context)
    except Exception as e:
        raise HTTPException(422, f"bad context: {str(e)[:200]}") from e

    async def gen():
        ctx = Ctx(org_id=org_id, node=node, index=LiteBrandIndex(), llm=LLM(_budget))
        try:
            with telemetry.span("agent.chat", org_id=org_id):
                async for ev in answer_stream(ctx, body.message, body.postId):
                    if ev["event"] == "answer" and ev["data"].get("flow") == "insight":
                        ev["data"].setdefault("dataLimits", []).append(LEAN_LIMIT)
                    yield _sse(ev["event"], ev["data"])
        except BudgetExceeded as e:
            yield _sse("error", {"code": "budget_exceeded", "message": str(e)})
        except Exception as e:  # surface, don't hang the stream
            log.exception("chat failed")
            yield _sse("error", {"code": "agent_error", "message": str(e)[:300]})
        finally:
            yield "event: done\ndata: {}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"cache-control": "no-cache", "x-accel-buffering": "no"})


@app.get("/health")
@app.get("/healthz")
async def health():
    chain = default_chain()
    return {
        "ok": True,
        "service": "yv-deals-agent",
        "chain": [{"name": p.name, "model": p.model} for p in chain],
        "offline": os.environ.get("LLM_OFFLINE") == "1",
        "configured": len(_secret()) >= 32,
        "chat": {"model": os.environ.get("LLM_MODEL", "stub"), "configured": bool(os.environ.get("SERVICE_JWT_SECRET"))},
    }


@app.post("/v1/deals/copilot")
async def deal_copilot(body: CopilotIn, x_agent_secret: str = Header(default="")):
    _check(x_agent_secret)
    if len(str(body.deal)) > 20_000:
        raise HTTPException(413, "deal view too large")
    router = LLMRouter()
    try:
        ans = await copilot.answer(router, body.question, body.deal, body.redact)
    except IdentityLeak:
        raise HTTPException(422, "identity left in the prompt; refused")
    if not ans:
        log.warning("copilot: no provider answered %s", [{k: c.get(k) for k in ("provider", "ok", "error")} for c in router.calls])
        raise HTTPException(503, "no LLM provider answered")
    return {"source": "live", **ans, "trace": [{k: c.get(k) for k in ("provider", "ok", "ms", "cached")} for c in router.calls]}
