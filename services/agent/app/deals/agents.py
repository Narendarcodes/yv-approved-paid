"""Video QA, Review, Scope and Dispute agents.

Shared contract (enforced in code, tested in tests/test_deals_agents.py):
* AI never sets an amount or a verdict. Amounts are arithmetic on the signed terms
  (rate card unit price x quantity, milestone amount x passed share); verdicts are
  the checklist comparison (media.VideoChecker) or a person's tap.
* LLM output is schema-validated and can only pick from ids we offered
  (checklist ids, rate-card ids). Anything else is dropped or downgraded.
* Every agent returns Proposal objects. A proposal names the Node route that would
  execute it; that route runs the deal policy engine (P1-P12) before anything happens.
  Money proposals carry `policy_action` in the exact MoneyAction shape the engine evaluates.
* All LLM input is identity-stripped by the router.
"""
from __future__ import annotations
import re
from dataclasses import dataclass, field, asdict
from typing import Literal

from .identity import Redactor
from .llm_router import LLMRouter
from .media import VideoChecker, words
from .stt import NEEDS_TRANSCRIPT


@dataclass
class Proposal:
    agent: str
    kind: Literal["record_checks", "request_changes", "change_order", "invoice", "split", "evidence_pack", "note"]
    route: str  # the Node route that executes it (policy runs there)
    body: dict
    needs_human: bool = True
    policy_action: dict | None = None  # MoneyAction for policy.evaluate, when money would move
    rationale: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _checks_of(milestone: dict) -> list[dict]:
    return [c for c in milestone.get("checklist", []) if c.get("kind") == "check"]


# =================================================================== Video QA
class VideoQAAgent:
    name = "video_qa"

    def __init__(self, router: LLMRouter | None = None):
        self.router = router

    async def run(self, deal_id: str, milestone: dict, version: dict, path: str, evidence_dir: str,
                  transcript=None, script=None, assets=None, stt=None) -> tuple[list[dict], Proposal]:
        needs_words = any((c.get("measure") or {}).get("metric") in NEEDS_TRANSCRIPT for c in _checks_of(milestone))
        if transcript is None and needs_words and stt is not None:
            transcript = stt(path)  # faster-whisper in production; a stub in tests
        checker = VideoChecker(path, evidence_dir, transcript=transcript, script=script, assets=assets)
        results = [r.to_dict() for r in checker.run(milestone.get("checklist", []))]
        failed = [r["checklist_id"] for r in results if not r["passed"]]
        summary = None
        if self.router and failed:
            # LLM writes a plain-language note from the facts only; it cannot change pass/fail.
            ans = await self.router.json(
                "qa_summary",
                "You explain failed video checks to a freelancer in <=2 short sentences each. Use only the facts given. "
                'Return {"notes": {"<checklist_id>": "<sentence>"}}.',
                {"failed": [r for r in results if not r["passed"]]},
                validate=lambda d: isinstance(d.get("notes"), dict),
            )
            if ans:
                summary = {k: v for k, v in ans["notes"].items() if k in failed and isinstance(v, str)}
        body = {"versionId": version["id"], "sha256": version["sha256"], "passed": not failed, "failed": failed,
                "results": results, "notes": summary or {}}
        return results, Proposal(self.name, "record_checks", f"POST /internal/deals/{deal_id}/milestones/{milestone['key']}/checks",
                                 body, needs_human=False, rationale=f"{len(results) - len(failed)}/{len(results)} checks passed")


# =================================================================== Review
TASTE_WORDS = {"vibe", "feel", "feels", "prefer", "like", "love", "hate", "punchy", "pop", "energy", "mood", "tone", "style",
               "nicer", "better", "cooler", "fresh", "boring", "warmer", "colder", "font", "colour", "color", "music", "aesthetic"}
