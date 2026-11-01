const PROD_REST = {
  CORS_ORIGIN: 'https://app.example.com',
  MONGO_URI: 'mongodb://db/yv',
  SERVICE_JWT_SECRET: 'service-secret-service-secret-service-secret-1',
  INTERNAL_API_TOKEN: 'internal-token-internal-token-internal-token-1',
  CSRF_SECRET: 'csrf-secret-csrf-secret-csrf-secret-csrf-secret-1',
};

describe('JWT_ACCESS_SECRET enforcement', () => {
  test('throws when JWT_ACCESS_SECRET is a known default in production', () => {
    const originalEnv = { ...process.env };
    const originalError = console.error;
    let caught = null;

    // Suppress console.error during the expected failure
    console.error = () => {};

    try {
      process.env.NODE_ENV = 'production';
      process.env.JWT_ACCESS_SECRET = 'change-me';
      // Clear require cache to force re-evaluation
      delete require.cache[require.resolve('../src/config')];
      delete require.cache[require.resolve('../src/config')];
      try {
        require('../src/config');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeTruthy();
      expect(caught.message).toMatch(/JWT_ACCESS_SECRET/i);
    } finally {
      process.env.NODE_ENV = originalEnv.NODE_ENV;
      process.env.JWT_ACCESS_SECRET = originalEnv.JWT_ACCESS_SECRET;
      console.error = originalError;
      delete require.cache[require.resolve('../src/config')];
    }
  });

  test('does not throw when JWT_ACCESS_SECRET is a strong value in production', () => {
    const originalEnv = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      process.env.JWT_ACCESS_SECRET = 'a-very-strong-and-unique-secret-value-12345';
      // the rest of a valid production env (config/validate.js), so this test
      // isolates the JWT secret check
      Object.assign(process.env, PROD_REST);
      delete require.cache[require.resolve('../src/config')];
      const config = require('../src/config');
      expect(config.jwt.accessSecret).toBe('a-very-strong-and-unique-secret-value-12345');
    } finally {
      process.env.NODE_ENV = originalEnv.NODE_ENV;
      process.env.JWT_ACCESS_SECRET = originalEnv.JWT_ACCESS_SECRET;
      for (const k of Object.keys(PROD_REST)) {
        if (originalEnv[k] === undefined) delete process.env[k];
        else process.env[k] = originalEnv[k];
      }
      delete require.cache[require.resolve('../src/config')];
    }
  });
});
