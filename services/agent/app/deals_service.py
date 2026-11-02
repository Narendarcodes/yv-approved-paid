"""Lean deal-agent web service (the Render free instance: 512 MB, no Redis/Qdrant/torch/litellm).

Only Node calls it, server to server, with the shared secret in X-Agent-Secret
(AGENT_SHARED_SECRET on both sides). It holds no user data and no signing keys:
Node sends an identity-free view of one deal and gets back render actions.

  GET  /health               liveness for Render (no auth, no LLM call)
  POST /v1/deals/copilot     {question, deal, redact?} -> {source:"live", actions, note, provider, model}
                             503 when no provider answered (Node then serves the offline replay)

AI checks facts, people own taste, the deal decides the money: nothing here sets
an amount or a verdict (see app/deals/copilot.py).
"""
from __future__ import annotations
import hmac
import logging
import os

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import telemetry
from .deals import copilot
from .deals.identity import IdentityLeak
from .deals.llm_router import LLMRouter, default_chain

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
