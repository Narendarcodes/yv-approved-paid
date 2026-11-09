"""Read-only org data that Node pushes WITH a chat call (lean agent: no callback to /internal).

Same read methods as node_client.NodeClient, served from the request body, so flows.py runs
unchanged. Node assembles the bundle after its own permission checks, for the token's org only.
Retention curves and transcripts are not pushed (too heavy per call); flows that would use them
get empty data and the route adds a data limit saying so."""
from __future__ import annotations
from typing import Any

from .contracts.BrandRule import BrandRule
from .contracts.MetricPoint import MetricPoint
from .contracts.Post import Post
from .contracts.ReviewComment import ReviewComment

LEAN_LIMIT = "Retention curves and transcripts are not read on the lean agent, so no retention spike is analysed here."


class PushedContext:
    def __init__(self, bundle: dict[str, Any] | None):
        b = bundle or {}
        self.brand_rules = [BrandRule.model_validate(r) for r in b.get("brandRules") or []]
        self.posts = [Post.model_validate(p) for p in b.get("posts") or []]
        self.metrics = [MetricPoint.model_validate(m) for m in b.get("metrics") or []]
        self.comments = [ReviewComment.model_validate(c) for c in b.get("reviewComments") or []]

    async def aclose(self):
        return None

    async def get_brand_rules(self) -> list[BrandRule]:
        return self.brand_rules

    async def get_posts(self, platform: str | None = None) -> list[Post]:
        return [p for p in self.posts if not platform or getattr(p.platform, "value", p.platform) == platform]

    async def get_metrics(self, post_id: str | None = None) -> list[MetricPoint]:
        return [m for m in self.metrics if not post_id or m.postId == post_id]

    async def get_retention(self, post_id: str) -> list:
        return []

    async def get_media(self, post_id: str) -> dict | None:
        return None

    async def get_review_comments(self, post_id: str) -> list[ReviewComment]:
        return [c for c in self.comments if c.postId == post_id]