# metric -> words that point at it in a comment
METRIC_WORDS = {
    "duration_s": {"long", "longer", "short", "shorter", "length", "duration", "seconds", "trim", "cut down"},
    "loudness_lufs": {"loud", "louder", "quiet", "quieter", "volume", "audio level", "lufs", "loudness"},
    "true_peak_dbtp": {"peak", "distort", "distortion"},
    "clipping": {"clip", "clipping", "crackle", "distorted"},
    "logo_present": {"logo", "brand mark", "watermark"},
    "caption_present": {"caption", "captions", "subtitle", "subtitles", "script", "line", "missing line", "last line", "final line",
                        "sentence", "cut off", "cuts off", "mid sentence", "finishes speaking", "ends before", "ending is cut"},
    "aspect_ratio": {"vertical", "horizontal", "aspect", "9:16", "16:9", "square", "crop"},
    "resolution_p": {"resolution", "blurry", "1080", "720", "4k", "pixelated"},
    "fps": {"fps", "frame rate", "choppy", "stutter"},
    "hook_by_s": {"hook", "intro", "opening", "first seconds"},
    "cut_interval_s": {"pace", "pacing", "cuts", "slow", "drags"},
}
# checklist-text words too generic to point at one line ("H.264 video" must not catch "the video ends early")
GENERIC_WORDS = {"the", "a", "is", "in", "of", "to", "be", "and", "must", "by", "video", "audio", "first", "least", "between", "match"}
OPPOSITES = [("louder", "quieter"), ("longer", "shorter"), ("faster", "slower"), ("bigger", "smaller"),
             ("brighter", "darker"), ("more music", "less music"), ("add", "remove"), ("keep", "cut"), ("earlier", "later")]


def _has(text: str, phrase: str) -> bool:
    return re.search(r"(?<!\w)" + re.escape(phrase) + r"(?!\w)", text) is not None


