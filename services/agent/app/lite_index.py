"""In-process brand-knowledge index for the lean agent image (no qdrant-client, no numpy).

Same surface as vector.BrandIndex (reindex / count / search) and the same rule: every call
REQUIRES an org_id and only ever sees that org's entries. Brand hubs are tens of entries, so a
plain cosine scan over hash embeddings is instant and costs a few KB per org."""
from __future__ import annotations

from .config import get_settings
from .embed import hash_embed


class LiteBrandIndex:
    def __init__(self, dim: int | None = None):
        self.dim = dim or get_settings().embed_dim
        self._by_org: dict[str, list[tuple[list[float], dict]]] = {}

    @staticmethod
    def _org(org_id: str) -> str:
        if not org_id:
            raise ValueError("org_id is mandatory for every vector operation")
        return org_id

    def embed(self, text: str) -> list[float]:
        return hash_embed(text, self.dim)

    def reindex(self, org_id: str, rules: list) -> int:
        rows = []
        for r in rules:
            payload = {"orgId": org_id, "ruleId": r.id, "title": r.title, "body": r.body, "kind": getattr(r.kind, "value", r.kind)}
            rows.append((self.embed(f"{r.title}. {r.body}"), payload))
        self._by_org[self._org(org_id)] = rows
        return len(rows)

    def count(self, org_id: str) -> int:
        return len(self._by_org.get(self._org(org_id), []))

    def search(self, org_id: str, query: str, k: int = 4) -> list[dict]:
        q = self.embed(query)
        scored = [(sum(a * b for a, b in zip(q, v)), p) for v, p in self._by_org.get(self._org(org_id), [])]
        scored.sort(key=lambda t: t[0], reverse=True)
        return [{**p, "score": round(s, 3)} for s, p in scored[:k]]
