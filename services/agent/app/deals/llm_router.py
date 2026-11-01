"""LLM router for the deal agents: River AI -> NVIDIA NIM -> OmniRoute (last resort).

All three speak the OpenAI chat API, so every call goes through yv's LiteLLM layer
(`litellm.acompletion(model="openai/<id>", api_base=...)`). The router:

* strips identity from every message and refuses to send if a name/email/phone survives
  (identity.assert_clean) - the "before any LLM call" rule lives HERE, not in callers;
* caches responses on disk keyed by (purpose, messages) so the same question never
  spends River credits twice (fixtures/llm_cache holds tiny recorded replies for CI);
* falls through the chain on any provider error / timeout / unparsable JSON;
* with LLM_OFFLINE=1 (tests, CI) it only replays the cache and returns None on a miss,
  so callers keep their deterministic answer.

Keys are never read here: the sandbox / host injects them for the provider hosts.
LLM_API_KEY_<NAME> env vars override for a self-hosted deploy.
"""
from __future__ import annotations
import hashlib
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable

from .identity import Redactor, assert_clean
from .. import telemetry

log = logging.getLogger("yv.deals.llm")

HERE = Path(__file__).resolve().parent
DEFAULT_CACHE = HERE.parent.parent / "fixtures" / "llm_cache"


@dataclass(frozen=True)
class Provider:
    name: str
    model: str
    api_base: str
    key_env: str | None = None
    extra: dict = field(default_factory=dict)

    @property
    def api_key(self) -> str:
        if self.key_env and os.environ.get(self.key_env):
            return os.environ[self.key_env]
        # The sandbox proxy (or host secret injection) adds the real Authorization header.
        return os.environ.get(f"LLM_API_KEY_{self.name.upper()}", "injected-by-proxy")


def default_chain() -> list[Provider]:
    chain = {
        "river": Provider(
            "river",
            os.environ.get("RIVER_MODEL", "Qwen/Qwen3.8-27B-FP8"),
            os.environ.get("RIVER_API_BASE", "https://api.river.ai/v1"),
            "RIVER_API_KEY",
            # Qwen3 thinks by default; we want short, schema-bound answers and frugal credit use.
            {"chat_template_kwargs": {"enable_thinking": False}},
        ),
        "nim": Provider(
            "nim",
            os.environ.get("NIM_MODEL", "meta/llama-3.3-70b-instruct"),
            os.environ.get("NIM_API_BASE", "https://integrate.api.nvidia.com/v1"),
            "NVIDIA_API_KEY",
        ),
    }
    # OmniRoute: local only, API-key providers only. Opt-in by URL so it never runs by accident.
    if os.environ.get("OMNIROUTE_URL"):
        chain["omniroute"] = Provider(
            "omniroute", os.environ.get("OMNIROUTE_MODEL", "auto"), os.environ["OMNIROUTE_URL"].rstrip("/"), "OMNIROUTE_API_KEY"
        )
    order = [n.strip() for n in os.environ.get("LLM_CHAIN", "river,nim,omniroute").split(",") if n.strip()]
    return [chain[n] for n in order if n in chain]


Caller = Callable[[Provider, list[dict], int], Awaitable[str]]


async def litellm_caller(p: Provider, messages: list[dict], max_tokens: int) -> str:
    import litellm  # heavy; only when a real call is made

    resp = await litellm.acompletion(
        model=f"openai/{p.model}", api_base=p.api_base, api_key=p.api_key, messages=messages,
        max_tokens=max_tokens, temperature=0, timeout=float(os.environ.get("LLM_TIMEOUT_S", "45")),
        extra_body=p.extra or None,
    )
    msg = resp.choices[0].message
    return (getattr(msg, "content", None) or "").strip()


def _strip_fences(s: str) -> str:
    s = re.sub(r"<think>.*?</think>", "", s, flags=re.S).strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", s, flags=re.S)
    if m:
        s = m.group(1)
    a, b = s.find("{"), s.rfind("}")
    return s[a : b + 1] if a != -1 and b > a else s


class LLMRouter:
    def __init__(self, chain: list[Provider] | None = None, caller: Caller | None = None,
                 cache_dir: str | Path | None = None, offline: bool | None = None):
        self.chain = chain if chain is not None else default_chain()
        self.caller = caller or litellm_caller
        self.cache_dir = Path(cache_dir or os.environ.get("LLM_CACHE_DIR") or DEFAULT_CACHE)
        self.offline = (os.environ.get("LLM_OFFLINE") == "1") if offline is None else offline
        self.calls: list[dict] = []  # trace of attempts (provider, ok, ms, cached)

    @staticmethod
    def key(purpose: str, messages: list[dict]) -> str:
        return hashlib.sha256(json.dumps([purpose, messages], sort_keys=True).encode()).hexdigest()[:32]

    def _cache_get(self, k: str):
        f = self.cache_dir / f"{k}.json"
        if f.exists():
            return json.loads(f.read_text())
        return None

    def _cache_put(self, k: str, purpose: str, provider: str, data) -> None:
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            (self.cache_dir / f"{k}.json").write_text(json.dumps({"purpose": purpose, "provider": provider, "data": data}, indent=1))
        except OSError as e:  # read-only image: still fine, just no cache
            log.warning("llm cache write failed: %s", e)

    async def json(self, purpose: str, system: str, payload: dict, redactor: Redactor | None = None,
                   max_tokens: int = 400, validate: Callable[[dict], bool] | None = None) -> dict | None:
        """Ask for a JSON object. Returns None when no provider gave a valid answer (caller keeps its rule-based result)."""
        red = redactor or Redactor()
        clean = red.redact_obj(payload)
        user = json.dumps(clean, sort_keys=True, ensure_ascii=False)
        assert_clean(user, red)
        messages = [{"role": "system", "content": system + "\nReply with ONE JSON object and nothing else."},
                    {"role": "user", "content": user}]
        k = self.key(purpose, messages)
        hit = self._cache_get(k)
        if hit is not None:
            self.calls.append({"provider": hit.get("provider"), "ok": True, "cached": True, "purpose": purpose})
            return hit["data"]
        if self.offline:
            self.calls.append({"provider": None, "ok": False, "cached": False, "purpose": purpose, "offline": True})
            return None
        for p in self.chain:
            t0 = time.monotonic()
            with telemetry.span("llm.call", provider=p.name, model=p.model, purpose=purpose):
                try:
                    raw = await self.caller(p, messages, max_tokens)
                    data = json.loads(_strip_fences(raw))
                    if not isinstance(data, dict) or (validate and not validate(data)):
                        raise ValueError("answer failed schema validation")
                except Exception as e:  # provider down, quota, bad JSON -> next provider
                    self.calls.append({"provider": p.name, "ok": False, "ms": int((time.monotonic() - t0) * 1000), "error": str(e)[:160], "purpose": purpose})
                    log.warning("llm %s failed for %s: %s", p.name, purpose, str(e)[:200])
                    continue
            self.calls.append({"provider": p.name, "ok": True, "ms": int((time.monotonic() - t0) * 1000), "purpose": purpose})
            self._cache_put(k, purpose, p.name, data)
            return data
        return None
