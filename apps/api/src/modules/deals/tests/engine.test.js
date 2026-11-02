/* The deal engine + Money Agent against the mock PayPal (real PayPal rules, injected clock). */
const { engine, ledger, hashOf } = require('../engine.cts');
const { harness, signedAndFunded, ms, HOUR, DAY } = require('./fixtures');

const V1 = { id: 'v1', sha256: 'a'.repeat(64) };
const V2 = { id: 'v2', sha256: 'b'.repeat(64) };
const STYLE = { id: 's1', sha256: 'c'.repeat(64) };

async function toReview(h, version = V1, report = { reportId: 'r1', passed: true, failed: [] }) {
  const m = ms(h.deal);
  if (m.state === 'FUNDED' && !m.styleApproved) {
    h.deal = engine.submitStyleSample(h.deal, 'reel1', 'u_worker', STYLE, h.clock.now());
    h.deal = engine.decideStyle(h.deal, 'reel1', 'u_client', true, h.clock.now());
  }
  h.deal = engine.submitVersion(h.deal, 'reel1', 'u_worker', version, h.clock.now());
  h.deal = engine.recordChecks(h.deal, 'reel1', version.id, report, h.clock.now());
}

describe('signing locks the deal', () => {
  test('both sides sign the same hash; then terms are locked', () => {
    const h = harness();
    h.deal = engine.sign(h.deal, 'client', 'u_client', h.clock.now());
    expect(ms(h.deal).state).toBe('DRAFT');
    h.deal = engine.sign(h.deal, 'worker', 'u_worker', h.clock.now());
    expect(h.deal.termsHash).toBe(hashOf(h.deal.terms));
    expect(h.deal.milestones.every((m) => m.state === 'SIGNED')).toBe(true);
    expect(() => engine.editTerms(h.deal, h.deal.terms)).toThrow(/locked/);
  });

  test('an edit after one signature clears it; the other side must re-sign', () => {
    const h = harness();
    h.deal = engine.sign(h.deal, 'client', 'u_client', h.clock.now());
    const t = JSON.parse(JSON.stringify(h.deal.terms));
    t.milestones[0].amountMinor = 45000;
    h.deal = engine.editTerms(h.deal, t);
    expect(h.deal.signatures).toHaveLength(0);
  });

  test('a stranger cannot sign; invalid terms cannot be signed', () => {
    const h = harness();
    expect(() => engine.sign(h.deal, 'client', 'u_worker', h.clock.now())).toThrow(/only the client/);
    const bad = harness({ terms: { killFeeBp: 20000 } });
    expect(() => engine.sign(bad.deal, 'client', 'u_client', bad.clock.now())).toThrow(/fix the deal/);
  });
});

describe('happy path: fund -> style sample -> logo missing -> fix -> approve -> capture -> payouts', () => {
  test('ends PAID_OUT with a verified ledger', async () => {
    const h = harness();
    const funded = await signedAndFunded(h);
    expect(funded.result.outcome).toBe('done');
    expect(ms(h.deal).state).toBe('FUNDED');
    expect(ms(h.deal).funding.status).toBe('AUTHORIZED');

    await toReview(h, V1, { reportId: 'r1', passed: false, failed: ['logo'] });
    expect(ms(h.deal).state).toBe('IN_REVIEW');
    h.deal = engine.requestChanges(h.deal, 'reel1', 'u_client', [{ text: 'Logo missing at 0:02', tag: 'fix', checklistId: 'logo' }], h.clock.now());
    expect(ms(h.deal).state).toBe('CHANGES_REQUESTED');
    expect(ms(h.deal).revisionRoundsUsed).toBe(0); // a Fix does not cost the client a round

    h.clock.advance(HOUR);
    await toReview(h, V2);
    h.deal = engine.approve(h.deal, 'reel1', 'u_client', 'v2', h.clock.now());
    const t1 = await engine.tick(h.deps, h.deal);
    h.deal = t1.deal;
    const m = ms(h.deal);
    expect(m.state).toBe('PAID_OUT');
    expect(m.capturedMinor).toBe(40000);
    expect(m.captures[0].versionId).toBe('v2');
    expect(m.payouts.map((p) => [p.email, p.amountMinor])).toEqual([
      ['ravi@example.com', 28000],
      ['sana@example.com', 12000],
    ]);
    const rows = await h.ledger.list('deal_1');
    expect(ledger.verifyChain(rows).ok).toBe(true);
    expect(ledger.totals(rows)).toMatchObject({ heldMinor: 40000, capturedMinor: 40000, paidOutMinor: 40000, blockedCount: 0 });
    expect(rows.find((r) => r.type === 'capture').explanation).toMatch(/approved version v2.*\$400\.00/);
    // a second tick does nothing
    const t2 = await engine.tick(h.deps, h.deal);
    expect(t2.results).toHaveLength(0);
  });
});

