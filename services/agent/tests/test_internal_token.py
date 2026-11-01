"""The agent sends Node's shared internal token (X-Internal-Token) next to the service JWT."""
import asyncio

import httpx

from app.node_client import NodeClient


def _capture(monkeypatch, token_env):
    if token_env is None:
        monkeypatch.delenv("INTERNAL_API_TOKEN", raising=False)
    else:
        monkeypatch.setenv("INTERNAL_API_TOKEN", token_env)
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.update(req.headers)
        return httpx.Response(200, json={"data": {"orgId": "o1"}})

    async def run():
        c = NodeClient("svc-jwt", base_url="http://node/internal", transport=httpx.MockTransport(handler))
        try:
            await c.whoami()
        finally:
            await c.aclose()

    asyncio.run(run())
    return seen


def test_sends_internal_token_and_service_jwt(monkeypatch):
    seen = _capture(monkeypatch, "tok-123")
    assert seen["x-internal-token"] == "tok-123"
    assert seen["authorization"] == "Bearer svc-jwt"


def test_dev_default_token_when_unset(monkeypatch):
    seen = _capture(monkeypatch, None)
    assert seen["x-internal-token"] == "dev_internal_token"


def test_default_internal_url_is_the_private_port(monkeypatch):
    monkeypatch.delenv("NODE_INTERNAL_URL", raising=False)
    from app.config import get_settings

    assert get_settings().node_internal_url == "http://127.0.0.1:3001/internal"
