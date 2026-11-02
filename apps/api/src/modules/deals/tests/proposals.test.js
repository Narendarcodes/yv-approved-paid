/* Agent proposals against the signed deal: Video QA reports, priced change orders, policy dry-runs (pure). */
const { engine } = require('../engine.cts');
const { checkReport, draftChangeOrder, decideChangeOrder, dryRun } = require('../engine.cts').proposals;
const { harness, signedAndFunded, ms, HOUR } = require('./fixtures');

const V1 = { id: 'v1', sha256: 'a'.repeat(64) };
const ev = (note = 'measured') => [{ t_start: 0, t_end: 1.5, note, screenshot: 'evidence/len_000.00.jpg' }];
const result = (id, passed, extra = {}) => ({ checklist_id: id, metric: 'm', measured: passed ? 1 : 0, passed, evidence: ev(), ...extra });
const allPass = () => ['len', 'hook', 'logo', 'loud'].map((id) => result(id, true));

async function inChecks() {
  const h = harness();
  await signedAndFunded(h);
  h.deal = engine.submitStyleSample(h.deal, 'reel1', 'u_worker', { id: 's1', sha256: 'c'.repeat(64) }, h.clock.now());
  h.deal = engine.decideStyle(h.deal, 'reel1', 'u_client', true, h.clock.now());
  h.deal = engine.submitVersion(h.deal, 'reel1', 'u_worker', V1, h.clock.now());
  return h;
}

describe('Video QA reports', () => {
  test('pass/fail is recomputed from the results; evidence is kept', async () => {
    const h = await inChecks();
    const r = checkReport(h.deal, 'reel1', { versionId: 'v1', sha256: V1.sha256, results: allPass(), passed: true, failed: [] });
    expect(r.passed).toBe(true);
    expect(r.results[0].evidence[0]).toEqual({ tStart: 0, tEnd: 1.5, note: 'measured', screenshot: 'evidence/len_000.00.jpg' });
  });

  test('a measurable line with no result counts as failed (silence never auto-approves an unchecked file)', async () => {
    const h = await inChecks();
    const r = checkReport(h.deal, 'reel1', { versionId: 'v1', sha256: V1.sha256, results: allPass().slice(0, 3) });
    expect(r.passed).toBe(false);
    expect(r.unmeasured).toEqual(['loud']);
    expect(r.failed).toEqual(['loud']);
  });

  test('not_measurable is a fail even if the agent says passed', async () => {
    const h = await inChecks();
    const res = allPass();
    res[1] = result('hook', true, { status: 'not_measurable' });
    const r = checkReport(h.deal, 'reel1', { versionId: 'v1', sha256: V1.sha256, results: res });
    expect(r.failed).toEqual(['hook']);
  });

  test.each([
    ['wrong file', { sha256: 'f'.repeat(64) }, 'version_mismatch'],
    ['older version', { versionId: 'v0' }, 'stale_version'],
    ['summary disagrees', { passed: true, results: [result('len', false), ...allPass().slice(1)] }, 'inconsistent_report'],
    ['failed list disagrees', { failed: ['len'] }, 'inconsistent_report'],
    ['line not in the deal', { results: [...allPass(), result('colour_grade', true)] }, 'unknown_checklist_line'],
    ['taste line', { results: [...allPass(), result('vibe', true)] }, 'taste_not_checkable'],
    ['no evidence', { results: [{ ...result('len', true), evidence: [] }, ...allPass().slice(1)] }, 'evidence_required'],
    ['bad timestamps', { results: [{ ...result('len', true), evidence: [{ t_start: 3, t_end: 1, note: 'x' }] }, ...allPass().slice(1)] }, 'evidence_required'],
    ['duplicate result', { results: [...allPass(), result('len', true)] }, 'invalid_report'],
  ])('refused: %s', async (_name, over, code) => {
    const h = await inChecks();
    expect(() => checkReport(h.deal, 'reel1', { versionId: 'v1', sha256: V1.sha256, results: allPass(), ...over })).toThrow(expect.objectContaining({ code }));
  });

  test('a second report for the same version is refused', async () => {
    const h = await inChecks();
    h.deal = engine.recordChecks(h.deal, 'reel1', 'v1', { reportId: 'r1', passed: true, failed: [] }, h.clock.now());
    expect(() => checkReport(h.deal, 'reel1', { versionId: 'v1', sha256: V1.sha256, results: allPass() })).toThrow(expect.objectContaining({ code: 'checks_recorded' }));
  });

  test('LLM notes survive only for lines that failed', async () => {
    const h = await inChecks();
    const res = allPass();
    res[0] = result('len', false);
    const r = checkReport(h.deal, 'reel1', { versionId: 'v1', sha256: V1.sha256, results: res, notes: { len: 'Trim 3 s.', hook: 'nice hook', loud: 42 } });
    expect(r.notes).toEqual({ len: 'Trim 3 s.' });
  });
});