describe('fairness rules', () => {
  test('silence past the review window auto-approves and captures (checks passed)', async () => {
    const h = harness();
    await signedAndFunded(h);
    await toReview(h);
    h.clock.advance(47 * HOUR);
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    expect(ms(h.deal).state).toBe('IN_REVIEW');
    h.clock.advance(2 * HOUR);
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    expect(ms(h.deal).state).toBe('PAID_OUT');
    expect(ms(h.deal).captures[0].reason).toBe('auto_approval');
  });

  test('no auto-approval when a check failed', async () => {
    const h = harness();
    await signedAndFunded(h);
    await toReview(h, V1, { reportId: 'r1', passed: false, failed: ['len'] });
    h.clock.advance(72 * HOUR);
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    expect(ms(h.deal).state).toBe('IN_REVIEW');
    expect(ms(h.deal).capturedMinor).toBe(0);
  });

  test('a Fix must cite a checklist line; a Fix on a passing line or a disputed tag counts as Taste', async () => {
    const h = harness();
    await signedAndFunded(h);
    await toReview(h, V1, { reportId: 'r1', passed: false, failed: ['logo'] });
    expect(() => engine.requestChanges(h.deal, 'reel1', 'u_client', [{ text: 'make it pop', tag: 'fix' }], h.clock.now())).toThrow(/cites no checklist/);
    h.deal = engine.requestChanges(h.deal, 'reel1', 'u_client', [{ text: 'too long', tag: 'fix', checklistId: 'len' }], h.clock.now());
    const cr = ms(h.deal).changeRequests[0];
    expect(cr.items[0].tag).toBe('taste'); // len passed, so it is a matter of taste
    expect(cr.tasteRound).toBe(true);
    expect(ms(h.deal).revisionRoundsUsed).toBe(1);
  });

  test('taste rounds past the included count need a change order', async () => {
    const h = harness();
    await signedAndFunded(h);
    await toReview(h);
    h.deal = engine.requestChanges(h.deal, 'reel1', 'u_client', [{ text: 'warmer colours', tag: 'taste' }], h.clock.now());
    await toReview(h, V2);
    expect(() => engine.requestChanges(h.deal, 'reel1', 'u_client', [{ text: 'different music', tag: 'taste' }], h.clock.now())).toThrow(/change order/);
    // an invented or unaccepted change order unlocks nothing
    expect(() => engine.requestChanges(h.deal, 'reel1', 'u_client', [{ text: 'different music', tag: 'taste' }], h.clock.now(), { changeOrderId: 'co_1' })).toThrow(/not an accepted/);
    const { draftChangeOrder, decideChangeOrder } = require('../lib/proposals.cts');
    h.deal = draftChangeOrder(h.deal, { milestoneKey: 'reel1', rateCardItemId: 'revision_round', quantity: 1, ask: 'one more round', by: 'agent' }, 'co_1', h.clock.now()).deal;
    expect(() => engine.requestChanges(h.deal, 'reel1', 'u_client', [{ text: 'different music', tag: 'taste' }], h.clock.now(), { changeOrderId: 'co_1' })).toThrow(/not an accepted/);
    h.deal = decideChangeOrder(h.deal, 'co_1', 'u_client', true, h.clock.now());
    h.deal = engine.requestChanges(h.deal, 'reel1', 'u_client', [{ text: 'different music', tag: 'taste' }], h.clock.now(), { changeOrderId: 'co_1' });
    expect(ms(h.deal).revisionRoundsUsed).toBe(2);
    await toReview(h, { id: 'v3', sha256: 'e'.repeat(64) });
    expect(() => engine.requestChanges(h.deal, 'reel1', 'u_client', [{ text: 'again', tag: 'taste' }], h.clock.now(), { changeOrderId: 'co_1' })).toThrow(/already used/);
  });

  test('kill fee: partial capture of 25%, void the rest, pay the fee out', async () => {
    const h = harness();
    await signedAndFunded(h);
    await toReview(h);
    h.deal = engine.kill(h.deal, 'reel1', 'u_client', h.clock.now());
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    const m = ms(h.deal);
    expect(m.capturedMinor).toBe(10000);
    expect(m.funding.status).toBe('VOIDED');
    expect(m.state).toBe('PAID_OUT');
    expect(m.paidOutMinor).toBe(10000);
    const ops = h.gateway.calls.map((c) => c.op);
    expect(ops).toEqual(expect.arrayContaining(['capture', 'void', 'payout']));
  });

  test('kill with a 0% kill fee voids everything and pays nothing', async () => {
    const h = harness({ terms: { killFeeBp: 0 } });
    await signedAndFunded(h);
    h.deal = engine.kill(h.deal, 'reel1', 'u_client', h.clock.now());
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    expect(ms(h.deal).state).toBe('CANCELLED');
    expect(ms(h.deal).capturedMinor).toBe(0);
  });

  test('missed deadline: the client can void only after deadline + grace', async () => {
    const h = harness();
    await signedAndFunded(h);
    const early = await engine.voidMissedDeadline(h.deps, h.deal, 'reel1', 'u_client');
    expect(early.result.outcome).toBe('blocked');
    h.deal = early.deal;
    h.clock.advance(8 * DAY + HOUR);
    const late = await engine.voidMissedDeadline(h.deps, h.deal, 'reel1', 'u_client');
    expect(late.result.outcome).toBe('done');
    expect(ms(late.deal).state).toBe('CANCELLED');
    await expect(engine.voidMissedDeadline(h.deps, h.deal, 'reel1', 'u_worker')).rejects.toThrow(/only the client/);
  });

  test('a delivered milestone cannot be voided for the deadline', async () => {
    const h = harness();
    await signedAndFunded(h);
    await toReview(h);
    h.clock.advance(9 * DAY);
    const r = await engine.voidMissedDeadline(h.deps, h.deal, 'reel1', 'u_client');
    expect(r.result.outcome).toBe('blocked');
    expect(r.result.violations.map((v) => v.rule)).toContain('P1_state');
  });

  test('dispute: both accept the same split -> partial capture + void remainder', async () => {
    const h = harness();
    await signedAndFunded(h);
    await toReview(h);
    h.deal = engine.openDispute(h.deal, 'reel1', 'u_worker', h.clock.now());
    h.deal = engine.acceptSplit(h.deal, 'reel1', 'u_worker', 30000);
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    expect(ms(h.deal).capturedMinor).toBe(0); // only one side agreed
    h.deal = engine.acceptSplit(h.deal, 'reel1', 'u_client', 30000);
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    expect(ms(h.deal).capturedMinor).toBe(30000);
    expect(ms(h.deal).funding.status).toBe('VOIDED');
    expect(ms(h.deal).state).toBe('PAID_OUT');
  });

  test('dispute settled at 0 voids the whole hold', async () => {
    const h = harness();
    await signedAndFunded(h);
    await toReview(h);
    h.deal = engine.openDispute(h.deal, 'reel1', 'u_client', h.clock.now());
    h.deal = engine.acceptSplit(h.deal, 'reel1', 'u_worker', 0);
    h.deal = engine.acceptSplit(h.deal, 'reel1', 'u_client', 0);
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    expect(ms(h.deal).state).toBe('CANCELLED');
  });
});

