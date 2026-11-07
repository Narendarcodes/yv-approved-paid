/**
 * The Fair Review Clock: how long a client has to review a submission before
 * money moves on its own. Pure: no database, no I/O, and every "now" is passed
 * in, so the same code runs in unit tests, the scheduler and the API.
 *
 *   isBusinessDay(date, country)              Mon-Fri, not a bank holiday there
 *   addBusinessDays(startISO, n, {country,tz}) 18:00 local on the nth business day
 *   normalizeTerms(t)                          defaults + validation (throws)
 *   buildSchedule(startISO, terms, cents)      deadline, reminders, grace, split
 *   clockState({schedule, now, ...})           status, days left, next step, one line
 *   dueSteps(schedule, now, doneStepIds)       stable step ids that are due now
 *   holdPlan(authISO, projectedEndISO)         PayPal 3-day honor / 29-day validity
 *
 * Business-day rule: each day's cut-off is 18:00 in the deal's IANA timezone.
 * A start before the cut-off on a business day counts that day as day 1; a
 * start at or after 18:00, or on a weekend/holiday, makes the next business
 * day day 1. The deadline is 18:00 on day n, and never more than 15 calendar
 * days after the start. Holidays come from holidays.json (2026-2027); outside
 * those years only weekends are skipped.
 */

const { format } = require('./money.cts');
const HOLIDAYS: Record<string, Record<string, string[]>> = require('./holidays.json');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const CUTOFF_HOUR = 18;
const MAX_CALENDAR_DAYS = 15;
const AUTH_HONOR_DAYS = 3;
const AUTH_VALID_DAYS = 29;

export type Country = 'IN' | 'US';
export type ClockStatus = 'waiting_checks' | 'running' | 'paused' | 'grace' | 'released_partial' | 'released_full';
export type StepId = 'remind_50' | 'remind_80' | 'final_24h' | 'release_partial' | 'release_grace';

export type ClockTermsInput = {
  reviewWindowBusinessDays?: unknown;
  partialReleasePct?: unknown;
  graceBusinessDays?: unknown;
  includedRevisionRounds?: unknown;
  backupReviewerId?: unknown;
  country?: unknown;
  tz?: unknown;
};

export type ClockTerms = {
  reviewWindowBusinessDays: number;
  partialReleasePct: number;
  graceBusinessDays: number;
  includedRevisionRounds: number;
  backupReviewerId?: string;
  country: Country;
  tz: string;
};

export type ClockStep = {
  id: StepId;
  atISO: string;
  kind: 'reminder' | 'release';
  /** Who a reminder goes to: always the reviewer, plus the backup on remind_80. */
  to?: string[];
  /** On final_24h and release_partial: the exact amount that will move. */
  partialAmountCents?: number;
  /** On release_grace: what is left to release. */
  remainderCents?: number;
};

export type ClockSchedule = {
  clockStartISO: string;
  deadline: string;
  /** True when the 15-calendar-day cap cut the business-day deadline short. */
  capped: boolean;
  graceDeadline: string;
  reminders: ClockStep[];
  /** Every step in time order: the reminders plus the two releases. */
  steps: ClockStep[];
  amountCents: number;
  partialAmountCents: number;
  remainderCents: number;
  currency: string;
  terms: ClockTerms;
};

export type ClockStateInput = {
  schedule: ClockSchedule | null | undefined;
  now: string | Date;
  paused?: boolean;
  pausedAtISO?: string;
  /** Time already spent paused in earlier, finished pauses. */
  pausedMs?: number;
};

export type ClockState = {
  status: ClockStatus;
  businessDaysLeft: number;
  /** Total time the deadlines have moved because of pauses (finished + current). */
  shiftMs: number;
  deadline: string | null;
  graceDeadline: string | null;
  nextStep: { id: StepId; atISO: string } | null;
  line: string;
};

export type HoldPlan = { reauthorizeAfterISO: string; lapsesISO: string; needsRefund: boolean };

// ---------- time zone helpers (Intl only, no dependency) ----------

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

type Local = { y: number; m: number; d: number; h: number; mi: number; s: number };

function localParts(ms: number, tz: string): Local {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, mi: out.minute, s: out.second };
}

/** Offset of tz from UTC at instant ms, in ms (IST = +5.5h). */
function offsetAt(ms: number, tz: string): number {
  const l = localParts(ms, tz);
  const asUtc = Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi, l.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of a wall-clock time in tz (DST-safe for whole-hour times like 18:00). */
function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ms = guess - offsetAt(guess, tz);
  const second = guess - offsetAt(ms, tz);
  if (second !== ms) ms = second;
  return ms;
}

