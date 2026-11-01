/**
 * deals/paypal: payment gateways behind one interface.
 *   makeMockGateway({ now })     in-memory PayPal with the real rules (tests, offline demo)
 *   makeRestGateway({ ... })     PayPal REST (sandbox by default)
 *   gatewayFromEnv(env)          PAYPAL_MODE=mock|sandbox|live picks one
 */
const { makeMockGateway } = require('./lib/paypal-mock.cts');
const { makeRestGateway } = require('./lib/paypal-rest.cts');
const { GatewayError } = require('./lib/gateway.cts');

function gatewayFromEnv(env: Record<string, string | undefined> = process.env) {
  const mode = env.PAYPAL_MODE || 'mock';
  if (mode === 'mock') return makeMockGateway({ webhookSecret: env.PAYPAL_MOCK_WEBHOOK_SECRET });
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required when PAYPAL_MODE is not mock');
  return makeRestGateway({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    apiBase: mode === 'live' ? 'https://api-m.paypal.com' : env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com',
    webhookId: env.PAYPAL_WEBHOOK_ID,
    currency: env.PAYPAL_CURRENCY || 'USD',
  });
}

module.exports = { makeMockGateway, makeRestGateway, gatewayFromEnv, GatewayError };
