/**
 * Agent proposals meet the signed deal here (pure, no I/O).
 *
 *   checkReport(deal, key, body)       validate a Video QA report and recompute pass/fail from its results
 *   draftChangeOrder(deal, input, ...) a change order priced from the signed rate card (never by the caller)
 *   decideChangeOrder(deal, id, ...)   the client accepts or declines it (one human tap)
 *   dryRun(deal, proposal, ...)        what policy.evaluate (or the engine) would say, without changing anything
 *   storeReview(deal, key, body, ...)  Review Agent output, dry-run, kept on the milestone for the UI
 *   storeDispute(deal, key, body, ...) Scope & Dispute evidence pack + a split computed HERE from the checklist
 *
 * The Python agents only propose. Every proposal is dry-run here before a person
 * sees it, and the routes that act on it run the same checks again.
 */
import type { DealDoc, MoneyAction, ChangeItem, ChangeOrder, CheckResultRecord, PolicyDecision, ReviewProposal, DisputeProposal, MilestoneRuntime } from './types.cts';

const { evaluate } = require('./policy.cts');
const { DealError } = require('./engine.cts');
const engine = require('./engine.cts');
const { percentOf } = require('./money.cts');

const MAX_RESULTS = 100;
const MAX_EVIDENCE = 10;
const MAX_OPEN_CHANGE_ORDERS = 10;

function bad(code: string, message: string, status = 422, details?: unknown) {
  return new DealError(code, message, status, details);
}
const isStr = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/* ------------------------------------------------------------ check reports */

export type CheckReportInput = {
  versionId: string;
  sha256: string;
  results: unknown[];
  passed?: boolean;
  failed?: string[];
  notes?: Record<string, unknown>;
};

/**
 * Turn an agent's report into the stored record. Pass/fail is recomputed from the
 * per-line results: every measurable check line of the milestone must have a
 * result that passed. A line the agent did not measure counts as failed
 * ("unmeasured"), so silence can never auto-approve an unchecked file. Every
 * result must carry evidence (a timestamped note, usually with a screenshot).
 * A report whose own summary disagrees with its results is refused.
 */
function checkReport(deal: DealDoc, key: string, body: CheckReportInput) {
  const terms = deal.terms.milestones.find((m) => m.key === key);
  const m = deal.milestones.find((x) => x.key === key);
  if (!terms || !m) throw bad('milestone_not_found', `milestone ${key} is not in this deal`, 404);
  if (!body || typeof body !== 'object') throw bad('invalid_report', 'report body required');
  if (!isStr(body.versionId, 100) || !isStr(body.sha256, 64)) throw bad('invalid_report', 'versionId and sha256 are required');
  const latest = m.versions[m.versions.length - 1];
  if (!latest || latest.id !== body.versionId) throw bad('stale_version', 'checks are for an older version', 409);
  if (latest.sha256 !== body.sha256) throw bad('version_mismatch', 'the checked file is not the submitted file (sha256 differs)', 409);
  if (latest.checks) throw bad('checks_recorded', 'checks for this version are already recorded', 409);
  if (!Array.isArray(body.results) || body.results.length > MAX_RESULTS) throw bad('invalid_report', `results must be a list of at most ${MAX_RESULTS}`);

  const lines = new Map(terms.checklist.map((c) => [c.id, c]));
  const results: CheckResultRecord[] = [];
  const seen = new Set<string>();
  for (const raw of body.results as any[]) {
    const id = raw?.checklist_id ?? raw?.checklistId;
    if (!isStr(id, 100)) throw bad('invalid_report', 'each result needs a checklist_id');
    const line = lines.get(id);
    if (!line) throw bad('unknown_checklist_line', `result for ${id}, which is not a line of the signed checklist`);
    if (line.kind !== 'check') throw bad('taste_not_checkable', `${id} is a Taste line; machines do not judge taste`);
    if (seen.has(id)) throw bad('invalid_report', `two results for ${id}`);
    seen.add(id);
    const ev = Array.isArray(raw.evidence) ? raw.evidence : [];
    if (!ev.length) throw bad('evidence_required', `result for ${id} has no evidence`);
    const evidence = ev.slice(0, MAX_EVIDENCE).map((e: any) => {
      const tStart = num(e?.t_start ?? e?.tStart);
      const tEnd = num(e?.t_end ?? e?.tEnd);
      if (tStart === undefined || tEnd === undefined || tStart < 0 || tEnd < tStart || !isStr(e?.note, 500))
        throw bad('evidence_required', `evidence for ${id} needs t_start <= t_end and a note`);
      const shot = e?.screenshot;
      return { tStart, tEnd, note: e.note, ...(isStr(shot, 500) ? { screenshot: shot } : {}) };
    });
    const status = raw.status === 'not_measurable' ? 'not_measurable' : 'ok';
    const measured = ['number', 'string', 'boolean'].includes(typeof raw.measured) ? raw.measured : null;
    results.push({
      checklistId: id,
      metric: typeof raw.metric === 'string' ? raw.metric.slice(0, 50) : line.measure?.metric || '',
      measured,
      passed: raw.passed === true && status === 'ok',
      status,
      evidence,
    });
  }
  const measurable = terms.checklist.filter((c) => c.kind === 'check' && c.measure);
  const unmeasured = measurable.filter((c) => !seen.has(c.id)).map((c) => c.id);
  const failed = [...results.filter((r) => !r.passed).map((r) => r.checklistId), ...unmeasured];
  const passed = failed.length === 0;
  if (body.passed !== undefined && body.passed !== passed)
    throw bad('inconsistent_report', `report says passed=${body.passed} but its results say ${passed}`, 422, { failed });
  if (Array.isArray(body.failed) && [...body.failed].sort().join() !== results.filter((r) => !r.passed).map((r) => r.checklistId).sort().join())
    throw bad('inconsistent_report', 'the failed list does not match the results', 422, { failed });
  const notes: Record<string, string> = {};
  for (const [k, v] of Object.entries(body.notes || {})) if (failed.includes(k) && typeof v === 'string') notes[k] = v.slice(0, 300);
  return { passed, failed, unmeasured, results, notes };
}

