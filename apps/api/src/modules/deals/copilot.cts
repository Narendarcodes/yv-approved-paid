/**
 * deals/copilot: the live LLM path for the web deal copilot, with an honest
 * offline fallback.
 *
 * AI checks facts, people own taste, the deal decides the money.
 *
 * Node builds an identity-free view of ONE deal (keys, titles, states, counts,
 * change-order ids; no names, emails, countries, PayPal ids or amounts) and
 * asks the lean deal agent (services/agent, app/deals_service.py) which cards
 * answer the question. The agent can only name whitelisted card actions and ids
 * from that view; this module re-checks both before anything reaches the web.
 * No amount ever comes from the model: the web uses the signed amount (or the
 * number the person typed) and runs proposals as a policy DRY RUN.
 *
 * Calls go through the agent router: AGENT_URL (Render) first, AGENT_FALLBACK_URL (Azure)
 * on failure or when the Render hour budget is spent.
 *
 * Enabled when AGENT_ENABLED=true (config.agent.enabled) and AGENT_URL +
 * AGENT_SHARED_SECRET are set. Disabled, unreachable, slow (AGENT_COPILOT_TIMEOUT_MS),
 * or a bad answer -> { source: 'offline', reason } and the web serves its
 * deterministic replay. This route never fails the page.
 */
import type { DealDoc } from './lib/types.cts';

const COPILOT_ACTIONS = [
  'showDeal',
  'showChecks',
  'showReviewMerge',
  'showMoneyTimeline',
  'showChangeOrder',
  'showDisputeSplit',
  'showBlocked',
  'proposeCapture',
  'help',
] as const;
const NEEDS_KEY = new Set(['showChecks', 'showReviewMerge', 'showDisputeSplit', 'proposeCapture']);

type CopilotAction = { name: string; milestoneKey?: string; changeOrderId?: string };
type CopilotReply =
  | {
      source: 'live';
      actions: CopilotAction[];
      note: string | null;
      provider: string | null;
      model: string | null;
      cached: boolean;
      ms: number;
      agent?: string;
    }
  | {
      source: 'offline';
      reason:
        | 'agent_disabled'
        | 'rate_limited'
        | 'agent_unreachable'
        | 'agent_timeout'
        | 'agent_error'
        | 'agent_no_answer';
    };

type CopilotConfig = { enabled: boolean; url: string; secret: string; timeoutMs: number };

/** What the model sees: ids and states only. No people, no money. */
function redactedView(deal: DealDoc, myRole: string | null) {
  return {
    id: deal.id,
    title: deal.terms.title,
    myRole,
    signedByBoth: (deal.signatures || []).length >= 2,
    milestones: deal.terms.milestones.map((t) => {
      const r = deal.milestones.find((m) => m.key === t.key);
      return {
        key: t.key,
        title: t.title,
        state: r?.state ?? 'DRAFT',
        versions: r?.versions?.length ?? 0,
        hasReviewProposal: !!r?.proposals?.review,
        hasDisputeProposal: !!r?.proposals?.dispute,
      };
    }),
    changeOrders: (deal.changeOrders || []).map((c) => ({
      id: c.id,
      milestoneKey: c.milestoneKey,
      status: c.status,
    })),
    pendingApprovals: (deal.pendingApprovals || []).length,
  };
}

/** Names the agent must strip from the question before any LLM sees it. */
function identities(deal: DealDoc): string[] {
  const out = new Set<string>();
  for (const p of [deal.terms.client, deal.terms.worker])
    if (p?.displayName) out.add(p.displayName);
  for (const m of deal.terms.milestones)
    for (const p of m.payees || []) if (p.displayName) out.add(p.displayName);
  return [...out].slice(0, 20);
}

