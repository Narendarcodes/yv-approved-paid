"""LLM access through LiteLLM (model switchable by env) with a per-org daily token budget.

The LLM only WRITES prose from facts the flow already computed; citations and
data limits are attached in code, so they cannot be hallucinated.
LLM_MODEL=stub uses a deterministic offline writer (unit tests, CI, no-GPU dev).
"""
from __future__ import annotations
import datetime as dt
import json
from typing import AsyncIterator

from .config import get_settings


class BudgetExceeded(RuntimeError):
    pass


class TokenBudget:
    """Per-org daily token counter. Redis when available (shared by api+worker), else in-process."""

    def __init__(self, redis=None, limit: int | None = None):
        self.redis = redis
        self.limit = limit if limit is not None else get_settings().org_daily_token_budget
        self._mem: dict[str, int] = {}

    def _key(self, org_id: str) -> str:
        return f"yv:budget:{org_id}:{dt.date.today().isoformat()}"

    async def used(self, org_id: str) -> int:
        k = self._key(org_id)
        if self.redis is not None:
            try:
                return int(await self.redis.get(k) or 0)
            except Exception:  # Redis down: degrade to the in-process counter
                pass
        return self._mem.get(k, 0)

    async def check(self, org_id: str) -> None:
        if await self.used(org_id) >= self.limit:
            raise BudgetExceeded(f"org {org_id} exceeded its daily token budget ({self.limit})")

    async def add(self, org_id: str, tokens: int) -> None:
        k = self._key(org_id)
        if self.redis is not None:
            try:
                await self.redis.incrby(k, tokens)
                await self.redis.expire(k, 172800)
                return
            except Exception:
                pass
        self._mem[k] = self._mem.get(k, 0) + tokens


def _est(text: str) -> int:
    return max(1, len(text) // 4)


def stub_write(task: str, facts: dict) -> str:
    """Deterministic writer used when LLM_MODEL=stub: renders the computed facts as plain sentences."""
    lines = facts.get("bullets") or []
    head = facts.get("headline", "")
    return (head + ("\n" if head and lines else "") + "\n".join(f"- {b}" for b in lines)).strip()


SYSTEM = (
    "You are yv., the content-ops analyst for a marketing team. Answer ONLY from the FACTS JSON. "
    "Quote the exact numbers and post IDs given in FACTS (format: [post:<id>], only for ids that FACTS labels as a post id; never tag comment or rule ids as posts). Never invent metrics, "
    "timestamps or quotes. If FACTS lacks something, say so. Keep it under 180 words, plain text, "
    "short paragraphs or bullets. Respect the brand rules in FACTS when making suggestions."
)


class LLM:
    def __init__(self, budget: TokenBudget | None = None):
        self.s = get_settings()
        self.budget = budget or TokenBudget()
        self.model = self.s.llm_model

    def _messages(self, task: str, facts: dict, question: str):
        return [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"TASK: {task}\nQUESTION: {question}\nFACTS:\n{json.dumps(facts, default=str)[:12000]}"},
        ]

    async def stream(self, org_id: str, task: str, facts: dict, question: str) -> AsyncIterator[str]:
        await self.budget.check(org_id)
        msgs = self._messages(task, facts, question)
        if self.model == "stub":
            text = stub_write(task, facts)
            await self.budget.add(org_id, _est(json.dumps(msgs)) + _est(text))
            for i in range(0, len(text), 48):
                yield text[i : i + 48]
            return
        import litellm  # heavy import, only when a real model is configured

        resp = await litellm.acompletion(
            model=self.model, messages=msgs, api_base=self.s.llm_api_base, api_key=self.s.llm_api_key or "EMPTY",
            max_tokens=self.s.llm_max_tokens, temperature=0.2, stream=True, timeout=self.s.llm_timeout_s,
        )
        out = []
        async for chunk in resp:
            delta = chunk.choices[0].delta
            piece = getattr(delta, "content", None) or ""
            if piece:
                out.append(piece)
                yield piece
        await self.budget.add(org_id, _est(json.dumps(msgs)) + _est("".join(out)))

    async def complete(self, org_id: str, task: str, facts: dict, question: str) -> str:
        parts = [p async for p in self.stream(org_id, task, facts, question)]
        return "".join(parts).strip()
