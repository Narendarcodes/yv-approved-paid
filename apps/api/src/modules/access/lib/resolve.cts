/**
 * Resolve the organization a request acts in, from the ADDRESSED RESOURCE and
 * the user's memberships, never from client-supplied organizationId (ADR-0015).
 *
 *   from: 'project'  org = the project's own organizationId (req.params[param])
 *   from: 'org'      org = the organization in the path (req.params[param])
 *   from: 'select'   org = body/query organizationId, used ONLY to pick one of
 *                    the user's own memberships (create/list endpoints)
 *
 * A user who is not an active member of the resolved org gets 404, exactly as
 * if the record did not exist, so other orgs' ids are not confirmed.
 */
const Project = require('../../../models/project.model');
const { activeMembership, permissionsOf, allows, isObjectId } = require('./membership.cts');

import type { MembershipDoc } from './membership.cts';

export type From = 'project' | 'org' | 'select';

export type AccessContext = {
  orgId: string;
  userId: string;
  membership: MembershipDoc;
  permissions: string[];
  projectId?: string;
};

class AccessError extends Error {
  status: number;
  code: string;
  expose: boolean;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

const NOT_FOUND: Record<From, [string, string]> = {
  project: ['project_not_found', 'Project not found'],
  org: ['organization_not_found', 'Organization not found'],
  select: ['organization_not_found', 'Organization not found'],
};

function notFound(from: From): AccessError {
  const [code, message] = NOT_FOUND[from];
  return new AccessError(404, code, message);
}

type Req = {
  user?: { _id: unknown };
  params: Record<string, string | undefined>;
  query: Record<string, unknown>;
  body?: Record<string, unknown>;
};

/** Which org does this request address? null = the addressed record does not exist. */
async function addressedOrg(
  req: Req,
  from: From,
  param: string,
): Promise<{ orgId: string; projectId?: string } | null> {
  if (from === 'project') {
    const id = req.params[param];
    if (!id || !isObjectId(id)) return null;
    const p = await Project.findById(id).select('organizationId').lean();
    return p ? { orgId: String(p.organizationId), projectId: String(p._id) } : null;
  }
  if (from === 'org') {
    const id = req.params[param];
    return id && isObjectId(id) ? { orgId: String(id) } : null;
  }
  const raw = (req.body && req.body[param]) || req.query[param];
  if (!raw) throw new AccessError(400, 'missing_organization', 'Organization id required');
  const id = String(raw);
  return isObjectId(id) ? { orgId: id } : null;
}

/** Resolve {orgId, membership, permissions} or throw AccessError (404 / 403 / 400). */
async function resolveAccess(
  req: Req,
  permission: string | null,
  from: From,
  param: string,
): Promise<AccessContext> {
  if (!req.user) throw new AccessError(401, 'unauthenticated', 'Missing token');
  const addressed = await addressedOrg(req, from, param);
  if (!addressed) throw notFound(from);
  const membership = await activeMembership(req.user._id, addressed.orgId);
  if (!membership) throw notFound(from);
  const permissions = await permissionsOf(membership);
  if (!allows(permissions, permission))
    throw new AccessError(403, 'forbidden', 'Insufficient permission');
  return {
    orgId: addressed.orgId,
    userId: String(req.user._id),
    membership,
    permissions,
    projectId: addressed.projectId,
  };
}

module.exports = { resolveAccess, AccessError, notFound };
