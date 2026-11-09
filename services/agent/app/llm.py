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
import asyncio
import datetime as dt
import json
import importlib.util
import logging
import os
import re
import sys
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


def _caller() -> str:
    """LLM_CALLER=httpx|litellm; default litellm when it is installed (full image), else httpx (lean image)."""
    want = os.environ.get("LLM_CALLER", "").lower()
    if want in ("httpx", "litellm"):
        return want
    if "litellm" in sys.modules:
        return "litellm"
    try:
        return "litellm" if importlib.util.find_spec("litellm") else "httpx"
    except (ValueError, ImportError):  # pragma: no cover
        return "httpx"


async def _aclose(it) -> None:
    close = getattr(it, "aclose", None)
    if close:
        try:
            await close()
        except Exception:  # pragma: no cover
            pass


async def httpx_stream(model: str, msgs: list, base: str | None, key: str, extra: dict, max_tokens: int, timeout_s: float) -> AsyncIterator[str]:
    """OpenAI-compatible streaming chat completion over plain httpx (no litellm)."""
    import httpx

    if not base:
        raise RuntimeError("LLM_API_BASE is required without litellm")
    name = model.split("/", 1)[1] if model.startswith("openai/") else model
    body = {"model": name, "messages": msgs, "max_tokens": max_tokens, "temperature": 0.2, "stream": True, **(extra or {})}
    timeout = httpx.Timeout(timeout_s, connect=min(10.0, timeout_s))
    async with httpx.AsyncClient(timeout=timeout) as c:
        async with c.stream("POST", f"{base.rstrip('/')}/chat/completions", json=body,
                            headers={"Authorization": f"Bearer {key}", "accept": "text/event-stream"}) as r:
            if r.status_code >= 400:
                text = (await r.aread()).decode(errors="replace")
                raise RuntimeError(f"HTTP {r.status_code}: {text[:200]}")
            async for line in r.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    delta = (json.loads(data).get("choices") or [{}])[0].get("delta") or {}
                except (ValueError, AttributeError):
                    continue
                yield delta.get("content") or ""  # reasoning_content is never read


class BudgetExceeded(RuntimeError):
    pass


class LLMStalled(RuntimeError):
    """The provider started answering, then went silent past LLM_STALL_S (or the answer ran past
    LLM_ANSWER_MAX_S). The text already streamed stands; flows.py closes the turn with a note."""


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
        out: list[str] = []
        last_err: Exception | None = None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.s.llm_deadline_s  # past this, no new provider is tried
        for name, model, base, key, extra in self._targets():
            left = deadline - loop.time()
            if left <= 0:
                last_err = last_err or TimeoutError("LLM deadline passed")
                break
            pieces = self._provider_stream(model, msgs, base, key, extra).__aiter__()
            think = _ThinkFilter()
            try:
                # Wait at most first_token_s (and never past the deadline) for the first visible text:
                # a provider that hangs (cold proxy, slow queue) falls through instead of freezing the UI.
                first_by = loop.time() + min(self.s.llm_first_token_s, left)
                while not out:
                    raw = await asyncio.wait_for(pieces.__anext__(), timeout=max(0.1, first_by - loop.time()))
                    piece = think.feed(raw)
                    if piece.strip():
                        out.append(piece)
                        yield piece
                answer_by = loop.time() + self.s.llm_answer_max_s
                while True:
                    try:
                        raw = await asyncio.wait_for(pieces.__anext__(), timeout=max(0.1, min(self.s.llm_stall_s, answer_by - loop.time())))
                    except StopAsyncIteration:
                        break
                    except asyncio.TimeoutError as e:  # went quiet mid-answer: keep what the reader has
                        await _aclose(pieces)
                        await self.budget.add(org_id, _est(json.dumps(msgs)) + _est("".join(out)))
                        log.warning("llm %s stalled mid-answer after %d chars", name, len("".join(out)))
                        raise LLMStalled(f"{name} stopped mid-answer") from e
                    piece = think.feed(raw)  # reasoning_content is never read
                    if piece:
                        out.append(piece)
                        yield piece
                tail = think.flush()
                if tail:
                    out.append(tail)
                    yield tail
            except StopAsyncIteration:  # ended before any visible text
                tail = think.flush()
                if tail.strip():
                    out.append(tail)
                    yield tail
            except LLMStalled:
                raise
            except Exception as e:  # provider down, out of credit (River 402), timeout
                if out:  # already streaming to the reader: cannot switch provider mid-answer
                    raise
                last_err = e if not isinstance(e, asyncio.TimeoutError) else TimeoutError(f"{name} sent no text in time")
                log.warning("llm %s failed: %s", name, str(last_err)[:200] or type(e).__name__)
                await _aclose(pieces)
                continue
            if out:
                break
            last_err = RuntimeError(f"{name} returned an empty answer")
            log.warning("llm %s returned an empty answer", name)
        await self.budget.add(org_id, _est(json.dumps(msgs)) + _est("".join(out)))
        if not out:
            raise last_err or RuntimeError("no LLM answered")

    async def _provider_stream(self, model: str, msgs: list, base: str | None, key: str, extra: dict) -> AsyncIterator[str]:
        """Raw content pieces from one provider. litellm when installed (full image), else a plain httpx
        SSE stream (lean image: importing litellm costs ~150 MB RSS and, cold, over a minute)."""
        if _caller() == "litellm":
            # Cold, `import litellm` takes over a minute (it was the first-call "Thinking..." hang):
            # import it off the event loop so the first-token timeout can still fire.
            litellm = sys.modules.get("litellm") or await asyncio.to_thread(importlib.import_module, "litellm")

            resp = await litellm.acompletion(
                model=model, messages=msgs, api_base=base, api_key=key,
                max_tokens=self.s.llm_max_tokens, temperature=0.2, stream=True, timeout=self.s.llm_timeout_s,
                **({"extra_body": extra} if extra else {}),  # extra_body=None crashes litellm 1.55
            )
            async for chunk in resp:
                yield getattr(chunk.choices[0].delta, "content", None) or ""
            return
        async for piece in httpx_stream(model, msgs, base, key, extra, self.s.llm_max_tokens, self.s.llm_timeout_s):
            yield piece

    def _targets(self) -> list[tuple[str, str, str | None, str, dict]]:
        """(name, litellm model, api_base, api_key, extra_body) tried in order."""
        if self.model == "chain":
            from .deals.llm_router import default_chain  # same River -> NIM chain as the deal copilot

            return [(p.name, f"openai/{p.model}", p.api_base, p.api_key, p.extra) for p in default_chain()]
        extra = NO_THINKING if _thinks(self.model) else {}
        return [(self.model, self.model, self.s.llm_api_base, self.s.llm_api_key or "EMPTY", extra)]

    async def warm(self) -> None:
        """Import the LLM client in the background at startup (full image), so no request pays for it."""
        if self.model != "stub" and _caller() == "litellm" and "litellm" not in sys.modules:
            try:
                await asyncio.to_thread(importlib.import_module, "litellm")
            except Exception as e:  # pragma: no cover
                log.warning("litellm warm-up failed: %s", e)

    async def complete(self, org_id: str, task: str, facts: dict, question: str) -> str:
        parts = [p async for p in self.stream(org_id, task, facts, question)]
        return "".join(parts).strip()
