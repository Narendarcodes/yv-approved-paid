/* Policy engine: each rule, and the red-team cases an agent might try. All must be blocked. */
const { engine, policy, ledger } = require('../engine.cts');
const { harness, signedAndFunded, ms, HOUR } = require('./fixtures');

const V1 = { id: 'v1', sha256: 'a'.repeat(64) };

async function approvedDeal(over) {
  const h = harness(over);
  await signedAndFunded(h);
  h.deal = engine.submitStyleSample(h.deal, 'reel1', 'u_worker', { id: 's1', sha256: 'c'.repeat(64) }, h.clock.now());
  h.deal = engine.decideStyle(h.deal, 'reel1', 'u_client', true, h.clock.now());
  h.deal = engine.submitVersion(h.deal, 'reel1', 'u_worker', V1, h.clock.now());
  h.deal = engine.recordChecks(h.deal, 'reel1', 'v1', { reportId: 'r1', passed: true, failed: [] }, h.clock.now());
  h.deal = engine.approve(h.deal, 'reel1', 'u_client', 'v1', h.clock.now());
  return h;
}

const capture = (over = {}) => ({ kind: 'capture', milestoneKey: 'reel1', amountMinor: 40000, versionId: 'v1', final: true, reason: 'approval', ...over });
const rules = (r) => r.result.violations.map((v) => v.rule);

