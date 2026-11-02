/**
 * Deals (Approved = Paid): data hooks for the /deals pages and the deal cards.
 *
 * AI checks facts, people own taste, the deal decides the money.
 *
 * Every amount shown comes from the deal doc or the ledger the API returns.
 * Buttons call the existing human routes; the Money Agent then acts through
 * the policy engine. The ledger stays live over Socket.IO (`deal:join`, then
 * `deal:ledger` on every append).
 */
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '../services/api'
import { primaryOrgId } from './data'
import { sharedSocket } from './chat'
import type {
  DealLedgerEntry,
  DealLedgerPush,
  DealLedgerView,
  DealMilestoneRuntime,
  DealMilestoneTerms,
  DealView,
} from '../contracts/types'

export const MOTTO = 'AI checks facts, people own taste, the deal decides the money.'
export const DEMO_DEAL_ID = 'deal_demo_diwali'
const ORG_KEY = 'yv.dealOrg'

/** Remember which org the demo deal lives in (from /auth/demo-login). */
export function rememberDealOrg(orgId: string | null | undefined) {
  try {
    if (orgId) localStorage.setItem(ORG_KEY, orgId)
  } catch {
    /* storage unavailable */
  }
}

/** The org deals are read from: the remembered one if the user still belongs to it, else the primary org. */
export async function dealOrgId(): Promise<string | null> {
  let remembered: string | null = null
  try {
    remembered = localStorage.getItem(ORG_KEY)
  } catch {
    /* storage unavailable */
  }
  if (remembered) {
    try {
      const orgs = await api.listOrgs()
      if (orgs.some((o) => o.id === remembered)) return remembered
    } catch {
      /* fall back below */
    }
  }
  return primaryOrgId()
}

export function useDealOrg() {
  return useQuery({ queryKey: ['deal-org'], queryFn: dealOrgId, staleTime: 5 * 60_000 })
}

export function useDeals() {
  const org = useDealOrg()
  const orgId = org.data ?? null
  const q = useQuery({
    queryKey: ['deals', orgId],
    queryFn: () => api.listDeals(orgId as string),
    enabled: !!orgId,
  })
  return { orgId, ...q, isLoading: org.isLoading || q.isLoading, isError: org.isError || q.isError }
}

export function useDeal(dealId: string | undefined) {
  const org = useDealOrg()
  const orgId = org.data ?? null
  const q = useQuery({
    queryKey: ['deal', orgId, dealId],
    queryFn: () => api.getDeal(orgId as string, dealId as string),
    enabled: !!orgId && !!dealId,
  })
  return { orgId, ...q, isLoading: org.isLoading || q.isLoading, isError: org.isError || q.isError }
}

/** The ledger, kept live: REST once, then every `deal:ledger` push is appended (deduped by seq). */
export function useDealLedger(orgId: string | null, dealId: string | undefined) {
  const qc = useQueryClient()
  const key = ['deal-ledger', orgId, dealId]
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.getDealLedger(orgId as string, dealId as string),
    enabled: !!orgId && !!dealId,
  })
  const [live, setLive] = useState(false)

  useEffect(() => {
    if (!orgId || !dealId) return
    let socket: ReturnType<typeof sharedSocket> | null = null
    try {
      socket = sharedSocket()
    } catch {
      return
    }
    const join = () =>
      socket?.emit('deal:join', { dealId }, (ack: { ok?: boolean } | undefined) => setLive(!!ack?.ok))
    const onLedger = (msg: DealLedgerPush) => {
      if (!msg || msg.dealId !== dealId || !msg.entry) return
      qc.setQueryData<DealLedgerView | undefined>(['deal-ledger', orgId, dealId], (prev) =>
        prev ? appendEntry(prev, msg.entry) : prev,
      )
      // the deal doc changed with it (state, captures, payouts): refetch the view
      void qc.invalidateQueries({ queryKey: ['deal', orgId, dealId] })
    }
    join()
    socket.on('connect', join)
    socket.on('deal:ledger', onLedger)
    return () => {
      socket?.emit('deal:leave', { dealId })
      socket?.off('connect', join)
      socket?.off('deal:ledger', onLedger)
      setLive(false)
    }
  }, [orgId, dealId, qc])

  return { ...q, live }
}

/** Merge one pushed ledger line into the view. Totals are recomputed the way the API does (ledger.cts totals()). */
export function appendEntry(view: DealLedgerView, entry: DealLedgerEntry): DealLedgerView {
  if (view.entries.some((e) => e.seq === entry.seq)) return view
  const entries = [...view.entries, entry].sort((a, b) => a.seq - b.seq)
  return { ...view, entries, totals: totalsOf(entries) }
}

export function totalsOf(entries: DealLedgerEntry[]): DealLedgerView['totals'] {
  const sum = (t: DealLedgerEntry['type']) =>
    entries.filter((e) => e.type === t && e.moved).reduce((a, e) => a + e.amountMinor, 0)
  return {
    heldMinor: sum('authorize'),
    capturedMinor: sum('capture') + sum('partial_capture'),
    refundedMinor: sum('refund'),
    paidOutMinor: sum('payout'),
    invoicedMinor: sum('invoice'),
    blockedCount: entries.filter((e) => e.type === 'blocked').length,
  }
}

