/**
 * The deal engine: human events (sign, submit, approve, request changes, kill,
 * dispute) and the Money Agent (plan + execute). It works on plain DealDoc
 * objects with an injected gateway, ledger store and clock, so the same code
 * runs in unit tests, against the PayPal sandbox and in the API.
 *
 * Money Agent loop: plan() looks at every milestone and proposes the money
 * moves the signed deal implies; execute() sends each through the policy
 * engine, then calls PayPal with the policy's idempotency key as the
 * PayPal-Request-Id, then writes the ledger line with a plain explanation.
 */
import type { DealDoc, DealTerms, MilestoneRuntime, MoneyAction, Role, ChangeItem, MilestoneTerms } from './types.cts';
import type { PaymentGateway } from './gateway.cts';
import type { LedgerEntry, LedgerType } from './ledger.cts';
import type { PolicyContext } from './policy.cts';

const { hashOf } = require('./canonical.cts');
const { transition, TransitionError } = require('./states.cts');
const { evaluate, idempotencyKey } = require('./policy.cts');
const { nextEntry } = require('./ledger.cts');
const { explain, explainBlocked } = require('./explain.cts');
const { validateTerms } = require('./validate.cts');
const { percentOf } = require('./money.cts');

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const RETRY_BLOCKED_MS = 6 * HOUR;

export type LedgerStore = {
  last(dealId: string): Promise<LedgerEntry | null>;
  append(entry: LedgerEntry): Promise<void>;
  list(dealId: string): Promise<LedgerEntry[]>;
};

export type EngineDeps = {
  gateway: PaymentGateway;
  ledger: LedgerStore;
  now: () => string;
  /** Where PayPal sends the buyer back after approving a hold. */
  returnUrl: (deal: DealDoc, milestoneKey: string) => { returnUrl: string; cancelUrl: string };
  /** Optional span hook (OpenTelemetry) around every tool call. */
  trace?: <T>(name: string, attrs: Record<string, unknown>, fn: () => Promise<T>) => Promise<T>;
};

export type ExecOutcome = {
  outcome: 'done' | 'blocked' | 'pending_approval' | 'failed';
  entry: LedgerEntry;
  violations?: { rule: string; message: string }[];
  error?: { code: string; message: string };
};

class DealError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ helpers */

function newRuntime(key: string): MilestoneRuntime {
  return {
    key,
    state: 'DRAFT',
    styleApproved: false,
    versions: [],
    revisionRoundsUsed: 0,
    tasteRoundsUsed: 0,
    capturedMinor: 0,
    captures: [],
    paidOutMinor: 0,
    payouts: [],
    changeRequests: [],
    history: [],
  };
}

function ms(deal: DealDoc, key: string): MilestoneRuntime {
  const m = deal.milestones.find((x) => x.key === key);
  if (!m) throw new DealError('milestone_not_found', `no milestone ${key}`, 404);
  return m;
}
function termsOf(deal: DealDoc, key: string): MilestoneTerms {
  const t = deal.terms.milestones.find((x) => x.key === key);
  if (!t) throw new DealError('milestone_not_found', `no milestone ${key}`, 404);
  return t;
}
function put(deal: DealDoc, m: MilestoneRuntime): DealDoc {
  return { ...deal, milestones: deal.milestones.map((x) => (x.key === m.key ? m : x)) };
}
function step(deal: DealDoc, key: string, event: string, actor: Role, at: string): DealDoc {
  try {
    return put(deal, transition(ms(deal, key), event, actor, at));
  } catch (e) {
    if (e instanceof TransitionError) throw new DealError('invalid_transition', (e as Error).message, 409);
    throw e;
  }
}
function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

async function writeLedger(
  deps: EngineDeps,
  deal: DealDoc,
  data: { milestoneKey: string; type: LedgerType; amountMinor: number; moved: boolean; explanation: string; actor: string; paypalRef?: string; idempotencyKey?: string; policy?: LedgerEntry['policy'] },
): Promise<LedgerEntry> {
  const prev = await deps.ledger.last(deal.id);
  const entry = nextEntry(prev, { dealId: deal.id, orgId: deal.orgId, currency: deal.terms.currency, at: deps.now(), ...data });
  await deps.ledger.append(entry);
  return entry;
}

