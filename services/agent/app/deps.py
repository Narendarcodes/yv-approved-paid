"""Shared singletons: brand index, token budget (Redis-backed when reachable), LLM."""
from __future__ import annotations
import functools

from .config import get_settings
from .llm import LLM, TokenBudget
from .vector import BrandIndex


@functools.lru_cache
def brand_index() -> BrandIndex:
    return BrandIndex()


@functools.lru_cache
def redis_client():
    try:
        import redis.asyncio as aioredis

        return aioredis.from_url(get_settings().redis_url, decode_responses=True)
    except Exception:  # pragma: no cover
        return None


@functools.lru_cache
def llm() -> LLM:
    s = get_settings()
    return LLM(TokenBudget(redis_client() if s.redis_url else None))
