/**
 * deals/paypal: payment gateways behind one interface.
 *   makeMockGateway({ now })     in-memory PayPal with the real rules (tests, offline demo)
 *   makeRestGateway({ ... })     PayPal REST (sandbox by default)
 *   makeSandboxGateway({ ... })  PayPal sandbox: REST + invoices sent + (demo only) pre-approved pool, then simulated approval
 *   gatewayFromEnv(env)          PAYPAL_MODE=mock|sandbox|live picks one
 */
const { makeMockGateway } = require('./lib/paypal-mock.cts');
const { makeRestGateway } = require('./lib/paypal-rest.cts');
const { makeSandboxGateway } = require('./lib/paypal-sandbox.cts');
const { GatewayError } = require('./lib/gateway.cts');

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
  if (mode === 'live') return makeRestGateway(opts);
  if (mode !== 'sandbox') throw new Error(`unknown PAYPAL_MODE ${mode} (mock | sandbox | live)`);
  // the judge demo cannot log a sandbox buyer in, so DEMO_MODE=1 (or PAYPAL_SANDBOX_SIMULATE=1)
  // lets the seed mark its own orders as approved; everything else stays real sandbox
  // Demo deals (ids "deal_demo_...") first take a real, pre-approved sandbox authorization from the
  // pool (pool.cts); only when none is left does the seed fall back to a simulated approval (SIM-).
  const simulate = env.DEMO_MODE === '1' || env.PAYPAL_SANDBOX_SIMULATE === '1';
  const usePool = simulate && env.PAYPAL_SANDBOX_POOL !== '0';
  return makeSandboxGateway({
    ...opts,
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
  makeSandboxGateway,
  gatewayFromEnv,
  GatewayError,
};