const traced = <T,>(deps: EngineDeps, name: string, attrs: Record<string, unknown>, fn: () => Promise<T>) =>
  deps.trace ? deps.trace(name, attrs, fn) : fn();

/* ------------------------------------------------------------- deal setup */

function createDeal(input: { id: string; orgId: string; terms: DealTerms }): DealDoc {
  return {
    id: input.id,
    orgId: input.orgId,
    terms: clone(input.terms),
    signatures: [],
    milestones: input.terms.milestones.map((m) => newRuntime(m.key)),
    executedKeys: [],
    pendingApprovals: [],
    humanApprovals: [],
    changeOrders: [],
  };
}

/** Either side edits the draft; any edit clears signatures (both must sign the same text). */
function editTerms(deal: DealDoc, terms: DealTerms): DealDoc {
  if (deal.termsHash) throw new DealError('deal_locked', 'signed deals are locked; use a change order', 409);
  return { ...deal, terms: clone(terms), signatures: [], milestones: terms.milestones.map((m) => deal.milestones.find((x) => x.key === m.key) || newRuntime(m.key)) };
}

function sign(deal: DealDoc, party: 'client' | 'worker', userId: string, at: string): DealDoc {
  if (deal.termsHash) throw new DealError('deal_locked', 'deal already signed by both sides', 409);
  const problems = validateTerms(deal.terms);
  if (problems.length) throw new DealError('invalid_terms', 'fix the deal before signing', 422, problems);
  if (deal.terms[party].userId !== userId) throw new DealError('not_party', `only the ${party} can sign as ${party}`, 403);
  const h = hashOf(deal.terms);
  const signatures = [...deal.signatures.filter((s) => s.party !== party && s.termsHash === h), { party, userId, termsHash: h, at }];
  let next: DealDoc = { ...deal, signatures };
  if (signatures.some((s) => s.party === 'client') && signatures.some((s) => s.party === 'worker')) {
    next = { ...next, termsHash: h, lockedAt: at };
    for (const m of next.milestones) next = step(next, m.key, 'sign', 'system', at);
  }
  return next;
}

/* ------------------------------------------------------------ human events */

function actorRole(deal: DealDoc, userId: string): 'client' | 'worker' | null {
  if (deal.terms.client.userId === userId) return 'client';
  if (deal.terms.worker.userId === userId) return 'worker';
  return null;
}
function need(deal: DealDoc, userId: string, role: 'client' | 'worker') {
  if (actorRole(deal, userId) !== role) throw new DealError('forbidden', `only the ${role} can do this`, 403);
}

/** Client starts funding: creates the PayPal AUTHORIZE order and returns the approval link. */
async function startFunding(deps: EngineDeps, deal: DealDoc, key: string, userId: string): Promise<DealDoc> {
  need(deal, userId, 'client');
  const m = ms(deal, key);
  const t = termsOf(deal, key);
  if (m.state !== 'SIGNED') throw new DealError('invalid_transition', `cannot fund from ${m.state}`, 409);
  if (m.funding?.orderId && m.funding.status === 'CREATED') return deal; // reuse the open order
  const urls = deps.returnUrl(deal, key);
  const order = await traced(deps, 'paypal.create_order', { dealId: deal.id, milestone: key }, () =>
    deps.gateway.createAuthorizeOrder({
      amountMinor: t.amountMinor,
      currency: deal.terms.currency,
      referenceId: `${deal.id}:${key}`,
      customId: `${deal.id}:${key}`,
      description: `${deal.terms.title} - ${t.title}`,
      ...urls,
      requestId: `order:${deal.id}:${key}:${(m.funding?.orderId ? 'retry' : 'first')}`,
    }),
  );
  return put(deal, { ...m, funding: { orderId: order.orderId, approveUrl: order.approveUrl, status: 'CREATED' } });
}

