const Organization = require('../models/organization.model');
const Membership = require('../models/membership.model');
const Role = require('../models/role.model');
const User = require('../models/user.model');
const { seedDefaultRoles } = require('../seed/roles');

async function createOrganization({ name, slug, adminUserId }) {
  const org = new Organization({ name, slug });
  await org.save();
  // ensure default roles exist (admin, editor, reviewer, publisher)
  await seedDefaultRoles();
  // create membership for admin
  const membership = new Membership({ userId: adminUserId, organizationId: org._id, role: 'admin' });
  await membership.save();
  return { org, membership };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Demo invites only reach reserved example.com addresses (RFC 2606): nobody real can be added or contacted. */
const DEMO_INVITE_DOMAIN = /@([a-z0-9-]+\.)*example\.com$/;
const DEMO_PENDING_CAP = 25;

function demoMode() {
  return process.env.DEMO_MODE === '1';
}

/**
 * POST /organizations/:org/members (manage_members). Adds an existing user by
 * email. No invitation email is ever sent (yv. has no mailer).
 *
 * DEMO_MODE=1 (the public judge demo): invites are limited to example.com
 * addresses, so a judge cannot pull a real account into the demo org or reach a
 * stranger's inbox. An example.com address with no account yet is added as a
 * *pending* member (a placeholder user with no usable password, no email sent),
 * capped at DEMO_PENDING_CAP pending members per org. Outside demo mode an
 * unknown email stays a 404 (no placeholder accounts squatting real addresses).
 */
async function addMember({ organizationId, userEmail, roleName }) {
  const email = String(userEmail || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw { status: 422, code: 'invalid_email', message: 'Enter a valid email address' };
  const demo = demoMode();
  if (demo && !DEMO_INVITE_DOMAIN.test(email))
    throw {
      status: 422,
      code: 'demo_invite_domain',
      message: 'The demo only invites example.com addresses (no email is sent to anyone)',
    };
  const role = await Role.findOne({ name: roleName });
  if (!role) throw { status: 400, code: 'invalid_role', message: 'Role does not exist' };
  let user = await User.findOne({ email });
  let pending = false;
  if (!user) {
    if (!demo) throw { status: 404, code: 'user_not_found', message: 'User not found' };
    const open = await Membership.countDocuments({ organizationId, pending: true });
    if (open >= DEMO_PENDING_CAP)
      throw { status: 429, code: 'demo_invite_limit', message: 'This demo org has enough pending invites' };
    const bcrypt = require('bcryptjs');
    const crypto = require('node:crypto');
    const local = email.split('@')[0].replace(/[._-]+/g, ' ').trim() || 'Invited member';
    user = await User.create({
      email,
      name: local.charAt(0).toUpperCase() + local.slice(1),
      // no usable password: a placeholder until the person signs up for real
      passwordHash: bcrypt.hashSync(crypto.randomBytes(24).toString('base64url'), 10),
    });
    pending = true;
  }
  const existing = await Membership.findOne({ userId: user._id, organizationId });
  if (existing) throw { status: 409, code: 'membership_exists', message: 'User already member' };
  const membership = new Membership({ userId: user._id, organizationId, role: roleName, pending });
  await membership.save();
  return { ...membership.toObject(), user: { _id: user._id, name: user.name, email: user.email }, emailSent: false };
}

async function listUserOrganizations(userId) {
  const memberships = await Membership.find({ userId }).populate('organizationId');
  return memberships.map((m) => m.organizationId).filter(Boolean);
}

module.exports = { createOrganization, addMember, listUserOrganizations };
