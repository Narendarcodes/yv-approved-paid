const Role = require('../models/role.model');

const DEFAULT_ROLES = [
  { name: 'admin', permissions: ['*'], description: 'Full access within the organization' },
  {
    name: 'editor',
    permissions: [
      'project.create',
      'project.transition',
      'project.upload_version',
      'project.comment',
      'project.revision',
      'project.view',
      'task.create',
      'task.update',
      'brief.manage',
      'chat.post',
      // read-only, own records: GET invoices/contracts the editor created (writes need *.manage)
      'invoice.view',
      'contract.view',
      // deal.manage: crew create deals and run their own milestones (payables/payout paths).
      // Brand-only capabilities stay off the crew role: project.assign, invoice.manage,
      // contract.manage, manage_members and payables.view_org come with '*' (admin) only.
      'deal.manage',
    ],
    description: 'Creates and works on projects (crew)',
  },
  {
    name: 'reviewer',
    permissions: [
      'project.view',
      'project.comment',
      'project.revision',
      'project.approve',
      'concept.review',
      'task.create',
      'task.update',
      'chat.post',
    ],
    description: 'Reviews drafts, comments, requests revisions, approves',
  },
  {
    name: 'publisher',
    permissions: ['project.view', 'project.schedule', 'project.publish', 'project.metrics'],
    description: 'Schedules and publishes approved projects, records metrics',
  },
];

async function seedDefaultRoles() {
  for (const r of DEFAULT_ROLES) {
    const existing = await Role.findOne({ name: r.name });
    if (existing) {
      // keep in sync: update permissions on existing roles so new capabilities apply
      if (JSON.stringify(existing.permissions || []) !== JSON.stringify(r.permissions)) {
        existing.permissions = r.permissions;
        await existing.save();
      }
    } else {
      await Role.create(r);
    }
  }
}

module.exports = { DEFAULT_ROLES, seedDefaultRoles };