function submitStyleSample(deal: DealDoc, key: string, userId: string, version: { id: string; sha256: string }, at: string): DealDoc {
  need(deal, userId, 'worker');
  if (!termsOf(deal, key).styleSample) throw new DealError('no_style_sample', 'this milestone has no style-sample checkpoint', 409);
  const d = step(deal, key, 'submit_style_sample', 'worker', at);
  const m = ms(d, key);
  return put(d, { ...m, versions: [...m.versions, { id: version.id, sha256: version.sha256, submittedAt: at }] });
}
function decideStyle(deal: DealDoc, key: string, userId: string, ok: boolean, at: string): DealDoc {
  need(deal, userId, 'client');
  const d = step(deal, key, ok ? 'approve_style' : 'redo_style', 'client', at);
  return put(d, { ...ms(d, key), styleApproved: ok });
}

function submitVersion(deal: DealDoc, key: string, userId: string, version: { id: string; sha256: string }, at: string): DealDoc {
  need(deal, userId, 'worker');
  const t = termsOf(deal, key);
  const m0 = ms(deal, key);
  if (t.styleSample && !m0.styleApproved) throw new DealError('style_sample_first', 'the client has to OK the style sample first', 409);
  if (m0.versions.some((v) => v.id === version.id)) throw new DealError('duplicate_version', 'this version was already submitted', 409);
  let d = step(deal, key, 'submit_version', 'worker', at);
  const m = ms(d, key);
  d = put(d, { ...m, firstSubmittedAt: m.firstSubmittedAt || at, versions: [...m.versions, { id: version.id, sha256: version.sha256, submittedAt: at }] });
  return step(d, key, 'start_checks', 'system', at);
}

function recordChecks(deal: DealDoc, key: string, versionId: string, report: { reportId: string; passed: boolean; failed: string[] }, at: string): DealDoc {
  const m0 = ms(deal, key);
  const latest = m0.versions[m0.versions.length - 1];
  if (!latest || latest.id !== versionId) throw new DealError('stale_version', 'checks are for an older version', 409);
  let d = put(deal, { ...m0, versions: m0.versions.map((v) => (v.id === versionId ? { ...v, checks: { ...report, at } } : v)) });
  d = step(d, key, 'checks_done', 'system', at);
  return put(d, { ...ms(d, key), reviewStartedAt: at });
}

/**
 * Client asks for changes. Every item is either a Fix that names an unmet
 * checklist line, or Taste. A Fix whose line actually passed, or a disputed
 * tag, counts as Taste. Taste costs a revision round (the client's budget),
 * never the worker's pay; past the included rounds a change order is needed.
 */
function requestChanges(deal: DealDoc, key: string, userId: string, items: ChangeItem[], at: string, opts: { changeOrderId?: string } = {}): DealDoc {
  need(deal, userId, 'client');
  if (!items.length) throw new DealError('empty_request', 'name at least one change', 422);
  const t = termsOf(deal, key);
  const m0 = ms(deal, key);
  const latest = m0.versions[m0.versions.length - 1];
  const failed = new Set(latest?.checks?.failed || []);
  const normalised: ChangeItem[] = items.map((it) => {
    if (it.tag === 'fix') {
      const line = t.checklist.find((c) => c.id === it.checklistId);
      if (!line) throw new DealError('fix_needs_checklist', `"${it.text}" is tagged Fix but cites no checklist line; cite one or tag it Taste`, 422);
      if (it.disputed || line.kind === 'taste' || (latest?.checks && !failed.has(line.id))) return { ...it, tag: 'taste' };
    }
    return it;
  });
  const tasteRound = normalised.some((i) => i.tag === 'taste');
  if (tasteRound && m0.revisionRoundsUsed >= t.revisionRoundsIncluded && !opts.changeOrderId) {
    throw new DealError('rounds_exhausted', `all ${t.revisionRoundsIncluded} included revision rounds are used; this Taste round needs a change order`, 409);
  }
  let d = step(deal, key, 'request_changes', 'client', at);
  const m = ms(d, key);
  d = put(d, {
    ...m,
    revisionRoundsUsed: m.revisionRoundsUsed + (tasteRound ? 1 : 0),
    tasteRoundsUsed: m.tasteRoundsUsed + (tasteRound ? 1 : 0),
    changeRequests: [...m.changeRequests, { at, versionId: latest?.id, items: normalised, tasteRound, changeOrderId: opts.changeOrderId }],
  });
  return d;
}