describe('red team: the Money Agent tries to break the deal', () => {
  test('capture more than the deal -> P3_amount', async () => {
    const h = await approvedDeal();
    const r = await engine.execute(h.deps, h.deal, capture({ amountMinor: 45000 }));
    expect(r.result.outcome).toBe('blocked');
    expect(rules(r)).toContain('P3_amount');
    expect(h.gateway.calls.filter((c) => c.op === 'capture')).toHaveLength(0);
  });

  test('capture less than the deal (shortchange the worker) -> P3_amount', async () => {
    const h = await approvedDeal();
    const r = await engine.execute(h.deps, h.deal, capture({ amountMinor: 1 }));
    expect(rules(r)).toContain('P3_amount');
  });

  test('double capture -> P5_already_ran, and PayPal is never called twice', async () => {
    const h = await approvedDeal();
    const first = await engine.execute(h.deps, h.deal, capture());
    expect(first.result.outcome).toBe('done');
    const second = await engine.execute(h.deps, first.deal, capture());
    expect(second.result.outcome).toBe('blocked');
    expect(rules(second)).toEqual(expect.arrayContaining(['P5_already_ran', 'P1_state']));
    expect(h.gateway.calls.filter((c) => c.op === 'capture')).toHaveLength(1);
  });

  test('capture the wrong version -> P6_version', async () => {
    const h = await approvedDeal();
    const r = await engine.execute(h.deps, h.deal, capture({ versionId: 'v0-old' }));
    expect(rules(r)).toContain('P6_version');
  });

  test('capture before approval -> P1_state', async () => {
    const h = harness();
    await signedAndFunded(h);
    const r = await engine.execute(h.deps, h.deal, capture());
    expect(rules(r)).toContain('P1_state');
  });

  test('claim auto-approval while the review window is still open -> blocked', async () => {
    const h = harness();
    await signedAndFunded(h);
    h.deal = engine.submitStyleSample(h.deal, 'reel1', 'u_worker', { id: 's1', sha256: 'c'.repeat(64) }, h.clock.now());
    h.deal = engine.decideStyle(h.deal, 'reel1', 'u_client', true, h.clock.now());
    h.deal = engine.submitVersion(h.deal, 'reel1', 'u_worker', V1, h.clock.now());
    h.deal = engine.recordChecks(h.deal, 'reel1', 'v1', { reportId: 'r1', passed: true, failed: [] }, h.clock.now());
    const r = await engine.execute(h.deps, h.deal, capture({ reason: 'auto_approval' }));
    expect(rules(r)).toEqual(expect.arrayContaining(['P1_state', 'P6_version']));
  });

  test('a human (not the Money Agent) calls capture directly -> P2_actor', async () => {
    const h = await approvedDeal();
    const r = await engine.execute(h.deps, h.deal, capture(), { actor: 'client' });
    expect(rules(r)).toContain('P2_actor');
  });

  test('terms changed after signing (amount bumped in the DB) -> P4_terms_locked', async () => {
    const h = await approvedDeal();
    const tampered = JSON.parse(JSON.stringify(h.deal));
    tampered.terms.milestones[0].amountMinor = 90000;
    const r = await engine.execute(h.deps, tampered, capture({ amountMinor: 90000 }));
    expect(rules(r)).toContain('P4_terms_locked');
  });

  test('capture in another currency -> P8_currency', async () => {
    const h = await approvedDeal();
    const r = await engine.execute(h.deps, h.deal, capture({ currency: 'EUR' }));
    expect(rules(r)).toContain('P8_currency');
  });

  test('pay out to an address that is not in the deal -> P10_payee', async () => {
    const h = await approvedDeal();
    const cap = await engine.execute(h.deps, h.deal, capture());
    const r = await engine.execute(h.deps, cap.deal, { kind: 'payout', milestoneKey: 'reel1', amountMinor: 1000, email: 'attacker@evil.test' });
    expect(rules(r)).toContain('P10_payee');
  });

  test('pay out while PayPal reports a reversed capture -> P13_flagged', async () => {
    const h = await approvedDeal();
    const cap = await engine.execute(h.deps, h.deal, capture());
    const flagged = { ...cap.deal, alerts: [{ at: h.clock.now(), milestoneKey: 'reel1', eventType: 'PAYMENT.CAPTURE.REVERSED', message: 'reversed' }] };
    const r = await engine.execute(h.deps, flagged, { kind: 'payout', milestoneKey: 'reel1', amountMinor: 28000, email: 'ravi@example.com' });
    expect(rules(r)).toEqual(['P13_flagged']);
    expect(h.gateway.calls.filter((c) => c.op === 'payout')).toHaveLength(0);
  });

  test('pay a payee more than their share -> P10_payee', async () => {
    const h = await approvedDeal();
    const cap = await engine.execute(h.deps, h.deal, capture());
    const r = await engine.execute(h.deps, cap.deal, { kind: 'payout', milestoneKey: 'reel1', amountMinor: 40000, email: 'sana@example.com' });
    expect(rules(r)).toContain('P10_payee');
  });

  test('pay out before capture -> P1_state', async () => {
    const h = await approvedDeal();
    const r = await engine.execute(h.deps, h.deal, { kind: 'payout', milestoneKey: 'reel1', amountMinor: 28000, email: 'ravi@example.com' });
    expect(rules(r)).toContain('P1_state');
  });

  test('invent a change-order price -> P11_rate_card', async () => {
    const h = await approvedDeal();
    const r = await engine.execute(h.deps, h.deal, { kind: 'invoice', milestoneKey: 'reel1', rateCardItemId: 'extra_cut', quantity: 1, amountMinor: 9900 }, { changeOrderId: 'co1' });
    expect(rules(r)).toContain('P11_rate_card');
    const ok = await engine.execute(h.deps, h.deal, { kind: 'invoice', milestoneKey: 'reel1', rateCardItemId: 'extra_cut', quantity: 1, amountMinor: 6000 }, { changeOrderId: 'co1' });
    expect(ok.result.outcome).toBe('done');
  });

  test('an item that is not on the rate card -> P11_rate_card', async () => {
    const h = await approvedDeal();
    const r = await engine.execute(h.deps, h.deal, { kind: 'invoice', milestoneKey: 'reel1', rateCardItemId: 'rush_fee', quantity: 1, amountMinor: 5000 }, { changeOrderId: 'co2' });
    expect(rules(r)).toContain('P11_rate_card');
  });

  test('kill fee bigger than agreed -> P3_amount', async () => {
    const h = harness();
    await signedAndFunded(h);
    h.deal = engine.kill(h.deal, 'reel1', 'u_client', h.clock.now());
    const r = await engine.execute(h.deps, h.deal, { kind: 'partial_capture', milestoneKey: 'reel1', amountMinor: 20000, reason: 'kill_fee' });
    expect(rules(r)).toContain('P3_amount');
  });

  test('dispute split that only one side accepted -> P3_amount', async () => {
    const h = await approvedDeal();
    const d = JSON.parse(JSON.stringify(h.deal));
    d.milestones[0].state = 'DISPUTED'; // simulate an open dispute
    d.milestones[0].split = { worker: 40000 };
    const r = await engine.execute(h.deps, d, { kind: 'partial_capture', milestoneKey: 'reel1', amountMinor: 40000, reason: 'dispute_split' });
    expect(rules(r)).toContain('P3_amount');
  });

  test('refund without a human tap waits; a refund larger than the capture is blocked', async () => {
    const h = await approvedDeal();
    const cap = await engine.execute(h.deps, h.deal, capture());
    const capId = ms(cap.deal).captures[0].id;
    const r = await engine.execute(h.deps, cap.deal, { kind: 'refund', milestoneKey: 'reel1', captureId: capId, amountMinor: 1000 });
    expect(r.result.outcome).toBe('pending_approval');
    const big = await engine.execute(h.deps, cap.deal, { kind: 'refund', milestoneKey: 'reel1', captureId: capId, amountMinor: 50000 });
    expect(rules(big)).toContain('P3_amount');
  });

  test('unknown milestone -> P12_milestone', async () => {
    const h = await approvedDeal();
    const r = await engine.execute(h.deps, h.deal, capture({ milestoneKey: 'reel9' }));
    expect(rules(r)).toContain('P12_milestone');
  });

  test('negative or fractional amounts are refused', async () => {
    const h = await approvedDeal();
    for (const amountMinor of [-40000, 400.5, 0, Number.NaN]) {
      const r = await engine.execute(h.deps, h.deal, capture({ amountMinor }));
      expect(rules(r)).toContain('P3_amount');
    }
  });

  test('every blocked attempt is on the ledger and moves no money', async () => {
    const h = await approvedDeal();
    let d = h.deal;
    for (const a of [capture({ amountMinor: 99999 }), capture({ versionId: 'zzz' }), capture({ currency: 'GBP' })]) {
      d = (await engine.execute(h.deps, d, a)).deal;
    }
    const rows = await h.ledger.list('deal_1');
    const blocked = rows.filter((r) => r.type === 'blocked');
    expect(blocked).toHaveLength(3);
    expect(blocked.every((b) => b.moved === false && /No money moved/.test(b.explanation))).toBe(true);
    expect(ledger.totals(rows).capturedMinor).toBe(0);
  });
});

