#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Refill the judge demo's pool of pre-approved PayPal SANDBOX authorizations
 * (src/modules/deals/pool.cts). Sandbox only: it refuses any other API base.
 *
 *   1. create   real sandbox orders (intent AUTHORIZE) for the demo amounts and
 *               print each approve link. Default: 3 pairs of $400 + $300 (one pair
 *               per demo seed/reset: reel1 $400, reel2 $300).
 *                 PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... \
 *                 node scripts/paypal-auth-pool.cjs create --pairs 3
 *   2. approve  open each link, log in as a sandbox PERSONAL (buyer) account and
 *               press Continue. PayPal returns the buyer to
 *               <api>/api/v1/paypal/pool/return?token=<orderId>, which authorizes
 *               the order and adds it to the pool.
 *   3. claim    only if a return page did not load:
 *                 node scripts/paypal-auth-pool.cjs claim <orderId> [<orderId> ...]
 *   4. status   node scripts/paypal-auth-pool.cjs status    (ready / used per amount)
 *
 * Options: --api <base> (default https://yv-approved-paid-api.onrender.com),
 *          --amounts 40000,30000 (minor units), --pairs N.
 * Credentials are read from env and never printed. Each authorization is valid
 * for 29 days (PayPal's honor period is the first 3; the Money Agent
 * reauthorizes once after that).
 */
const SANDBOX = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const API = String(
  arg('api', process.env.POOL_API_BASE || 'https://yv-approved-paid-api.onrender.com'),
).replace(/\/$/, '');

async function token() {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
  // without env credentials the call goes out bare (for a proxy that adds the app's credentials)
  if (id && secret)
    headers.Authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
  const r = await fetch(`${SANDBOX}/v1/oauth2/token`, {
    method: 'POST',
    headers,
    body: 'grant_type=client_credentials',
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || !b.access_token) throw new Error(`PayPal OAuth failed (${r.status})`);
  return b.access_token;
}

async function create() {
  if (!/sandbox\.paypal\.com/.test(SANDBOX))
    throw new Error('sandbox only: PAYPAL_API_BASE must be the PayPal sandbox');
  const pairs = Math.max(1, Math.min(10, Number(arg('pairs', '3'))));
  const amounts = String(arg('amounts', '40000,30000'))
    .split(',')
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  const tok = await token();
  const out = [];
  for (let p = 0; p < pairs; p += 1) {
    for (const amountMinor of amounts) {
      const r = await fetch(`${SANDBOX}/v2/checkout/orders`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tok}`,
          'Content-Type': 'application/json',
          'PayPal-Request-Id': `yv-pool-${Date.now()}-${p}-${amountMinor}`,
        },
        body: JSON.stringify({
          intent: 'AUTHORIZE',
          purchase_units: [
            {
              reference_id: `yv-auth-pool-${amountMinor}`,
              custom_id: `yv-auth-pool:${amountMinor}`,
              description: 'yv. Approved = Paid demo hold (PayPal sandbox)',
              amount: { currency_code: 'USD', value: (amountMinor / 100).toFixed(2) },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: 'yv.',
                user_action: 'CONTINUE',
                shipping_preference: 'NO_SHIPPING',
                return_url: `${API}/api/v1/paypal/pool/return`,
                cancel_url: `${API}/api/v1/paypal/pool/cancel`,
              },
            },
          },
        }),
      });
      const o = await r.json();
      if (!r.ok)
        throw new Error(`create order failed (${r.status}): ${o?.details?.[0]?.issue || o?.name}`);
      const link = (o.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
      out.push({ orderId: o.id, amountMinor, approveUrl: link && link.href });
    }
  }
  console.log(JSON.stringify(out, null, 2));
}

async function claim(ids) {
  for (const orderId of ids) {
    const r = await fetch(`${API}/api/v1/paypal/pool/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId }),
    });
    console.log(orderId, r.status, JSON.stringify(await r.json().catch(() => ({}))));
  }
}

async function status() {
  const r = await fetch(`${API}/api/v1/paypal/pool`);
  console.log(JSON.stringify(await r.json(), null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
const run =
  cmd === 'create'
    ? create()
    : cmd === 'claim'
      ? claim(rest.filter((x) => !x.startsWith('--') && /^[A-Z0-9]{10,30}$/.test(x)))
      : cmd === 'status'
        ? status()
        : null;
if (!run) {
  console.error(
    'usage: paypal-auth-pool.cjs create [--pairs 3] | claim <orderId...> | status   [--api <base>]',
  );
  process.exit(2);
}
run.catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