/* ------------------------------------------------------------ change orders */

export type ChangeOrderInput = {
  milestoneKey: string;
  rateCardItemId: string;
  quantity: number;
  /** Optional: if the proposer states a price it must equal the rate-card arithmetic. */
  amountMinor?: number;
  ask: string;
  by: 'agent' | 'client' | 'worker';
};

function invoiceAction(co: { milestoneKey: string; rateCardItemId: string; quantity: number; amountMinor: number }): MoneyAction {
  return { kind: 'invoice', milestoneKey: co.milestoneKey, rateCardItemId: co.rateCardItemId, quantity: co.quantity, amountMinor: co.amountMinor };
}

function draftChangeOrder(deal: DealDoc, input: ChangeOrderInput, id: string, at: string): { deal: DealDoc; changeOrder: ChangeOrder; decision: PolicyDecision } {
  if (!isStr(input?.milestoneKey, 100) || !isStr(input?.rateCardItemId, 100)) throw bad('invalid_input', 'milestoneKey and rateCardItemId are required');
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 100) throw bad('invalid_input', 'quantity must be a whole number from 1 to 100');
  if (!isStr(input.ask, 2000)) throw bad('invalid_input', 'ask (what the client wants) is required');
  const item = deal.terms.rateCard.find((r) => r.id === input.rateCardItemId);
  // the price is always the signed unit price times the quantity; a caller cannot set it
  const amountMinor = item ? item.unitPriceMinor * input.quantity : 0;
  const decision: PolicyDecision = evaluate(deal, invoiceAction({ ...input, amountMinor: input.amountMinor ?? amountMinor }), {
    actor: 'system',
    now: at,
    changeOrderId: id,
  });
  if (!decision.allowed) throw bad('change_order_blocked', decision.violations.map((v) => v.message).join('; '), 422, decision.violations);
  const open = deal.changeOrders.filter((c) => c.milestoneKey === input.milestoneKey && c.status === 'draft').length;
  if (open >= MAX_OPEN_CHANGE_ORDERS) throw bad('too_many_drafts', 'too many open change orders on this milestone; settle some first', 409);
  const changeOrder: ChangeOrder = {
    id,
    milestoneKey: input.milestoneKey,
    rateCardItemId: input.rateCardItemId,
    quantity: input.quantity,
    amountMinor,
    reason: input.ask.trim(),
    status: 'draft',
    by: input.by,
    at,
  };
  return { deal: { ...deal, changeOrders: [...deal.changeOrders, changeOrder] }, changeOrder, decision };
}

