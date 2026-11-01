"""Platform connectors normalised to the shared contracts. Each uses the real API when its
credential env var is set and otherwise reads a recorded fixture (fixtures/*.json)."""
from __future__ import annotations
import json
import os

import httpx

from ..config import get_settings
from ..contracts.MetricPoint import MetricPoint
from ..contracts.RetentionPoint import RetentionPoint


def _fixture(name: str) -> dict:
    return json.load(open(os.path.join(get_settings().fixtures_dir, name)))


class YouTubeAnalytics:
    """youtubeAnalytics.v2 reports: dimensions=elapsedVideoTimeRatio, metrics=audienceWatchRatio,relativeRetentionPerformance."""
    URL = "https://youtubeanalytics.googleapis.com/v2/reports"

    def __init__(self, token: str | None = None):
        self.token = token if token is not None else get_settings().youtube_api_key

    def retention(self, video_id: str, post_id: str, duration_sec: float) -> list[RetentionPoint]:
        if self.token:  # pragma: no cover - needs OAuth
            r = httpx.get(self.URL, headers={"authorization": f"Bearer {self.token}"}, params={
                "ids": "channel==MINE", "startDate": "2020-01-01", "endDate": "2030-01-01", "filters": f"video=={video_id}",
                "dimensions": "elapsedVideoTimeRatio", "metrics": "audienceWatchRatio,relativeRetentionPerformance"})
            r.raise_for_status()
            rows = r.json().get("rows", [])
        else:
            rows = _fixture("youtube_analytics_retention.json")["rows"]
        return [RetentionPoint(postId=post_id, second=round(ratio * duration_sec, 2), audienceWatchRatio=awr, relativeRetentionPerformance=rrp) for ratio, awr, rrp in rows]


class InstagramGraph:
    """GET /{ig-media-id}/insights?metric=views,reach,likes,comments,shares,saved (aggregate only)."""
    MAP = {"views": "views", "plays": "views", "reach": "reach", "likes": "likes", "comments": "comments", "shares": "shares", "saved": "saves"}

    def __init__(self, token: str | None = None):
        self.token = token if token is not None else get_settings().instagram_token

    def reel_metrics(self, media_id: str, post_id: str, ts: str) -> list[MetricPoint]:
        if self.token:  # pragma: no cover
            r = httpx.get(f"https://graph.facebook.com/v21.0/{media_id}/insights", params={"metric": "views,reach,likes,comments,shares,saved", "access_token": self.token})
            r.raise_for_status()
            data = r.json()["data"]
        else:
            data = _fixture("instagram_graph_insights.json")["data"]
        out = []
        for d in data:
            key = self.MAP.get(d["name"])
            if key:
                out.append(MetricPoint(postId=post_id, metric=key, value=d["values"][0]["value"], ts=ts, source="instagram_graph"))
        return out


class Postiz:
    """Postiz public API: GET /posts (+ /analytics/post/:id). Fixture when POSTIZ_API_URL/KEY are unset."""

    def __init__(self, url: str | None = None, key: str | None = None):
        s = get_settings()
        self.url, self.key = url or s.postiz_api_url, key or s.postiz_api_key

    def posts(self) -> list[dict]:
        if self.url and self.key:  # pragma: no cover
            r = httpx.get(f"{self.url.rstrip('/')}/posts", headers={"authorization": self.key}, params={"display": "week"})
            r.raise_for_status()
            return r.json().get("posts", [])
        return _fixture("postiz_posts.json")["posts"]