class ReviewAgent:
    """Merges reviewer comments, tags each Fix (cites a broken checklist line) or Taste, flags contradictions."""

    name = "review"

    def __init__(self, router: LLMRouter | None = None):
        self.router = router

    def rule_tag(self, text: str, milestone: dict, failed: set[str]) -> dict:
        low = text.lower()
        hits = []
        for c in _checks_of(milestone):
            metric = (c.get("measure") or {}).get("metric", "")
            kw = METRIC_WORDS.get(metric, set()) | set(words(c.get("text", ""))) - GENERIC_WORDS
            score = sum(1 for k in kw if len(k) > 2 and _has(low, k))
            if score:
                hits.append((score + (2 if c["id"] in failed else 0), c["id"]))
        if hits:
            hits.sort(reverse=True)
            return {"tag": "fix", "checklistId": hits[0][1], "basis": "rule", "confident": hits[0][0] >= 2}
        taste = any(_has(low, w) for w in TASTE_WORDS)
        return {"tag": "taste", "checklistId": None, "basis": "rule", "confident": taste}

    async def run(self, deal_id: str, milestone: dict, comments: list[dict], failed_checks: list[str] | None = None,
                  redactor: Redactor | None = None) -> Proposal:
        failed = set(failed_checks or [])
        ids = {c["id"] for c in _checks_of(milestone)}
        items = []
        for i, c in enumerate(comments):
            t = self.rule_tag(c["text"], milestone, failed)
            items.append({"i": i, "text": c["text"], "reviewer": c.get("reviewer"), **t})
        unsure = [it for it in items if not it["confident"]]
        if self.router and unsure:
            ans = await self.router.json(
                "fix_taste",
                "Tag each reviewer comment on a video. 'fix' ONLY if it asks to meet one of the measurable checklist lines given "
                "(cite its id). Otherwise 'taste'. Do not judge who wrote it. "
                'Return {"tags": [{"i": <int>, "tag": "fix"|"taste", "checklistId": "<id or null>"}]}.',
                {"checklist": [{"id": c["id"], "text": c["text"]} for c in _checks_of(milestone)],
                 "comments": [{"i": it["i"], "text": it["text"]} for it in unsure]},
                redactor=redactor,
                validate=lambda d: isinstance(d.get("tags"), list),
            )
            for t in (ans or {}).get("tags", []):
                it = next((x for x in items if x["i"] == t.get("i")), None)
                if not it:
                    continue
                if t.get("tag") == "fix" and t.get("checklistId") in ids:
                    it.update(tag="fix", checklistId=t["checklistId"], basis="llm")
                elif t.get("tag") in ("fix", "taste"):
                    # a Fix that cites nothing signed is Taste: it costs a revision round, not pay
                    it.update(tag="taste", checklistId=None, basis="llm")
        contradictions = self.contradictions(items)
        merged = self.merge(items, contradictions)
        fix_n = sum(1 for x in merged if x["tag"] == "fix")
        body = {"items": [{"text": x["text"], "tag": x["tag"], "checklistId": x["checklistId"] or None,
                           "disputed": any(x["i"] in (c["a"], c["b"]) for c in contradictions)} for x in merged],
                "contradictions": contradictions,
                # original comment indexes behind each merged item (contradictions use those indexes)
                "merged_from": [[x["i"], *x.get("also", [])] for x in merged]}
        return Proposal(self.name, "request_changes", f"POST /api/v1/organizations/:org/deals/{deal_id}/milestones/{milestone['key']}/changes", body,
                        needs_human=True, rationale=f"{fix_n} fix, {len(merged) - fix_n} taste, {len(contradictions)} contradiction(s)")

    @staticmethod
    def merge(items: list[dict], contradictions: list[dict] | None = None) -> list[dict]:
        """Same ask from two reviewers (same tag+checklist line, near-identical words) becomes one item.
        Two asks that contradict each other are never merged: both stay visible for the people to settle."""
        clash = {frozenset((c["a"], c["b"])) for c in (contradictions or [])}
        out: list[dict] = []
        for it in items:
            w = set(words(it["text"]))
            dup = next((o for o in out if o["tag"] == it["tag"] and o["checklistId"] == it["checklistId"]
                        and frozenset((o["i"], it["i"])) not in clash
                        and len(w & set(words(o["text"]))) / max(1, len(w | set(words(o["text"])))) >= 0.5), None)
            if dup:
                dup.setdefault("also", []).append(it["i"])
            else:
                out.append(dict(it))
        return out

    @staticmethod
    def contradictions(items: list[dict]) -> list[dict]:
        out = []
        for x in range(len(items)):
            for y in range(x + 1, len(items)):
                a, b = items[x]["text"].lower(), items[y]["text"].lower()
                for p, q in OPPOSITES:
                    if (_has(a, p) and _has(b, q)) or (_has(a, q) and _has(b, p)):
                        same_target = items[x]["checklistId"] == items[y]["checklistId"] or bool(
                            (set(words(a)) & set(words(b))) - {p, q, "the", "a", "it", "make", "more", "less", "please", "be", "is"})
                        if same_target:
                            out.append({"a": items[x]["i"], "b": items[y]["i"], "why": f"'{p}' vs '{q}'"})
                            break
        return out


