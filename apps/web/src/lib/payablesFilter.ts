/**
 * Plain-language filters for the payables board. Deterministic: a small set of
 * phrase patterns, no model. Every clause the parser reads becomes a visible,
 * removable chip; a clause it cannot read becomes an "unknown" chip that
 * filters nothing, so the board never hides rows for a reason the user cannot see.
 *
 *   parseFilter("held over $300 and in grace")  -> [{kind:'held',...}, {kind:'grace',...}]
 *   matchesAll(row, filters, nowMs)             -> does the row pass every filter
 *
 * Clauses are joined with "and" (also "&", "plus", or a comma that is not a thousands separator).
 */

export type Op = 'gt' | 'gte' | 'lt' | 'lte'

export type PayableFilter =
  | { kind: 'held'; op: Op; minor: number; text: string; label: string }
  | { kind: 'waiting'; op: Op; days: number; text: string; label: string }
  | { kind: 'daysLeft'; op: Op; days: number; text: string; label: string }
  | { kind: 'grace'; text: string; label: string }
  | { kind: 'failedChecks'; text: string; label: string }
  | { kind: 'person'; name: string; text: string; label: string }
  | { kind: 'lapsing'; days: number; text: string; label: string }
  | { kind: 'approvable'; text: string; label: string }
  | { kind: 'unknown'; text: string; label: string }

/** The row fields the filters read (a subset of the API's payables row). */
export type FilterableRow = {
  heldMinor: number
  waitingDays?: number | null
  businessDaysLeft?: number | null
  clockStatus?: string | null
  failedChecks: number
  editorName?: string
  team?: { name: string }[]
  holdLapsesAt?: string | null
  approvable?: boolean
}

/** Holds lapsing within this many days count as "lapsing soon" (the board warns at the same point). */
export const LAPSING_SOON_DAYS = 5
const DAY_MS = 24 * 3600 * 1000

const OP_WORDS: [RegExp, Op][] = [
  [/^(?:>=|at least|min(?:imum)?|no less than)$/, 'gte'],
  [/^(?:>|over|above|more than|greater than|bigger than)$/, 'gt'],
  [/^(?:<=|at most|max(?:imum)?|no more than)$/, 'lte'],
  [/^(?:<|under|below|less than|fewer than|smaller than)$/, 'lt'],
]
const OP_RE = '(>=|<=|>|<|at least|at most|no less than|no more than|minimum|maximum|min|max|over|above|more than|greater than|bigger than|under|below|less than|fewer than|smaller than)'
const SYMBOL: Record<Op, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤' }

function opOf(word: string): Op {
  const w = word.trim()
  for (const [re, op] of OP_WORDS) if (re.test(w)) return op
  return 'gt'
}

/** "$1,250.50" / "300" / "1.5k" -> minor units (cents/paise). NaN when it is not a number. */
function toMinor(num: string, k?: string): number {
  const n = Number(num.replace(/,/g, ''))
  if (!Number.isFinite(n)) return NaN
  return Math.round(n * (k ? 1000 : 1) * 100)
}

function moneyLabel(minor: number): string {
  const major = minor / 100
  return `$${Number.isInteger(major) ? major.toLocaleString('en-US') : major.toFixed(2)}`
}

const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase())