/** After a human tap: refresh the deal and its ledger. */
export function useDealRefresh(orgId: string | null, dealId: string | undefined) {
  const qc = useQueryClient()
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['deal', orgId, dealId] }),
      qc.invalidateQueries({ queryKey: ['deal-ledger', orgId, dealId] }),
      qc.invalidateQueries({ queryKey: ['deals', orgId] }),
    ])
}

/** Minor units -> "$400.00". */
export function money(minor: number | undefined | null, currency = 'USD'): string {
  const n = (minor ?? 0) / 100
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n)
  } catch {
    return `${currency} ${n.toFixed(2)}`
  }
}

export function milestonePair(
  deal: DealView,
  key: string,
): { terms: DealMilestoneTerms; runtime: DealMilestoneRuntime } | null {
  const terms = deal.terms.milestones.find((m) => m.key === key)
  const runtime = deal.milestones.find((m) => m.key === key)
  return terms && runtime ? { terms, runtime } : null
}

export function shortHash(h?: string | null, n = 10) {
  return h ? `${h.slice(0, n)}…` : '—'
}

export function when(iso?: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime())
    ? '—'
    : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Role words, never names (identity-blind; matches the agent side's identity.py). */
export function roleWord(role?: string | null) {
  if (role === 'client') return 'Client'
  if (role === 'worker') return 'Editor'
  if (role === 'system') return 'Money Agent'
  if (role === 'reviewer') return 'Reviewer'
  return role ? role[0].toUpperCase() + role.slice(1) : '—'
}

/**
 * The redacted deal view handed to the copilot: roles, states, ids and the
 * deal's own amounts. No names, emails, countries or PayPal ids.
 */
export function redactedDeal(deal: DealView) {
  return {
    id: deal.id,
    title: deal.terms.title,
    currency: deal.terms.currency,
    myRole: deal.me ?? null,
    signedByBoth: deal.signatures.length >= 2,
    milestones: deal.terms.milestones.map((t) => {
      const r = deal.milestones.find((m) => m.key === t.key)
      return {
        key: t.key,
        title: t.title,
        state: r?.state,
        amountMinor: t.amountMinor,
        capturedMinor: r?.capturedMinor ?? 0,
        versions: r?.versions.length ?? 0,
        hasReviewProposal: !!r?.proposals?.review,
        hasDisputeProposal: !!r?.proposals?.dispute,
      }
    }),
    changeOrders: deal.changeOrders.map((c) => ({ id: c.id, milestoneKey: c.milestoneKey, status: c.status })),
    pendingApprovals: deal.pendingApprovals.map((p) => ({ key: p.key, reason: p.reason })),
  }
}

/* ------------------------------------------------------------------ */
/* Invoices and blocked lines: presentation helpers.                   */
/* Every amount still comes from the deal or the ledger; these helpers */
/* only format it. The AI never sets an amount.                        */
/* ------------------------------------------------------------------ */

/** Major units (the org invoice store keeps whole amounts) -> "₹12,000" / "$60.50". */
export function moneyMajor(amount: number | undefined | null, currency = 'USD'): string {
  const n = amount ?? 0
  const whole = Number.isInteger(n)
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: whole && currency === 'INR' ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    return `${currency} ${n.toFixed(2)}`
  }
}