/** The client (who pays) accepts or declines a drafted change order. */
function decideChangeOrder(deal: DealDoc, id: string, userId: string, accept: boolean, at: string): DealDoc {
  if (engine.actorRole(deal, userId) !== 'client') throw bad('forbidden', 'only the client can accept or decline a change order', 403);
  const co = deal.changeOrders.find((c) => c.id === id);
  if (!co) throw bad('change_order_not_found', 'change order not found', 404);
  if (co.status !== 'draft') throw bad('change_order_decided', `this change order is already ${co.status}`, 409);
  return { ...deal, changeOrders: deal.changeOrders.map((c) => (c.id === id ? { ...c, status: accept ? 'accepted' : 'declined', decidedAt: at, decidedBy: userId } : c)) };
}

/* ------------------------------------------------------------------ dry run */

const KINDS = ['authorize', 'reauthorize', 'capture', 'partial_capture', 'void', 'refund', 'payout', 'invoice'];

function moneyActionShape(a: any): MoneyAction {
  if (!a || typeof a !== 'object' || !KINDS.includes(a.kind) || !isStr(a.milestoneKey, 100)) throw bad('invalid_action', 'action needs a known kind and a milestoneKey');
  for (const k of ['amountMinor', 'quantity']) if (a[k] !== undefined && typeof a[k] !== 'number') throw bad('invalid_action', `${k} must be a number`);
  const out: Record<string, unknown> = {};
  for (const k of ['kind', 'milestoneKey', 'amountMinor', 'versionId', 'final', 'reason', 'captureId', 'email', 'rateCardItemId', 'quantity', 'currency', 'step'])
    if (a[k] !== undefined) out[k] = a[k];
  if (a.items !== undefined) {
    if (!Array.isArray(a.items) || a.items.length > 20) throw bad('invalid_action', 'items must be a list of at most 20 payees');
    out.items = a.items.map((i: any) => ({ userId: String(i?.userId || ''), email: String(i?.email || ''), amountMinor: typeof i?.amountMinor === 'number' ? i.amountMinor : NaN }));
  }
  return out as MoneyAction;
}

export type DryRunInput =
  | { kind: 'money'; action: unknown; changeOrderId?: string }
  | { kind: 'request_changes'; milestoneKey: string; items: unknown[]; changeOrderId?: string };

/**
 * Evaluate a proposal against the deal as it is now. Nothing is saved.
 *
 * money: policy.evaluate as the Money Agent would run it. Two things a proposal
 *   cannot have yet are assumed and reported in `assumed`: a dispute split is
 *   evaluated as if both sides accepted exactly the proposed number, and an
 *   invoice gets a placeholder change-order id.
 * request_changes: the engine's own rules (Fix must cite a line, a Fix on a line
 *   that passed becomes Taste, rounds left) run on a copy of the deal.
 */
