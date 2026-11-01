"""Qdrant brand-knowledge index. Every search/upsert REQUIRES an org_id and applies an orgId
payload filter; there is no code path that queries across orgs."""
from __future__ import annotations
import hashlib
import math
import re
import uuid

from qdrant_client import QdrantClient, models as qm

from .config import get_settings

_TOKEN = re.compile(r"[\w']+", re.UNICODE)


def hash_embed(text: str, dim: int) -> list[float]:
    """Dependency-free hashing-trick embedding (unigrams + bigrams). Swap via EMBED_MODEL."""
    v = [0.0] * dim
    toks = [t.lower() for t in _TOKEN.findall(text)]
    feats = toks + [a + "_" + b for a, b in zip(toks, toks[1:])]
    for f in feats:
        h = int(hashlib.md5(f.encode()).hexdigest(), 16)
        v[h % dim] += 1.0 if (h >> 64) & 1 else -1.0
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


class BrandIndex:
    def __init__(self, client: QdrantClient | None = None):
        s = get_settings()
        self.s = s
        self.client = client or (QdrantClient(location=":memory:") if s.qdrant_url == ":memory:" else QdrantClient(url=s.qdrant_url))
        self.collection = s.qdrant_collection
        self._ensure()

    def _ensure(self):
        if not self.client.collection_exists(self.collection):
            self.client.create_collection(self.collection, vectors_config=qm.VectorParams(size=self.s.embed_dim, distance=qm.Distance.COSINE))
            self.client.create_payload_index(self.collection, "orgId", qm.PayloadSchemaType.KEYWORD)

    def embed(self, text: str) -> list[float]:
        if self.s.embed_model == "hash":
            return hash_embed(text, self.s.embed_dim)
        import litellm  # pragma: no cover

        return litellm.embedding(model=self.s.embed_model, input=[text]).data[0]["embedding"]  # pragma: no cover

    @staticmethod
    def _org_filter(org_id: str) -> qm.Filter:
        if not org_id:
            raise ValueError("org_id is mandatory for every vector operation")
        return qm.Filter(must=[qm.FieldCondition(key="orgId", match=qm.MatchValue(value=org_id))])

    def reindex(self, org_id: str, rules: list) -> int:
        self.client.delete(self.collection, points_selector=qm.FilterSelector(filter=self._org_filter(org_id)))
        pts = []
        for r in rules:
            text = f"{r.title}. {r.body}"
            pts.append(qm.PointStruct(id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"{org_id}:{r.id}")), vector=self.embed(text),
                                      payload={"orgId": org_id, "ruleId": r.id, "title": r.title, "body": r.body, "kind": getattr(r.kind, "value", r.kind)}))
        if pts:
            self.client.upsert(self.collection, points=pts)
        return len(pts)

    def count(self, org_id: str) -> int:
        return self.client.count(self.collection, count_filter=self._org_filter(org_id)).count

    def search(self, org_id: str, query: str, k: int = 4) -> list[dict]:
        res = self.client.query_points(self.collection, query=self.embed(query), query_filter=self._org_filter(org_id), limit=k, with_payload=True)
        return [{**p.payload, "score": round(p.score, 3)} for p in res.points]
