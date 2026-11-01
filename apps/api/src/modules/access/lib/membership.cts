/**
 * Membership + role lookups. The ONLY source of a user's organizations is the
 * Membership collection; nothing here reads the request.
 */
const mongoose = require('mongoose');
const Membership = require('../../../models/membership.model');
const Role = require('../../../models/role.model');

export type MembershipDoc = {
  _id: unknown;
  userId: unknown;
  organizationId: unknown;
  role?: string;
  disabled?: boolean;
};

function isObjectId(v: unknown): boolean {
  return typeof v === 'string' || v instanceof mongoose.Types.ObjectId
    ? mongoose.isValidObjectId(v) && String(v).length === 24
    : false;
}

/** Active (not disabled) membership of userId in orgId, or null. */
async function activeMembership(userId: unknown, orgId: unknown): Promise<MembershipDoc | null> {
  if (!userId || !orgId || !isObjectId(String(orgId))) return null;
  const m = await Membership.findOne({ userId, organizationId: orgId, disabled: { $ne: true } });
  return m || null;
}

/** Permissions granted by the membership's role (role may be a Role id or a Role name). */
async function permissionsOf(membership: MembershipDoc): Promise<string[]> {
  const ref = membership.role;
  if (!ref) return [];
  const role = /^[0-9a-fA-F]{24}$/.test(String(ref))
    ? await Role.findById(ref).lean()
    : await Role.findOne({ name: ref }).lean();
  return (role && Array.isArray(role.permissions) ? role.permissions : []) as string[];
}

function allows(permissions: string[], permission: string | null): boolean {
  if (!permission) return true;
  return permissions.includes('*') || permissions.includes(permission);
}

/** Ids of every organization the user is an active member of. */
async function organizationIdsOf(userId: unknown): Promise<string[]> {
  const rows = await Membership.find({ userId, disabled: { $ne: true } })
    .select('organizationId')
    .lean();
  return rows.map((r: { organizationId: unknown }) => String(r.organizationId));
}

module.exports = { activeMembership, permissionsOf, allows, organizationIdsOf, isObjectId };
