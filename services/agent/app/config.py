"""Typed runtime config. Every URL, model id, threshold and stream name comes from env."""
from __future__ import annotations
import os
from dataclasses import dataclass, field


def _f(name: str, default: str) -> float:
    return float(os.environ.get(name, default))


@dataclass(frozen=True)
class Settings:
    # Node's private /internal listener (INTERNAL_PORT, never the public port) and the
    # shared token it requires in X-Internal-Token on top of the per-call service JWT.
    node_internal_url: str = field(default_factory=lambda: os.environ.get("NODE_INTERNAL_URL", "http://127.0.0.1:3001/internal"))
    node_internal_token: str = field(default_factory=lambda: os.environ.get("INTERNAL_API_TOKEN", "dev_internal_token"))
    redis_url: str = field(default_factory=lambda: os.environ.get("REDIS_URL", "redis://127.0.0.1:6379"))
    jobs_stream: str = field(default_factory=lambda: os.environ.get("JOBS_STREAM", "yv:jobs"))
    dlq_stream: str = field(default_factory=lambda: os.environ.get("JOBS_DLQ_STREAM", "yv:jobs:dead"))
    consumer_group: str = field(default_factory=lambda: os.environ.get("JOBS_GROUP", "agent-workers"))
    consumer_name: str = field(default_factory=lambda: os.environ.get("HOSTNAME", "worker-1"))
    max_attempts: int = field(default_factory=lambda: int(os.environ.get("JOBS_MAX_ATTEMPTS", "3")))
    claim_idle_ms: int = field(default_factory=lambda: int(os.environ.get("JOBS_CLAIM_IDLE_MS", "30000")))
    # LLM via LiteLLM. LLM_MODEL=stub -> deterministic offline writer (tests/CI).
    llm_model: str = field(default_factory=lambda: os.environ.get("LLM_MODEL", "stub"))
    llm_api_base: str | None = field(default_factory=lambda: os.environ.get("LLM_API_BASE") or None)
    llm_api_key: str | None = field(default_factory=lambda: os.environ.get("LLM_API_KEY") or None)
    llm_max_tokens: int = field(default_factory=lambda: int(os.environ.get("LLM_MAX_TOKENS", "700")))
    llm_timeout_s: float = field(default_factory=lambda: _f("LLM_TIMEOUT_S", "90"))
    # A provider that sends no visible text within LLM_FIRST_TOKEN_S is skipped; past LLM_DEADLINE_S
    # no further provider is tried and the flow answers from the brand hub's own text (flows.py).
    llm_first_token_s: float = field(default_factory=lambda: _f("LLM_FIRST_TOKEN_S", "12"))
    llm_deadline_s: float = field(default_factory=lambda: _f("LLM_DEADLINE_S", "22"))
    # Once text flows: a gap longer than LLM_STALL_S, or an answer longer than LLM_ANSWER_MAX_S, ends it.
    llm_stall_s: float = field(default_factory=lambda: _f("LLM_STALL_S", "10"))
    llm_answer_max_s: float = field(default_factory=lambda: _f("LLM_ANSWER_MAX_S", "45"))
    org_daily_token_budget: int = field(default_factory=lambda: int(os.environ.get("ORG_DAILY_TOKEN_BUDGET", "200000")))
    # vectors
    qdrant_url: str = field(default_factory=lambda: os.environ.get("QDRANT_URL", ":memory:"))
    qdrant_collection: str = field(default_factory=lambda: os.environ.get("QDRANT_COLLECTION", "brand_knowledge"))
    embed_dim: int = field(default_factory=lambda: int(os.environ.get("EMBED_DIM", "384")))
    embed_model: str = field(default_factory=lambda: os.environ.get("EMBED_MODEL", "hash"))  # hash | <litellm embedding model>
    # analysis thresholds
    spike_min_lift: float = field(default_factory=lambda: _f("SPIKE_MIN_LIFT", "0.12"))
    spike_window_s: float = field(default_factory=lambda: _f("SPIKE_CONTEXT_WINDOW_S", "4"))
    # media / ingestion
    stt_url: str | None = field(default_factory=lambda: os.environ.get("STT_URL") or None)  # e.g. http://127.0.0.1:8794/v1/transcribe
    stt_engine: str = field(default_factory=lambda: os.environ.get("STT_ENGINE", "whisper-turbo"))
    stt_chunk_s: float = field(default_factory=lambda: _f("STT_CHUNK_S", "6"))
    s3_endpoint: str | None = field(default_factory=lambda: os.environ.get("S3_ENDPOINT") or None)
    s3_access_key: str = field(default_factory=lambda: os.environ.get("S3_ACCESS_KEY", "minioadmin"))
    s3_secret_key: str = field(default_factory=lambda: os.environ.get("S3_SECRET_KEY", "minioadmin"))
    fixtures_dir: str = field(default_factory=lambda: os.environ.get("FIXTURES_DIR", os.path.join(os.path.dirname(__file__), "..", "fixtures")))
    youtube_api_key: str | None = field(default_factory=lambda: os.environ.get("YOUTUBE_OAUTH_TOKEN") or None)
    instagram_token: str | None = field(default_factory=lambda: os.environ.get("INSTAGRAM_TOKEN") or None)
    postiz_api_url: str | None = field(default_factory=lambda: os.environ.get("POSTIZ_API_URL") or None)
    postiz_api_key: str | None = field(default_factory=lambda: os.environ.get("POSTIZ_API_KEY") or None)


def get_settings() -> Settings:
    return Settings()