describe('keeping the hold alive', () => {
  test('reauthorizes after the 3-day honor period, not before; new honor period each time', async () => {
    const h = harness();
    await signedAndFunded(h);
    h.clock.advance(2 * DAY);
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    expect(ms(h.deal).funding.reauthorizations || []).toHaveLength(0);
    h.clock.advance(1 * DAY + HOUR);
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    expect(ms(h.deal).funding.reauthorizations).toHaveLength(1);
    h.clock.advance(DAY);
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    expect(ms(h.deal).funding.reauthorizations).toHaveLength(1);
    h.clock.advance(3 * DAY);
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    expect(ms(h.deal).funding.reauthorizations).toHaveLength(2);
    // capture still works on the newest authorization
    await toReview(h);
    h.deal = engine.approve(h.deal, 'reel1', 'u_client', 'v1', h.clock.now());
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    expect(ms(h.deal).state).toBe('PAID_OUT');
  });

  test('no reauthorization after day 29', async () => {
    const h = harness();
    await signedAndFunded(h);
    h.clock.advance(29 * DAY + HOUR);
    const r = await engine.execute(h.deps, h.deal, { kind: 'reauthorize', milestoneKey: 'reel1' });
    expect(r.result.outcome).toBe('blocked');
    expect(r.result.violations.map((v) => v.rule)).toContain('P9_auth_window');
  });
});

