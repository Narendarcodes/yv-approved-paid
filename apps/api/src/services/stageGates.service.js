/**
 * Project stage gates: a project moves to the next stage only when the work of
 * the stage it is leaving is done. The stages are the dashboard's macro stages
 * (Idea -> Brief -> Production -> Review -> Publish -> Live); each owns a set of
 * project statuses. A move that crosses into a LATER stage is checked here; a
 * move inside a stage, or back to an earlier one (a revision), is not.
 *
 *   Idea -> Brief          the concept is picked (status APPROVED_CONCEPT) or the
 *                          project was converted from an approved concept
 *   Brief -> Production    brief items (deliverables) exist, an editor is assigned,
 *                          a deal is linked, signed by both sides, and the linked
 *                          milestone's money is held
 *   Production -> Review   a version is uploaded and the automated checks ran on it
 *   Review -> Publish      the version is approved by the client or a reviewer
 *   Publish -> Live        a post is scheduled or published
 *
 * Deal and money state are READ here only (deals/service `get`); nothing in this
 * file moves money or changes a deal. Admins get no bypass.
 */
const Project = require('../models/project.model');
const ProjectVersion = require('../models/projectVersion.model');
const Brief = require('../models/brief.model');
const Concept = require('../models/concept.model');
const Membership = require('../models/membership.model');
const Publication = require('../models/publication.model');

const STAGES = Object.freeze([
  { key: 'idea', label: 'Idea', statuses: ['IDEA', 'APPROVED_CONCEPT'] },
  { key: 'brief', label: 'Brief', statuses: ['ASSIGNED', 'WAITING_FOR_INPUTS', 'INPUTS_READY'] },
  {
    key: 'production',
    label: 'Production',
    statuses: ['IN_PROGRESS', 'REVISION_REQUESTED', 'REVISION_IN_PROGRESS'],
  },
  {
    key: 'review',
    label: 'Review',
    statuses: ['FIRST_DRAFT_SUBMITTED', 'UNDER_REVIEW', 'REVISION_SUBMITTED'],
  },
  { key: 'publish', label: 'Publish', statuses: ['APPROVED', 'SCHEDULED'] },
  { key: 'live', label: 'Live', statuses: ['PUBLISHED'] },
]);

/** The happy-path next status from each status (what "Move to next stage" does). */
const NEXT = Object.freeze({
  IDEA: 'ASSIGNED',
  APPROVED_CONCEPT: 'ASSIGNED',
  ASSIGNED: 'IN_PROGRESS',
  WAITING_FOR_INPUTS: 'INPUTS_READY',
  INPUTS_READY: 'IN_PROGRESS',
  IN_PROGRESS: 'FIRST_DRAFT_SUBMITTED',
  FIRST_DRAFT_SUBMITTED: 'UNDER_REVIEW',
  UNDER_REVIEW: 'APPROVED',
  REVISION_REQUESTED: 'REVISION_IN_PROGRESS',
  REVISION_IN_PROGRESS: 'REVISION_SUBMITTED',
  REVISION_SUBMITTED: 'APPROVED',
  APPROVED: 'SCHEDULED',
  SCHEDULED: 'PUBLISHED',
});

/** Index of the stage that owns `status`, or -1 (CANCELLED, CLOSED, unknown). */
function stageIndex(status) {
  return STAGES.findIndex((s) => s.statuses.includes(status));
}

/** The stage a move enters when it crosses forward into a later stage, else null. */
function gatedStage(from, to) {
  const a = stageIndex(from);
  const b = stageIndex(to);
  if (a === -1 || b === -1 || b <= a) return null;
  return STAGES[b].key;
}

/** Milestone states in which the client's money is (or was) held for the work. */
const HELD = new Set([
  'FUNDED',
  'STYLE_SAMPLE',
  'SUBMITTED',
  'CHECKS',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'AUTO_APPROVED',
  'CAPTURED',
  'PAID_OUT',
  'DISPUTED',
]);
const CLIENT_APPROVED = new Set(['APPROVED', 'AUTO_APPROVED', 'CAPTURED', 'PAID_OUT']);
const EDITOR_ROLES = new Set(['editor', 'admin']);

/** Read the linked deal (read-only). Missing or another org's deal reads as null. */
async function readDeal(dealId, organizationId) {
  if (!dealId) return null;
  try {
    const { dealService } = require('../modules/deals/service.cts');
    return await dealService().get(String(dealId), String(organizationId));
  } catch {
    return null;
  }
}

function dealHref(project, open) {
  const qs = [
    project.milestoneKey ? `reel=${encodeURIComponent(project.milestoneKey)}` : '',
    open ? `open=${open}` : '',
  ]
    .filter(Boolean)
    .join('&');
  return `/deals/${encodeURIComponent(project.dealId)}${qs ? `?${qs}` : ''}`;
}

function milestoneOf(deal, key) {
  if (!deal || !Array.isArray(deal.milestones)) return null;
  if (key) return deal.milestones.find((m) => m.key === key) || null;
  return null;
}

/**
 * The checklist for entering `stage`: [{ key, label, done, href, action }].
 * `href` is where the missing work gets done; `action` is the link text.
 */