# =================================================================== Scope & Dispute
class ScopeDisputeAgent:
    name = "scope_dispute"

    def __init__(self, router: LLMRouter | None = None):
        self.router = router

    async def scope(self, deal_id: str, terms: dict, milestone: dict, ask: str, redactor: Redactor | None = None) -> Proposal:
        """Is `ask` inside the signed checklist? If not, draft a change order priced from the rate card."""
        signed = [c["text"] for c in milestone.get("checklist", [])]
        card = {r["id"]: r for r in terms.get("rateCard", [])}
        low = ask.lower()
        # rule pass: does the ask overlap a signed line?
        overlap = max((len(set(words(low)) & set(words(s.lower()))) for s in signed), default=0)
        decision = {"in_scope": overlap >= 3, "rateCardItemId": None, "quantity": None, "basis": "rule"}
        if self.router:
            ans = await self.router.json(
                "scope",
                "Decide if a client's new ask is covered by the signed checklist. If not, pick the ONE rate-card item that "
                "covers it and a whole-number quantity in that item's unit. Never output prices. "
                'Return {"in_scope": bool, "rateCardItemId": "<id or null>", "quantity": <int or null>, "why": "<short>"}.',
                {"signed_checklist": signed, "rate_card": [{"id": r["id"], "label": r["label"], "unit": r["unit"]} for r in card.values()], "ask": ask},
                redactor=redactor,
                validate=lambda d: isinstance(d.get("in_scope"), bool),
            )
            if ans:
                decision = {"in_scope": ans["in_scope"], "rateCardItemId": ans.get("rateCardItemId"), "quantity": ans.get("quantity"),
                            "basis": "llm", "why": str(ans.get("why", ""))[:200]}
        if decision["in_scope"]:
            return Proposal(self.name, "note", "", {"ask": ask, "in_scope": True}, needs_human=False,
                            rationale="covered by the signed checklist; no extra charge")
        item = card.get(decision.get("rateCardItemId") or "")
        q = decision.get("quantity")
        if not item or not isinstance(q, int) or not (1 <= q <= 100):
            # cannot price it from the signed card -> people negotiate; nothing is invented
            return Proposal(self.name, "change_order", "", {"ask": ask, "in_scope": False, "priced": False}, needs_human=True,
                            rationale="out of scope, and no rate-card line fits: needs a new term both sides sign")
        amount = item["unitPriceMinor"] * q  # the only place an amount appears, and it is pure arithmetic on signed terms
        action = {"kind": "invoice", "milestoneKey": milestone["key"], "rateCardItemId": item["id"], "quantity": q, "amountMinor": amount}
        return Proposal(self.name, "change_order", f"POST /internal/deals/{deal_id}/change-orders",
                        {"ask": ask, "in_scope": False, "priced": True, "rateCardItemId": item["id"], "quantity": q, "amountMinor": amount,
                         "currency": terms.get("currency")},
                        needs_human=True, policy_action=action,
                        rationale=f"{q} x {item['label']} at the signed rate ({item['unitPriceMinor']} per {item['unit']})")

    def dispute(self, deal_id: str, terms: dict, milestone: dict, runtime: dict, check_results: list[dict],
                change_requests: list[dict] | None = None) -> tuple[Proposal, Proposal]:
        """Evidence pack + proposed split. Split = milestone amount x (passed checks / all checks). Both sides must accept."""
        checks = _checks_of(milestone)
        by_id = {r["checklist_id"]: r for r in check_results}
        passed = [c["id"] for c in checks if by_id.get(c["id"], {}).get("passed")]
        unmeasured = [c["id"] for c in checks if c["id"] not in by_id]
        total = len(checks)
        remaining = milestone["amountMinor"] - int(runtime.get("capturedMinor", 0))
        share_bp = (len(passed) * 10000) // total if total else 0
        worker_minor = (milestone["amountMinor"] * share_bp) // 10000
        worker_minor = max(0, min(worker_minor, remaining))
        pack = {
            "milestone": milestone["key"], "termsHash": runtime.get("termsHash"),
            "checks": [{"id": c["id"], "text": c["text"], "passed": by_id.get(c["id"], {}).get("passed"),
                        "evidence": by_id.get(c["id"], {}).get("evidence", [])} for c in checks],
            "taste_lines": [c["text"] for c in milestone.get("checklist", []) if c.get("kind") == "taste"],
            "revision_rounds": {"included": milestone.get("revisionRoundsIncluded"), "used": runtime.get("revisionRoundsUsed", 0),
                                "taste_rounds": runtime.get("tasteRoundsUsed", 0)},
            "change_requests": change_requests or runtime.get("changeRequests", []),
            "history": runtime.get("history", []),
            "unmeasured": unmeasured,
        }
        ev = Proposal(self.name, "evidence_pack", "", pack, needs_human=False, rationale="facts only; no verdict")
        split = Proposal(
            self.name, "split", f"POST /api/v1/organizations/:org/deals/{deal_id}/milestones/{milestone['key']}/split", {"workerMinor": worker_minor},
            needs_human=True,
            policy_action={"kind": "partial_capture", "milestoneKey": milestone["key"], "amountMinor": worker_minor, "reason": "dispute_split"},
            rationale=f"{len(passed)}/{total} signed checks pass -> {share_bp / 100:.0f}% of the milestone; applies only if BOTH sides accept",
        )
        return ev, split