describe('one human tap for big moves', () => {
  test('capture above the threshold waits; approving it releases the money', async () => {
    const h = harness({ terms: { humanApprovalThresholdMinor: 30000 } });
    await signedAndFunded(h);
    await toReview(h);
    h.deal = engine.approve(h.deal, 'reel1', 'u_client', 'v1', h.clock.now());
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    expect(ms(h.deal).state).toBe('APPROVED');
    expect(h.deal.pendingApprovals).toHaveLength(1);
    const key = h.deal.pendingApprovals[0].key;
    expect(() => engine.approveHuman(h.deal, key, 'u_worker')).toThrow(/only the client/);
    h.deal = engine.approveHuman(h.deal, key, 'u_client');
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    expect(ms(h.deal).state).toBe('PAID_OUT');
  });

  test('"approve & release" in one tap needs no second confirmation', async () => {
    const h = harness({ terms: { humanApprovalThresholdMinor: 30000 } });
    await signedAndFunded(h);
    await toReview(h);
    h.deal = engine.approve(h.deal, 'reel1', 'u_client', 'v1', h.clock.now(), true);
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    expect(ms(h.deal).state).toBe('PAID_OUT');
  });
});

describe('human-event guards', () => {
  test('style sample must be OKed first; only the latest checked version can be approved', async () => {
    const h = harness();
    await signedAndFunded(h);
    expect(() => engine.submitVersion(h.deal, 'reel1', 'u_worker', V1, h.clock.now())).toThrow(/style sample/);
    await toReview(h, V1, { reportId: 'r', passed: true, failed: [] });
    h.deal = engine.requestChanges(h.deal, 'reel1', 'u_client', [{ text: 'x', tag: 'taste' }], h.clock.now());
    h.deal = engine.submitVersion(h.deal, 'reel1', 'u_worker', V2, h.clock.now());
    expect(() => engine.approve(h.deal, 'reel1', 'u_client', 'v2', h.clock.now())).toThrow(); // checks running
    h.deal = engine.recordChecks(h.deal, 'reel1', 'v2', { reportId: 'r2', passed: true, failed: [] }, h.clock.now());
    expect(() => engine.approve(h.deal, 'reel1', 'u_client', 'v1', h.clock.now())).toThrow(/latest/);
    expect(() => engine.approve(h.deal, 'reel1', 'u_worker', 'v2', h.clock.now())).toThrow(/only the client/);
  });

  test('funding needs both signatures and a buyer approval', async () => {
    const h = harness();
    await expect(engine.startFunding(h.deps, h.deal, 'reel1', 'u_client')).rejects.toThrow(/cannot fund/);
    h.deal = engine.sign(h.deal, 'client', 'u_client', h.clock.now());
    h.deal = engine.sign(h.deal, 'worker', 'u_worker', h.clock.now());
    h.deal = await engine.startFunding(h.deps, h.deal, 'reel1', 'u_client');
    const r = await engine.confirmFunding(h.deps, h.deal, 'reel1', 'u_client');
    expect(r.result.outcome).toBe('failed'); // PayPal: payer has not approved
    expect(r.result.error.code).toBe('ORDER_NOT_APPROVED');
    expect(ms(r.deal).state).toBe('SIGNED');
  });
});
