"""Identity stripping + the fairness swap test: who is on the deal must not change what the AI sees or says."""
import copy

import pytest

from app.deals.identity import Redactor, IdentityLeak, assert_clean
from app.deals.llm_router import LLMRouter, Provider
from app.deals.agents import ReviewAgent
from tests.deals_fixtures import TERMS

COMMENTS = [
    {"reviewer": "Asha Rao", "text": "Asha here - the logo must show in the first 3 seconds, John forgot it."},
    {"reviewer": "Priya", "text": "Make it louder please, she said the audio is too low. Call me at +91 98765 43210."},
    {"reviewer": "Priya", "text": "I just prefer a warmer vibe, maybe a different font. Our Indian audience likes it."},
    {"reviewer": "Asha Rao", "text": "Honestly make it quieter, email john@example.com if unsure."},
]


def swapped_terms():
    t = copy.deepcopy(TERMS)
    t["client"].update(displayName="Wei Chen", country="Nigeria", org="Lagos Looms", userId="u_c_9")
    t["worker"].update(displayName="Fatima Khan", country="Pakistan", paypalEmail="fatima@example.org", userId="u_w_9")
    t["milestones"][0]["payees"][0].update(displayName="Fatima Khan", email="fatima@example.org", userId="u_w_9")
    return t


def swap_text(s):
    for a, b in [("Asha Rao", "Wei Chen"), ("Asha", "Wei"), ("John", "Fatima"), ("john@example.com", "fatima@example.org"),
                 ("Priya", "Grace"), ("Indian", "Nigerian"), ("she", "he"), ("+91 98765 43210", "+234 803 555 0199")]:
        s = s.replace(a, b)
    return s


def test_redaction_removes_names_emails_phones_countries_gender():
    r = Redactor.for_deal(TERMS, reviewers=["Asha Rao", "Priya"])
    out = r.redact(" ".join(c["text"] for c in COMMENTS))
    for leak in ["Asha", "John", "Priya", "john@example.com", "98765", "Indian", " she "]:
        assert leak not in out, leak
    assert "[CLIENT]" in out and "[WORKER]" in out and "[EMAIL]" in out and "[PHONE]" in out and "[COUNTRY]" in out
    assert r.restore("[WORKER] fixed it") == "John Miller fixed it"


def test_redact_obj_drops_identity_keys():
    r = Redactor.for_deal(TERMS)
    o = r.redact_obj({"client": TERMS["client"], "note": "John Miller delivered"})
    assert o == {"client": {"role": "client", "org": "[CLIENT]"}, "note": "[WORKER] delivered"}


def test_assert_clean_blocks_leaks():
    r = Redactor.for_deal(TERMS)
    with pytest.raises(IdentityLeak):
        assert_clean("mail me at a@b.co")
    with pytest.raises(IdentityLeak):
        assert_clean("John Miller did it", r)
    assert_clean(r.redact("John Miller did it"), r)


def test_swap_test_prompts_are_byte_identical_and_labels_unchanged():
    """Names, countries, roles' identities and pronouns swapped -> the LLM sees the same bytes, and tags stay the same."""
    seen = []

    async def caller(p, messages, max_tokens):
        seen.append(messages[1]["content"])
        return '{"tags": []}'

    import asyncio

    def run(terms, comments, reviewers):
        router = LLMRouter(chain=[Provider("fake", "m", "http://x")], caller=caller, cache_dir="/tmp/yvap-swap-none", offline=False)
        router._cache_get = lambda k: None  # always call
        router._cache_put = lambda *a: None
        red = Redactor.for_deal(terms, reviewers=reviewers)
        return asyncio.run(ReviewAgent(router).run("d1", terms["milestones"][0], comments, redactor=red))

    a = run(TERMS, COMMENTS, ["Asha Rao", "Priya"])
    b = run(swapped_terms(), [{"reviewer": swap_text(c["reviewer"]), "text": swap_text(c["text"])} for c in COMMENTS], ["Wei Chen", "Grace"])
    assert len(seen) == 2 and seen[0] == seen[1], "identity leaked into the prompt"
    strip = lambda p: [(i["tag"], i["checklistId"], i["disputed"]) for i in p.body["items"]]
    assert strip(a) == strip(b)
    assert [c["a"] for c in a.body["contradictions"]] == [c["a"] for c in b.body["contradictions"]]