describe('change orders', () => {
  test('price is rate-card arithmetic; a stated price must match it', async () => {
    const h = harness();
    await signedAndFunded(h);
    const r = draftChangeOrder(h.deal, { milestoneKey: 'reel1', rateCardItemId: 'extra_cut', quantity: 2, ask: 'a 15s cutdown for stories', by: 'agent' }, 'co1', h.clock.now());
    expect(r.changeOrder).toMatchObject({ amountMinor: 12000, status: 'draft', by: 'agent' });
    expect(() => draftChangeOrder(h.deal, { milestoneKey: 'reel1', rateCardItemId: 'extra_cut', quantity: 2, amountMinor: 99000, ask: 'x', by: 'agent' }, 'co2', h.clock.now())).toThrow(
      expect.objectContaining({ code: 'change_order_blocked', details: [expect.objectContaining({ rule: 'P11_rate_card' })] }),
    );
    expect(() => draftChangeOrder(h.deal, { milestoneKey: 'reel1', rateCardItemId: 'rush_fee', quantity: 1, ask: 'x', by: 'agent' }, 'co3', h.clock.now())).toThrow(/rate card has no item/);
    expect(() => draftChangeOrder(h.deal, { milestoneKey: 'reel9', rateCardItemId: 'extra_cut', quantity: 1, ask: 'x', by: 'agent' }, 'co4', h.clock.now())).toThrow(/not in the signed deal/);
    expect(() => draftChangeOrder(h.deal, { milestoneKey: 'reel1', rateCardItemId: 'extra_cut', quantity: 1.5, ask: 'x', by: 'agent' }, 'co5', h.clock.now())).toThrow(/whole number/);
  });

  test('unsigned deals take no change orders', () => {
    const h = harness();
    expect(() => draftChangeOrder(h.deal, { milestoneKey: 'reel1', rateCardItemId: 'extra_cut', quantity: 1, ask: 'x', by: 'client' }, 'co1', h.clock.now())).toThrow(/P4|not signed/);
  });

  test('only the client accepts, once; accepting then invoicing runs through policy', async () => {
    const h = harness();
    await signedAndFunded(h);
    h.deal = draftChangeOrder(h.deal, { milestoneKey: 'reel1', rateCardItemId: 'extra_cut', quantity: 1, ask: 'cutdown', by: 'agent' }, 'co1', h.clock.now()).deal;
    expect(() => decideChangeOrder(h.deal, 'co1', 'u_worker', true, h.clock.now())).toThrow(expect.objectContaining({ status: 403 }));
    await expect(engine.invoiceChangeOrder(h.deps, h.deal, 'co1')).rejects.toThrow(/not accepted/);
    h.deal = decideChangeOrder(h.deal, 'co1', 'u_client', true, h.clock.now());
    expect(() => decideChangeOrder(h.deal, 'co1', 'u_client', false, h.clock.now())).toThrow(/already accepted/);
    const r = await engine.invoiceChangeOrder(h.deps, h.deal, 'co1');
    expect(r.result.outcome).toBe('done');
    expect(r.deal.changeOrders[0]).toMatchObject({ status: 'invoiced', invoiceId: expect.any(String) });
    expect(r.result.entry).toMatchObject({ type: 'invoice', moved: false, amountMinor: 6000 });
    await expect(engine.invoiceChangeOrder(h.deps, r.deal, 'co1')).rejects.toThrow(/invoiced, not accepted/);
  });
});

