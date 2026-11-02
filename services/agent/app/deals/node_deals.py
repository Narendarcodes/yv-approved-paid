"""Agent proposals -> Node's deal routes (/internal/deals). Every proposal is dry-run first.

Flow for one proposal:
  1. POST /internal/deals/:id/policy-check  (money action, or a request_changes list)
  2. if the policy says no, the proposal is returned blocked and NOT shown as actionable
  3. machine facts (record_checks) and priced change-order drafts are posted;
     anything that moves money or needs a party's tap (split, request_changes) is
     returned with the decision attached for the person to act on in the UI.
The agent never calls a route that moves money.
"""
from __future__ import annotations
from dataclasses import dataclass, field

from ..node_client import NodeClient, NodeError
from .agents import Proposal


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

    async def submit(self, deal_id: str, p: Proposal) -> Submitted:
        out = Submitted(proposal=p.to_dict())
        decision = None
        if p.policy_action:
            decision = await self.policy_check(deal_id, {"kind": "money", "action": p.policy_action})
        elif p.kind == "request_changes":
            key = p.route.split("/milestones/")[1].split("/")[0]
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
            elif not p.route:
                out.status = "note"
        except NodeError as e:
            out.status = "blocked"
            out.error = {"status": e.status, "message": str(e)}
        return out
