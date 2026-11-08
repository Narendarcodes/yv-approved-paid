"""LLM access through LiteLLM (model switchable by env) with a per-org daily token budget.

The LLM only WRITES prose from facts the flow already computed; citations and
data limits are attached in code, so they cannot be hallucinated.
LLM_MODEL=stub uses a deterministic offline writer (unit tests, CI, no-GPU dev).
LLM_MODEL=chain uses the deal copilot's provider chain (LLM_CHAIN, default River -> NIM): a
provider that errors (River 402) or answers empty falls through to the next one.
Thinking is switched off for reasoning models (Nemotron, Qwen3) and any <think> block is dropped,
so the reader only ever gets the final answer.
"""
from __future__ import annotations
import datetime as dt
import json
import logging
import re
from typing import AsyncIterator

from .config import get_settings


log = logging.getLogger("yv.llm")

NO_THINKING = {"chat_template_kwargs": {"enable_thinking": False}}


def _thinks(model: str) -> bool:
    """Models that reason by default and can spend the whole budget thinking (empty content)."""
    return bool(re.search(r"nemotron|qwen3", model or "", re.I))


class _ThinkFilter:
    """Drops <think>...</think> from a stream of text pieces (some servers inline the reasoning)."""

    def __init__(self):
        self.buf = ""
        self.inside = False

    def feed(self, piece: str) -> str:
        self.buf += piece
        out = []
        while self.buf:
            if self.inside:
                end = self.buf.find("</think>")
                if end == -1:
                    self.buf = self.buf[-8:]
                    break
                self.buf, self.inside = self.buf[end + 8 :], False
                continue
            start = self.buf.find("<think>")
            if start != -1:
                out.append(self.buf[:start])
                self.buf, self.inside = self.buf[start + 7 :], True
                continue
            keep = next((k for k in range(min(6, len(self.buf)), 0, -1) if "<think>".startswith(self.buf[-k:])), 0)
            out.append(self.buf[: len(self.buf) - keep])
            self.buf = self.buf[len(self.buf) - keep :]
            break
        return "".join(out)

    def flush(self) -> str:
        rest, self.buf = ("" if self.inside else self.buf), ""
        return rest


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

        out: list[str] = []
        last_err: Exception | None = None
        for name, model, base, key, extra in self._targets():
            try:
                resp = await litellm.acompletion(
                    model=model, messages=msgs, api_base=base, api_key=key,
                    max_tokens=self.s.llm_max_tokens, temperature=0.2, stream=True, timeout=self.s.llm_timeout_s,
                    **({"extra_body": extra} if extra else {}),  # extra_body=None crashes litellm 1.55
                )
                think = _ThinkFilter()
                async for chunk in resp:
                    delta = chunk.choices[0].delta
                    piece = think.feed(getattr(delta, "content", None) or "")  # reasoning_content is never read
                    if piece and (out or piece.strip()):
                        out.append(piece)
                        yield piece
                tail = think.flush()
                if tail and (out or tail.strip()):
                    out.append(tail)
                    yield tail
            except Exception as e:  # provider down, out of credit (River 402), timeout
                if out:  # already streaming to the reader: cannot switch provider mid-answer
                    raise
                last_err = e
                log.warning("llm %s failed: %s", name, str(e)[:200])
                continue
            if out:
                break
            last_err = RuntimeError(f"{name} returned an empty answer")
            log.warning("llm %s returned an empty answer", name)
        await self.budget.add(org_id, _est(json.dumps(msgs)) + _est("".join(out)))
        if not out:
            raise last_err or RuntimeError("no LLM answered")

    def _targets(self) -> list[tuple[str, str, str | None, str, dict]]:
        """(name, litellm model, api_base, api_key, extra_body) tried in order."""
        if self.model == "chain":
            from .deals.llm_router import default_chain  # same River -> NIM chain as the deal copilot

            return [(p.name, f"openai/{p.model}", p.api_base, p.api_key, p.extra) for p in default_chain()]
        extra = NO_THINKING if _thinks(self.model) else {}
        return [(self.model, self.model, self.s.llm_api_base, self.s.llm_api_key or "EMPTY", extra)]

    async def complete(self, org_id: str, task: str, facts: dict, question: str) -> str:
        parts = [p async for p in self.stream(org_id, task, facts, question)]
        return "".join(parts).strip()
