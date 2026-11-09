"""Private FastAPI agent service. Only Node calls it (chat proxied to the browser as SSE).
Incoming requests carry a Node-minted service JWT; we verify it by asking Node (/internal/whoami)
so the agent never holds the signing secret, and we take orgId from Node's answer."""
from __future__ import annotations
import asyncio
import contextlib
import hashlib
import json
import logging
import time

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import telemetry
from .deps import brand_index, llm
from .flows import Ctx, answer_stream, route
from .llm import BudgetExceeded
from .node_client import NodeClient, NodeError

log = logging.getLogger("yv.agent")
telemetry.init("yv-agent")


@contextlib.asynccontextmanager
async def _lifespan(_app):
    asyncio.get_running_loop().create_task(llm().warm())  # cold `import litellm` is >1 min; never on a request
    yield


app = FastAPI(title="yv. agent", version="1.0.0", lifespan=_lifespan)
_verified: dict[str, tuple[dict, float]] = {}


class ChatIn(BaseModel):
    message: str
    postId: str | None = None
    history: list[dict] = []


async def service_claims(authorization: str = Header(default="")) -> tuple[str, dict]:
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing service token")
    token = authorization[7:]
    key = hashlib.sha256(token.encode()).hexdigest()
    hit = _verified.get(key)
    if hit and hit[1] > time.time():
        return token, hit[0]
    node = NodeClient(token)
    try:
        claims = await node.whoami()
    except NodeError as e:
        raise HTTPException(401, "service token rejected by Node") from e
    finally:
        await node.aclose()
    _verified[key] = (claims, time.time() + 60)
    return token, claims


@app.get("/healthz")
async def healthz():
    return {"ok": True, "model": llm().model}


@app.post("/v1/route")
async def route_only(body: ChatIn):
    return {"flow": route(body.message)}


@app.post("/v1/chat")
async def chat(body: ChatIn, auth=Depends(service_claims)):
    token, claims = auth
    org_id = claims["orgId"]

    async def gen():
        node = NodeClient(token)
        ctx = Ctx(org_id=org_id, node=node, index=brand_index(), llm=llm())
        try:
            with telemetry.span("agent.chat", org_id=org_id):
                async for ev in answer_stream(ctx, body.message, body.postId):
                    yield f"event: {ev['event']}\ndata: {json.dumps(ev['data'])}\n\n"
        except BudgetExceeded as e:
            yield f"event: error\ndata: {json.dumps({'code': 'budget_exceeded', 'message': str(e)})}\n\n"
        except Exception as e:  # surface, don't hang the stream
            log.exception("chat failed")
            yield f"event: error\ndata: {json.dumps({'code': 'agent_error', 'message': str(e)[:300]})}\n\n"
        finally:
            await node.aclose()
            yield "event: done\ndata: {}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"cache-control": "no-cache"})