async function checklist(project, stage, { canApprove = false } = {}) {
  const pid = String(project._id);
  const orgId = project.organizationId;
  const items = [];
  const add = (key, label, done, href, action) =>
    items.push({ key, label, done: !!done, href, action });

  if (stage === 'brief') {
    let converted = false;
    if (project.conceptId) {
      converted = !!(await Concept.exists({
        _id: project.conceptId,
        organizationId: orgId,
        status: 'APPROVED',
      }));
    }
    add(
      'concept_picked',
      'Pick the concept or convert it from Concepts',
      converted || project.status === 'APPROVED_CONCEPT',
      '/concepts',
      'Open concepts',
    );
  }

  if (stage === 'production') {
    const brief = await Brief.findOne({ projectId: project._id, organizationId: orgId })
      .select('deliverables')
      .lean();
    add(
      'brief_items',
      'Add brief items (deliverables)',
      !!(
        brief &&
        Array.isArray(brief.deliverables) &&
        brief.deliverables.some((d) => String(d).trim())
      ),
      `/projects/${pid}#brief`,
      'Open brief',
    );
    let editor = false;
    if (project.assignee) {
      const m = await Membership.findOne({
        userId: project.assignee,
        organizationId: orgId,
        disabled: { $ne: true },
      })
        .select('role')
        .lean();
      editor = !!(m && EDITOR_ROLES.has(m.role));
    }
    add('editor_assigned', 'Assign an editor', editor, `/projects/${pid}#assign`, 'Assign');
    const deal = await readDeal(project.dealId, orgId);
    const ms = milestoneOf(deal, project.milestoneKey);
    add(
      'deal_linked',
      'Link the deal for this work',
      !!(deal && ms),
      `/projects/${pid}#deal`,
      'Link deal',
    );
    const dealLink = deal ? dealHref(project, 'terms') : '/deals';
    add(
      'deal_signed',
      'Both sides sign the deal',
      !!(deal && deal.termsHash),
      dealLink,
      'Open deal',
    );
    add(
      'money_held',
      'Hold the money for this milestone',
      !!(ms && HELD.has(ms.state)),
      deal ? dealHref(project, 'money') : '/deals',
      'Open deal',
    );
  }

  if (stage === 'review') {
    const deal = await readDeal(project.dealId, orgId);
    const ms = milestoneOf(deal, project.milestoneKey);
    const versions = ms && Array.isArray(ms.versions) ? ms.versions : [];
    const projectVersion = await ProjectVersion.exists({
      projectId: project._id,
      organizationId: orgId,
    });
    add(
      'version_uploaded',
      'Upload a version',
      !!projectVersion || versions.length > 0,
      `/projects/${pid}#versions`,
      'Upload',
    );
    const latest = versions[versions.length - 1];
    add(
      'checks_ran',
      'Run the automated checks on the latest version',
      !!(latest && latest.checks),
      deal ? dealHref(project, 'checks') : `/projects/${pid}#deal`,
      'Open checks',
    );
  }

  if (stage === 'publish') {
    const deal = await readDeal(project.dealId, orgId);
    const ms = milestoneOf(deal, project.milestoneKey);
    const approved = !!project.approvedVersionId || !!(ms && CLIENT_APPROVED.has(ms.state));
    add(
      'approved',
      canApprove && !approved
        ? 'Approve the latest version (you can do it with this move)'
        : 'Approval from the client or a reviewer',
      approved || canApprove,
      `/projects/${pid}/review`,
      'Open review',
    );
  }

  if (stage === 'live') {
    const post = await Publication.exists({
      projectId: project._id,
      status: { $in: ['scheduled', 'published'] },
    });
    add(
      'post_scheduled',
      'Schedule or publish a post',
      !!post,
      `/publishing/compose?project=${pid}`,
      'Open composer',
    );
  }

  return items;
}

/**
 * The gate for a move from the project's current status to `to` (default: the
 * happy-path next status). `ready` is true when nothing is missing or the move
 * does not cross into a later stage.
 */
async function evaluate(project, { to, canApprove = false } = {}) {
  const next = to || NEXT[project.status] || null;
  const fromIdx = stageIndex(project.status);
  const stage = next ? gatedStage(project.status, next) : null;
  const items = stage ? await checklist(project, stage, { canApprove }) : [];
  const missing = items.filter((i) => !i.done);
  return {
    status: project.status,
    next,
    from: fromIdx === -1 ? null : STAGES[fromIdx].key,
    to: stage || (next && stageIndex(next) !== -1 ? STAGES[stageIndex(next)].key : null),
    gated: !!stage,
    ready: !!next && missing.length === 0,
    items,
    missing,
  };
}

/** Throw a 409 with the missing items when the move is gated and not ready. */
async function assertMove(project, to, opts = {}) {
  const stage = gatedStage(project.status, to);
  if (!stage) return;
  const g = await evaluate(project, { to, ...opts });
  if (g.missing.length) {
    const label = STAGES.find((s) => s.key === stage).label;
    throw {
      status: 409,
      code: 'stage_gate',
      message: `Not ready for ${label}: ${g.missing.map((m) => m.label.toLowerCase()).join('; ')}`,
      details: g.missing.map(({ key, label: l, href, action }) => ({
        key,
        label: l,
        href,
        action,
      })),
    };
  }
}

/** GET /projects/:id/gate: the checklist for the next move, as the caller sees it. */
async function gateFor({ projectId, organizationId, canApprove = false }) {
  const project = await Project.findOne({ _id: projectId, organizationId }).lean();
  if (!project) throw { status: 404, code: 'project_not_found', message: 'Project not found' };
  return evaluate(project, { canApprove });
}

module.exports = { STAGES, NEXT, stageIndex, gatedStage, evaluate, assertMove, gateFor, checklist };
