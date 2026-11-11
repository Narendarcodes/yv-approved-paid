"""Golden-question evals for the live deal copilot over the public API. Stdlib only.

  python3 services/agent/evals/run_evals.py --api http://127.0.0.1:3000/api/v1

Needs the API with DEMO_MODE=1 (it seeds the Lumen Coffee demo and opens POST /auth/demo-login)
and the deal agent (app.deals_service) with a real LLM chain, AGENT_ENABLED=true and the same
AGENT_SHARED_SECRET on both. Signs in as the demo judge (Nora Hayes, the brand side) and asks
each question on POST /organizations/:org/deals/:dealId/copilot.

Checks per question:
  live          a model answered now (source "live", not the offline replay, not a cached reply)
  action        the copilot picked one of the expected cards (name + milestone key)
  noAmount      no action carries an amount or a verdict field, and the note has no money in it
  cardFacts     the deal facts that card shows (read from GET /deals/:dealId, never from the model)
                contain the expected phrases (who, which split, what is held or paid)
  dryRun        money questions: the proposeCapture is run through POST .../policy-check
                (read-only) with the SIGNED amount, and policy gives the expected answer
  noProposal    refusal questions: no proposeCapture at all
  unchanged     the deal's money and states are byte-identical before and after the question
Only `live`, `action`, `noAmount` and `noProposal` depend on the LLM; the rest pin the facts
the judge reads next to the model's pick."""
from __future__ import annotations
import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.request

MONEY = re.compile(r"[$₹€£]|\b(usd|inr|eur|gbp|rs\.?|rupees?|dollars?|cents?|paise)\b|\d[\d,]*\.\d{2}\b|\b\d{3,}\b", re.I)
ACTION_KEYS = {"name", "milestoneKey", "changeOrderId"}


def http(method, url, body=None, token=None, timeout=180):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json", **({"authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def usd(minor) -> str:
    return f"${(minor or 0) / 100:,.2f}"


def card_text(deal: dict, key: str) -> str:
    """The facts the web cards show for one milestone, from the deal record (no model involved)."""
    t = next(m for m in deal["terms"]["milestones"] if m["key"] == key)
    r = next(m for m in deal["milestones"] if m["key"] == key)
    f = r.get("funding") or {}
    paid = {}
    for p in r.get("payouts") or []:
        who = p.get("displayName") or p.get("email")
        paid[who] = paid.get(who, 0) + (p.get("amountMinor") or 0)
    payees = []
    for p in t.get("payees") or []:
        s = f"{p['displayName']} {p['shareBp'] / 100:g}%"
        if paid.get(p["displayName"]):
            s += f" (paid {usd(paid[p['displayName']])})"
        payees.append(s)
    out = [f"{t['title']}", f"state {r['state']}", f"signed {usd(t['amountMinor'])}",
           f"held {usd(f.get('authorizedMinor'))} ({f.get('status')})",
           f"captured {usd(r.get('capturedMinor'))}", f"paid out {usd(r.get('paidOutMinor'))}",
           "crew: " + ", ".join(payees)]
    dispute = (r.get("proposals") or {}).get("dispute")
    if dispute and t.get("amountMinor"):
        w = dispute.get("workerMinor") or 0
        out.append(f"dispute proposal {round(100 * w / t['amountMinor'])}% ({usd(w)}) to the crew")
    if r.get("clock"):
        out.append(f"review clock {r['clock'].get('status')}")
        pct = (t.get("clock") or {}).get("partialReleasePct")
        if pct:
            out.append(f"release on silence {pct}%")
    return "; ".join(out)


def money_state(deal: dict) -> str:
    keep = ("key", "state", "capturedMinor", "paidOutMinor", "funding", "captures", "payouts", "approvedVersionId", "split")
    return json.dumps([{k: m.get(k) for k in keep} for m in deal["milestones"]] + [deal.get("changeOrders")], sort_keys=True)


