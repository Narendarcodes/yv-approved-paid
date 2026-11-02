"""Fix/Taste tagger eval (rule layer, offline). Run: python -m evals.deals.run_fix_taste
Scores tag accuracy, checklist-id accuracy for Fix, and swap-pair stability. Exits 1 below the bars."""
from __future__ import annotations
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from app.deals.agents import ReviewAgent  # noqa: E402
from tests.deals_fixtures import TERMS  # noqa: E402

CASES = json.loads((pathlib.Path(__file__).parent / "fix_taste_cases.json").read_text())["cases"]
M = TERMS["milestones"][0]


def metric_to_id(m):
    return {(c.get("measure") or {}).get("metric"): c["id"] for c in M["checklist"]}.get(m)


def evaluate():
    ag = ReviewAgent()
    out, by_id = [], {}
    for c in CASES:
        got = ag.rule_tag(c["text"], M, set())
        want_id = metric_to_id(c.get("metric")) if c["tag"] == "fix" else None
        ok = got["tag"] == c["tag"] and got["checklistId"] == want_id and (c["tag"] == "taste" or want_id is not None)
        by_id[c["id"]] = got
        out.append({"id": c["id"], "ok": ok, "want": [c["tag"], want_id], "got": [got["tag"], got["checklistId"]]})
    swaps = [c for c in CASES if c.get("swap_of")]
    swap_ok = all(by_id[c["id"]]["tag"] == by_id[c["swap_of"]]["tag"] and
                  by_id[c["id"]]["checklistId"] == by_id[c["swap_of"]]["checklistId"] for c in swaps)
    acc = sum(r["ok"] for r in out) / len(out)
    return {"cases": len(out), "accuracy": round(acc, 3), "swap_pairs": len(swaps), "swap_stable": swap_ok,
            "failures": [r for r in out if not r["ok"]]}


if __name__ == "__main__":
    r = evaluate()
    print(json.dumps(r, indent=2))
    sys.exit(0 if r["accuracy"] >= 0.9 and r["swap_stable"] else 1)
