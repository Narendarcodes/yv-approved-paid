/**
 * access: who may act in which organization (ADR-0015).
 *
 *   can(permission, { from, param })  Express middleware. Resolves the org from
 *                                     the addressed resource and the user's
 *                                     memberships, checks the permission, sets
 *                                     req.ctx = { orgId, userId, membership,
 *                                     permissions, projectId? }.
 *   requireCtx(req)                   req.ctx or throw (for services/controllers).
 *   memberOf(userId, orgId)           active membership or null (sockets, jobs).
 *   sharesOrganization(a, b)          users a and b have a common active org.
 *   allows(permissions, permission)
 *
 * Client-supplied organizationId never overrides the org of an addressed
 * record; with from:'select' it only picks among the user's own memberships.
 * Non-members get 404, members without the permission get 403.
 */
const { resolveAccess, AccessError } = require('./lib/resolve.cts');
const { activeMembership, allows, organizationIdsOf } = require('./lib/membership.cts');

import type { AccessContext, From } from './lib/resolve.cts';

export type { AccessContext, From };

type Options = { from: From; param?: string };

const DEFAULT_PARAM: Record<From, string> = {
  project: 'id',
  org: 'organizationId',
  select: 'organizationId',
};

type AnyReq = {
  ctx?: AccessContext;
  membership?: unknown;
  projectOrgId?: string;
  [k: string]: any;
};
type Next = (err?: unknown) => void;
type Res = { status: (n: number) => { json: (b: unknown) => unknown } };

function sendError(res: Res, err: { status: number; code: string; message: string }) {
  return res.status(err.status).json({ error: { code: err.code, message: err.message } });
}

function can(permission: string | null, opts: Options) {
  const param = opts.param || DEFAULT_PARAM[opts.from];
  return async function accessMiddleware(req: AnyReq, res: Res, next: Next) {
    try {
      const ctx: AccessContext = await resolveAccess(req, permission, opts.from, param);
      req.ctx = ctx;
      // legacy names read by older controllers
      req.membership = ctx.membership;
      req.projectOrgId = ctx.orgId;
      next();
    } catch (err) {
      if (err instanceof AccessError)
        return sendError(res, err as { status: number; code: string; message: string });
      next(err);
    }
  };
}

/** Check one more permission against an already-resolved req.ctx. */
function also(permission: string) {
  return function alsoMiddleware(req: AnyReq, res: Res, next: Next) {
    if (!req.ctx)
      return sendError(res, {
        status: 500,
        code: 'access_unresolved',
        message: 'Access context missing',
      });
    if (!allows(req.ctx.permissions, permission)) {
      return sendError(res, { status: 403, code: 'forbidden', message: 'Insufficient permission' });
    }
    next();
  };
}

function requireCtx(req: AnyReq): AccessContext {
  if (!req.ctx) throw new AccessError(500, 'access_unresolved', 'Access context missing');
  return req.ctx;
}

async function memberOf(userId: unknown, orgId: unknown) {
  return activeMembership(userId, orgId);
}

/** Do two users hold active memberships in at least one common organization? */
async function sharesOrganization(userA: unknown, userB: unknown): Promise<boolean> {
  if (String(userA) === String(userB)) return true;
  const [a, b] = await Promise.all([organizationIdsOf(userA), organizationIdsOf(userB)]);
  const set = new Set(a);
  return b.some((id: string) => set.has(id));
}

module.exports = {
  can,
  also,
  requireCtx,
  memberOf,
  sharesOrganization,
  allows,
  organizationIdsOf,
  AccessError,
};