describe('policy dry-run', () => {
  test('a split proposal is judged as if both sides accepted exactly that number', async () => {
    const h = await inChecks();
    h.deal = engine.recordChecks(h.deal, 'reel1', 'v1', { reportId: 'r1', passed: false, failed: ['loud'] }, h.clock.now());
    h.deal = engine.openDispute(h.deal, 'reel1', 'u_worker', h.clock.now());
    const ok = dryRun(h.deal, { kind: 'money', action: { kind: 'partial_capture', milestoneKey: 'reel1', amountMinor: 30000, reason: 'dispute_split' } }, h.clock.now());
    expect(ok).toMatchObject({ allowed: true, violations: [], assumed: ['both sides accept this split'] });
    const over = dryRun(h.deal, { kind: 'money', action: { kind: 'partial_capture', milestoneKey: 'reel1', amountMinor: 45000, reason: 'dispute_split' } }, h.clock.now());
    expect(over.allowed).toBe(false);
    expect(over.violations.map((v) => v.rule)).toContain('P3_amount');
    // once both sides accepted 30000, a proposal for another number is refused
    h.deal = engine.acceptSplit(h.deal, 'reel1', 'u_client', 30000);
    h.deal = engine.acceptSplit(h.deal, 'reel1', 'u_worker', 30000);
    const other = dryRun(h.deal, { kind: 'money', action: { kind: 'partial_capture', milestoneKey: 'reel1', amountMinor: 20000, reason: 'dispute_split' } }, h.clock.now());
    expect(other.violations.map((v) => v.message).join()).toMatch(/accepted 30000/);
  });

  test('red-team proposals are blocked: over-capture, wrong version, invented price, unknown kind', async () => {
    const h = await inChecks();
    h.deal = engine.recordChecks(h.deal, 'reel1', 'v1', { reportId: 'r1', passed: true, failed: [] }, h.clock.now());
    h.deal = engine.approve(h.deal, 'reel1', 'u_client', 'v1', h.clock.now());
    const cap = (o) => dryRun(h.deal, { kind: 'money', action: { kind: 'capture', milestoneKey: 'reel1', amountMinor: 40000, versionId: 'v1', final: true, reason: 'approval', ...o } }, h.clock.now());
    expect(cap({}).violations).toEqual([]);
    expect(cap({}).needsHumanApproval).toBe(false);
    expect(cap({ amountMinor: 40001 }).violations.map((v) => v.rule)).toContain('P3_amount');
    expect(cap({ versionId: 'v0' }).violations.map((v) => v.rule)).toContain('P6_version');
    const inv = dryRun(h.deal, { kind: 'money', action: { kind: 'invoice', milestoneKey: 'reel1', rateCardItemId: 'extra_cut', quantity: 1, amountMinor: 1 } }, h.clock.now());
    expect(inv.violations.map((v) => v.rule)).toContain('P11_rate_card');
    expect(inv.assumed).toEqual(['a change order is drafted for it']);
    expect(() => dryRun(h.deal, { kind: 'money', action: { kind: 'wire_transfer', milestoneKey: 'reel1' } }, h.clock.now())).toThrow(/known kind/);
    expect(() => dryRun(h.deal, { kind: 'shell' }, h.clock.now())).toThrow(/kind must be/);
    // nothing was saved
    expect(h.deal.executedKeys).toEqual([expect.stringMatching(/^authorize:/)]);
  });

  test('request_changes: a Fix on a line that passed is shown as Taste before the client sends it', async () => {
    const h = await inChecks();
    h.deal = engine.recordChecks(h.deal, 'reel1', 'v1', { reportId: 'r1', passed: false, failed: ['loud'] }, h.clock.now());
    const r = dryRun(h.deal, { kind: 'request_changes', milestoneKey: 'reel1', items: [
      { text: 'audio is too quiet', tag: 'fix', checklistId: 'loud' },
      { text: 'it is too long', tag: 'fix', checklistId: 'len' },
    ] }, h.clock.now());
    expect(r).toMatchObject({ allowed: true, costsRevisionRound: true, roundsLeftAfter: 0, downgraded: ['it is too long'] });
    const noCite = dryRun(h.deal, { kind: 'request_changes', milestoneKey: 'reel1', items: [{ text: 'make it pop', tag: 'fix' }] }, h.clock.now());
    expect(noCite).toMatchObject({ allowed: false, violations: [{ rule: 'fix_needs_checklist' }] });
    expect(ms(h.deal).changeRequests).toEqual([]);
    h.clock.advance(HOUR);
  });
});
