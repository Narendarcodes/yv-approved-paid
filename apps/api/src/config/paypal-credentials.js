/**
 * PAYPAL_CREDENTIALS="<client id>:<secret>" (one value, the form PayPal's
 * dashboard and a password vault hand over) fills PAYPAL_CLIENT_ID and
 * PAYPAL_CLIENT_SECRET at boot, so a host can be given the pair as one secret.
 * When it is set and well formed it wins over the two separate vars. The values
 * are never logged.
 */
function applyPaypalCredentials(env = process.env) {
  const raw = (env.PAYPAL_CREDENTIALS || '').trim();
  if (!raw) return false;
  const i = raw.indexOf(':');
  if (i <= 0 || i === raw.length - 1) return false;
  env.PAYPAL_CLIENT_ID = raw.slice(0, i).trim();
  env.PAYPAL_CLIENT_SECRET = raw.slice(i + 1).trim();
  return true;
}

module.exports = { applyPaypalCredentials };