/** Normalise one clause: lower case, single spaces, no filler words at the ends. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:show(?: me)?|only|just|with|has|have|having|that are|which are|are|is|items?|rows?|milestones?)\s+/, '')
    .replace(/^(?:with|has|have|having)\s+/, '')
    .trim()
}

/** Parse one clause into a filter (or an 'unknown' one carrying the original text). */
export function parseClause(raw: string): PayableFilter {
  const text = raw.trim().replace(/\s+/g, ' ')
  const s = norm(text)
  let m: RegExpMatchArray | null

  // held over $300 / held > 300 / holding at least ₹1.5k / over $300 held
  m =
    s.match(new RegExp(`^(?:held|holding|hold|amount held|on hold)\\s*${OP_RE}\\s*(?:\\$|usd|₹|rs\\.?|inr)?\\s*([\\d,]+(?:\\.\\d+)?)\\s*(k)?\\s*(?:usd|inr|dollars?|rupees?)?$`)) ||
    s.match(new RegExp(`^${OP_RE}\\s*(?:\\$|usd|₹|rs\\.?|inr)?\\s*([\\d,]+(?:\\.\\d+)?)\\s*(k)?\\s*(?:usd|inr|dollars?|rupees?)?\\s*(?:held|on hold)$`))
  if (m) {
    const op = opOf(m[1])
    const minor = toMinor(m[2], m[3])
    if (Number.isFinite(minor)) return { kind: 'held', op, minor, text, label: `Held ${SYMBOL[op]} ${moneyLabel(minor)}` }
  }

  // 3 or more days left / 3+ days left / under 2 days left / at least 1 business day left
  m = s.match(/^(\d+)\s*(\+|or more|or fewer|or less)?\s*(?:business |working )?days? (?:left|remaining)(?: on the clock)?$/)
  if (m) {
    const days = Number(m[1])
    // a bare "2 days left" reads as "2 days left or fewer" (how close it is)
    const op: Op = !m[2] || m[2] === 'or fewer' || m[2] === 'or less' ? 'lte' : 'gte'
    return { kind: 'daysLeft', op, days, text, label: `Clock ${SYMBOL[op]} ${days} day${days === 1 ? '' : 's'} left` }
  }
  m = s.match(new RegExp(`^${OP_RE}\\s*(\\d+)\\s*(?:business |working )?days? (?:left|remaining)(?: on the clock)?$`))
  if (m) {
    const op = opOf(m[1])
    const days = Number(m[2])
    return { kind: 'daysLeft', op, days, text, label: `Clock ${SYMBOL[op]} ${days} day${days === 1 ? '' : 's'} left` }
  }

  // waiting 3+ days / waiting 3 or more days / waiting over 3 days / waiting at least 2 days
  m = s.match(/^(?:waiting|in review|waiting for review|pending)(?: for)? (\d+)\s*(\+|or more|or fewer|or less)?\s*days?$/)
  if (m) {
    const days = Number(m[1])
    const op: Op = m[2] === 'or fewer' || m[2] === 'or less' ? 'lte' : 'gte'
    return { kind: 'waiting', op, days, text, label: `Waiting ${SYMBOL[op]} ${days} day${days === 1 ? '' : 's'}` }
  }
  m = s.match(new RegExp(`^(?:waiting|in review|waiting for review|pending)(?: for)? ${OP_RE}\\s*(\\d+)\\s*days?$`))
  if (m) {
    const op = opOf(m[1])
    const days = Number(m[2])
    return { kind: 'waiting', op, days, text, label: `Waiting ${SYMBOL[op]} ${days} day${days === 1 ? '' : 's'}` }
  }

  if (/^(?:in )?grace(?: period)?$|^in the grace period$/.test(s)) return { kind: 'grace', text, label: 'In grace' }

  if (/^(?:failed|failing|any failed|some failed) checks?$|^checks? failed$|^failed$/.test(s))
    return { kind: 'failedChecks', text, label: 'Failed checks' }

  if (/^(?:hold(?:s)? )?(?:lapsing|expiring|lapses|expires)(?: soon)?$|^(?:lapsing|expiring) holds?$|^(?:about|close) to lapse$/.test(s))
    return { kind: 'lapsing', days: LAPSING_SOON_DAYS, text, label: `Hold lapsing ≤ ${LAPSING_SOON_DAYS} days` }

  if (/^(?:ready to approve|approvable|needs? (?:my )?approval|to approve)$/.test(s))
    return { kind: 'approvable', text, label: 'Ready to approve' }

  // editor Ravi / team Sana / by Ravi / for Ravi
  m = s.match(/^(?:editor|team|crew|member|by|for|from|editor is|editor named) ([\p{L}][\p{L}\s.-]{0,40})$/u)
  if (m) {
    const name = m[1].trim()
    return { kind: 'person', name, text, label: `Team: ${titleCase(name)}` }
  }

  return { kind: 'unknown', text, label: `Not understood: “${text}”` }
}

/** Split on "and" / "&" / commas, then parse each clause. Empty input -> no filters. */
export function parseFilter(input: string): PayableFilter[] {
  return input
    .split(/\s*(?:,(?!\d)|&|\band\b|\bplus\b)\s*/i)
    .map((c) => c.trim())
    .filter(Boolean)
    .map(parseClause)
}

/** The source text of a set of filters (what the filter box shows after a chip edit or removal). */
export function filtersToText(filters: PayableFilter[]): string {
  return filters.map((f) => f.text).join(' and ')
}

function cmp(a: number, op: Op, b: number): boolean {
  return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b
}

export function matches(row: FilterableRow, f: PayableFilter, nowMs: number): boolean {
  switch (f.kind) {
    case 'held':
      return cmp(row.heldMinor || 0, f.op, f.minor)
    case 'waiting':
      return row.waitingDays != null && cmp(row.waitingDays, f.op, f.days)
    case 'daysLeft':
      // only rows with a review clock that is still counting have days left
      return (
        row.businessDaysLeft != null &&
        (row.clockStatus === 'running' || row.clockStatus === 'paused') &&
        cmp(row.businessDaysLeft, f.op, f.days)
      )
    case 'grace':
      return row.clockStatus === 'grace' || row.clockStatus === 'released_partial'
    case 'failedChecks':
      return (row.failedChecks || 0) > 0
    case 'person': {
      const needle = f.name.toLowerCase()
      const names = [row.editorName || '', ...(row.team || []).map((t) => t.name)]
      return names.some((n) => n.toLowerCase().includes(needle))
    }
    case 'lapsing': {
      if (!row.holdLapsesAt || !(row.heldMinor > 0)) return false
      const left = Date.parse(row.holdLapsesAt) - nowMs
      return left <= f.days * DAY_MS
    }
    case 'approvable':
      return !!row.approvable
    case 'unknown':
      return true // never hides a row
    default:
      return true
  }
}

export function matchesAll(row: FilterableRow, filters: PayableFilter[], nowMs: number): boolean {
  return filters.every((f) => matches(row, f, nowMs))
}

/** Days until a hold lapses (whole days, can be negative), or null. */
export function daysToLapse(holdLapsesAt: string | null | undefined, nowMs: number): number | null {
  if (!holdLapsesAt) return null
  return Math.floor((Date.parse(holdLapsesAt) - nowMs) / DAY_MS)
}