function dryRun(deal: DealDoc, input: DryRunInput, now: string) {
  if (input?.kind === 'request_changes') {
    const m = deal.milestones.find((x) => x.key === input.milestoneKey);
    if (!m) return { allowed: false, violations: [{ rule: 'P12_milestone', message: `milestone ${input.milestoneKey} is not in the signed deal` }] };
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) throw bad('invalid_input', 'items must be a non-empty list');
    const items: ChangeItem[] = input.items.map((i: any) => ({
      text: String(i?.text || '').slice(0, 2000),
      tag: i?.tag === 'fix' ? 'fix' : 'taste',
      checklistId: typeof i?.checklistId === 'string' ? i.checklistId : undefined,
      disputed: i?.disputed === true,
    }));
    try {
      const after: DealDoc = engine.requestChanges(deal, input.milestoneKey, deal.terms.client.userId, items, now, { changeOrderId: input.changeOrderId });
      const ma = after.milestones.find((x) => x.key === input.milestoneKey)!;
      const t = deal.terms.milestones.find((x) => x.key === input.milestoneKey)!;
      const req = ma.changeRequests[ma.changeRequests.length - 1];
      return {
        allowed: true,
        violations: [],
        items: req.items,
        downgraded: req.items.filter((x, i) => x.tag !== items[i].tag).map((x) => x.text),
        costsRevisionRound: req.tasteRound,
        roundsLeftAfter: Math.max(0, t.revisionRoundsIncluded - ma.revisionRoundsUsed),
      };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { allowed: false, violations: [{ rule: err.code || 'engine', message: err.message || 'refused' }] };
    }
  }
  if (input?.kind !== 'money') throw bad('invalid_input', "kind must be 'money' or 'request_changes'");
  const action = moneyActionShape(input.action);
  const assumed: string[] = [];
  const m = deal.milestones.find((x) => x.key === action.milestoneKey);
  let agreedSplitMinor: number | undefined;
  if (m?.split && m.split.client !== undefined && m.split.client === m.split.worker) agreedSplitMinor = m.split.client;
  if (action.kind === 'partial_capture' && action.reason === 'dispute_split' && agreedSplitMinor === undefined) {
    agreedSplitMinor = action.amountMinor;
    assumed.push('both sides accept this split');
  }
  let changeOrderId = input.changeOrderId;
  if (action.kind === 'invoice' && !changeOrderId) {
    changeOrderId = 'dry-run';
    assumed.push('a change order is drafted for it');
  }
  const decision: PolicyDecision = evaluate(deal, action, { actor: 'system', now, humanApprovals: deal.humanApprovals, agreedSplitMinor, changeOrderId });
  return { ...decision, action, assumed };
}

/* -------------------------------------------------- stored agent proposals */

const MAX_ITEMS = 50;
/** Any key that looks like money. Agents propose words and checklist ids; amounts come from the deal. */
const AMOUNT_KEY = /(minor|amount|price|split|share|fee|bp|usd|inr)$/i;

function refuseAmounts(v: unknown, path = 'body', depth = 0): void {
  if (depth > 6 || !v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (AMOUNT_KEY.test(k)) throw bad('ai_amount_refused', `${path}.${k}: agents do not supply amounts; they come from the signed deal`, 422);
    refuseAmounts(x, `${path}.${k}`, depth + 1);
  }
}

function latestVersionFor(deal: DealDoc, key: string, versionId: unknown) {
  const m = deal.milestones.find((x) => x.key === key);
  const t = deal.terms.milestones.find((x) => x.key === key);
  if (!m || !t) throw bad('milestone_not_found', `milestone ${key} is not in this deal`, 404);
  const latest = m.versions[m.versions.length - 1];
  if (versionId !== undefined && (!latest || versionId !== latest.id)) throw bad('stale_version', 'the proposal is for an older version', 409);
  return { m, t, latest };
}

function withProposal(deal: DealDoc, m: MilestoneRuntime, kind: 'review' | 'dispute', p: ReviewProposal | DisputeProposal): DealDoc {
  const next = { ...m, proposals: { ...(m.proposals || {}), [kind]: p } };
  return { ...deal, milestones: deal.milestones.map((x) => (x.key === m.key ? next : x)) };
}

/**
 * Review Agent output -> stored proposal. The items are dry-run exactly as the
 * client's "Send changes" would run them, so what is stored is what the engine
 * would do (a Fix that cites a passing line already shows as Taste). A blocked
 * dry-run is stored too, with its violations, so the UI can say why.
 */
function storeReview(deal: DealDoc, key: string, body: any, id: string, at: string): { deal: DealDoc; proposal: ReviewProposal } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('invalid_input', 'proposal body required');
  refuseAmounts(body);
  const { m, latest } = latestVersionFor(deal, key, body.versionId);
  if (!latest) throw bad('no_version', 'nothing has been submitted on this milestone yet', 409);
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_ITEMS) throw bad('invalid_input', `items must be a list of 1 to ${MAX_ITEMS}`);
  const items: ChangeItem[] = body.items.map((i: any) => {
    if (!isStr(i?.text, 2000)) throw bad('invalid_input', 'each item needs text');
    return {
      text: i.text.trim(),
      tag: i.tag === 'fix' ? 'fix' : 'taste',
      ...(isStr(i.checklistId, 100) ? { checklistId: i.checklistId } : {}),
      disputed: i.disputed === true,
    };
  });
  const raw = Array.isArray(body.contradictions) ? body.contradictions.slice(0, MAX_ITEMS) : [];
  const contradictions = raw
    .filter((c: any) => Number.isSafeInteger(c?.a) && Number.isSafeInteger(c?.b) && c.a >= 0 && c.b >= 0 && c.a < items.length && c.b < items.length)
    .map((c: any) => ({ a: c.a, b: c.b, why: typeof c.why === 'string' ? c.why.slice(0, 200) : '' }));
  const r: any = dryRun(deal, { kind: 'request_changes', milestoneKey: key, items }, at);
  const proposal: ReviewProposal = {
    id,
    agent: 'review',
    at,
    versionId: latest.id,
    items: r.allowed ? r.items : items,
    downgraded: r.allowed ? r.downgraded : [],
    contradictions,
    ...(r.allowed ? { costsRevisionRound: r.costsRevisionRound, roundsLeftAfter: r.roundsLeftAfter } : {}),
    ...(isStr(body.rationale, 300) ? { rationale: body.rationale } : {}),
    decision: { allowed: !!r.allowed, violations: r.violations || [] },
  };
  return { deal: withProposal(deal, m, 'review', proposal), proposal };
}

