import pytest

from app import analysis as A
from app.contracts.RetentionPoint import RetentionPoint
from app.flows import Ctx, answer, route, insight, review_digest, planner
from app.llm import LLM, TokenBudget, BudgetExceeded
from app.vector import BrandIndex
from app.contracts.BrandRule import BrandRule
from tests.fake_node import FakeNode, ORG, OTHER_ORG, P, curve


def make_ctx(fake=None, budget=None):
    fake = fake or FakeNode()
    return fake, Ctx(org_id=ORG, node=fake.client(), index=BrandIndex(), llm=LLM(budget or TokenBudget(limit=10**9)))


@pytest.mark.parametrize("q,flow", [
    ("Why did the breathing short go viral?", "insight"),
    ("Merge the reviewers' comments on the dads video", "review_digest"),
    ("Plan next week's posts", "planner"),
    ("Can we use 'Buy now' in a CTA?", "brand_qa"),
    ("hello", "brand_qa"),
])
def test_router(q, flow):
    assert route(q) == flow


def test_find_spike_at_42s_not_at_decay():
    pts = [RetentionPoint(**p, postId="x") if "postId" not in p else RetentionPoint(**p) for p in curve(58, spike=42)]
    spikes = A.find_spikes(pts, 0.12)
    assert spikes and spikes[0]["second"] == 42 and spikes[0]["lift"] > 0.3
    flat = [RetentionPoint(**{**p, "postId": "x"}) for p in curve(45, decay=0.02)]
    assert A.find_spikes(flat, 0.12) == []


def test_context_at_spike():
    c = A.context_at(42, [{"start": 38, "end": 46, "text": "Feel that?"}, {"start": 0, "end": 4, "text": "intro"}], [{"second": 41.2, "label": "palm close-up"}], 4)
    assert c == {"spokenText": "Feel that?", "onScreen": "palm close-up", "sceneCutAt": 41.2}


def test_vector_search_is_org_scoped():
    idx = BrandIndex()
    idx.reindex(ORG, [BrandRule(id="a", title="CTA", body="Join the next workshop")])
    idx.reindex(OTHER_ORG, [BrandRule(id="b", title="CTA", body="Shop the sale now")])
    assert [h["ruleId"] for h in idx.search(ORG, "call to action")] == ["a"]
    assert [h["ruleId"] for h in idx.search(OTHER_ORG, "call to action")] == ["b"]
    with pytest.raises(ValueError):
        idx.search("", "x")


async def test_insight_flow_cites_spike_and_limits():
    fake, ctx = make_ctx()
    prep = await insight(ctx, "why did the breathing cues short go viral", store=True, job_id="j1")
    metrics = {c.metric: c.value for c in prep.citations}
    assert all(c.postId == P["breath"] for c in prep.citations)
    assert metrics["views"] == 184000 and "retention@0:42" in metrics
    assert prep.facts["atSpike"]["spokenText"].startswith("Now keep your palm")
    assert "palm on belly" in prep.facts["atSpike"]["onScreen"]
    assert any("YouTube Analytics" in d for d in prep.data_limits) and any("synthetic" in d for d in prep.data_limits)
    assert prep.insight.kind.value == "retention_spike" and prep.insight.atSecond == 42


async def test_instagram_insight_states_aggregate_limit():
    _, ctx = make_ctx()
    prep = await insight(ctx, "why did the telugu lullaby reel perform")
    assert prep.facts["post"]["platform"] == "instagram"
    assert any("aggregate reel metrics only" in d for d in prep.data_limits)
    assert "retentionSpikes" not in prep.facts


async def test_review_digest_merges_duplicates():
    _, ctx = make_ctx()
    prep = await review_digest(ctx, "digest the review comments", P["dads"])
    themes = {g["theme"]: g for g in prep.facts["clusters"]}
    assert themes["audio"]["duplicates"] == 1 and set(themes["audio"]["authors"]) == {"Sana", "Priya"}
    assert {"disclaimer", "cta"} <= set(themes)
    assert prep.citations[0].value == 4


async def test_planner_uses_winners_and_rules():
    _, ctx = make_ctx()
    prep = await planner(ctx, "plan next week")
    assert prep.facts["winners"][0]["postId"] == P["breath"]
    assert any(c.metric == "brandRule" for c in prep.citations)


async def test_brand_qa_answer_end_to_end_stub():
    _, ctx = make_ctx()
    ans = await answer(ctx, "Can we say Buy now in the CTA?")
    assert ans.flow.value == "brand_qa" and ans.answer
    assert any(c.value == "r2" for c in ans.citations)
    assert ans.dataLimits


async def test_token_budget_blocks():
    b = TokenBudget(limit=10)
    _, ctx = make_ctx(budget=b)
    await ctx.llm.complete(ORG, "t", {"headline": "x" * 200}, "q")
    with pytest.raises(BudgetExceeded):
        await ctx.llm.complete(ORG, "t", {"headline": "x"}, "q")


async def test_wrong_token_rejected():
    fake = FakeNode()
    from app.node_client import NodeError

    with pytest.raises(NodeError):
        await fake.client("forged").get_posts()
