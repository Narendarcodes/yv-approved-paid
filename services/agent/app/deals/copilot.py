"""Deal copilot, live path: map a question about ONE deal to the cards the web renders.

AI checks facts, people own taste, the deal decides the money.

The model only PICKS from a fixed menu of render actions and from ids the deal
itself offered (milestone keys, change-order ids). It never writes an amount, a
version verdict or a policy answer:

* every action name is whitelisted; unknown names are dropped;
* milestoneKey / changeOrderId must be ids from the deal we sent, else dropped;
* proposeCapture carries a milestone key only. The web takes the amount from the
  SIGNED terms (or the number the person typed) and runs it as a policy DRY RUN;
* the optional one-line note is dropped if it mentions money (symbols, codes, sums).

Identity is stripped by the router before the prompt leaves (identity.assert_clean).
When no provider answers, `answer` returns None and the caller (Node, then the web)
falls back to the deterministic offline replay.
"""
from __future__ import annotations
import os
import re

from .identity import Redactor
from .llm_router import LLMRouter

ACTIONS = {
    "showDeal": "the deal summary card (terms, signatures, milestone states)",
    "showChecks": "machine checks on a milestone's latest version (needs milestoneKey)",
    "showReviewMerge": "review notes merged into Fix (blocks pay) vs Taste (does not) (needs milestoneKey)",
    "showMoneyTimeline": "where the money is: held, captured, paid out (milestoneKey optional)",
    "showChangeOrder": "an out-of-scope change order priced from the rate card (needs changeOrderId)",
    "showDisputeSplit": "the dispute split proposal for a milestone (needs milestoneKey)",
    "showBlocked": "payment attempts the policy engine refused",
    "proposeCapture": "a read-only policy dry run of capturing a milestone (needs milestoneKey; never an amount)",
    "help": "the question is not about this deal",
}
NEEDS_KEY = {"showChecks", "showReviewMerge", "showDisputeSplit", "proposeCapture"}
MAX_ACTIONS = 3
MONEY_WORDS = re.compile(r"[$₹€£]|\b(usd|inr|eur|gbp|rs\.?|rupees?|dollars?|cents?|paise)\b|\d[\d,]*\.\d{2}\b|\b\d{3,}\b", re.I)

SYSTEM = (
    "You route questions about ONE freelance video deal to UI cards. You never decide money, amounts, "
    "verdicts or whether a video passed: the cards show facts from the deal and the policy engine decides. "
    "Pick 1 to 3 actions from this menu, using only ids present in the deal JSON:\n"
    + "\n".join(f"- {k}: {v}" for k, v in ACTIONS.items())
    + '\nReturn {"actions": [{"name": "<action>", "milestoneKey": "<key or omit>", "changeOrderId": "<id or omit>"}], '
    '"note": "<at most one short sentence saying which cards you chose, no amounts or numbers of money>"}.'
)


def _valid_shape(d: dict) -> bool:
    return isinstance(d.get("actions"), list)


def sanitize(ans: dict, deal: dict) -> dict | None:
    """Keep only whitelisted actions with ids the deal offered. Returns None if nothing usable survives."""
    keys = {m.get("key") for m in deal.get("milestones", []) if isinstance(m, dict)}
    cos = {c.get("id") for c in deal.get("changeOrders", []) if isinstance(c, dict)}
    out: list[dict] = []
    for a in ans.get("actions", [])[: MAX_ACTIONS * 2]:
        if not isinstance(a, dict) or a.get("name") not in ACTIONS:
            continue
        name = a["name"]
        mk = a.get("milestoneKey") if a.get("milestoneKey") in keys else None
        if name in NEEDS_KEY and not mk:
            continue
        if name == "showChangeOrder":
            co = a.get("changeOrderId")
            if co not in cos:
                continue
            item = {"name": name, "changeOrderId": co}
        elif name == "showMoneyTimeline":
            item = {"name": name, **({"milestoneKey": mk} if mk else {})}
        elif name in NEEDS_KEY:
            item = {"name": name, "milestoneKey": mk}  # no amount, no version: the web derives those
        else:
            item = {"name": name}
        if item not in out:
            out.append(item)
        if len(out) >= MAX_ACTIONS:
            break
    if not out:
        return None
    note = ans.get("note")
    note = note.strip()[:200] if isinstance(note, str) and note.strip() and not MONEY_WORDS.search(note) else None
    return {"actions": out, "note": note}


async def answer(router: LLMRouter, question: str, deal: dict, redact: list[str] | None = None) -> dict | None:
    red = Redactor()
    for i, lit in enumerate(redact or []):
        if isinstance(lit, str) and lit.strip():
            red.add(lit.strip(), f"[PARTY_{i + 1}]")
    ans = await router.json(
        "deal_copilot", SYSTEM, {"question": question[:500], "deal": deal}, redactor=red,
        max_tokens=int(os.environ.get("COPILOT_MAX_TOKENS", "900")), validate=_valid_shape,
    )
    if not ans:
        return None
    clean = sanitize(ans, deal)
    if not clean:
        return None
    last = router.calls[-1] if router.calls else {}
    provider = last.get("provider")
    model = next((p.model for p in router.chain if p.name == provider), None)
    return {**clean, "provider": provider, "model": model, "cached": bool(last.get("cached"))}
