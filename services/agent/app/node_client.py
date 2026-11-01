"""Typed client for Node's /internal API. The ONLY way Python reads or writes app data."""
from __future__ import annotations
from typing import Any
import httpx

from .config import get_settings
from .contracts.Post import Post
from .contracts.MetricPoint import MetricPoint
from .contracts.RetentionPoint import RetentionPoint
from .contracts.BrandRule import BrandRule
from .contracts.ReviewComment import ReviewComment
from .contracts.Insight import Insight
from .contracts.JobResult import JobResult


class NodeError(RuntimeError):
    def __init__(self, status: int, body: str):
        super().__init__(f"node internal API {status}: {body[:300]}")
        self.status = status


class NodeClient:
    def __init__(self, token: str, base_url: str | None = None, transport: httpx.AsyncBaseTransport | None = None):
        settings = get_settings()
        self.base = (base_url or settings.node_internal_url).rstrip("/")
        headers = {"authorization": f"Bearer {token}"}
        if settings.node_internal_token:
            headers["x-internal-token"] = settings.node_internal_token
        self._http = httpx.AsyncClient(base_url=self.base, headers=headers, timeout=30, transport=transport)

    async def aclose(self):
        await self._http.aclose()

    async def _req(self, method: str, path: str, **kw) -> Any:
        r = await self._http.request(method, path, **kw)
        if r.status_code >= 400:
            raise NodeError(r.status_code, r.text)
        return r.json().get("data")

    # --- tools ---
    async def whoami(self) -> dict:
        return await self._req("GET", "/whoami")

    async def get_posts(self, platform: str | None = None) -> list[Post]:
        return [Post.model_validate(p) for p in await self._req("GET", "/posts", params={"platform": platform} if platform else None)]

    async def get_metrics(self, post_id: str | None = None) -> list[MetricPoint]:
        return [MetricPoint.model_validate(m) for m in await self._req("GET", "/metrics", params={"postId": post_id} if post_id else None)]

    async def get_retention(self, post_id: str) -> list[RetentionPoint]:
        return [RetentionPoint.model_validate(p) for p in await self._req("GET", f"/posts/{post_id}/retention")]

    async def get_media(self, post_id: str) -> dict | None:
        return await self._req("GET", f"/posts/{post_id}/media")

    async def put_media(self, post_id: str, **body) -> dict:
        return await self._req("PUT", f"/posts/{post_id}/media", json=body)

    async def get_brand_rules(self) -> list[BrandRule]:
        return [BrandRule.model_validate(b) for b in await self._req("GET", "/brand/rules")]

    async def get_review_comments(self, post_id: str) -> list[ReviewComment]:
        return [ReviewComment.model_validate(c) for c in await self._req("GET", "/review-comments", params={"postId": post_id})]

    async def create_insight(self, insight: Insight) -> str:
        return (await self._req("POST", "/insights", json=insight.model_dump(mode="json", exclude_none=True)))["id"]

    async def post_job_result(self, result: JobResult) -> None:
        await self._req("POST", f"/jobs/{result.jobId}/result", json=result.model_dump(mode="json", exclude_none=True))
