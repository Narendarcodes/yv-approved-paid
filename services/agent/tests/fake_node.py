"""In-memory fake of Node's /internal API (httpx MockTransport) mirroring the demo seed."""
import json
import math

import httpx

ORG = "64b000000000000000000001"
OTHER_ORG = "64b000000000000000000002"
P = {k: f"65a00000000000000000000{i}" for i, k in enumerate(["breath", "garbh", "dads", "lullaby", "myth", "bts"], start=1)}


def curve(duration, spike=None, decay=0.004):
    return [{"postId": "", "second": s, "audienceWatchRatio": round(math.exp(-decay * s) * (1 if s < 3 else 0.93) + (0.42 * math.exp(-((s - spike) ** 2) / (2 * 1.6 ** 2)) if spike else 0), 3)} for s in range(0, duration + 1)]


class FakeNode:
    def __init__(self):
        self.insights, self.results, self.media_puts = [], [], []
        self.posts = [
            dict(id=P["breath"], orgId=ORG, platform="youtube", title="3 breathing cues for the third trimester", format="short", durationSec=58, tags=["breathing"], source="fixture"),
            dict(id=P["garbh"], orgId=ORG, platform="youtube", title="Garbh Sanskar explained in 8 minutes", format="long", durationSec=480, tags=[], source="fixture"),
            dict(id=P["dads"], orgId=ORG, platform="youtube", title="What dads can do in week 30", format="short", durationSec=45, tags=[], source="fixture"),
            dict(id=P["lullaby"], orgId=ORG, platform="instagram", title="A Telugu lullaby for your bump (30s)", format="reel", durationSec=30, tags=["lullaby"], source="fixture"),
            dict(id=P["myth"], orgId=ORG, platform="instagram", title="Myth vs fact: eating for two", format="reel", durationSec=24, tags=[], source="fixture"),
        ]
        vals = {"breath": (184000, 12100, 640, 2900, 0), "garbh": (41000, 1900, 210, 300, 0), "dads": (9800, 410, 22, 35, 0), "lullaby": (96000, 8800, 410, 2100, 6400), "myth": (38000, 2100, 190, 520, 900)}
        self.metrics = []
        for k, v in vals.items():
            for name, x in zip(["views", "likes", "comments", "shares", "saves"], v):
                self.metrics.append({"postId": P[k], "metric": name, "value": x, "ts": "2026-10-15T00:00:00Z", "source": "fixture"})
        self.retention = {P["breath"]: curve(58, spike=42), P["dads"]: curve(45, decay=0.02)}
        self.media = {P["breath"]: {"storageKey": "s3://yv-media/demo/breath.wav", "transcriptEngine": "fixture",
                                    "transcript": [{"start": 38, "end": 46, "text": "Now keep your palm right here. Feel that?"}],
                                    "sceneCuts": [{"second": 41.2, "label": "Close-up: palm on belly, caption \"Feel that?\""}]},
                      P["dads"]: {"storageKey": "file:///tmp/dads.wav", "transcript": [], "sceneCuts": []}}
        self.rules = [
            {"id": "r1", "title": "No medical advice", "body": "Never prescribe. Show the on-screen disclaimer Not medical advice in the first 3 seconds.", "kind": "dont"},
            {"id": "r2", "title": "Call to action", "body": "End every video with Join the next workshop. Never use Buy now.", "kind": "do"},
            {"id": "r3", "title": "Visual identity", "body": "Teal #035E5E accents on warm off-white; captions always on.", "kind": "visual"},
        ]
        self.comments = {P["dads"]: [
            {"id": "c1", "postId": P["dads"], "author": "Sana", "body": "The background music is too loud around 0:12", "timecodeSec": 12},
            {"id": "c2", "postId": P["dads"], "author": "Priya", "body": "Lower the music under the voiceover", "timecodeSec": 11},
            {"id": "c3", "postId": P["dads"], "author": "Meera", "body": "Disclaimer missing in first 3 seconds", "timecodeSec": 2},
            {"id": "c4", "postId": P["dads"], "author": "Meera", "body": "End card should say Join the next workshop, not Book now", "timecodeSec": 43},
        ]}

    def handler(self, req: httpx.Request) -> httpx.Response:
        path = req.url.path.replace("/internal", "")
        if req.headers.get("authorization") != "Bearer good":
            return httpx.Response(401, json={"error": "bad token"})
        pid = req.url.params.get("postId")
        if path == "/whoami":
            return httpx.Response(200, json={"data": {"orgId": ORG, "userId": "u1", "scopes": []}})
        if path == "/posts":
            return httpx.Response(200, json={"data": self.posts})
        if path == "/metrics":
            return httpx.Response(200, json={"data": [m for m in self.metrics if not pid or m["postId"] == pid]})
        if path.endswith("/retention"):
            p = path.split("/")[2]
            return httpx.Response(200, json={"data": [{**x, "postId": p} for x in self.retention.get(p, [])]})
        if path.endswith("/media"):
            p = path.split("/")[2]
            if req.method == "PUT":
                body = json.loads(req.content)
                self.media_puts.append((p, body))
                return httpx.Response(200, json={"data": {"segments": len(body.get("transcript", []))}})
            return httpx.Response(200, json={"data": self.media.get(p)})
        if path == "/brand/rules":
            return httpx.Response(200, json={"data": self.rules})
        if path == "/review-comments":
            return httpx.Response(200, json={"data": self.comments.get(pid, [])})
        if path == "/insights":
            self.insights.append(json.loads(req.content))
            return httpx.Response(201, json={"data": {"id": f"ins{len(self.insights)}"}})
        if path.startswith("/jobs/"):
            self.results.append(json.loads(req.content))
            return httpx.Response(200, json={"data": {"ok": True}})
        return httpx.Response(404, json={"error": "nf"})

    def client(self, token="good"):
        from app.node_client import NodeClient

        return NodeClient(token, base_url="http://node/internal", transport=httpx.MockTransport(self.handler))