describe('policy unit checks', () => {
  test('idempotency keys are stable and distinct per action', async () => {
    const h = await approvedDeal();
    const k1 = policy.idempotencyKey(h.deal, capture(), ms(h.deal));
    const k2 = policy.idempotencyKey(h.deal, capture({ versionId: 'other' }), ms(h.deal));
    expect(k1).toBe(k2); // one capture per milestone whatever the version
    expect(policy.idempotencyKey(h.deal, { kind: 'void', milestoneKey: 'reel1', reason: 'cancelled' }, ms(h.deal))).not.toBe(k1);
  });

  test('termsLocked needs both signatures over the current hash', () => {
    const h = harness();
    expect(policy.termsLocked(h.deal)).toBe(false);
    h.deal = engine.sign(h.deal, 'client', 'u_client', h.clock.now());
    expect(policy.termsLocked(h.deal)).toBe(false);
    h.deal = engine.sign(h.deal, 'worker', 'u_worker', h.clock.now());
    expect(policy.termsLocked(h.deal)).toBe(true);
  });

  test('the policy never mentions names or countries (identity-blind)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'policy.cts'), 'utf8');
    expect(src).not.toMatch(/displayName|country/);
  });

  test('ledger tampering is detected', async () => {
    const h = await approvedDeal();
    await engine.execute(h.deps, h.deal, capture());
    const rows = JSON.parse(JSON.stringify(await h.ledger.list('deal_1')));
    expect(ledger.verifyChain(rows).ok).toBe(true);
    rows[rows.length - 1].amountMinor = 1;
    expect(ledger.verifyChain(rows)).toMatchObject({ ok: false, reason: 'entry content changed' });
    rows.splice(0, 1);
    expect(ledger.verifyChain(rows).ok).toBe(false);
  });

  test('HOUR sanity', () => expect(HOUR).toBe(3600000));
});