function assertTz(tz: unknown): string {
  if (typeof tz !== 'string' || !tz) throw new Error('tz must be an IANA timezone name');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`unknown timezone "${tz}"`);
  }
  return tz;
}

function toMs(v: string | Date, name: string): number {
  const ms = v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`${name} is not a valid date`);
  return ms;
}

// ---------- civil dates ----------

type Civil = { y: number; m: number; d: number };

function ymd(c: Civil): string {
  return `${c.y}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
}

function nextCivil(c: Civil): Civil {
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function parseCivil(date: string | Date): Civil {
  if (date instanceof Date) {
    if (!Number.isFinite(date.getTime())) throw new Error('invalid date');
    return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date));
  if (!m) throw new Error(`invalid date "${date}"`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

const holidaySets = new Map<string, Set<string>>();

function holidaySet(country: string): Set<string> {
  let s = holidaySets.get(country);
  if (!s) {
    const byYear = HOLIDAYS[country];
    if (!byYear || country.startsWith('_')) throw new Error(`no holiday calendar for country "${country}"`);
    s = new Set(Object.values(byYear).flat());
    holidaySets.set(country, s);
  }
  return s;
}

/**
 * Mon-Fri and not a bank holiday in that country. A "YYYY-MM-DD" string is
 * read as that calendar date; a Date is read as its UTC calendar date.
 */
function isBusinessDay(date: string | Date, country: string): boolean {
  const c = parseCivil(date);
  const dow = new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !holidaySet(country).has(ymd(c));
}

/** Day 1 of a count: the start day if before 18:00 on a business day, else the next business day. */
function firstCountedDay(startMs: number, country: string, tz: string): Civil {
  const l = localParts(startMs, tz);
  let c: Civil = { y: l.y, m: l.m, d: l.d };
  const beforeCutoff = l.h < CUTOFF_HOUR;
  if (!beforeCutoff || !isBusinessDay(ymd(c), country)) {
    c = nextCivil(c);
    while (!isBusinessDay(ymd(c), country)) c = nextCivil(c);
  }
  return c;
}

/**
 * 18:00 (tz) on the nth business day. Day 1 is the start day when the start is
 * before 18:00 on a business day, otherwise the next business day.
 */
function addBusinessDays(startISO: string, n: number, opts: { country: string; tz: string }): string {
  if (!Number.isInteger(n) || n < 1) throw new Error('n must be a whole number of business days, at least 1');
  const tz = assertTz(opts.tz);
  holidaySet(opts.country);
  const startMs = toMs(startISO, 'startISO');
  let c = firstCountedDay(startMs, opts.country, tz);
  for (let i = 1; i < n; i++) {
    c = nextCivil(c);
    while (!isBusinessDay(ymd(c), opts.country)) c = nextCivil(c);
  }
  return new Date(zonedToUtc(c.y, c.m, c.d, CUTOFF_HOUR, 0, tz)).toISOString();
}

// ---------- terms ----------

function intIn(v: unknown, dflt: number, min: number, max: number, name: string): number {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return v;
}

function normalizeTerms(t: ClockTermsInput = {}): ClockTerms {
  if (t === null || typeof t !== 'object') throw new Error('terms must be an object');
  const country = t.country === undefined || t.country === null ? 'IN' : t.country;
  if (country !== 'IN' && country !== 'US') throw new Error('country must be "IN" or "US"');
  const tz = assertTz(t.tz === undefined || t.tz === null ? 'Asia/Kolkata' : t.tz);
  const out: ClockTerms = {
    reviewWindowBusinessDays: intIn(t.reviewWindowBusinessDays, 3, 2, 10, 'reviewWindowBusinessDays'),
    partialReleasePct: intIn(t.partialReleasePct, 50, 0, 90, 'partialReleasePct'),
    graceBusinessDays: intIn(t.graceBusinessDays, 3, 0, 10, 'graceBusinessDays'),
    includedRevisionRounds: intIn(t.includedRevisionRounds, 2, 0, 10, 'includedRevisionRounds'),
    country,
    tz,
  };
  if (t.backupReviewerId !== undefined && t.backupReviewerId !== null && t.backupReviewerId !== '') {
    if (typeof t.backupReviewerId !== 'string' || t.backupReviewerId.length > 64) {
      throw new Error('backupReviewerId must be a string id');
    }
    out.backupReviewerId = t.backupReviewerId;
  }
  return out;
}

// ---------- schedule ----------

function currencyFor(country: Country): string {
  return country === 'US' ? 'USD' : 'INR';
}

function buildSchedule(clockStartISO: string, termsIn: ClockTermsInput, amountCents: number): ClockSchedule {
  const terms = normalizeTerms(termsIn);
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new Error('amountCents must be a non-negative integer');
  const startMs = toMs(clockStartISO, 'clockStartISO');
  const startISO = new Date(startMs).toISOString();
  const opts = { country: terms.country, tz: terms.tz };

  const businessMs = Date.parse(addBusinessDays(startISO, terms.reviewWindowBusinessDays, opts));
  const capMs = startMs + MAX_CALENDAR_DAYS * DAY;
  const capped = businessMs > capMs;
  const deadlineMs = capped ? capMs : businessMs;
  const deadline = new Date(deadlineMs).toISOString();
  const graceDeadline =
    terms.graceBusinessDays === 0 ? deadline : addBusinessDays(deadline, terms.graceBusinessDays, opts);

  const partialAmountCents = Math.floor((amountCents * terms.partialReleasePct) / 100);
  const remainderCents = amountCents - partialAmountCents;

  const window = deadlineMs - startMs;
  const at = (ms: number) => new Date(Math.max(startMs, Math.round(ms))).toISOString();
  const reviewer = ['reviewer'];
  const reminders: ClockStep[] = [
    { id: 'remind_50', kind: 'reminder', atISO: at(startMs + window * 0.5), to: reviewer },
    {
      id: 'remind_80',
      kind: 'reminder',
      atISO: at(startMs + window * 0.8),
      to: terms.backupReviewerId ? ['reviewer', terms.backupReviewerId] : reviewer,
    },
    { id: 'final_24h', kind: 'reminder', atISO: at(deadlineMs - DAY), to: reviewer, partialAmountCents },
  ];
  const releases: ClockStep[] = [];
  if (partialAmountCents > 0) {
    releases.push({ id: 'release_partial', kind: 'release', atISO: deadline, partialAmountCents });
  }
  releases.push({ id: 'release_grace', kind: 'release', atISO: graceDeadline, remainderCents });
  const steps = [...reminders, ...releases].sort((a, b) => Date.parse(a.atISO) - Date.parse(b.atISO));

  return {
    clockStartISO: startISO,
    deadline,
    capped,
    graceDeadline,
    reminders,
    steps,
    amountCents,
    partialAmountCents,
    remainderCents,
    currency: currencyFor(terms.country),
    terms,
  };
}

// ---------- state ----------

/** "Tue 10 Nov 6:00 PM IST" in the deal's timezone. */
function fmtWhen(ms: number, tz: string): string {
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  const zoneOf = (loc: string) =>
    new Intl.DateTimeFormat(loc, { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? tz;
  let zone = zoneOf('en-US');
  if (/^GMT[+-]/.test(zone)) zone = zoneOf('en-IN');
  return `${get('weekday')} ${get('day')} ${get('month')} ${time} ${zone}`;
}

/** Business-day cut-offs still ahead of `nowMs` up to and including the deadline. */
function businessDaysBetween(nowMs: number, deadlineMs: number, country: string, tz: string): number {
  if (nowMs >= deadlineMs) return 0;
  let count = 0;
  let c = firstCountedDay(nowMs, country, tz);
  for (let guard = 0; guard < 400; guard++) {
    const cutoff = zonedToUtc(c.y, c.m, c.d, CUTOFF_HOUR, 0, tz);
    if (cutoff > deadlineMs) break;
    count++;
    c = nextCivil(c);
    while (!isBusinessDay(ymd(c), country)) c = nextCivil(c);
  }
  // A capped deadline that is not on a cut-off still leaves part of a day.
  return count === 0 ? 1 : count;
}

function clockState(input: ClockStateInput): ClockState {
  const { schedule } = input;
  const nowMs = toMs(input.now, 'now');
  const earlier = input.pausedMs ?? 0;
  if (!Number.isFinite(earlier) || earlier < 0) throw new Error('pausedMs must be a non-negative number');
  if (!schedule) {
    return {
      status: 'waiting_checks',
      businessDaysLeft: 0,
      shiftMs: 0,
      deadline: null,
      graceDeadline: null,
      nextStep: null,
      line: 'The review clock starts once the automatic checks pass.',
    };
  }
  const { terms } = schedule;
  let current = 0;
  if (input.paused) {
    const pausedAt = input.pausedAtISO ? toMs(input.pausedAtISO, 'pausedAtISO') : nowMs;
    current = Math.max(0, nowMs - pausedAt);
  }
  const shiftMs = earlier + current;
  // Compare on the schedule's own (unshifted) timeline: pausing stops the clock.
  const effNow = nowMs - shiftMs;
  const startMs = Date.parse(schedule.clockStartISO);
  const deadlineMs = Date.parse(schedule.deadline);
  const graceMs = Date.parse(schedule.graceDeadline);
  const shifted = (ms: number) => new Date(ms + shiftMs).toISOString();
  const when = (ms: number) => fmtWhen(ms + shiftMs, terms.tz);
  const money = (n: number) => format(n, schedule.currency);
  const partial = `${money(schedule.partialAmountCents)} (${terms.partialReleasePct}%)`;

  const next = schedule.steps.find((s) => Date.parse(s.atISO) > effNow);
  const nextStep = next ? { id: next.id, atISO: shifted(Date.parse(next.atISO)) } : null;
  const businessDaysLeft = effNow < startMs
    ? businessDaysBetween(startMs, deadlineMs, terms.country, terms.tz)
    : businessDaysBetween(effNow, deadlineMs, terms.country, terms.tz);

  let status: ClockStatus;
  let line: string;
  if (effNow < startMs) {
    status = 'waiting_checks';
    line = `The review clock starts ${when(startMs)}.`;
  } else if (input.paused) {
    status = 'paused';
    line = `The review clock is paused with ${businessDaysLeft} business day${businessDaysLeft === 1 ? '' : 's'} left; deadlines move by the time it stays paused.`;
  } else if (effNow < deadlineMs) {
    status = 'running';
    line =
      schedule.partialAmountCents > 0
        ? `If no reply by ${when(deadlineMs)}, ${partial} releases to the team.`
        : `If no reply by ${when(deadlineMs)}, the grace period starts and the full ${money(schedule.amountCents)} releases by ${when(graceMs)}.`;
  } else if (effNow < graceMs) {
    if (schedule.partialAmountCents > 0) {
      status = 'released_partial';
      line = `${partial} has been released to the team. If there is still no reply by ${when(graceMs)}, the remaining ${money(schedule.remainderCents)} releases too.`;
    } else {
      status = 'grace';
      line = `The review window has ended. If there is still no reply by ${when(graceMs)}, the full ${money(schedule.amountCents)} releases to the team.`;
    }
  } else {
    status = 'released_full';
    line = `No reply came in time, so the full ${money(schedule.amountCents)} has been released to the team.`;
  }

  return {
    status,
    businessDaysLeft: status === 'running' || status === 'paused' || status === 'waiting_checks' ? businessDaysLeft : 0,
    shiftMs,
    deadline: shifted(deadlineMs),
    graceDeadline: shifted(graceMs),
    nextStep,
    line,
  };
}

/**
 * Ids of steps that are due at `now` and not yet done, in time order. Ids are
 * stable per schedule, so a caller can record them and make each step
 * idempotent. `shiftMs` is the total pause time (clockState().shiftMs).
 */
function dueSteps(
  schedule: ClockSchedule,
  now: string | Date,
  doneStepIds: Iterable<string> = [],
  shiftMs = 0,
): StepId[] {
  const nowMs = toMs(now, 'now') - shiftMs;
  const done = new Set(doneStepIds);
  return schedule.steps.filter((s) => Date.parse(s.atISO) <= nowMs && !done.has(s.id)).map((s) => s.id);
}

/** PayPal authorizations: 3-day honor period, valid for 29 days. */
function holdPlan(authCreatedISO: string, projectedEndISO: string): HoldPlan {
  const a = toMs(authCreatedISO, 'authCreatedISO');
  const end = toMs(projectedEndISO, 'projectedEndISO');
  const lapses = a + AUTH_VALID_DAYS * DAY;
  return {
    reauthorizeAfterISO: new Date(a + AUTH_HONOR_DAYS * DAY).toISOString(),
    lapsesISO: new Date(lapses).toISOString(),
    needsRefund: end > lapses,
  };
}

module.exports = {
  isBusinessDay,
  addBusinessDays,
  normalizeTerms,
  buildSchedule,
  clockState,
  dueSteps,
  holdPlan,
  fmtWhen,
  CUTOFF_HOUR,
  MAX_CALENDAR_DAYS,
};
