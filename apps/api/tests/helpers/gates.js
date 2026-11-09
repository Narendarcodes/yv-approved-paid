/**
 * Test fixtures for the project stage gates (services/stageGates.service.js).
 *
 * meetGates(projectId, opts) gives a project everything the gates up to Review
 * read: an approved concept, brief deliverables, an editor assignee, and a
 * linked deal signed by both sides with the milestone's money held and one
 * checked version. The deal is a plain read-only row (no PayPal, no ledger,
 * inactive so no tick touches it); it only exists for the gates to read.
 *
 * addPost(projectId, status) records one post for the Publish -> Live gate.
 */
const mongoose = require('mongoose');
const Project = require('../../src/models/project.model');
const Concept = require('../../src/models/concept.model');
const Brief = require('../../src/models/brief.model');
const Publication = require('../../src/models/publication.model');
const { Deal } = require('../../src/modules/deals/lib/models.cts');

let n = 0;

/** A read-only deal row for the gates: `signed`, `state` and `checked` shape it. */
async function gateDeal(
  orgId,
  { signed = true, state = 'FUNDED', checked = true, key = 'reel1', versions } = {},
) {
  n += 1;
  const id = `deal_gate_${Date.now().toString(36)}_${n}`;
  const at = new Date().toISOString();
  const vs =
    versions !== undefined
      ? versions
      : [
          {
            id: 'v1',
            sha256: 'f'.repeat(64),
            submittedAt: at,
            ...(checked ? { checks: { reportId: 'r1', passed: true, failed: [], at } } : {}),
          },
        ];
  const doc = {
    id,
    orgId: String(orgId),
    terms: {
      title: 'Gate fixture deal',
      currency: 'USD',
      client: { userId: 'u_client' },
      worker: { userId: 'u_worker' },
      milestones: [{ key, title: 'Reel' }],
      rateCard: [],
      killFeeBp: 0,
      humanApprovalThresholdMinor: 0,
    },
    signatures: signed
      ? [
          { party: 'client', userId: 'u_client', termsHash: 'h', at },
          { party: 'worker', userId: 'u_worker', termsHash: 'h', at },
        ]
      : [],
    ...(signed ? { termsHash: 'h', lockedAt: at } : {}),
    milestones: [
      {
        key,
        state,
        styleApproved: false,
        versions: vs,
        revisionRoundsUsed: 0,
        tasteRoundsUsed: 0,
        capturedMinor: 0,
        captures: [],
        paidOutMinor: 0,
        payouts: [],
        changeRequests: [],
        history: [],
        ...(state !== 'DRAFT' && state !== 'SIGNED' ? { funding: { status: 'AUTHORIZED' } } : {}),
      },
    ],
    executedKeys: [],
    pendingApprovals: [],
    humanApprovals: [],
    changeOrders: [],
  };
  await Deal.create({
    _id: id,
    orgId: String(orgId),
    clientUserId: 'u_client',
    workerUserId: 'u_worker',
    title: doc.terms.title,
    active: false,
    doc,
  });
  return { id, key };
}

/**
 * Everything the gates up to Review need. `assigneeId` must be an editor or
 * admin member of the org (it is only set when the project has no assignee).
 */
async function meetGates(projectId, { assigneeId, deal = {}, brief = true, concept = true } = {}) {
  const p = await Project.findById(projectId);
  if (!p) throw new Error(`meetGates: no project ${projectId}`);
  const set = {};
  if (concept) {
    const c = await Concept.create({
      organizationId: p.organizationId,
      title: `Concept for ${p.title}`.slice(0, 140),
      description: 'Gate fixture concept',
      status: 'APPROVED',
      proposer: p.creator || assigneeId || new mongoose.Types.ObjectId(),
      approvedProjectId: p._id,
    });
    set.conceptId = c._id;
  }
  if (brief) {
    await Brief.findOneAndUpdate(
      { projectId: p._id },
      {
        $set: {
          projectId: p._id,
          organizationId: p.organizationId,
          deliverables: ['One 30s reel'],
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }
  if (assigneeId && !p.assignee) set.assignee = assigneeId;
  if (deal) {
    const d = await gateDeal(p.organizationId, deal);
    set.dealId = d.id;
    set.milestoneKey = d.key;
  }
  await Project.updateOne({ _id: p._id }, { $set: set });
  return set;
}

async function addPost(projectId, status = 'scheduled') {
  const p = await Project.findById(projectId).lean();
  return Publication.create({
    projectId: p._id,
    organizationId: p.organizationId,
    platform: 'instagram',
    status,
    provider: 'manual',
    scheduledFor: status === 'scheduled' ? new Date(Date.now() + 86400000) : null,
  });
}

module.exports = { meetGates, gateDeal, addPost };
