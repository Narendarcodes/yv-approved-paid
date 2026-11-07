const { applyPaypalCredentials } = require('../src/config/paypal-credentials');

describe('applyPaypalCredentials', () => {
  it('splits id:secret on the first colon and wins over the separate vars', () => {
    const env = {
      PAYPAL_CREDENTIALS: 'AbcId:sec:ret',
      PAYPAL_CLIENT_ID: 'old',
      PAYPAL_CLIENT_SECRET: 'old',
    };
    expect(applyPaypalCredentials(env)).toBe(true);
    expect(env.PAYPAL_CLIENT_ID).toBe('AbcId');
    expect(env.PAYPAL_CLIENT_SECRET).toBe('sec:ret');
  });

  it('leaves the separate vars alone when unset or malformed', () => {
    for (const v of [undefined, '', 'nocolon', ':secret', 'id:']) {
      const env = { PAYPAL_CREDENTIALS: v, PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' };
      expect(applyPaypalCredentials(env)).toBe(false);
      expect(env).toMatchObject({ PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' });
    }
  });
});
