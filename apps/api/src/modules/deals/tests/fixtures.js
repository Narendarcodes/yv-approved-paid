/* Shared fixtures for deals tests: a two-milestone deal and an engine wired to the mock PayPal. */
const { engine } = require('../engine.cts');
const { makeMockGateway } = require('../paypal.cts');

const T0 = Date.parse('2026-11-02T09:00:00.000Z');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function terms(over = {}) {
  return {
    title: 'Diwali launch reels',
    currency: 'USD',
    client: { role: 'client', userId: 'u_client', displayName: 'Kalpa Crafts', country: 'IN' },
    worker: { role: 'worker', userId: 'u_worker', displayName: 'Ravi', country: 'IN', paypalEmail: 'ravi@example.com' },
    killFeeBp: 2500,
    humanApprovalThresholdMinor: 50000,
    rateCard: [
      { id: 'extra_cut', label: 'Extra 15s cut', unit: 'per cut', unitPriceMinor: 6000 },
      { id: 'revision_round', label: 'Extra revision round', unit: 'per round', unitPriceMinor: 4000 },
    ],
    milestones: [
      {
        key: 'reel1',
        title: 'Reel 1: 45s launch cut',
        amountMinor: 40000,
        dueAt: new Date(T0 + 7 * DAY).toISOString(),
        graceHours: 24,
        reviewWindowHours: 48,
        revisionRoundsIncluded: 1,
        styleSample: true,
        checklist: [
          { id: 'len', text: 'Under 45 seconds', kind: 'check', measure: { metric: 'duration_s', op: '<=', value: 45 }, source: 'punchy' },
          { id: 'hook', text: 'Hook in the first 3 seconds', kind: 'check', measure: { metric: 'hook_by_s', op: '<=', value: 3 }, source: 'punchy' },
          { id: 'logo', text: 'Logo visible from 0:00 to 0:03', kind: 'check', measure: { metric: 'logo_present', op: 'present', window: [0, 3] } },
          { id: 'loud', text: 'Loudness -14 LUFS (+-1)', kind: 'check', measure: { metric: 'loudness_lufs', op: 'between', value: -15, max: -13 } },
          { id: 'vibe', text: 'Feels warm and festive', kind: 'taste' },
        ],
        payees: [
          { userId: 'u_worker', email: 'ravi@example.com', shareBp: 7000, displayName: 'Ravi' },
          { userId: 'u_motion', email: 'sana@example.com', shareBp: 3000, displayName: 'Sana' },
        ],
      },
      {
        key: 'reel2',
        title: 'Reel 2: 30s teaser',
        amountMinor: 30000,
        dueAt: new Date(T0 + 10 * DAY).toISOString(),
        graceHours: 24,
        reviewWindowHours: 48,
        revisionRoundsIncluded: 2,
        styleSample: false,
        checklist: [{ id: 'len', text: 'Under 30 seconds', kind: 'check', measure: { metric: 'duration_s', op: '<=', value: 30 } }],
        payees: [{ userId: 'u_worker', email: 'ravi@example.com', shareBp: 10000, displayName: 'Ravi' }],
      },
    ],
    ...over,
  };
}

function memoryLedger() {
  const rows = [];
  return {
    rows,
    async last(dealId) {
      const r = rows.filter((x) => x.dealId === dealId);
      return r.length ? r[r.length - 1] : null;
    },
    async append(e) {
      rows.push(e);
    },
    async list(dealId) {
      return rows.filter((x) => x.dealId === dealId);
    },
  };
}

function harness(over = {}) {
  let now = T0;
  const clock = { now: () => new Date(now).toISOString(), advance: (ms) => (now += ms), set: (t) => (now = t) };
  const gateway = over.gateway || makeMockGateway({ now: () => now });
  const ledger = memoryLedger();
  const deps = {
    gateway,
    ledger,
    now: clock.now,
    returnUrl: (d, k) => ({ returnUrl: `https://app.test/deals/${d.id}/${k}/funded`, cancelUrl: `https://app.test/deals/${d.id}` }),
  };
  let deal = engine.createDeal({ id: 'deal_1', orgId: 'org_1', terms: terms(over.terms) });
  return { deps, gateway, ledger, clock, get deal() { return deal; }, set deal(d) { deal = d; } };
}

/** Sign by both sides and fund one milestone through the mock (buyer approval simulated). */
async function signedAndFunded(h, key = 'reel1') {
  h.deal = engine.sign(h.deal, 'client', 'u_client', h.clock.now());
  h.deal = engine.sign(h.deal, 'worker', 'u_worker', h.clock.now());
  h.deal = await engine.startFunding(h.deps, h.deal, key, 'u_client');
  const m = h.deal.milestones.find((x) => x.key === key);
  if (h.gateway.approveOrder) h.gateway.approveOrder(m.funding.orderId);
  const r = await engine.confirmFunding(h.deps, h.deal, key, 'u_client');
  h.deal = r.deal;
  return r;
}

const ms = (deal, key = 'reel1') => deal.milestones.find((x) => x.key === key);

module.exports = { terms, harness, signedAndFunded, memoryLedger, ms, T0, HOUR, DAY };