/** Client approves an exact version. `release` = the one human tap that also releases a big capture. */
function approve(deal: DealDoc, key: string, userId: string, versionId: string, at: string, release = false): DealDoc {
  need(deal, userId, 'client');
  const m0 = ms(deal, key);
  const latest = m0.versions[m0.versions.length - 1];
  if (!latest || latest.id !== versionId) throw new DealError('stale_version', 'you can only approve the latest submitted version', 409);
  if (!latest.checks) throw new DealError('checks_pending', 'checks have not finished for this version', 409);
  let d = step(deal, key, 'approve', 'client', at);
  d = put(d, { ...ms(d, key), approvedVersionId: versionId, approvedAt: at });
  if (release) d = { ...d, humanApprovals: [...new Set([...d.humanApprovals, `capture:${d.id}:${key}`])] };
  return d;
}

function kill(deal: DealDoc, key: string, userId: string, at: string): DealDoc {
  need(deal, userId, 'client');
  return step(deal, key, 'kill', 'client', at);
}

function openDispute(deal: DealDoc, key: string, userId: string, at: string): DealDoc {
  const role = actorRole(deal, userId);
  if (!role) throw new DealError('forbidden', 'only a party can open a dispute', 403);
  return step(deal, key, 'open_dispute', role, at);
}

/** Each side accepts a split (minor units owed to the worker). Equal numbers = agreement. */
function acceptSplit(deal: DealDoc, key: string, userId: string, workerMinor: number): DealDoc {
  const role = actorRole(deal, userId);
  if (!role) throw new DealError('forbidden', 'only a party can accept a split', 403);
  const m = ms(deal, key);
  if (m.state !== 'DISPUTED') throw new DealError('invalid_transition', 'no open dispute', 409);
  const t = termsOf(deal, key);
  if (!Number.isSafeInteger(workerMinor) || workerMinor < 0 || workerMinor > t.amountMinor) throw new DealError('invalid_split', 'split must be between 0 and the milestone amount', 422);
  return put(deal, { ...m, split: { ...(m.split || {}), [role]: workerMinor } });
}

function approveHuman(deal: DealDoc, key: string, userId: string): DealDoc {
  const p = deal.pendingApprovals.find((x) => x.key === key);
  if (!p) throw new DealError('not_pending', 'nothing waiting for approval with that key', 404);
  // refunds are approved by the worker side (money leaves them); everything else by the client.
  const who = p.action.kind === 'refund' ? 'worker' : 'client';
  need(deal, userId, who);
  return { ...deal, humanApprovals: [...new Set([...deal.humanApprovals, key])], pendingApprovals: deal.pendingApprovals.filter((x) => x.key !== key) };
}

/* --------------------------------------------------------- the Money Agent */

