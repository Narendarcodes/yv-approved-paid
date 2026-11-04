/**
 * DealTeamCard: who gets paid for each milestone, and the split.
 *
 * Before both sides sign, the client picks org members and types the shares;
 * every save is dry-run on the server first (same rules as the save: client
 * only, members only, shares = 100%) and clears the signatures, so both sides
 * sign the new split. After signing the team is read-only: payees move money,
 * and PayPal Payouts only ever go to the people named here, within what was
 * captured. No AI sets a payee, a share or an amount.
 */
import { useMemo, useState } from 'react'
import { Lock, Plus, Trash2, Users } from 'lucide-react'
import Avatar from '../ui'
import { useToast } from '../toast'
import * as api from '../../services/api'
import type { DealView } from '../../contracts/types'
import { useTeam } from '../../lib/data'
import { money } from '../../lib/deals'
import { DealCardShell } from './common'
import { initialsOf } from '../../lib/initials'

type Row = { userId: string; pct: string; label: string }

const shareOf = (minor: number, bp: number) => Math.floor((minor * bp + 5000) / 10000)
const pctText = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`
const toBp = (pct: string) => Math.round(Number(pct) * 100)

export default function DealTeamCard({
  deal,
  orgId,
  onChanged,
}: {
  deal: DealView
  orgId: string
  onChanged?: () => void
}) {
  const toast = useToast()
  const { team } = useTeam()
  const [editing, setEditing] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [problems, setProblems] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const locked = !!deal.termsHash
  const canEdit = !locked && deal.me === 'client'
  const cur = deal.terms.currency
  const memberOf = (id: string) => team.find((m) => m.id === id)
  const choices = useMemo(() => team.filter((m) => !m.disabled), [team])

  const start = (key: string) => {
    const t = deal.terms.milestones.find((m) => m.key === key)
    setRows(
      (t?.payees || []).map((p) => ({
        userId: p.userId,
        pct: String(p.shareBp / 100),
        label: p.displayName || '',
      })),
    )
    setProblems([])
    setEditing(key)
  }
  const totalBp = rows.reduce((a, r) => a + (Number.isFinite(toBp(r.pct)) ? toBp(r.pct) : 0), 0)

  const save = async (key: string) => {
    const input = {
      payees: rows.map((r) => ({
        userId: r.userId,
        shareBp: toBp(r.pct),
        label: r.label.trim() || undefined,
      })),
    }
    setBusy(true)
    try {
      const plan = await api.checkDealTeam(orgId, deal.id, key, input)
      if (!plan.allowed) {
        setProblems(plan.violations.map((v) => v.message))
        return
      }
      await api.setDealTeam(orgId, deal.id, key, input)
      toast(
        'success',
        'Team saved',
        plan.clearsSignatures
          ? 'Signatures were cleared: both sides sign the new split.'
          : 'Both sides sign this split.',
      )
      setEditing(null)
      onChanged?.()
    } catch (e: any) {
      setProblems(
        Array.isArray(e?.details)
          ? e.details.map((v: any) => v.message)
          : [e?.message || 'Could not save the team'],
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <DealCardShell
      title="Deal team"
      label="Who gets paid"
      testId="deal-team-card"
      meta={
        locked ? (
          <span className="status-chip bg-ink/[0.05] text-umber">
            <Lock size={11} strokeWidth={2} className="mr-1 inline" /> Signed
          </span>
        ) : (
          <span className="status-chip bg-st-production-bg text-st-production">Draft</span>
        )
      }
      footer={
        <p className="text-[12px] text-umber">
          {locked
            ? 'Locked with the signed terms. Payees move money, so the team is not edited after signing: PayPal pays only these people, within what was captured.'
            : canEdit
              ? 'You pick the team and type the split. Shares must add up to 100%; saving clears signatures so both sides sign the new split.'
              : 'Only the client picks the team before signing.'}
        </p>
      }
    >
      <div className="space-y-5">
        {deal.terms.milestones.map((t) => (
          <div key={t.key} data-testid={`team-${t.key}`}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-[13px] font-medium text-ink">
                {t.title} <span className="t-num ml-1 text-umber">{money(t.amountMinor, cur)}</span>
              </p>
              {canEdit && editing !== t.key && (
                <button className="btn-secondary btn-xs" onClick={() => start(t.key)}>
                  <Users size={13} strokeWidth={2} /> Edit team
                </button>
              )}
            </div>

            {editing === t.key ? (
              <div className="space-y-2 rounded-xl border border-line bg-canvas/50 p-3">
                {rows.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label="Member"
                      className="input !h-9 min-w-[180px] flex-1"
                      value={r.userId}
                      onChange={(e) =>
                        setRows(
                          rows.map((x, j) => (j === i ? { ...x, userId: e.target.value } : x)),
                        )
                      }
                    >
                      <option value="">Choose a member…</option>
                      {choices.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.role}
                          {m.pending ? ', pending' : ''})
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label="Role on this deal"
                      className="input !h-9 w-40"
                      placeholder="Editor, designer…"
                      maxLength={40}
                      value={r.label}
                      onChange={(e) =>
                        setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                      }
                    />
                    <div className="flex items-center gap-1">
                      <input
                        aria-label="Share percent"
                        className="input !h-9 w-20 text-right"
                        inputMode="decimal"
                        value={r.pct}
                        onChange={(e) =>
                          setRows(rows.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))
                        }
                      />
                      <span className="text-[13px] text-umber">%</span>
                    </div>
                    <span className="t-num w-20 text-right text-[12.5px] text-umber">
                      {Number.isFinite(toBp(r.pct)) && toBp(r.pct) > 0
                        ? money(shareOf(t.amountMinor, toBp(r.pct)), cur)
                        : '-'}
                    </span>
                    <button
                      type="button"
                      className="icon-btn icon-btn-sm"
                      aria-label="Remove"
                      onClick={() => setRows(rows.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={13} strokeWidth={1.75} />
                    </button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <button
                    type="button"
                    className="btn-ghost btn-xs text-teal"
                    onClick={() => setRows([...rows, { userId: '', pct: '', label: '' }])}
                    disabled={rows.length >= 10}
                  >
                    <Plus size={13} strokeWidth={2} /> Add person
                  </button>
                  <span
                    className={`t-num text-[12.5px] ${totalBp === 10000 ? '!text-teal' : '!text-danger'}`}
                    data-testid="team-total"
                  >
                    Total {pctText(totalBp)}
                  </span>
                </div>
                {problems.length > 0 && (
                  <ul className="rounded-lg bg-st-failed-bg px-3 py-2 text-[12.5px] text-st-failed">
                    {problems.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                )}
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    className="btn-ghost btn-xs"
                    onClick={() => setEditing(null)}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn-primary btn-xs"
                    onClick={() => void save(t.key)}
                    disabled={busy || rows.some((r) => !r.userId)}
                  >
                    {busy ? 'Checking…' : 'Save team'}
                  </button>
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {t.payees.map((p) => {
                  const m = memberOf(p.userId)
                  return (
                    <li key={p.userId} className="flex items-center gap-3 px-3 py-2.5">
                      <Avatar
                        initials={m?.initials ?? initialsOf(p.displayName)}
                        size="sm"
                        tone="tint"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-ink">
                          {m?.name ?? p.displayName ?? 'Payee'}
                        </p>
                        <p className="truncate text-[11.5px] text-umber">
                          {p.displayName || (m ? m.role : 'payee')}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="t-num text-[14px]">{pctText(p.shareBp)}</p>
                        <p className="t-num text-[11.5px] text-umber">
                          {money(shareOf(t.amountMinor, p.shareBp), cur)}
                        </p>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        ))}
      </div>
    </DealCardShell>
  )
}