/** Second gate (the agent already filtered): whitelisted names, ids from this deal, no other fields. */
function sanitizeActions(raw: unknown, deal: DealDoc): CopilotAction[] {
  if (!Array.isArray(raw)) return [];
  const keys = new Set(deal.terms.milestones.map((m) => m.key));
  const cos = new Set((deal.changeOrders || []).map((c) => c.id));
  const out: CopilotAction[] = [];
  for (const a of raw.slice(0, 6)) {
    if (!a || typeof a !== 'object') continue;
    const name = (a as any).name;
    if (!(COPILOT_ACTIONS as readonly string[]).includes(name)) continue;
    const mk =
      typeof (a as any).milestoneKey === 'string' && keys.has((a as any).milestoneKey)
        ? (a as any).milestoneKey
        : undefined;
    if (NEEDS_KEY.has(name) && !mk) continue;
    if (name === 'showChangeOrder') {
      const co = (a as any).changeOrderId;
      if (typeof co !== 'string' || !cos.has(co)) continue;
      out.push({ name, changeOrderId: co });
    } else if (NEEDS_KEY.has(name) || (name === 'showMoneyTimeline' && mk)) {
      out.push({ name, milestoneKey: mk });
    } else out.push({ name });
    if (out.length >= 3) break;
  }
  return out;
}

const MONEY =
  /[$₹€£]|\b(usd|inr|eur|gbp|rs\.?|rupees?|dollars?|cents?|paise)\b|\d[\d,]*\.\d{2}\b|\b\d{3,}\b/i;

type FetchLike = (
  url: string,
  init: any,
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

type AgentRouter = {
  fetch: (
    path: string,
    init: any,
    opts: { attemptTimeoutMs: number },
  ) => Promise<{ res: { ok: boolean; status: number; json: () => Promise<any> }; agent: string }>;
};

/** No shared router (tests, scripts): primary then optional fallback, no cached state. */
function directRouter(
  cfg: CopilotConfig & { fallbackUrl?: string },
  fetchImpl: FetchLike,
): AgentRouter {
  const { makeAgentRouter } = require('../../agent/routing');
  return makeAgentRouter({
    getTargets: () => ({ primary: cfg.url, fallback: cfg.fallbackUrl || '' }),
    fetchImpl,
  });
}

async function askCopilot(
  cfg: CopilotConfig & { fallbackUrl?: string; router?: AgentRouter },
  deal: DealDoc,
  myRole: string | null,
  question: string,
  fetchImpl: FetchLike = (globalThis as any).fetch,
): Promise<CopilotReply> {
  if (!cfg.enabled || !cfg.url || !cfg.secret)
    return { source: 'offline', reason: 'agent_disabled' };
  const t0 = Date.now();
  // AGENT_URL first; a network error, a timeout or a 502/503/504 retries once on
  // AGENT_FALLBACK_URL (src/agent/routing.js). Each attempt gets cfg.timeoutMs.
  const router = cfg.router || directRouter(cfg, fetchImpl);
  try {
    const { res: r, agent } = await router.fetch(
      '/v1/deals/copilot',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-secret': cfg.secret },
        body: JSON.stringify({
          question: question.slice(0, 500),
          deal: redactedView(deal, myRole),
          redact: identities(deal),
        }),
      },
      { attemptTimeoutMs: cfg.timeoutMs },
    );
    if (r.status === 503) return { source: 'offline', reason: 'agent_no_answer' };
    if (!r.ok) return { source: 'offline', reason: 'agent_error' };
    const body = await r.json();
    const actions = sanitizeActions(body?.actions, deal);
    if (!actions.length) return { source: 'offline', reason: 'agent_no_answer' };
    const note =
      typeof body?.note === 'string' && body.note.trim() && !MONEY.test(body.note)
        ? body.note.trim().slice(0, 200)
        : null;
    return {
      source: 'live',
      actions,
      note,
      provider: typeof body?.provider === 'string' ? body.provider : null,
      model: typeof body?.model === 'string' ? body.model : null,
      cached: body?.cached === true,
      ms: Date.now() - t0,
      agent,
    };
  } catch (e: any) {
    return { source: 'offline', reason: e && e.timedOut ? 'agent_timeout' : 'agent_unreachable' };
  }
}

module.exports = { COPILOT_ACTIONS, redactedView, identities, sanitizeActions, askCopilot };