/**
 * Scope & Dispute Agent output -> stored proposal. The agent may send a note;
 * everything else is built here from the deal: the evidence pack from the stored
 * checks, and the split from checklist arithmetic (passed / total signed check
 * lines x the milestone amount, never above what is still held). The split is
 * dry-run as the partial capture the Money Agent would run if both sides accept it.
 */
function storeDispute(deal: DealDoc, key: string, body: any, id: string, at: string): { deal: DealDoc; proposal: DisputeProposal } {
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body))) throw bad('invalid_input', 'proposal body must be an object');
  const b = body || {};
  refuseAmounts(b);
  const { m, t, latest } = latestVersionFor(deal, key, b.versionId);
  const lines = t.checklist.filter((c) => c.kind === 'check' && c.measure);
  const checked = [...m.versions].reverse().find((v) => v.checks?.results);
  const byId = new Map((checked?.checks?.results || []).map((r) => [r.checklistId, r]));
  const checks = lines.map((c) => {
    const r = byId.get(c.id);
    return { id: c.id, text: c.text, passed: r ? r.passed : null, ...(r ? { measured: r.measured } : {}), evidence: r ? r.evidence : [] };
  });
  const passedChecks = checks.filter((c) => c.passed === true).length;
  const totalChecks = lines.length;
  const shareBp = totalChecks ? Math.floor((passedChecks * 10000) / totalChecks) : 0;
  const remainingMinor = Math.max(0, t.amountMinor - m.capturedMinor);
  const workerMinor = Math.max(0, Math.min(percentOf(t.amountMinor, shareBp), remainingMinor));
  const action = workerMinor > 0
    ? { kind: 'partial_capture', milestoneKey: key, amountMinor: workerMinor, reason: 'dispute_split' }
    : { kind: 'void', milestoneKey: key, reason: 'dispute_split' };
  const r: any = dryRun(deal, { kind: 'money', action }, at);
  const proposal: DisputeProposal = {
    id,
    agent: 'scope_dispute',
    at,
    ...(latest ? { versionId: latest.id } : {}),
    basis: { passedChecks, totalChecks, shareBp, amountMinor: t.amountMinor, remainingMinor },
    workerMinor,
    clientMinor: remainingMinor - workerMinor,
    evidence: {
      checks,
      unmeasured: lines.filter((c) => !byId.has(c.id)).map((c) => c.id),
      tasteLines: t.checklist.filter((c) => c.kind === 'taste').map((c) => c.text),
      rounds: { included: t.revisionRoundsIncluded, used: m.revisionRoundsUsed, tasteRounds: m.tasteRoundsUsed },
      changeRequests: m.changeRequests.map(({ at: a, versionId, items, tasteRound }) => ({ at: a, versionId, items, tasteRound })),
      versions: m.versions.length,
    },
    ...(isStr(b.notes, 1000) ? { notes: b.notes } : {}),
    decision: { allowed: !!r.allowed, violations: r.violations || [], needsHumanApproval: !!r.needsHumanApproval, assumed: r.assumed || [] },
  };
  return { deal: withProposal(deal, m, 'dispute', proposal), proposal };
}

module.exports = { checkReport, draftChangeOrder, decideChangeOrder, dryRun, invoiceAction, storeReview, storeDispute, refuseAmounts };
