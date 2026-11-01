/**
 * PayPal REST adapter (Orders v2, Payments v2, Payouts v1, Invoicing v2,
 * Webhooks v1). Same interface as the mock. Every write sends a
 * PayPal-Request-Id so a retried call never moves money twice.
 *
 * Credentials come from env (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET); they are
 * never logged. PAYPAL_API_BASE defaults to the sandbox.
 */
import type { PaymentGateway, AuthorizationResult } from './gateway.cts';

const { GatewayError } = require('./gateway.cts');
const { toMajor, toMinor } = require('./money.cts');

type Fetch = (url: string, init?: any) => Promise<any>;

function makeRestGateway(opts: {
  clientId: string;
  clientSecret: string;
  apiBase?: string;
  webhookId?: string;
  fetchImpl?: Fetch;
  currency?: string;
}) {
  const base = (opts.apiBase || 'https://api-m.sandbox.paypal.com').replace(/\/$/, '');
  const f: Fetch = opts.fetchImpl || ((globalThis as any).fetch as Fetch);
  let token: { value: string; exp: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.exp - 60_000) return token.value;
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
    const r = await f(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.access_token) throw new GatewayError('AUTH_FAILED', `PayPal OAuth failed (${r.status})`, 502);
    token = { value: body.access_token, exp: Date.now() + (Number(body.expires_in) || 300) * 1000 };
    return token.value;
  }

  async function call(method: string, path: string, body?: unknown, requestId?: string): Promise<any> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    if (requestId) headers['PayPal-Request-Id'] = requestId.slice(0, 108);
    const r = await f(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!r.ok) {
      const issue = json?.details?.[0]?.issue || json?.name || json?.error || 'PAYPAL_ERROR';
      const msg = json?.details?.[0]?.description || json?.message || `PayPal ${method} ${path} failed (${r.status})`;
      throw new GatewayError(issue, msg, r.status, { debug_id: json?.debug_id });
    }
    return json;
  }

  function authFrom(a: any, currency: string): AuthorizationResult {
    return {
      authorizationId: a.id,
      status: a.status,
      amountMinor: a.amount ? toMinor(a.amount.value, a.amount.currency_code || currency) : 0,
      createdAt: a.create_time,
      expiresAt: a.expiration_time,
    };
  }

  const gw: PaymentGateway & { createWebhook(url: string, eventTypes: string[]): Promise<{ id: string; url: string }>; listWebhooks(): Promise<{ id: string; url: string; events: string[] }[]>; deleteWebhook(id: string): Promise<void> } = {
    name: base.includes('sandbox') ? 'paypal-sandbox' : 'paypal-live',
    async createAuthorizeOrder(input) {
      const o = await call(
        'POST',
        '/v2/checkout/orders',
        {
          intent: 'AUTHORIZE',
          purchase_units: [
            {
              reference_id: input.referenceId.slice(0, 256),
              custom_id: input.customId.slice(0, 127),
              description: input.description.slice(0, 127),
              amount: { currency_code: input.currency, value: toMajor(input.amountMinor, input.currency) },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: 'yv.',
                user_action: 'CONTINUE',
                shipping_preference: 'NO_SHIPPING',
                return_url: input.returnUrl,
                cancel_url: input.cancelUrl,
              },
            },
          },
        },
        input.requestId,
      );
      const link = (o.links || []).find((l: any) => l.rel === 'payer-action' || l.rel === 'approve');
      return { orderId: o.id, status: o.status, approveUrl: link?.href };
    },
    async getOrder(orderId) {
      const o = await call('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
      const auth = o?.purchase_units?.[0]?.payments?.authorizations?.[0];
      return { orderId: o.id, status: o.status, authorizationId: auth?.id };
    },
    async authorizeOrder(orderId, requestId) {
      const o = await call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {}, requestId);
      const a = o?.purchase_units?.[0]?.payments?.authorizations?.[0];
      if (!a) throw new GatewayError('NO_AUTHORIZATION', 'authorize returned no authorization', 502);
      return authFrom(a, opts.currency || 'USD');
    },
    async getAuthorization(authorizationId) {
      const a = await call('GET', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`);
      return authFrom(a, opts.currency || 'USD');
    },
    async reauthorize(authorizationId, requestId) {
      const a = await call('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/reauthorize`, {}, requestId);
      return authFrom(a, opts.currency || 'USD');
    },
    async capture(authorizationId, input) {
      const c = await call(
        'POST',
        `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`,
        {
          amount: { currency_code: input.currency, value: toMajor(input.amountMinor, input.currency) },
          final_capture: input.finalCapture,
          invoice_id: input.invoiceId,
          note_to_payer: input.note?.slice(0, 255),
        },
        input.requestId,
      );
      return {
        captureId: c.id,
        status: c.status,
        amountMinor: c.amount ? toMinor(c.amount.value, c.amount.currency_code) : input.amountMinor,
        finalCapture: c.final_capture ?? input.finalCapture,
      };
    },
    async voidAuthorization(authorizationId, requestId) {
      const r = await call('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, undefined, requestId);
      return { id: r?.id || authorizationId, status: r?.status || 'VOIDED' };
    },
    async refund(captureId, input) {
      const r = await call(
        'POST',
        `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
        { amount: { currency_code: input.currency, value: toMajor(input.amountMinor, input.currency) }, note_to_payer: input.note?.slice(0, 255) },
        input.requestId,
      );
      return { id: r.id, status: r.status };
    },
    async payout(input) {
      const r = await call('POST', '/v1/payments/payouts', {
        sender_batch_header: { sender_batch_id: input.senderBatchId.slice(0, 256), email_subject: input.emailSubject },
        items: input.items.map((i) => ({
          recipient_type: 'EMAIL',
          receiver: i.email,
          note: i.note.slice(0, 4000),
          sender_item_id: i.senderItemId.slice(0, 63),
          amount: { currency: i.currency, value: toMajor(i.amountMinor, i.currency) },
        })),
      });
      return { id: r?.batch_header?.payout_batch_id, status: r?.batch_header?.batch_status };
    },
    async createInvoiceDraft(input) {
      const r = await call(
        'POST',
        '/v2/invoicing/invoices',
        {
          detail: { currency_code: input.currency, invoice_number: input.invoiceNumber, note: input.note.slice(0, 4000) },
          primary_recipients: input.recipientEmail ? [{ billing_info: { email_address: input.recipientEmail } }] : undefined,
          items: input.items.map((i) => ({
            name: i.name.slice(0, 200),
            description: i.description?.slice(0, 1000),
            quantity: String(i.quantity),
            unit_amount: { currency_code: input.currency, value: toMajor(i.unitAmountMinor, input.currency) },
            unit_of_measure: 'QUANTITY',
          })),
        },
        input.requestId,
      );
      return { id: r.id, status: r.status || 'DRAFT', href: r?.detail?.metadata?.recipient_view_url };
    },
    async verifyWebhook(headers, rawBody) {
      if (!opts.webhookId) return false;
      let event: unknown;
      try {
        event = JSON.parse(rawBody);
      } catch {
        return false;
      }
      const h = (k: string) => headers[k] || headers[k.toLowerCase()];
      for (const k of ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time']) if (!h(k)) return false;
      // PayPal only fetches certs from its own hosts; refuse anything else before calling out
      if (!/^https:\/\/api(-m)?\.(sandbox\.)?paypal\.com\//.test(String(h('paypal-cert-url')))) return false;
      let r: any;
      try {
        r = await call('POST', '/v1/notifications/verify-webhook-signature', {
        auth_algo: h('paypal-auth-algo'),
        cert_url: h('paypal-cert-url'),
        transmission_id: h('paypal-transmission-id'),
        transmission_sig: h('paypal-transmission-sig'),
        transmission_time: h('paypal-transmission-time'),
        webhook_id: opts.webhookId,
        webhook_event: event,
        });
      } catch (e) {
        if ((e as { status?: number }).status && (e as { status: number }).status < 500) return false; // malformed proof = not verified
        throw e; // PayPal down: let the caller answer 5xx so PayPal retries later
      }
      return r?.verification_status === 'SUCCESS';
    },
    async createWebhook(url: string, eventTypes: string[]) {
      const r = await call('POST', '/v1/notifications/webhooks', { url, event_types: eventTypes.map((name) => ({ name })) });
      return { id: r.id as string, url: r.url as string };
    },
    async listWebhooks() {
      const r = await call('GET', '/v1/notifications/webhooks');
      return (r.webhooks || []).map((w: any) => ({ id: w.id, url: w.url, events: (w.event_types || []).map((e: any) => e.name) }));
    },
    async deleteWebhook(id: string) {
      await call('DELETE', `/v1/notifications/webhooks/${encodeURIComponent(id)}`);
    },
  };
  return gw;
}

module.exports = { makeRestGateway };
