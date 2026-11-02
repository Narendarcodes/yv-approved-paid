"""Agent proposals -> Node's deal routes (/internal/deals). Every proposal is dry-run first.

Flow for one proposal:
  1. POST /internal/deals/:id/policy-check  (money action, or a request_changes list)
  2. if the policy says no, the proposal is returned blocked and NOT shown as actionable
  3. machine facts (record_checks) and priced change-order drafts are posted;
     anything that moves money or needs a party's tap (split, request_changes) is
     returned with the decision attached for the person to act on in the UI.
  4. the Review merge and the Scope & Dispute proposal are also STORED on the
     milestone (POST /internal/deals/:id/milestones/:key/review and
     .../dispute-proposal) so the deal page and the copilot cards can show them.
     The dispute call carries no amount at all: Node computes the split from the
     signed checklist (passed / total check lines) and refuses amount-like keys.
The agent never calls a route that moves money.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..node_client import NodeClient, NodeError
from .agents import Proposal

# Same shape Node refuses (proposals.cts AMOUNT_KEY): agents send words and ids, never money.
AMOUNT_KEY = re.compile(r"(minor|amount|price|split|share|fee|bp|usd|inr)$", re.I)


def _milestone_key(route: str) -> str:
    return route.split("/milestones/")[1].split("/")[0]


def _no_amounts(v, path="body"):
    if isinstance(v, dict):
        for k, x in v.items():
            if AMOUNT_KEY.search(str(k)):
                raise ValueError(f"{path}.{k}: agents do not send amounts")
            _no_amounts(x, f"{path}.{k}")
    elif isinstance(v, list):
        for i, x in enumerate(v):
            _no_amounts(x, f"{path}[{i}]")


def review_body(p: Proposal, version_id: str | None = None) -> dict:
    """Review Agent proposal -> the /review body: items, contradictions (as indexes into the
    merged items), rationale. Merged duplicates point their original comment index at the kept item."""
    items = p.body.get("items", [])
    out_items = []
    for it in items:
        x = {"text": it["text"], "tag": "fix" if it.get("tag") == "fix" else "taste", "disputed": bool(it.get("disputed"))}
        if it.get("checklistId"):
            x["checklistId"] = it["checklistId"]
        out_items.append(x)
    # contradictions carry ORIGINAL comment indexes; map them onto the merged list
    where = {}
    for j, idxs in enumerate(p.body.get("merged_from") or []):
        for i in idxs:
            where[i] = j
    contradictions = []
    for c in p.body.get("contradictions", []):
        a, b = where.get(c["a"], c["a"]), where.get(c["b"], c["b"])
        if a != b and 0 <= a < len(out_items) and 0 <= b < len(out_items):
            contradictions.append({"a": a, "b": b, "why": str(c.get("why", ""))[:200]})
    body = {"items": out_items, "contradictions": contradictions}
    if p.rationale:
        body["rationale"] = p.rationale[:300]
    if version_id:
        body["versionId"] = version_id
    _no_amounts(body)
    return body


def dispute_body(version_id: str | None = None, notes: str | None = None) -> dict:
    """The dispute-proposal body: at most a version id and a note. No workerMinor, no amount of any kind."""
    body: dict = {}
    if version_id:
        body["versionId"] = version_id
    if notes:
        body["notes"] = notes[:1000]
    _no_amounts(body)
    return body


@dataclass
class Submitted:
    proposal: dict
    decision: dict | None = None
    posted: dict | None = None
    status: str = "for_human"  # posted | for_human | blocked | note
    error: dict | None = field(default=None)


class DealsNode:
    def __init__(self, node: NodeClient):
        self.node = node

    async def get_deal(self, deal_id: str) -> dict:
        return await self.node._req("GET", f"/deals/{deal_id}")

    async def policy_check(self, deal_id: str, body: dict) -> dict:
        return await self.node._req("POST", f"/deals/{deal_id}/policy-check", json=body)

    async def store_review(self, deal_id: str, key: str, p: Proposal, version_id: str | None = None) -> dict:
        """Store the Review Agent merge on the milestone (Node dry-runs it as request_changes first)."""
        return await self.node._req("POST", f"/deals/{deal_id}/milestones/{key}/review", json=review_body(p, version_id))

    async def store_dispute(self, deal_id: str, key: str, version_id: str | None = None, notes: str | None = None) -> dict:
        """Ask Node to build and store the Scope & Dispute proposal. Sends NO amount: Node computes the split."""
        return await self.node._req("POST", f"/deals/{deal_id}/milestones/{key}/dispute-proposal", json=dispute_body(version_id, notes))

    async def submit(self, deal_id: str, p: Proposal) -> Submitted:
        out = Submitted(proposal=p.to_dict())
        decision = None
        if p.policy_action:
            decision = await self.policy_check(deal_id, {"kind": "money", "action": p.policy_action})
        elif p.kind == "request_changes":
            key = _milestone_key(p.route)
            decision = await self.policy_check(deal_id, {"kind": "request_changes", "milestoneKey": key, "items": p.body["items"]})
        out.decision = decision
        if decision is not None and not decision.get("allowed") and not decision.get("needsHumanApproval"):
            out.status = "blocked"
            return out
        try:
            if p.kind == "record_checks":
                key = p.route.split("/milestones/")[1].split("/")[0]
                body = {k: p.body[k] for k in ("versionId", "sha256", "passed", "failed", "results", "notes")}
                out.posted = await self.node._req("POST", f"/deals/{deal_id}/milestones/{key}/checks", json=body)
                out.status = "posted"
            elif p.kind == "change_order" and p.body.get("priced"):
                b = p.body
                out.posted = await self.node._req("POST", f"/deals/{deal_id}/change-orders", json={
                    "milestoneKey": p.policy_action["milestoneKey"], "rateCardItemId": b["rateCardItemId"],
                    "quantity": b["quantity"], "amountMinor": b["amountMinor"], "ask": b["ask"]})
                out.status = "posted"  # a draft: the client still accepts it with one tap
            elif p.kind == "request_changes":
                # stored for the deal page; the CLIENT still sends it (status stays for_human)
                out.posted = await self.store_review(deal_id, _milestone_key(p.route), p)
            elif p.kind == "split":
                # stored for the deal page; both parties still accept it. Node computes the number.
                out.posted = await self.store_dispute(deal_id, _milestone_key(p.route), notes=p.rationale or None)
            elif not p.route:
                out.status = "note"
        except NodeError as e:
            out.status = "blocked"
            out.error = {"status": e.status, "message": str(e)}
        return out
