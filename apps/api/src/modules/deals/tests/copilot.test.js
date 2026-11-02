/**
 * Live deal copilot (Node side): picks cards only, never money, and falls back
 * to the offline replay whenever the agent is off, slow, down or unhelpful.
 * Pure unit tests with an injected fetch: no Mongo, no network.
 */
const { askCopilot, redactedView, identities, sanitizeActions } = require('../copilot.cts');
const { terms } = require('./fixtures');

function deal() {
  const t = terms();
  return {
    id: 'deal_x',
    orgId: 'org_1',
    terms: t,
    signatures: [{}, {}],
    milestones: t.milestones.map((m) => ({ key: m.key, state: 'IN_REVIEW', versions: [{ id: 'v1' }], capturedMinor: 0 })),
    executedKeys: [],
    pendingApprovals: [],
    humanApprovals: [],
    changeOrders: [{ id: 'co_1', milestoneKey: t.milestones[0].key, status: 'draft' }],
  };
}
const CFG = { enabled: true, url: 'http://agent.test/', secret: 's'.repeat(40), timeoutMs: 200 };
const ok = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });

test('the view sent to the agent has no people and no money', () => {
  const d = deal();
  const v = JSON.stringify(redactedView(d, 'client'));
  for (const p of [d.terms.client, d.terms.worker]) {
    if (p.displayName) expect(v).not.toContain(p.displayName);
    if (p.paypalEmail) expect(v).not.toContain(p.paypalEmail);
  }
  expect(v).not.toMatch(/amount|Minor|rateCard|unitPrice/i);
  expect(identities(d)).toEqual(expect.arrayContaining([d.terms.client.displayName, d.terms.worker.displayName].filter(Boolean)));
});

test('sanitizeActions keeps whitelisted cards with this deal\'s ids and drops any amount', () => {
  const d = deal();
  const k = d.terms.milestones[0].key;
  const out = sanitizeActions(
    [
      { name: 'moveMoney', milestoneKey: k },
      { name: 'proposeCapture', milestoneKey: k, amountMinor: 999999, versionId: 'v9' },
      { name: 'showChecks', milestoneKey: 'nope' },
      { name: 'showChangeOrder', changeOrderId: 'co_404' },
      { name: 'showChangeOrder', changeOrderId: 'co_1' },
    ],
    d,
  );
  expect(out).toEqual([
    { name: 'proposeCapture', milestoneKey: k },
    { name: 'showChangeOrder', changeOrderId: 'co_1' },
  ]);
});

test('live answer is labelled with its provider; a note about money is dropped', async () => {
  const d = deal();
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ actions: [{ name: 'showDeal' }], note: 'Pay $450 now', provider: 'river', model: 'q', cached: false }) };
  };
  const r = await askCopilot(CFG, d, 'client', 'show the deal', fetchImpl);
  expect(r).toMatchObject({ source: 'live', actions: [{ name: 'showDeal' }], note: null, provider: 'river', model: 'q' });
  expect(seen.url).toBe('http://agent.test/v1/deals/copilot');
  expect(seen.init.headers['x-agent-secret']).toBe(CFG.secret);
});

test('falls back to the offline replay: disabled, no secret, 503, error, junk, unreachable, timeout', async () => {
  const d = deal();
  expect(await askCopilot({ ...CFG, enabled: false }, d, null, 'q', ok({}))).toEqual({ source: 'offline', reason: 'agent_disabled' });
  expect(await askCopilot({ ...CFG, secret: '' }, d, null, 'q', ok({}))).toEqual({ source: 'offline', reason: 'agent_disabled' });
  expect(await askCopilot(CFG, d, null, 'q', ok({}, 503))).toEqual({ source: 'offline', reason: 'agent_no_answer' });
  expect(await askCopilot(CFG, d, null, 'q', ok({}, 500))).toEqual({ source: 'offline', reason: 'agent_error' });
  expect(await askCopilot(CFG, d, null, 'q', ok({ actions: [{ name: 'pay' }] }))).toEqual({ source: 'offline', reason: 'agent_no_answer' });
  const down = async () => {
    throw new Error('ECONNREFUSED');
  };
  expect(await askCopilot(CFG, d, null, 'q', down)).toEqual({ source: 'offline', reason: 'agent_unreachable' });
  const slow = (_url, init) =>
    new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  expect(await askCopilot({ ...CFG, timeoutMs: 20 }, d, null, 'q', slow)).toEqual({ source: 'offline', reason: 'agent_timeout' });
});
