/**
 * The Fair Review Clock as it lives on a deal: the bridge between the pure
 * clock maths (clock.cts) and the deal documents the engine works on. Pure:
 * no database, no PayPal; every function takes and returns plain objects.
 *
 *   clockTermsOf(terms, milestoneTerms)  effective clock terms (country + tz from the brand) or null
 *   clockProblems(terms)                 validation lines for validateTerms (empty = fine)
 *   onChecks(m, t, terms, passed, at)    start the clock on the first passing checks, resume a paused one
 *   pauseForChanges(m, at, by)           a change request: pause + count the round
 *   endClock(m, status, at, id, by)      approve / dispute / kill stop it for good
 *   shiftOf(clock, now)                  total paused time (finished + current)
 *   dueFor(clock, now)                   step ids due now (running clocks only)
 *   viewOf(deal, key, now)               what GET .../clock returns
 */
import type { DealDoc, DealTerms, MilestoneTerms, MilestoneRuntime, ClockRuntime, ClockEvent } from './types.cts';
import type { ClockTerms } from './clock.cts';

const { normalizeTerms, buildSchedule, clockState, dueSteps, fmtWhen } = require('./clock.cts');

const STEP_IDS = ['remind_50', 'remind_80', 'final_24h', 'release_partial', 'release_grace'];
const LIVE: ClockRuntime['status'][] = ['running', 'paused'];

function defaultTz(country: string): string {
  return country === 'US' ? 'America/New_York' : 'Asia/Kolkata';
}

/** The brand's country as the clock knows it (IN or US); anything else is passed through so normalizeTerms rejects it. */
function brandCountry(terms: DealTerms): unknown {
  const c = terms?.client?.country;
  return c === undefined || c === null || c === '' ? 'IN' : String(c).toUpperCase();
}

/** Effective clock terms for a milestone, or null when it has no clock. Throws on invalid terms. */
function clockTermsOf(terms: DealTerms, t: MilestoneTerms | undefined): ClockTerms | null {
  if (!t || !t.clock || typeof t.clock !== 'object') return null;
  const country = brandCountry(terms);
  const c = t.clock;
  return normalizeTerms({
    reviewWindowBusinessDays: c.reviewWindowBusinessDays,
    partialReleasePct: c.partialReleasePct,
    graceBusinessDays: c.graceBusinessDays,
    includedRevisionRounds: c.includedRevisionRounds,
    backupReviewerId: c.backupReviewerId,
    country,
    tz: terms.client?.tz || defaultTz(String(country)),
  });
}

function clockProblems(terms: DealTerms): string[] {
  const out: string[] = [];
  for (const t of terms?.milestones || []) {
    if (t.clock === undefined || t.clock === null) continue;
    if (typeof t.clock !== 'object' || Array.isArray(t.clock)) {
      out.push(`milestone ${t.key}: review clock terms must be an object`);
      continue;
    }
    try {
      clockTermsOf(terms, t);
    } catch (e) {
      out.push(`milestone ${t.key}: review clock: ${(e as Error).message}`);
    }
  }
  return out;
}

function ev(at: string, kind: ClockEvent['kind'], id: string, extra: Partial<ClockEvent> = {}): ClockEvent {
  return { at, kind, id, ...extra };
}

/**
 * Checks finished on the latest version. Passing checks start the clock (first
 * time) or resume a paused one, adding the pause to pausedMs. Failing checks
 * leave it as it was: a clock never starts or resumes on a failed delivery.
 */
function onChecks(m: MilestoneRuntime, t: MilestoneTerms, terms: DealTerms, passed: boolean, at: string): MilestoneRuntime {
  const ct = clockTermsOf(terms, t);
  if (!ct) return m;
  const c = m.clock;
  if (!passed) {
    if (!c) return m;
    return { ...m, clock: { ...c, timeline: [...c.timeline, ev(at, 'action', 'checks_failed', { by: 'system' })] } };
  }
  if (!c) {
    const schedule = buildSchedule(at, ct, t.amountMinor);
    // amounts are in the deal's currency, whatever the brand's country
    schedule.currency = terms.currency;
    const clock: ClockRuntime = {
      startedAt: at,
      schedule,
      doneSteps: [],
      paused: false,
      pausedMs: 0,
      revisionsUsed: 0,
      status: 'running',
      notices: [],
      timeline: [ev(at, 'action', 'started', { by: 'system', note: 'automatic checks passed' })],
    };
    return { ...m, clock };
  }
  if (c.status === 'paused' && c.paused) {
    const add = Math.max(0, Date.parse(at) - Date.parse(c.pausedAt || at));
    return {
      ...m,
      clock: {
        ...c,
        paused: false,
        pausedAt: undefined,
        pausedMs: c.pausedMs + add,
        status: 'running',
        timeline: [...c.timeline, ev(at, 'action', 'resumed', { by: 'system', note: 'redelivery passed the checks' })],
      },
    };
  }
  return m;
}

function pauseForChanges(m: MilestoneRuntime, at: string, by: string, citation?: string): MilestoneRuntime {
  const c = m.clock;
  if (!c || !LIVE.includes(c.status)) return m;
  return {
    ...m,
    clock: {
      ...c,
      paused: true,
      pausedAt: c.paused ? c.pausedAt : at,
      status: 'paused',
      revisionsUsed: c.revisionsUsed + 1,
      timeline: [...c.timeline, ev(at, 'action', 'changes_requested', { by, note: citation ? `cites ${citation}` : undefined })],
    },
  };
}

