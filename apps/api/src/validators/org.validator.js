const Joi = require('joi');

const createOrgSchema = Joi.object({
  name: Joi.string().trim().min(1).max(300).required(),
  slug: Joi.string()
    .trim()
    .min(1)
    .max(100)
    .lowercase()
    .pattern(/^[a-z0-9-]+$/)
    .required(),
});

/**
 * PATCH /organizations/:organizationId/members/:memberUserId (and the
 * /users/organizations/... alias). Role names are checked against the Role
 * collection in the service; this only pins the shape and the types.
 */
const updateMemberSchema = Joi.object({
  role: Joi.string()
    .trim()
    .lowercase()
    .pattern(/^[a-z][a-z0-9_-]{0,39}$/),
  disabled: Joi.boolean().strict(),
})
  .min(1);

module.exports = { createOrgSchema, updateMemberSchema };
