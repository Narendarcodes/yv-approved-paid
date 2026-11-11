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
    + "\nRouting rules (most relevant card first):\n"
    "- 'can we pay / release / capture' a milestone, or 'nobody replied, can the money go out': proposeCapture for that "
    "milestone first. It is a read-only dry run; the policy engine answers yes or no and why.\n"
    "- a request to SET an amount, a percentage or a payout, or to settle or close a dispute: you cannot do it. "
    "Put showDisputeSplit for that milestone first (if it has a dispute), then showMoneyTimeline. Never proposeCapture.\n"
    "- a request to mark a version passed, approve it or give a verdict: you cannot do it. Put showChecks for that "
    "milestone first, then showReviewMerge. Never proposeCapture.\n"
    "- facts (who is on the crew, has it been paid, where is the money): showDeal and/or showMoneyTimeline.\n"
    "- routingHints in the input are computed from the question by fixed rules: keep them, in that order, first.\n"
    + 'Return {"actions": [{"name": "<action>", "milestoneKey": "<key or omit>", "changeOrderId": "<id or omit>"}], '
    '"note": "<at most one short sentence saying which cards you chose, no amounts or numbers of money>"}.'
)

_VERDICT = re.compile(r"\b(mark|marked|pass|passed|passes|approve|approved|approval|accept|accepted|sign[- ]?off|verdict|reject|rejected|fail|failed)\b", re.I)
_VERDICT_ASK = re.compile(r"\b(mark|flag|set|call)\b[^.?!]*\b(pass|passed|approved|fail|failed|rejected|ok|good)\b|\b(approve|reject|pass|fail)\s+(it|this|that|them|reel|the|for|version)\b", re.I)
_SET_MONEY = re.compile(r"(\d+\s*(%|percent)|\bset\b.*\b(pay|payout|amount|split|share|cut)\b|\b(close|settle|resolve|end)\b.*\bdispute\b|\bdispute\b.*\b(close|settle|resolve)\b|\b(change|raise|lower|increase|decrease)\b.*\b(payout|amount|split|share)\b)", re.I)
_PAY_ASK = re.compile(r"(\b(can|could|should|may|is it ok to|ok to)\b.*\b(pay|paid|release|released|capture|captured|send|payout)\b|^\s*(please\s+)?(pay|release|capture)\b)", re.I)


def _milestone_in(question: str, deal: dict) -> str | None:
    """The milestone the question names ('reel 3', 'reel3', or its title), from the keys the deal offered."""
    q = re.sub(r"[^a-z0-9]+", "", question.lower())
    ms = [m for m in deal.get("milestones", []) if isinstance(m, dict) and isinstance(m.get("key"), str)]
    for m in sorted(ms, key=lambda m: -len(m["key"])):
        k = re.sub(r"[^a-z0-9]+", "", m["key"].lower())
        if k and re.search(re.escape(k) + r"(?!\d)", q):
            return m["key"]
    for m in ms:
        t = m.get("title")
        if isinstance(t, str):
            head = re.sub(r"[^a-z0-9]+", "", t.split(":")[0].lower())
            if head and re.search(re.escape(head) + r"(?!\d)", q):
                return m["key"]
    return None


def route_hints(question: str, deal: dict) -> tuple[list[dict], bool]:
    """Fixed rules over the question: (cards that must come first, refusal?).

    A refusal is a request for the AI to set money or a verdict: those cards show the facts and who decides,
    and no proposeCapture is ever offered for them. The hints only ever name cards and deal ids, never amounts."""
    q = question or ""
    mk = _milestone_in(q, deal)
    m = next((x for x in deal.get("milestones", []) if isinstance(x, dict) and x.get("key") == mk), {}) if mk else {}
    if _SET_MONEY.search(q):
        out: list[dict] = []
        if mk and (m.get("hasDisputeProposal") or m.get("state") == "DISPUTED" or re.search(r"\bdispute\b", q, re.I)):
            out.append({"name": "showDisputeSplit", "milestoneKey": mk})
        out.append({"name": "showMoneyTimeline", **({"milestoneKey": mk} if mk else {})})
        return out, True
    if _VERDICT.search(q) and not _PAY_ASK.search(re.sub(_VERDICT, "", q)):
        cards = [{"name": "showChecks", "milestoneKey": mk}, {"name": "showReviewMerge", "milestoneKey": mk}] if mk else []
        return cards, bool(_VERDICT_ASK.search(q))
    if mk and _PAY_ASK.search(q):
        return [{"name": "proposeCapture", "milestoneKey": mk}], False
    return [], False


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


def merge(hints: list[dict], refusal: bool, clean: dict | None) -> dict | None:
    """Hinted cards first, then the model's picks; a refusal never carries proposeCapture. Capped at MAX_ACTIONS."""
    out: list[dict] = []
    for a in hints + ((clean or {}).get("actions") or []):
        if refusal and a.get("name") == "proposeCapture":
            continue
        if a not in out:
            out.append(a)
    if not out:
        return None
    return {"actions": out[:MAX_ACTIONS], "note": (clean or {}).get("note")}


async def answer(router: LLMRouter, question: str, deal: dict, redact: list[str] | None = None) -> dict | None:
    red = Redactor()
    for i, lit in enumerate(redact or []):
        if isinstance(lit, str) and lit.strip():
            red.add(lit.strip(), f"[PARTY_{i + 1}]")
    hints, refusal = route_hints(question, deal)
    # hints were computed from the question here; sanitize keeps only whitelisted names and ids from this deal
    hints = (sanitize({"actions": hints}, deal) or {}).get("actions", []) if hints else []
    payload = {"question": question[:500], "deal": deal}
    if hints:
        payload["routingHints"] = {"cardsFirst": hints, "aiMustRefuse": refusal}
    ans = await router.json(
        "deal_copilot", SYSTEM, payload, redactor=red,
        max_tokens=int(os.environ.get("COPILOT_MAX_TOKENS", "900")), validate=_valid_shape,
    )
    if not ans:
        return None
    clean = merge(hints, refusal, sanitize(ans, deal))
    if not clean:
        return None
    last = router.calls[-1] if router.calls else {}
    provider = last.get("provider")
    model = next((p.model for p in router.chain if p.name == provider), None)
    return {**clean, "provider": provider, "model": model, "cached": bool(last.get("cached"))}
