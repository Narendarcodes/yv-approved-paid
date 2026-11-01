"""End-to-end test against a running stack (docker compose). Stdlib only.
seed -> enqueue analyze job -> insight stored -> review digest job -> transcribe job (Whisper if
STT_URL is set on the worker) -> chat answer with citations (golden evals run separately).
  python infra/e2e.py --api http://127.0.0.1:18300/api/v1 --seed seed.json"""
import argparse
import json
import sys
import time
import urllib.request

sys.path.insert(0, __file__.rsplit("/", 2)[0] + "/services/agent/evals")
from run_evals import chat, http, login  # noqa: E402


def wait_job(api, org, token, job_id, timeout=300):
    t0 = time.time()
    while time.time() - t0 < timeout:
        with http("GET", f"{api}/organizations/{org}/agent/jobs/{job_id}", token=token) as r:
            j = json.load(r)["data"]
        if j["status"] != "queued":
            j["seconds"] = round(time.time() - t0, 2)
            return j
        time.sleep(1)
    raise TimeoutError(job_id)


def enqueue(api, org, token, path, body=None):
    with http("POST", f"{api}/organizations/{org}/agent{path}", body or {}, token) as r:
        return json.load(r)["data"]["jobId"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", required=True)
    ap.add_argument("--seed", required=True)
    ap.add_argument("--skip-transcribe", action="store_true")
    a = ap.parse_args()
    seed = json.load(open(a.seed))
    org, P = seed["orgId"], seed["postIds"]
    token = login(a.api, seed["login"]["email"], seed["login"]["password"])
    out, ok = {}, True

    jid = enqueue(a.api, org, token, f"/posts/{P['breath']}/analyze")
    job = wait_job(a.api, org, token, jid)
    with http("GET", f"{a.api}/organizations/{org}/agent/insights?postId={P['breath']}", token=token) as r:
        ins = json.load(r)["data"]
    spike = next((i for i in ins if i["kind"] == "retention_spike"), None)
    out["analyze"] = {"status": job["status"], "seconds": job["seconds"], "insightAtSecond": spike and spike.get("atSecond"),
                      "citations": spike and spike["citations"], "summary": spike and spike["summary"][:500]}
    ok &= job["status"] == "succeeded" and spike is not None and spike.get("atSecond") == 42

    jid = enqueue(a.api, org, token, f"/posts/{P['dads']}/review-digest")
    job = wait_job(a.api, org, token, jid)
    out["reviewDigest"] = {"status": job["status"], "seconds": job["seconds"], "result": job.get("result")}
    ok &= job["status"] == "succeeded" and (job.get("result") or {}).get("changes", 0) >= 4

    if not a.skip_transcribe:
        jid = enqueue(a.api, org, token, f"/posts/{P['dads']}/transcribe", {"language": "en"})
        job = wait_job(a.api, org, token, jid)
        out["transcribe"] = {"status": job["status"], "seconds": job["seconds"], "result": job.get("result"), "error": job.get("error")}
        ok &= job["status"] == "succeeded" and (job.get("result") or {}).get("segments", 0) > 0

    events, secs = chat(a.api, org, token, "Why did the 3 breathing cues short go viral?")
    ans = next((d for e, d in events if e == "answer"), {})
    out["chat"] = {"seconds": secs, "flow": ans.get("flow"), "model": ans.get("model"), "answer": (ans.get("answer") or "")[:800],
                   "citations": ans.get("citations"), "dataLimits": ans.get("dataLimits"), "tokenEvents": sum(1 for e, _ in events if e == "token")}
    ok &= ans.get("flow") == "insight" and any(c["postId"] == P["breath"] and c["metric"].startswith("retention@") for c in ans.get("citations", []))

    # isolation: a second org's user must not reach this org's agent
    try:
        http("POST", f"{a.api}/organizations/000000000000000000000000/agent/chat", {"message": "hi"}, token)
        out["isolation"] = "FAIL: foreign org accepted"
        ok = False
    except urllib.error.HTTPError as e:
        out["isolation"] = f"foreign org rejected with {e.code}"

    print(json.dumps(out, indent=2))
    print("E2E", "PASSED" if ok else "FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
