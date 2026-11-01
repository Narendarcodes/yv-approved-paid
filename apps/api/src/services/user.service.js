const User = require('../models/user.model');
const Membership = require('../models/membership.model');
const uploadService = require('./upload.service');

async function getMe(userId) {
  const user = await User.findById(userId);
  if (!user) throw { status: 404, code: 'user_not_found', message: 'User not found' };
  // Attach the user's primary organization role so role-based UX in the
  // frontend reflects what the backend actually enforces (membership.role).
  const membership = await Membership.findOne({ userId, disabled: { $ne: true } }).sort({
    createdAt: 1,
  });
  // toJSON: no passwordHash / storage ref; avatar = the authenticated route
  const plain = user.toJSON();
  plain.role = membership ? membership.role : 'member';
  return plain;
}

async function listMyOrganizations(userId) {
  // Disabled memberships are treated as not-a-member by requireOrg, so exclude
  // them here too — a disabled user must not see the org in a switcher.
  const memberships = await Membership.find({ userId, disabled: { $ne: true } })
    .populate('organizationId', 'name slug settings')
    .sort({ createdAt: 1 });
  return memberships.map((m) => ({
    membershipId: m._id,
    organization: m.organizationId,
    role: m.role,
  }));
}

async function updateProfile(userId, { name, email }) {
  const user = await User.findById(userId);
  if (!user) throw { status: 404, code: 'user_not_found', message: 'User not found' };
  if (name !== undefined) user.name = name;
  if (email !== undefined) {
    const normalized = email.trim().toLowerCase();
    if (normalized !== user.email) {
      const existing = await User.findOne({ email: normalized });
      if (existing && existing._id.toString() !== userId.toString()) {
        throw { status: 409, code: 'email_in_use', message: 'Email already registered' };
      }
      user.email = normalized;
    }
  }
  await user.save();
  const plain = user.toJSON();
  return plain;
}

async function listOrgMembers({ organizationId }) {
  return Membership.find({ organizationId })
    .populate('userId', 'name email disabled')
    .sort({ createdAt: 1 });
}

/** Role refs (names and ids) whose role grants everything ('*'): the org's admins. */
async function adminRoleRefs() {
  const Role = require('../models/role.model');
  const roles = await Role.find({ permissions: '*' }).select('_id name').lean();
  return roles.flatMap((r) => [r.name, String(r._id)]);
}

async function countActiveAdmins(organizationId) {
  const refs = await adminRoleRefs();
  return Membership.countDocuments({ organizationId, disabled: { $ne: true }, role: { $in: refs } });
}

/**
 * PATCH a membership: { role?, disabled? } (validated by updateMemberSchema).
 * Refuses (409 last_admin) any change that would leave the organization with
 * no active admin, whether by demoting or by disabling the last one.
 *
 * The guard runs after the write and puts the old values back if the org was
 * left without an admin, so two concurrent demotions of the last two admins
 * both fail instead of both succeeding.
 */
async function updateMember({ organizationId, userId, role, disabled }) {
  const Role = require('../models/role.model');
  const m = await Membership.findOne({ organizationId, userId });
  if (!m) throw { status: 404, code: 'membership_not_found', message: 'Membership not found' };
  if (role !== undefined) {
    const exists = await Role.exists({ name: role });
    if (!exists) throw { status: 400, code: 'invalid_role', message: 'Role does not exist' };
  }
  const before = { role: m.role, disabled: m.disabled };
  const refs = await adminRoleRefs();
  const wasActiveAdmin = !before.disabled && refs.includes(String(before.role));
  if (role !== undefined) m.role = role;
  if (disabled !== undefined) m.disabled = disabled;
  await m.save();
  const stillActiveAdmin = !m.disabled && refs.includes(String(m.role));
  if (wasActiveAdmin && !stillActiveAdmin && (await countActiveAdmins(organizationId)) === 0) {
    await Membership.updateOne({ _id: m._id }, { $set: before });
    throw {
      status: 409,
      code: 'last_admin',
      message: 'An organization needs at least one active admin. Make someone else admin first.',
    };
  }
  return m;
}

async function setMemberStatus({ organizationId, userId, disabled }) {
  return updateMember({ organizationId, userId, disabled });
}

async function updateMemberRole({ organizationId, userId, roleName }) {
  return updateMember({ organizationId, userId, role: roleName });
}

/**
 * Set a user's profile photo by uploading a file buffer.
 * Returns the updated user object.
 */
async function setProfilePhoto(userId, buffer, filename, mimeType) {
  await uploadService.uploadProfilePhoto(userId, buffer, filename, mimeType);
  return getMe(userId);
}

/**
 * Remove a user's profile photo.
 * Returns the updated user object.
 */
async function removeProfilePhoto(userId) {
  await uploadService.removeProfilePhoto(userId);
  return getMe(userId);
}

module.exports = {
  getMe,
  listMyOrganizations,
  updateProfile,
  listOrgMembers,
  updateMember,
  countActiveAdmins,
  setMemberStatus,
  updateMemberRole,
  setProfilePhoto,
  removeProfilePhoto,
};