/** What the signed deal implies should happen to the money right now. */
function plan(deal: DealDoc, nowIso: string): { action: MoneyAction; why: string }[] {
  const out: { action: MoneyAction; why: string }[] = [];
  const now = Date.parse(nowIso);
  for (const m of deal.milestones) {
    const t = termsOf(deal, m.key);
    const f = m.funding;
    const live = f?.authorizationId && (f.status === 'AUTHORIZED' || f.status === 'PARTIALLY_CAPTURED');
    // keep the hold alive: reauthorize once the honor period has lapsed, while money still has to move
    if (live && f?.honorExpiresAt && now >= Date.parse(f.honorExpiresAt) && f.authorizedAt && now < Date.parse(f.authorizedAt) + 29 * DAY
        && ['FUNDED', 'STYLE_SAMPLE', 'SUBMITTED', 'CHECKS', 'IN_REVIEW', 'CHANGES_REQUESTED', 'DISPUTED'].includes(m.state)) {
      out.push({ action: { kind: 'reauthorize', milestoneKey: m.key }, why: 'honor period lapsed' });
    }
    if (m.state === 'IN_REVIEW' && m.reviewStartedAt && now >= Date.parse(m.reviewStartedAt) + t.reviewWindowHours * HOUR) {
      const latest = m.versions[m.versions.length - 1];
      if (latest?.checks?.passed) out.push({ action: { kind: 'capture', milestoneKey: m.key, amountMinor: Math.min(t.amountMinor, f?.authorizedMinor || 0) - m.capturedMinor, versionId: latest.id, final: true, reason: 'auto_approval' }, why: 'review window lapsed' });
    }
    if (m.state === 'APPROVED' || m.state === 'AUTO_APPROVED') {
      const v = m.state === 'APPROVED' ? m.approvedVersionId : m.versions[m.versions.length - 1]?.id;
      out.push({ action: { kind: 'capture', milestoneKey: m.key, amountMinor: Math.min(t.amountMinor, f?.authorizedMinor || 0) - m.capturedMinor, versionId: v || '', final: true, reason: m.state === 'APPROVED' ? 'approval' : 'auto_approval' }, why: 'approved' });
    }
    if (m.state === 'KILLED' && live) {
      const fee = percentOf(t.amountMinor, deal.terms.killFeeBp);
      if (fee > 0 && f?.status === 'AUTHORIZED') out.push({ action: { kind: 'partial_capture', milestoneKey: m.key, amountMinor: fee, reason: 'kill_fee' }, why: 'kill fee' });
      else out.push({ action: { kind: 'void', milestoneKey: m.key, reason: fee > 0 ? 'remainder_after_partial' : 'cancelled' }, why: 'release the rest' });
    }
    if (m.state === 'DISPUTED' && live && m.split && m.split.client !== undefined && m.split.client === m.split.worker) {
      const s = m.split.client;
      if (s > 0 && f?.status === 'AUTHORIZED') out.push({ action: { kind: 'partial_capture', milestoneKey: m.key, amountMinor: s, reason: 'dispute_split' }, why: 'split agreed' });
      else out.push({ action: { kind: 'void', milestoneKey: m.key, reason: s > 0 ? 'remainder_after_partial' : 'dispute_split' }, why: 'release the rest' });
    }
    if (m.state === 'CAPTURED') {
      for (const p of t.payees) {
        if (m.payouts.some((x) => x.email.toLowerCase() === p.email.toLowerCase())) continue;
        const amount = percentOf(m.capturedMinor, p.shareBp);
        if (amount > 0) out.push({ action: { kind: 'payout', milestoneKey: m.key, amountMinor: amount, email: p.email }, why: 'pay the editor' });
      }
    }
  }
  return out;
}

function ctxFor(deal: DealDoc, action: MoneyAction, deps: EngineDeps, extra: Partial<PolicyContext> = {}): PolicyContext {
  const m = deal.milestones.find((x) => x.key === action.milestoneKey);
  const split = m?.split && m.split.client !== undefined && m.split.client === m.split.worker ? m.split.client : undefined;
  return { actor: 'system', now: deps.now(), humanApprovals: deal.humanApprovals, agreedSplitMinor: split, ...extra };
}

