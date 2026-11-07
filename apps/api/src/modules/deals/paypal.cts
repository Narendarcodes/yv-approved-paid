/**
 * deals/paypal: payment gateways behind one interface.
 *   makeMockGateway({ now })     in-memory PayPal with the real rules (tests, offline demo)
 *   makeRestGateway({ ... })     PayPal REST (sandbox by default), hand-written fetch calls
 *   makeSdkGateway({ ... })      PayPal Server SDK (APIMatic) for Orders + Payments; Payouts/Invoicing/Webhooks on REST
 *   makeSandboxGateway({ ... })  PayPal sandbox: REST + invoices sent + (demo only) pre-approved pool, then simulated approval
 *   gatewayFromEnv(env)          PAYPAL_MODE=mock|sandbox|live picks one;
 *                                PAYPAL_CLIENT=sdk|rest picks the adapter (default sdk on sandbox, rest on live)
 */
const { makeMockGateway } = require('./lib/paypal-mock.cts');
const { makeRestGateway } = require('./lib/paypal-rest.cts');
const { makeSdkGateway, SANDBOX_BASE, LIVE_BASE } = require('./lib/paypal-sdk.cts');
const { makeSandboxGateway } = require('./lib/paypal-sandbox.cts');
const { GatewayError } = require('./lib/gateway.cts');

/**
 * PAYPAL_CLIENT=sdk|rest: which adapter makes the Orders/Payments calls.
 * Default: sdk on sandbox, rest on live (the SDK path has not been run against live).
 * A custom PAYPAL_API_BASE (not one of PayPal's two hosts) can only use rest: the SDK
 * picks its host from its Environment, so an unset PAYPAL_CLIENT falls back to rest
 * there and an explicit PAYPAL_CLIENT=sdk is an error.
 */
function paypalClientFromEnv(
  env: Record<string, string | undefined>,
  mode: string,
  apiBase: string,
): 'sdk' | 'rest' {
  const v = (env.PAYPAL_CLIENT || '').trim().toLowerCase();
  if (v && v !== 'sdk' && v !== 'rest') throw new Error(`unknown PAYPAL_CLIENT ${v} (sdk | rest)`);
  const base = apiBase.replace(/\/$/, '');
  const sdkHost = base === SANDBOX_BASE || base === LIVE_BASE;
  if (v === 'sdk' && !sdkHost)
    throw new Error(`PAYPAL_CLIENT=sdk cannot use PAYPAL_API_BASE=${base}; use PAYPAL_CLIENT=rest`);
  if (v) return v as 'sdk' | 'rest';
  return mode === 'sandbox' && sdkHost ? 'sdk' : 'rest';
}

function gatewayFromEnv(env: Record<string, string | undefined> = process.env) {
  const mode = env.PAYPAL_MODE || 'mock';
  if (mode === 'mock') return makeMockGateway({ webhookSecret: env.PAYPAL_MOCK_WEBHOOK_SECRET });
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET)
    throw new Error(
      'PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required when PAYPAL_MODE is not mock',
    );
  const opts = {
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    apiBase:
      mode === 'live'
        ? 'https://api-m.paypal.com'
        : env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com',
    webhookId: env.PAYPAL_WEBHOOK_ID,
    currency: env.PAYPAL_CURRENCY || 'USD',
  };
  if (mode !== 'live' && mode !== 'sandbox')
    throw new Error(`unknown PAYPAL_MODE ${mode} (mock | sandbox | live)`);
  const client = paypalClientFromEnv(env, mode, opts.apiBase);
  if (mode === 'live') return client === 'sdk' ? makeSdkGateway(opts) : makeRestGateway(opts);
  // the judge demo cannot log a sandbox buyer in, so DEMO_MODE=1 (or PAYPAL_SANDBOX_SIMULATE=1)
  // lets the seed mark its own orders as approved; everything else stays real sandbox
  // Demo deals (ids "deal_demo_...") first take a real, pre-approved sandbox authorization from the
  // pool (pool.cts); only when none is left does the seed fall back to a simulated approval (SIM-).
  const simulate = env.DEMO_MODE === '1' || env.PAYPAL_SANDBOX_SIMULATE === '1';
  const usePool = simulate && env.PAYPAL_SANDBOX_POOL !== '0';
  return makeSandboxGateway({
    ...opts,
    client,
    simulate,
    ...(usePool
      ? {
          pool: require('./pool.cts').mongoPool,
          poolFor: (o: { referenceId: string }) => o.referenceId.startsWith('deal_demo_'),
        }
      : {}),
  });
}

module.exports = {
  makeMockGateway,
  makeRestGateway,
  makeSdkGateway,
  makeSandboxGateway,
  gatewayFromEnv,
  paypalClientFromEnv,
  GatewayError,
};
