/**
 * Real PayPal sandbox run of the escrow moves, through the deal engine and the
 * policy engine (not raw API calls). Needs a sandbox PERSONAL (buyer) account to
 * approve the hold once, which is the only human step.
 *
 *   node scripts/paypal-sandbox-e2e.cjs start      creates two holds, prints two approval links
 *   (open each link, log in as the sandbox buyer, click Continue/Approve)
 *   node scripts/paypal-sandbox-e2e.cjs finish     authorize both; then
 *        deal A: kill -> 25% kill-fee partial capture -> void the rest
 *        deal B: approve v1 -> final capture -> one-tap refund of $1
 *        and every blocked red-team move on the way (double capture, over-capture)
 *
 * Credentials: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET, or Hark's egress
 * gateway (NODE_USE_ENV_PROXY=1). State lives in tmp/paypal-e2e.json.
 */
const fs = require('node:fs');
const path = require('node:path');
const { engine, ledger: L } = require('../src/modules/deals/engine.cts');
const { makeRestGateway } = require('../src/modules/deals/paypal.cts');

const STATE = path.join(__dirname, '../tmp/paypal-e2e.json');
const viaGateway = !process.env.PAYPAL_CLIENT_ID;
const fetchImpl = async (url, init = {}) => {
  if (viaGateway && url.endsWith('/v1/oauth2/token')) {
    const { Authorization, ...rest } = init.headers;
    init = { ...init, headers: rest };
  }
  return fetch(url, init);
};
const gateway = makeRestGateway({ clientId: process.env.PAYPAL_CLIENT_ID || 'gw', clientSecret: process.env.PAYPAL_CLIENT_SECRET || 'gw', fetchImpl });
const rows = [];
const deps = {
  gateway,
  now: () => new Date().toISOString(),
  ledger: { last: async () => rows[rows.length - 1] || null, append: async (e) => rows.push(e), list: async () => rows },
  returnUrl: () => ({ returnUrl: 'https://example.com/approved', cancelUrl: 'https://example.com/cancelled' }),
};

function terms(title, amountMinor) {
  return {
    title,
    currency: 'USD',
    client: { role: 'client', userId: 'c', displayName: 'Demo client' },
    worker: { role: 'worker', userId: 'w', displayName: 'Demo editor', paypalEmail: 'editor@example.com' },
    killFeeBp: 2500,
    humanApprovalThresholdMinor: 100000,
    rateCard: [{ id: 'extra_cut', label: 'Extra cut', unit: 'per cut', unitPriceMinor: 1500 }],
    milestones: [
      {
        key: 'm1', title, amountMinor, dueAt: new Date(Date.now() + 7 * 864e5).toISOString(), graceHours: 24, reviewWindowHours: 48,
        revisionRoundsIncluded: 1, styleSample: false,
        checklist: [{ id: 'len', text: 'Under 45 s', kind: 'check', measure: { metric: 'duration_s', op: '<=', value: 45 } }],
        payees: [{ userId: 'w', email: 'editor@example.com', shareBp: 10000 }],
      },
    ],
  };
}

async function start() {
  const out = {};
  for (const [k, title, amt] of [['A', 'Sandbox kill-fee run', 4000], ['B', 'Sandbox approve run', 3000]]) {
    let d = engine.createDeal({ id: `sbx_${k}_${Date.now().toString(36)}`, orgId: 'sandbox', terms: terms(title, amt) });
    d = engine.sign(d, 'client', 'c', deps.now());
    d = engine.sign(d, 'worker', 'w', deps.now());
    d = await engine.startFunding(deps, d, 'm1', 'c');
    out[k] = d;
    console.log(`${k}: approve as the sandbox buyer -> ${d.milestones[0].funding.approveUrl}`);
  }
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(out, null, 2));
}

const say = (label, r) => console.log(`${label}: ${r.result.outcome}${r.result.violations ? ' ' + r.result.violations.map((v) => v.rule).join(',') : ''}${r.result.error ? ' ' + r.result.error.code : ''} | ${r.result.entry.explanation}`);

async function finish() {
  const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  // A: hold -> kill -> kill fee -> void rest
  let a = s.A;
  let r = await engine.confirmFunding(deps, a, 'm1', 'c'); say('A authorize', r); a = r.deal;
  a = engine.kill(a, 'm1', 'c', deps.now());
  r = await engine.execute(deps, a, { kind: 'partial_capture', milestoneKey: 'm1', amountMinor: 3000, reason: 'kill_fee' }); say('A red-team: kill fee 75%', r);
  const t = await engine.tick(deps, a); a = t.deal;
  for (const x of t.results) console.log(`A tick: ${x.outcome} | ${x.entry.explanation}`);
  // B: hold -> approve -> capture -> refund $1
  let b = s.B;
  r = await engine.confirmFunding(deps, b, 'm1', 'c'); say('B authorize', r); b = r.deal;
  b = engine.submitVersion(b, 'm1', 'w', { id: 'v1', sha256: 'a'.repeat(64) }, deps.now());
  b = engine.recordChecks(b, 'm1', 'v1', { reportId: 'r', passed: true, failed: [] }, deps.now());
  b = engine.approve(b, 'm1', 'c', 'v1', deps.now());
  r = await engine.execute(deps, b, { kind: 'capture', milestoneKey: 'm1', amountMinor: 3500, versionId: 'v1', final: true, reason: 'approval' }); say('B red-team: over-capture', r);
  r = await engine.execute(deps, b, { kind: 'capture', milestoneKey: 'm1', amountMinor: 3000, versionId: 'v1', final: true, reason: 'approval' }); say('B capture', r); b = r.deal;
  r = await engine.execute(deps, b, { kind: 'capture', milestoneKey: 'm1', amountMinor: 3000, versionId: 'v1', final: true, reason: 'approval' }); say('B red-team: double capture', r);
  const capId = b.milestones[0].captures[0]?.id;
  if (capId) {
    r = await engine.execute(deps, b, { kind: 'refund', milestoneKey: 'm1', captureId: capId, amountMinor: 100 }); say('B refund (waits for a tap)', r); b = r.deal;
    b = engine.approveHuman(b, r.result.entry.idempotencyKey, 'w');
    r = await engine.execute(deps, b, { kind: 'refund', milestoneKey: 'm1', captureId: capId, amountMinor: 100 }); say('B refund after tap', r); b = r.deal;
  }
  console.log('ledger chain:', JSON.stringify(L.verifyChain(rows)), 'totals:', JSON.stringify(L.totals(rows)));
  fs.writeFileSync(STATE.replace('.json', '-result.json'), JSON.stringify({ A: a, B: b, ledger: rows }, null, 2));
}

(process.argv[2] === 'finish' ? finish() : start()).catch((e) => {
  console.error('FAILED', e.code || '', e.message, e.details || '');
  process.exit(1);
});
