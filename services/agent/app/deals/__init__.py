"""Approved = Paid: the Python half of the deal agents.

Rule of the house: AI checks facts, people own taste, the deal decides the money.
Nothing in this package moves money or sets an amount or a verdict. Agents return
*proposals*; amounts come from the signed terms (rate card, milestone amount,
checklist arithmetic) and every proposal is executed only by Node's policy engine
(apps/api/src/modules/deals/lib/policy.cts) after a human or the Money Agent asks.
"""
