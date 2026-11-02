from evals.deals.run_fix_taste import evaluate


def test_fix_taste_eval_meets_bar():
    r = evaluate()
    assert r["cases"] >= 20 and r["swap_pairs"] >= 3
    assert r["swap_stable"], r
    assert r["accuracy"] >= 0.9, r["failures"]


def test_ending_cut_before_last_line_is_a_captions_fix():
    from app.deals.agents import ReviewAgent
    from tests.deals_fixtures import TERMS
    t = ReviewAgent().rule_tag("The ending is cut before the last line", TERMS["milestones"][0], set())
    assert t["tag"] == "fix" and t["checklistId"] == "c_caps" and t["confident"]