/** Policy check, then the PayPal call, then the ledger line. Returns the updated deal. */
async function execute(deps: EngineDeps, deal0: DealDoc, action: MoneyAction, extra: Partial<PolicyContext> = {}): Promise<{ deal: DealDoc; result: ExecOutcome }> {
  let deal = deal0;
  const ctx = ctxFor(deal, action, deps, extra);
  const decision = evaluate(deal, action, ctx);
  const amount = (action as { amountMinor?: number }).amountMinor || 0;
  if (!decision.allowed && !decision.needsHumanApproval) {
    const entry = await writeLedger(deps, deal, { milestoneKey: action.milestoneKey, type: 'blocked', amountMinor: amount, moved: false, actor: ctx.actor, idempotencyKey: decision.idempotencyKey, explanation: explainBlocked(action, decision.violations), policy: { allowed: false, violations: decision.violations } });
    deal = { ...deal, lastBlocked: { ...(deal.lastBlocked || {}), [decision.idempotencyKey]: deps.now() } };
    return { deal, result: { outcome: 'blocked', entry, violations: decision.violations } };
  }
  if (decision.needsHumanApproval) {
    if (!deal.pendingApprovals.some((p) => p.key === decision.idempotencyKey)) {
      deal = { ...deal, pendingApprovals: [...deal.pendingApprovals, { key: decision.idempotencyKey, action, at: deps.now(), reason: action.kind === 'refund' ? 'every refund needs one human tap' : 'above the auto-release threshold' }] };
      const entry = await writeLedger(deps, deal, { milestoneKey: action.milestoneKey, type: 'pending_approval', amountMinor: amount, moved: false, actor: 'system', idempotencyKey: decision.idempotencyKey, explanation: `Waiting for one tap to ${action.kind.replace('_', ' ')} ${amount ? (require('./money.cts').format(amount, deal.terms.currency)) : ''}: ${action.kind === 'refund' ? 'every refund' : 'moves above the auto-release threshold'} need a person to confirm.`, policy: { allowed: true, violations: [] } });
      return { deal, result: { outcome: 'pending_approval', entry } };
    }
    const entry = (await deps.ledger.last(deal.id)) as LedgerEntry;
    return { deal, result: { outcome: 'pending_approval', entry } };
  }

  const key = decision.idempotencyKey;
  const m = ms(deal, action.milestoneKey);
  const t = termsOf(deal, action.milestoneKey);
  const cur = deal.terms.currency;
  const now = deps.now();
  let ref = '';
  let extraExplain: Record<string, unknown> = {};
  try {
    switch (action.kind) {
      case 'authorize': {
        if (!m.funding?.orderId) throw new DealError('no_order', 'start funding first', 409);
        const a = await traced(deps, 'paypal.authorize_order', { key }, () => deps.gateway.authorizeOrder(m.funding!.orderId!, key));
        const at = a.createdAt || now;
        deal = put(deal, { ...m, funding: { ...m.funding, authorizationId: a.authorizationId, authorizedMinor: a.amountMinor, authorizedAt: at, honorExpiresAt: new Date(Date.parse(at) + 3 * DAY).toISOString(), expiresAt: a.expiresAt || new Date(Date.parse(at) + 29 * DAY).toISOString(), status: 'AUTHORIZED' } });
        deal = step(deal, action.milestoneKey, 'fund', 'system', now);
        ref = a.authorizationId;
        extraExplain = { expiresAt: ms(deal, action.milestoneKey).funding?.expiresAt };
        break;
      }
      case 'reauthorize': {
        const a = await traced(deps, 'paypal.reauthorize', { key }, () => deps.gateway.reauthorize(m.funding!.authorizationId!, key));
        const f = m.funding!;
        deal = put(deal, { ...m, funding: { ...f, authorizationId: a.authorizationId, honorExpiresAt: new Date(Date.parse(now) + 3 * DAY).toISOString(), expiresAt: a.expiresAt || f.expiresAt, reauthorizations: [...(f.reauthorizations || []), { authorizationId: a.authorizationId, at: now }] } });
        ref = a.authorizationId;
        extraExplain = { expiresAt: a.expiresAt || f.expiresAt };
        break;
      }
      case 'capture':
      case 'partial_capture': {
        const final = action.kind === 'capture';
        const c = await traced(deps, `paypal.${action.kind}`, { key, amount: action.amountMinor }, () =>
          deps.gateway.capture(m.funding!.authorizationId!, { amountMinor: action.amountMinor, currency: cur, finalCapture: final, invoiceId: `${deal.id}-${action.milestoneKey}-${action.kind}`.slice(0, 127), requestId: key }),
        );
        const capturedMinor = m.capturedMinor + c.amountMinor;
        deal = put(deal, { ...m, capturedMinor, captures: [...m.captures, { id: c.captureId, amountMinor: c.amountMinor, versionId: action.kind === 'capture' ? action.versionId : undefined, reason: action.kind === 'capture' ? action.reason : action.reason, at: now }], funding: { ...m.funding!, status: final ? 'CAPTURED' : 'PARTIALLY_CAPTURED' } });
        if (final) deal = step(deal, action.milestoneKey, 'captured', 'system', now);
        ref = c.captureId;
        break;
      }
      case 'void': {
        await traced(deps, 'paypal.void', { key }, () => deps.gateway.voidAuthorization(m.funding!.authorizationId!, key));
        deal = put(deal, { ...m, funding: { ...m.funding!, status: 'VOIDED' } });
        const st = ms(deal, action.milestoneKey).state;
        if (action.reason === 'missed_deadline' && st !== 'CANCELLED') deal = step(deal, action.milestoneKey, 'deadline_void', 'client', now);
        else if (action.reason === 'remainder_after_partial' && st === 'KILLED') deal = step(deal, action.milestoneKey, 'captured', 'system', now);
        else if (action.reason === 'remainder_after_partial' && st === 'DISPUTED') deal = step(deal, action.milestoneKey, 'resolve_dispute_split', 'system', now);
        else if (action.reason === 'dispute_split' && st === 'DISPUTED') deal = step(deal, action.milestoneKey, 'resolve_dispute_void', 'system', now);
        else if (action.reason === 'cancelled' && st === 'KILLED') deal = step(deal, action.milestoneKey, 'closed_without_pay', 'system', now);
        else if (action.reason === 'mutual' && st !== 'CANCELLED') deal = step(deal, action.milestoneKey, 'mutual_cancel', 'system', now);
        ref = m.funding!.authorizationId!;
        break;
      }
      case 'refund': {
        const r = await traced(deps, 'paypal.refund', { key }, () => deps.gateway.refund(action.captureId, { amountMinor: action.amountMinor, currency: cur, requestId: key }));
        ref = r.id;
        break;
      }
      case 'payout': {
        const payee = t.payees.find((p) => p.email.toLowerCase() === action.email.toLowerCase());
        const r = await traced(deps, 'paypal.payout', { key, amount: action.amountMinor }, () =>
          deps.gateway.payout({ senderBatchId: key, emailSubject: `Payment for ${t.title}`, items: [{ email: action.email, amountMinor: action.amountMinor, currency: cur, note: `${deal.terms.title} - ${t.title}`, senderItemId: `${action.milestoneKey}-${(payee?.userId || 'payee').slice(0, 30)}` }] }),
        );
        const paidOutMinor = m.paidOutMinor + action.amountMinor;
        deal = put(deal, { ...m, paidOutMinor, payouts: [...m.payouts, { batchId: r.id, amountMinor: action.amountMinor, email: action.email, at: now, status: r.status }] });
        const sharesPaid = ms(deal, action.milestoneKey).payouts.length === t.payees.filter((p) => percentOf(m.capturedMinor, p.shareBp) > 0).length;
        if (sharesPaid) deal = step(deal, action.milestoneKey, 'paid_out', 'system', now);
        ref = r.id;
        extraExplain = { payeeName: payee?.displayName || action.email };
        break;
      }
      case 'invoice': {
        const item = deal.terms.rateCard.find((r) => r.id === action.rateCardItemId)!;
        const r = await traced(deps, 'paypal.create_invoice', { key }, () =>
          deps.gateway.createInvoiceDraft({ currency: cur, note: `Change order for ${deal.terms.title} - ${t.title}. Priced from the signed rate card.`, items: [{ name: item.label, description: item.unit, quantity: action.quantity, unitAmountMinor: item.unitPriceMinor }], requestId: key }),
        );
        deal = { ...deal, changeOrders: deal.changeOrders.map((co) => (co.id === ctx.changeOrderId ? { ...co, status: 'invoiced', invoiceId: r.id } : co)) };
        ref = r.id;
        extraExplain = { itemLabel: item.label };
        break;
      }
    }
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const entry = await writeLedger(deps, deal, { milestoneKey: action.milestoneKey, type: 'blocked', amountMinor: amount, moved: false, actor: 'system', idempotencyKey: key, explanation: `PayPal refused ${action.kind.replace('_', ' ')}: ${err.message || err.code}. No money moved.`, policy: { allowed: true, violations: [{ rule: `PAYPAL_${err.code || 'ERROR'}`, message: err.message || 'PayPal error' }] } });
    return { deal: { ...deal0, lastBlocked: { ...(deal0.lastBlocked || {}), [key]: deps.now() } }, result: { outcome: 'failed', entry, error: { code: err.code || 'PAYPAL_ERROR', message: err.message || '' } } };
  }
  deal = { ...deal, executedKeys: [...deal.executedKeys, key] };
  const moved = action.kind !== 'invoice';
  const entry = await writeLedger(deps, deal, { milestoneKey: action.milestoneKey, type: action.kind, amountMinor: action.kind === 'void' || action.kind === 'reauthorize' ? 0 : amount, moved, actor: 'system', paypalRef: ref, idempotencyKey: key, explanation: explain(deal, action, extraExplain), policy: { allowed: true, violations: [] } });
  return { deal, result: { outcome: 'done', entry } };
}