/** A calendar date with the year: "2 Nov 2026". */
export function dateOnly(iso?: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The one invoice status vocabulary every screen uses. */
export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'overdue' | 'void'
export const INVOICE_STATUS: Record<InvoiceStatus, { label: string; tone: 'neutral' | 'warning' | 'teal' | 'success' | 'danger'; hint: string }> = {
  draft: { label: 'Draft', tone: 'neutral', hint: 'Not sent to the client yet' },
  sent: { label: 'Sent', tone: 'warning', hint: 'Waiting for payment' },
  paid: { label: 'Paid', tone: 'success', hint: 'Payment received' },
  overdue: { label: 'Overdue', tone: 'danger', hint: 'Past the due date' },
  void: { label: 'Void', tone: 'neutral', hint: 'Cancelled, nothing is owed' },
}

/** PayPal environment tag for an invoice id: the mock gateway mints ids ending in MOCK. */
export function paypalEnv(id?: string | null): 'mock' | 'sandbox' {
  return id && /mock/i.test(id) ? 'mock' : 'sandbox'
}

/** Where a change order stands, as the client reads it. */
export function changeOrderStage(co: DealView['changeOrders'][number]): {
  invoice: InvoiceStatus | null
  label: string
  tone: 'neutral' | 'warning' | 'teal' | 'success' | 'danger'
} {
  if (co.status === 'declined') return { invoice: 'void', label: 'Declined', tone: 'neutral' }
  if (co.status === 'invoiced') return { invoice: 'draft', label: 'Invoice drafted', tone: 'teal' }
  if (co.status === 'accepted') return { invoice: null, label: 'Accepted · invoicing', tone: 'warning' }
  return { invoice: null, label: 'Awaiting client', tone: 'warning' }
}

/* ---- policy violations (blocked ledger lines) ---- */

export type PolicyViolation = { rule: string; message: string }

const RULE_NAME: Record<string, string> = {
  P1: 'Milestone state',
  P2: 'Who may act',
  P3: 'Amount',
  P4: 'Signed terms',
  P5: 'Already ran',
  P6: 'Approved version',
  P8: 'Currency',
  P9: 'Hold window',
  P10: 'Payee',
  P11: 'Rate card',
  P12: 'Milestone',
  P13: 'Flagged',
}
/** "P5_already_ran" -> { id: "P5", name: "Already ran" } */
export function ruleName(rule: string) {
  const id = rule.split('_')[0]
  return { id, name: RULE_NAME[id] ?? rule.replace(/^P\d+_/, '').replace(/_/g, ' ') }
}

const STATE_WORDS = /\b(SIGNED|APPROVED|AUTO_APPROVED|CAPTURED|PAID_OUT|CANCELLED|KILLED|DISPUTED|IN_REVIEW|DRAFT|FUNDED|SUBMITTED|DELIVERED)\b/g

/**
 * Policy messages carry raw minor units ("got 45000") and internal keys.
 * Rewrite them for people: amounts as currency, states in words, keys dropped.
 */
export function humanizePolicyMessage(msg: string, currency = 'USD'): string {
  const m = (s: string) => money(Number(s), currency)
  let out = msg
    // internal idempotency keys: "(capture:deal_demo:reel1)"
    .replace(/\s*\([a-z_ ]+:[^)\s]+\)/g, '')
    // "price must be 6000 x 1 = 6000"
    .replace(/(\d+) x (\d+) = (\d+)/g, (_s, a, q, t) => `${m(a)} × ${q} = ${m(t)}`)
    // "<verb> 45000 exceeds"
    .replace(/\b(capture|partial capture|refund|payout) (\d+) exceeds\b/g, (_s, v, n) => `${v} of ${m(n)} exceeds`)
    // "... exactly 0", "got 45000", "held amount 0", "the capture 1200", "share 300", "accepted 900", "unpaid 0"
    .replace(/\b(exactly|got|held amount|the capture|share|accepted|captured-but-unpaid) (\d+)\b/g, (_s, w, n) => `${w} ${m(n)}`)
    .replace(/= (\d+)\b/g, (_s, n) => `= ${m(n)}`)
    // "signed milestone amount (40000)"
    .replace(/amount \((\d+)\)/g, (_s, n) => `amount (${m(n)})`)
    .replace(STATE_WORDS, (s) => s.toLowerCase().replace(/_/g, ' '))
    .replace(/\s*\(signed amount less earlier captures\)/, '')
    .trim()
  out = out.charAt(0).toUpperCase() + out.slice(1)
  return out.endsWith('.') ? out : `${out}.`
}

/** One chip per rule; repeated messages collapse, distinct ones stay listed under it. */
export function groupViolations(violations: PolicyViolation[] | undefined, currency = 'USD') {
  const groups: { rule: string; id: string; name: string; messages: string[] }[] = []
  for (const v of violations ?? []) {
    const text = humanizePolicyMessage(v.message, currency)
    let g = groups.find((x) => x.rule === v.rule)
    if (!g) {
      g = { rule: v.rule, ...ruleName(v.rule), messages: [] }
      groups.push(g)
    }
    if (!g.messages.includes(text)) g.messages.push(text)
  }
  return groups
}

const ACTION_WORD: Record<string, string> = {
  authorize: 'Hold',
  reauthorize: 'Hold renewal',
  capture: 'Capture',
  'partial capture': 'Partial capture',
  void: 'Release',
  refund: 'Refund',
  payout: 'Payout',
  invoice: 'Invoice',
}
/** Most telling rule first: a duplicate run, then the wrong state, then the rest. */
const RULE_ORDER = ['P5', 'P2', 'P4', 'P1', 'P6', 'P13', 'P9', 'P11', 'P10', 'P3', 'P8', 'P12']

/** A blocked ledger line in one sentence: what was tried, for how much, and the main reason. */
export function blockedSummary(entry: DealLedgerEntry, currency = 'USD') {
  const kindRaw = /^Blocked ([a-z ]+):/.exec(entry.explanation || '')?.[1]?.trim() ?? ''
  const action = ACTION_WORD[kindRaw] ?? (kindRaw ? kindRaw[0].toUpperCase() + kindRaw.slice(1) : 'Money move')
  const amount = entry.amountMinor > 0 ? ` of ${money(entry.amountMinor, entry.currency || currency)}` : ''
  const groups = groupViolations(entry.policy?.violations, entry.currency || currency)
  const rank = (id: string) => {
    const i = RULE_ORDER.indexOf(id)
    return i === -1 ? 99 : i
  }
  const top = [...groups].sort((a, b) => rank(a.id) - rank(b.id))[0]
  return {
    title: `${action}${amount} refused`,
    reason: top?.messages[0] ?? 'A policy rule did not pass.',
    groups,
    ruleCount: groups.length,
  }
}