function endClock(m: MilestoneRuntime, status: 'approved' | 'disputed' | 'stopped' | 'released', at: string, id: string, by: string): MilestoneRuntime {
  const c = m.clock;
  if (!c || !LIVE.includes(c.status)) return m;
  const add = c.paused ? Math.max(0, Date.parse(at) - Date.parse(c.pausedAt || at)) : 0;
  return {
    ...m,
    clock: {
      ...c,
      paused: false,
      pausedAt: undefined,
      pausedMs: c.pausedMs + add,
      status,
      timeline: [...c.timeline, ev(at, 'action', id, { by })],
    },
  };
}

function shiftOf(c: ClockRuntime, now: string): number {
  const cur = c.paused && c.pausedAt ? Math.max(0, Date.parse(now) - Date.parse(c.pausedAt)) : 0;
  return c.pausedMs + cur;
}

function dueFor(c: ClockRuntime | undefined, now: string): string[] {
  if (!c || c.status !== 'running') return [];
  return dueSteps(c.schedule, now, c.doneSteps, shiftOf(c, now));
}

const ENDED_LINE: Record<string, string> = {
  approved: 'Approved: the review clock has stopped and the full amount releases to the team.',
  released: 'No reply came in time, so the full amount was released to the team.',
  disputed: 'Disputed: the review clock has stopped and what is still held is frozen until the dispute is settled.',
  stopped: 'The review clock has stopped.',
};

function viewOf(deal: DealDoc, key: string, now: string) {
  const t = deal.terms.milestones.find((x) => x.key === key);
  const m = deal.milestones.find((x) => x.key === key);
  if (!t || !m) return null;
  const terms = clockTermsOf(deal.terms, t);
  if (!terms) return null;
  const c = m.clock;
  let state = clockState({ schedule: c?.schedule, now, paused: c?.paused, pausedAtISO: c?.pausedAt, pausedMs: c?.pausedMs || 0 });
  if (c && !LIVE.includes(c.status)) {
    state = { ...state, businessDaysLeft: 0, nextStep: null, line: ENDED_LINE[c.status] || state.line };
  }
  return {
    milestoneKey: key,
    milestoneState: m.state,
    status: c ? c.status : 'waiting_checks',
    state,
    terms,
    revisionsUsed: c?.revisionsUsed || 0,
    includedRevisionRounds: terms.includedRevisionRounds,
    startedAt: c?.startedAt || null,
    pausedMs: c ? shiftOf(c, now) : 0,
    amounts: c
      ? { amountMinor: c.schedule.amountCents, partialAmountCents: c.schedule.partialAmountCents, remainderCents: c.schedule.remainderCents, currency: c.schedule.currency }
      : null,
    doneSteps: c?.doneSteps || [],
    timeline: c?.timeline || [],
  };
}

const CLOCK_KEYS = ['reviewWindowBusinessDays', 'partialReleasePct', 'graceBusinessDays', 'includedRevisionRounds', 'backupReviewerId'];

/**
 * Plan a clock-terms edit on one milestone of a draft (the dry run and the save
 * run the same plan). `input` is { clock: {...} } or { clock: null } to remove
 * the clock. Returns the next terms, the problems (validateTerms' clock rules
 * plus shape rules) and a preview: when review would end if the editor
 * delivered now. Pure: membership of the backup reviewer is checked by the route.
 */
function planClockTerms(deal: DealDoc, key: string, input: unknown, now: string) {
  const problems: string[] = [];
  const t = deal.terms.milestones.find((x) => x.key === key);
  if (!t) return { allowed: false, problems: [`no milestone ${key}`], terms: null, clock: null, preview: null };
  const raw = input && typeof input === 'object' ? (input as { clock?: unknown }).clock : undefined;
  let clock: Record<string, unknown> | null = null;
  if (raw === null) clock = null;
  else if (!raw || typeof raw !== 'object' || Array.isArray(raw)) problems.push('clock must be an object, or null to remove the review clock');
  else {
    clock = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!CLOCK_KEYS.includes(k)) problems.push(`unknown clock field ${k}`);
      else if (v !== undefined && v !== null && v !== '') clock[k] = v;
    }
    if (clock.backupReviewerId !== undefined && clock.backupReviewerId === deal.terms.worker.userId)
      problems.push('the backup reviewer reviews for the client, so it cannot be the editor');
  }
  const next: DealTerms = {
    ...deal.terms,
    milestones: deal.terms.milestones.map((x) => {
      if (x.key !== key) return x;
      const { clock: _old, ...rest } = x;
      return clock ? { ...rest, clock } : rest;
    }) as MilestoneTerms[],
  };
  if (!problems.length) problems.push(...clockProblems({ ...next, milestones: next.milestones.filter((x) => x.key === key) }));
  let preview = null;
  const nt = next.milestones.find((x) => x.key === key);
  if (!problems.length && clock && nt) {
    const ct = clockTermsOf(next, nt) as ClockTerms;
    const sched = buildSchedule(now, ct, nt.amountMinor);
    sched.currency = next.currency;
    const st = clockState({ schedule: sched, now });
    preview = {
      deliverAt: now,
      deadline: sched.deadline,
      deadlineText: fmtWhen(Date.parse(sched.deadline), ct.tz),
      graceDeadline: sched.graceDeadline,
      graceText: fmtWhen(Date.parse(sched.graceDeadline), ct.tz),
      capped: sched.capped,
      partialAmountMinor: sched.partialAmountCents,
      remainderMinor: sched.remainderCents,
      currency: next.currency,
      tz: ct.tz,
      line: st.line,
    };
  }
  return {
    allowed: problems.length === 0,
    problems,
    terms: problems.length ? null : next,
    clock: problems.length || !clock || !nt ? null : clockTermsOf(next, nt),
    preview,
  };
}

module.exports = { STEP_IDS, planClockTerms, clockTermsOf, clockProblems, onChecks, pauseForChanges, endClock, shiftOf, dueFor, viewOf, defaultTz };
