/**
 * Records real PayPal sandbox responses for the REST adapter's unit tests
 * (src/modules/deals/tests/fixtures/paypal-sandbox-recorded.json). Only calls
 * that need no buyer approval: OAuth, create AUTHORIZE order, get order,
 * authorize an unapproved order (error shape), draft invoice, verify a bogus
 * webhook signature. Tokens, ids of the app and debug ids are redacted.
 *
 *   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/paypal-record.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { makeRestGateway } = require('../src/modules/deals/paypal.cts');

const OUT = path.join(__dirname, '../src/modules/deals/tests/fixtures/paypal-sandbox-recorded.json');
const tape = [];
const redact = (s) =>
  s
    .replace(/"access_token":"[^"]+"/g, '"access_token":"REDACTED"')
    .replace(/"app_id":"[^"]+"/g, '"app_id":"APP-REDACTED"')
    .replace(/"nonce":"[^"]+"/g, '"nonce":"REDACTED"')
    .replace(/"payer_id":"[^"]+"/g, '"payer_id":"REDACTED"')
    .replace(/"merchant_id":"[^"]+"/g, '"merchant_id":"REDACTED"')
    .replace(/"email_address":"[^"]+"/g, '"email_address":"merchant@example.com"');

async function fetchImpl(url, init = {}) {
  // Inside Hark's sandbox the egress gateway injects the app's Basic credentials
  // on the token call; drop our placeholder header so it can.
  if (!process.env.PAYPAL_CLIENT_ID && url.endsWith('/v1/oauth2/token')) {
    const { Authorization, ...rest } = init.headers;
    init = { ...init, headers: rest };
  }
  const r = await fetch(url, init);
  const text = await r.text();
  tape.push({
    method: init.method || 'GET',
    path: new URL(url).pathname,
    requestBody: init.body && !String(init.body).startsWith('grant_type') ? JSON.parse(init.body) : undefined,
    status: r.status,
    body: text ? JSON.parse(redact(text)) : null,
  });
  return { ok: r.ok, status: r.status, text: async () => text, json: async () => JSON.parse(text) };
}

(async () => {
  const opts = {
    clientId: process.env.PAYPAL_CLIENT_ID || 'injected-by-gateway',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || 'injected-by-gateway',
    fetchImpl,
  };
  const stamp = Date.now().toString(36);
  // a throwaway webhook so verify-webhook-signature runs against a real webhook id; deleted at the end
  const admin = makeRestGateway(opts);
  const hook = await admin.createWebhook(`https://example.com/yv-recording/${stamp}`, ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED']);
  console.log('webhook', hook.id);
  const gw = makeRestGateway({ ...opts, webhookId: hook.id });
  const order = await gw.createAuthorizeOrder({
    amountMinor: 40000,
    currency: 'USD',
    referenceId: `rec_${stamp}:reel1`,
    customId: `rec_${stamp}:reel1`,
    description: 'Recording: Reel 1 launch cut',
    returnUrl: 'https://example.com/return',
    cancelUrl: 'https://example.com/cancel',
    requestId: `rec-order-${stamp}`,
  });
  console.log('order', order.orderId, order.status, !!order.approveUrl);
  console.log('get', await gw.getOrder(order.orderId));
  try {
    await gw.authorizeOrder(order.orderId, `rec-auth-${stamp}`);
  } catch (e) {
    console.log('authorize unapproved ->', e.code, e.status);
  }
  const inv = await gw.createInvoiceDraft({
    currency: 'USD',
    note: 'Recording: change order priced from the signed rate card.',
    items: [{ name: 'Extra 15s cut', description: 'per cut', quantity: 2, unitAmountMinor: 6000 }],
    requestId: `rec-inv-${stamp}`,
  });
  console.log('invoice', inv.id, inv.status);
  console.log('verify bogus webhook ->', await gw.verifyWebhook({ 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77', 'paypal-transmission-id': '69cd13f0-d67a-11e5-baa3-778b53f4ae55', 'paypal-transmission-sig': 'bm90LWEtcmVhbC1zaWduYXR1cmU=', 'paypal-transmission-time': new Date().toISOString() }, JSON.stringify({ id: 'WH-X', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: order.orderId } })).catch((e) => `error ${e.code}`));
  await admin.deleteWebhook(hook.id);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ recordedAt: new Date().toISOString(), note: 'real PayPal sandbox responses, redacted', tape }, null, 2) + '\n');
  console.log('wrote', OUT, tape.length, 'calls');
})().catch((e) => {
  console.error('FAILED', e.code, e.message, e.details);
  process.exit(1);
});
