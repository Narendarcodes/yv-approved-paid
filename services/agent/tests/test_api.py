import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import main
from tests.fake_node import FakeNode


@pytest.fixture
def client(monkeypatch):
    fake = FakeNode()
    from app import node_client

    orig = node_client.NodeClient.__init__

    def init(self, token, base_url=None, transport=None):
        orig(self, token, base_url="http://node/internal", transport=httpx.MockTransport(fake.handler))

    monkeypatch.setattr(node_client.NodeClient, "__init__", init)
    main._verified.clear()
    return TestClient(main.app)


def parse_sse(text):
    evs = []
    for block in text.strip().split("\n\n"):
        lines = dict(l.split(": ", 1) for l in block.splitlines() if ": " in l)
        evs.append((lines.get("event"), json.loads(lines.get("data", "{}"))))
    return evs


def test_chat_streams_answer_with_citations(client):
    r = client.post("/v1/chat", json={"message": "Why did the breathing cues short go viral?"}, headers={"authorization": "Bearer good"})
    assert r.status_code == 200
    evs = parse_sse(r.text)
    names = [e for e, _ in evs]
    assert names[0] == "meta" and "token" in names and names[-1] == "done"
    ans = next(d for e, d in evs if e == "answer")
    assert ans["flow"] == "insight" and any(c["metric"].startswith("retention@") for c in ans["citations"]) and ans["dataLimits"]


def test_chat_rejects_unverified_token(client):
    r = client.post("/v1/chat", json={"message": "hi"}, headers={"authorization": "Bearer forged"})
    assert r.status_code == 401