/** One Money Agent pass: auto-approve lapsed reviews, then run every planned move through policy. */
async function tick(deps: EngineDeps, deal0: DealDoc): Promise<{ deal: DealDoc; results: ExecOutcome[] }> {
  let deal = deal0;
  const now = deps.now();
  const results: ExecOutcome[] = [];
  // silence past the review window = approval, but only for a version that passed every check
  for (const m of deal.milestones) {
    const t = termsOf(deal, m.key);
    const latest = m.versions[m.versions.length - 1];
    if (m.state === 'IN_REVIEW' && m.reviewStartedAt && Date.parse(now) >= Date.parse(m.reviewStartedAt) + t.reviewWindowHours * HOUR && latest?.checks?.passed) {
      deal = step(deal, m.key, 'review_window_lapsed', 'system', now);
      results.push({ outcome: 'done', entry: await writeLedger(deps, deal, { milestoneKey: m.key, type: 'state', amountMinor: 0, moved: false, actor: 'system', explanation: `The ${t.reviewWindowHours}-hour review window for "${t.title}" passed with no response, and version ${latest.id} passed every check, so it counts as approved.` }) });
    }
  }
  // up to a few rounds so chained moves (partial capture -> void -> payout) settle in one tick
  for (let round = 0; round < 4; round += 1) {
    const recentlyBlocked = (a: MoneyAction) => {
      const k = idempotencyKey(deal, a, deal.milestones.find((x) => x.key === a.milestoneKey));
      const at = deal.lastBlocked?.[k];
      return !!at && Date.parse(now) - Date.parse(at) < RETRY_BLOCKED_MS;
    };
    const planned = plan(deal, now).filter(
      (p) => !deal.pendingApprovals.some((x) => x.action.kind === p.action.kind && x.action.milestoneKey === p.action.milestoneKey) && !recentlyBlocked(p.action),
    );
    if (!planned.length) break;
    let progressed = false;
    for (const p of planned) {
      const r = await execute(deps, deal, p.action);
      deal = r.deal;
      results.push(r.result);
      if (r.result.outcome === 'done') progressed = true;
    }
    if (!progressed) break;
  }
  return { deal, results };
}

/** Client-chosen void after a missed deadline (+ grace). */
async function voidMissedDeadline(deps: EngineDeps, deal: DealDoc, key: string, userId: string) {
  need(deal, userId, 'client');
  return execute(deps, deal, { kind: 'void', milestoneKey: key, reason: 'missed_deadline' });
}

async function confirmFunding(deps: EngineDeps, deal: DealDoc, key: string, userId?: string) {
  if (userId) need(deal, userId, 'client');
  return execute(deps, deal, { kind: 'authorize', milestoneKey: key, amountMinor: termsOf(deal, key).amountMinor });
}

module.exports = {
  DealError,
  createDeal,
  editTerms,
  sign,
  startFunding,
  confirmFunding,
  submitStyleSample,
  decideStyle,
  submitVersion,
  recordChecks,
  requestChanges,
  approve,
  kill,
  openDispute,
  acceptSplit,
  approveHuman,
  voidMissedDeadline,
  plan,
  execute,
  tick,
  actorRole,
};