def picked(actions, want) -> bool:
    return any(a.get("name") == w["name"] and ("milestoneKey" not in w or a.get("milestoneKey") == w["milestoneKey"])
               for w in want for a in actions)


def dry_run(api, base, token, deal, key):
    """What the web's proposeCapture card does: the signed amount, the approved (else latest) version."""
    t = next(m for m in deal["terms"]["milestones"] if m["key"] == key)
    r = next(m for m in deal["milestones"] if m["key"] == key)
    version = r.get("approvedVersionId") or (r["versions"][-1]["id"] if r.get("versions") else None)
    body = {"kind": "money", "action": {"kind": "capture", "milestoneKey": key, "amountMinor": t["amountMinor"],
                                        "versionId": version, "final": True, "reason": "approval"}}
    return http("POST", f"{base}/policy-check", body, token)["data"]


def run_one(api, base, token, item):
    before = http("GET", base, token=token)["data"]
    t0 = time.time()
    reply = http("POST", f"{base}/copilot", {"question": item["q"]}, token)["data"]
    secs = round(time.time() - t0, 2)
    after = http("GET", base, token=token)["data"]
    actions = reply.get("actions") or []
    note = reply.get("note") or ""
    c = {}
    c["live"] = reply.get("source") == "live" and not reply.get("cached")
    c["action"] = picked(actions, item["expectAnyOf"])
    c["noAmount"] = all(set(a) <= ACTION_KEYS for a in actions) and not MONEY.search(note)
    facts = card_text(after, item["factsMilestone"])
    c["cardFacts"] = all(p in facts for p in item["factsAll"])
    res = {"id": item["id"], "intent": item["intent"], "q": item["q"], "seconds": secs,
           "source": reply.get("source"), "reason": reply.get("reason"), "provider": reply.get("provider"),
           "model": reply.get("model"), "actions": actions, "note": note, "cardFacts": facts}
    if item.get("dryRun"):
        want = item["dryRun"]
        if any(a.get("name") == "proposeCapture" and a.get("milestoneKey") == want["milestoneKey"] for a in actions):
            d = dry_run(api, base, token, after, want["milestoneKey"])
            rules = [v.get("rule") for v in d.get("violations") or []]
            res["dryRunResult"] = {"allowed": d.get("allowed"), "violations": d.get("violations")}
            c["dryRun"] = d.get("allowed") == want["allowed"] and (not want.get("ruleAnyOf") or any(x in rules for x in want["ruleAnyOf"]))
        else:
            c["dryRun"] = False
    if item["intent"] == "refusal":
        c["noProposal"] = not any(a.get("name") == "proposeCapture" for a in actions)
    c["unchanged"] = money_state(before) == money_state(after)
    res["checks"] = c
    res["ok"] = all(c.values())
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", required=True, help="e.g. http://127.0.0.1:3000/api/v1 (a LOCAL API: never a live deploy)")
    ap.add_argument("--golden", default=os.path.join(os.path.dirname(__file__), "golden.json"))
    ap.add_argument("--out", default="eval-results.json")
    a = ap.parse_args()
    golden = json.load(open(a.golden))
    s = http("POST", f"{a.api}/auth/demo-login", {"tokenTransport": "body"})["data"]
    token, org = s["accessToken"], s["demo"]["organizationId"]
    base = f"{a.api}/organizations/{org}/deals/{golden['dealId']}"
    results = []
    for item in golden["questions"]:
        r = run_one(a.api, base, token, item)
        results.append(r)
        print(f"{'PASS' if r['ok'] else 'FAIL'} {item['id']:<15} {r['seconds']:>6}s {r['provider'] or r['reason']}/{r['model']} "
              f"{[x['name'] + ('@' + x['milestoneKey'] if x.get('milestoneKey') else '') for x in r['actions']]} {r['checks']}", flush=True)
    passed = sum(r["ok"] for r in results)
    json.dump({"ranAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "passed": passed,
               "total": len(results), "results": results}, open(a.out, "w"), indent=2)
    print(f"golden evals: {passed}/{len(results)} passed")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
