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
