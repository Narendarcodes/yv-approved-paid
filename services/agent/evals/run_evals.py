"""Golden-question evals over the public API (login -> SSE chat). Stdlib only.
  python evals/run_evals.py --api http://127.0.0.1:3000/api/v1 --seed seed.json
Checks per question: routed flow, a citation for the expected post/metric, data limits stated,
and answer text containing an expected phrase (the phrase check is the only LLM-dependent one)."""
from __future__ import annotations
import argparse
import json
import os
import sys
import time
import urllib.request


def http(method, url, body=None, token=None, timeout=180):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json", **({"authorization": f"Bearer {token}"} if token else {})})
    return urllib.request.urlopen(req, timeout=timeout)


def login(api, email, password):
    with http("POST", f"{api}/auth/login", {"email": email, "password": password}) as r:
        return json.load(r)["data"]["accessToken"]


def chat(api, org, token, q):
    t0 = time.time()
    events = []
    with http("POST", f"{api}/organizations/{org}/agent/chat", {"message": q}, token) as r:
        buf = r.read().decode()
    for block in buf.strip().split("\n\n"):
        lines = dict(l.split(": ", 1) for l in block.splitlines() if ": " in l)
        if "event" in lines:
            events.append((lines["event"], json.loads(lines.get("data") or "{}")))
    return events, round(time.time() - t0, 2)


def check(item, events, post_ids):
    ans = next((d for e, d in events if e == "answer"), None)
    err = next((d for e, d in events if e == "error"), None)
    res = {"id": item["id"], "ok": False, "checks": {}}
    if not ans:
        res["error"] = err or "no answer event"
        return res
    c = res["checks"]
    c["flow"] = ans["flow"] == item["flow"]
    want_post = post_ids.get(item.get("citePost")) if item.get("citePost") else None
    c["citation"] = any((want_post is None or x["postId"] == want_post) and x["metric"].startswith(item["citeMetricPrefix"]) for x in ans["citations"])
    c["dataLimits"] = any(any(s in d for s in item["limitAnyOf"]) for d in ans["dataLimits"])
    c["answerPhrase"] = any(s.lower() in ans["answer"].lower() for s in item["answerAnyOf"])
    c["tokensStreamed"] = sum(1 for e, _ in events if e == "token") > 0
    res["ok"] = all(c.values())
    res["model"] = ans.get("model")
    res["answer"] = ans["answer"][:600]
    res["citations"] = ans["citations"][:6]
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", required=True)
    ap.add_argument("--seed", required=True, help="seed-agent-demo.js JSON output")
    ap.add_argument("--golden", default=os.path.join(os.path.dirname(__file__), "golden.json"))
    ap.add_argument("--out", default="eval-results.json")
    a = ap.parse_args()
    seed = json.load(open(a.seed))
    token = login(a.api, seed["login"]["email"], seed["login"]["password"])
    results = []
    for item in json.load(open(a.golden))["questions"]:
        events, secs = chat(a.api, seed["orgId"], token, item["q"])
        r = check(item, events, seed["postIds"])
        r["seconds"] = secs
        results.append(r)
        print(f"{'PASS' if r['ok'] else 'FAIL'} {item['id']:<14} {secs:>6}s {r.get('checks')}", flush=True)
    json.dump(results, open(a.out, "w"), indent=2)
    passed = sum(r["ok"] for r in results)
    print(f"golden evals: {passed}/{len(results)} passed")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
