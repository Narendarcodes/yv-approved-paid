const Joi = require('joi');

const registerSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200).required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(8).max(128).required(),
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
  // 'body' = also return the refresh token in the JSON (non-browser clients).
  // Browsers keep it in the httpOnly cookie only (ADR-0017).
  tokenTransport: Joi.string().valid('cookie', 'body'),
});

// refreshToken in the body = API-client mode; omitted = cookie mode (browser).
const refreshSchema = Joi.object({
  refreshToken: Joi.string(),
});

const logoutSchema = Joi.object({
  refreshToken: Joi.string(),
});

module.exports = { registerSchema, loginSchema, refreshSchema, logoutSchema };
