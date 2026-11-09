/**
 * Dashboard money data (read-only): one load of payables + my money, shared by
 * the attention strip and the Awaiting review list. Nothing here writes.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { primaryOrgId } from '../../lib/data'
import { getMyMoney, getPayables, type MyMoneyRow, type PayableRow } from '../../services/api'
import { money } from '../../lib/deals'
import { attentionOf, type MoneyTotal } from '../../lib/attention'
import { DASH_EMPTY, DASH_LINE } from '../../lib/copy'
import { Skeleton } from '../states'
import { Wallet } from 'lucide-react'

export type MoneyBoard = { payables: PayableRow[]; myMoney: MyMoneyRow[]; asOf: number }

export function useMoneyBoard(): MoneyBoard | null {
  const [board, setBoard] = useState<MoneyBoard | null>(null)
  useEffect(() => {
    let live = true
    void (async () => {
      const orgId = await primaryOrgId().catch(() => null)
      if (!orgId) {
        if (live) setBoard({ payables: [], myMoney: [], asOf: Date.now() })
        return
      }
      // a role without payables access gets a 403 there; that just means no brand-side rows
      const [p, m] = await Promise.all([
        getPayables(orgId).catch(() => null),
        getMyMoney(orgId).catch(() => null),
      ])
      if (!live) return
      const asOf = Date.parse(p?.asOf || m?.asOf || '') || Date.now()
      setBoard({ payables: p?.rows ?? [], myMoney: m?.rows ?? [], asOf })
    })()
    return () => {
      live = false
    }
  }, [])
  return board
}

function total(t: MoneyTotal): string {
  const parts = Object.entries(t).map(([c, v]) => money(v, c))
  return parts.length ? parts.join(' + ') : money(0)
}

function Tile({
  label,
  value,
  sub,
  to,
  tone = 'ink',
  testId,
}: {
  label: string
  value: string
  sub: string
  to: string
  tone?: 'ink' | 'danger' | 'teal'
  testId: string
}) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'teal' ? 'text-teal' : 'text-ink'
  return (
    <Link
      to={to}
      className="row-link flex min-w-0 flex-col gap-0.5 bg-surface px-4 py-3 sm:px-5"
      data-testid={testId}
    >
      <span className="text-[12.5px] text-umber">{label}</span>
      <span className={`t-num truncate text-[20px] leading-tight ${color}`}>{value}</span>
      <span className="truncate text-[12px] text-umber">{sub}</span>
    </Link>
  )
}

export function AttentionStrip({ board }: { board: MoneyBoard | null }) {
  if (!board) {
    return (
      <div className="card grid grid-cols-2 gap-4 p-4 md:grid-cols-4" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-5 w-24" />
          </div>
        ))}
      </div>
    )
  }
  const a = attentionOf(board.payables, board.myMoney, board.asOf)
  if (a.empty || (!a.heldCount && !a.dueThisWeek && !a.overdue && !a.onTheWayCount)) {
    return (
      <section
        className="card flex min-h-[52px] items-center gap-3 px-5 py-3"
        data-testid="attention-strip"
        data-empty="true"
      >
        <Wallet size={16} strokeWidth={1.75} className="shrink-0 text-umber" aria-hidden="true" />
        <h2 className="shrink-0 text-[14px] font-medium text-ink">Money</h2>
        <p className="min-w-0 flex-1 truncate text-[13px] text-umber">{DASH_EMPTY.attention}</p>
      </section>
    )
  }
  const reels = (n: number) => `${n} reel${n === 1 ? '' : 's'}`
  return (
    <section className="card overflow-hidden" data-testid="attention-strip" aria-label="Attention">
      <div className="grid grid-cols-2 gap-px bg-line md:grid-cols-4">
        <Tile
          label="Money held"
          value={total(a.held)}
          sub={a.heldCount ? `across ${reels(a.heldCount)}` : 'nothing held'}
          to="/payables"
          testId="attention-held"
        />
        <Tile
          label="Due this week"
          value={String(a.dueThisWeek)}
          sub={a.dueThisWeek ? 'review decisions' : 'no deadlines'}
          to="/payables"
          testId="attention-due"
        />
        <Tile
          label="Overdue reviews"
          value={String(a.overdue)}
          sub={a.overdue ? 'past the deadline' : 'none late'}
          to="/payables"
          tone={a.overdue ? 'danger' : 'ink'}
          testId="attention-overdue"
        />
        <Tile
          label="Payouts on the way"
          value={total(a.onTheWay)}
          sub={
            a.onTheWayCount
              ? a.onTheWaySource === 'my-money'
                ? 'your share, releasing now'
                : `released, paying ${reels(a.onTheWayCount)}`
              : 'nothing in flight'
          }
          to={a.onTheWaySource === 'my-money' ? '/my-money' : '/payables'}
          tone={a.onTheWayCount ? 'teal' : 'ink'}
          testId="attention-on-the-way"
        />
      </div>
      <p className="border-t border-line px-5 py-2 text-[12.5px] text-umber">
        {DASH_LINE.attention}
      </p>
    </section>
  )
}
