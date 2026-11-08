/**
 * LiveChecksCard: what the Video QA agent measured on a submitted version.
 * One row per checklist line: measured value vs the signed target, pass/fail,
 * timestamped evidence with screenshots (served by the deal's evidence route).
 * Taste lines are shown as "people decide": no machine verdict on taste.
 *
 * Buttons (client, while the milestone is in review): Approve this version,
 * Request changes. AI checks facts, people own taste, the deal decides the money.
 */
import { useMemo, useState } from 'react'
import { CircleCheck, MessageSquareDiff } from 'lucide-react'
import { useToast } from '../toast'
import * as api from '../../services/api'
import type { DealChecklistItem, DealMeasure, DealView } from '../../contracts/types'
import { milestonePair, shortHash, when } from '../../lib/deals'
import { DealCardShell, PassPill } from './common'

function target(m?: DealMeasure): string {
  if (!m) return '—'
  const u = m.unit ? ` ${m.unit}` : ''
  const w = m.window ? ` in ${m.window[0]}–${m.window[1]}s` : ''
  switch (m.op) {
    case 'between':
      return `${m.value} to ${m.max}${u}`
    case 'present':
      return `present${w}`
    case 'absent':
      return `absent${w}`
    default:
      return `${m.op} ${m.value}${u}${w}`
  }
}
function shown(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  return String(v)
}
const ts = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export default function LiveChecksCard({
  deal,
  orgId,
  milestoneKey,
  onChanged,
  onRequestChanges,
  hideDecisions = false,
}: {
  deal: DealView
  orgId: string
  milestoneKey: string
  onChanged?: () => void
  onRequestChanges?: () => void
  /** On a Fair Review Clock milestone the clock card carries the decisions. */
  hideDecisions?: boolean
}) {
  const toast = useToast()
  const pair = milestonePair(deal, milestoneKey)
  const checked = useMemo(() => (pair?.runtime.versions ?? []).filter((v) => v.checks), [pair])
  const [pick, setPick] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!pair) return null
  const { terms, runtime } = pair
  const version = checked.find((v) => v.id === pick) ?? checked[checked.length - 1]
  const latest = runtime.versions[runtime.versions.length - 1]
  const byId = new Map((version?.checks?.results ?? []).map((r) => [r.checklistId, r]))
  const canDecide =
    !hideDecisions && deal.me === 'client' && runtime.state === 'IN_REVIEW' && !!latest

  const approve = async () => {
    if (!latest) return
    setBusy(true)
    try {
      await api.approveMilestone(orgId, deal.id, milestoneKey, latest.id)
      toast('success', 'Approved', 'The Money Agent captures the signed amount through policy.')
      onChanged?.()
    } catch (e: any) {
      toast('danger', 'Could not approve', e?.message || 'Try again')
    } finally {
      setBusy(false)
    }
  }

  const row = (c: DealChecklistItem) => {
    if (c.kind === 'taste')
      return (
        <li key={c.id} className="flex items-start gap-3 py-2.5">
          <span className="status-chip bg-st-idea-bg text-st-idea">Taste</span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-ink">{c.text}</p>
            <p className="text-[12px] text-umber">
              People decide. Taste costs a revision round, never pay.
            </p>
          </div>
        </li>
      )
    const r = byId.get(c.id)
    const unmeasured =
      !r || r.status === 'not_measurable' || version?.checks?.unmeasured?.includes(c.id)
    const note = version?.checks?.notes?.[c.id]
    return (
      <li key={c.id} className="flex items-start gap-3 py-2.5" data-testid={`check-${c.id}`}>
        <PassPill passed={unmeasured ? null : r?.passed} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-ink">{c.text}</p>
          <p className="font-mono text-xs text-label">
            {c.measure?.metric}: measured {shown(r?.measured)} · target {target(c.measure)}
          </p>
          {unmeasured && (
            <p className="text-[12px] text-warning">Not measured: counts as not met until it is.</p>
          )}
          {note && <p className="mt-0.5 text-[12px] text-umber">{note}</p>}
          {!!r?.evidence?.length && (
            <div className="mt-2 flex flex-wrap gap-2">
              {r.evidence.map((e, i) => (
                <figure
                  key={i}
                  className="w-[148px] overflow-hidden rounded-lg border border-line bg-canvas"
                >
                  {e.screenshot ? (
                    <a
                      href={api.dealEvidenceUrl(orgId, deal.id, e.screenshot)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img
                        src={api.dealEvidenceUrl(orgId, deal.id, e.screenshot)}
                        alt={`Evidence ${ts(e.tStart)}–${ts(e.tEnd)}: ${e.note}`}
                        loading="lazy"
                        className="block h-[84px] w-full object-cover"
                      />
                    </a>
                  ) : (
                    <div className="h-[36px]" />
                  )}
                  <figcaption className="px-2 py-1 text-xs leading-snug text-umber">
                    <span className="font-mono text-label">
                      {ts(e.tStart)}–{ts(e.tEnd)}
                    </span>{' '}
                    {e.note}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      </li>
    )
  }

  return (
    <DealCardShell
      testId="live-checks-card"
      label="Live checks"
      title={terms.title}
      meta={
        version ? (
          <span className="font-mono text-xs text-label">
            VERSION {version.id} · {shortHash(version.sha256, 8)}
          </span>
        ) : undefined
      }
      footer={
        canDecide ? (
          <>
            <button className="btn-primary" disabled={busy} onClick={approve}>
              <CircleCheck size={15} strokeWidth={2} />
              Approve {latest.id}
            </button>
            <button className="btn-secondary" disabled={busy} onClick={onRequestChanges}>
              <MessageSquareDiff size={15} strokeWidth={2} />
              Request changes
            </button>
          </>
        ) : undefined
      }
    >
      {checked.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Versions">
          {checked.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={v.id === version?.id}
              onClick={() => setPick(v.id)}
              className={`rounded-full border px-2.5 py-1 text-xs ${
                v.id === version?.id ? 'border-teal bg-teal/10 text-teal' : 'border-line text-umber'
              }`}
            >
              {v.id} {v.checks?.passed ? '· pass' : '· fail'}
            </button>
          ))}
        </div>
      )}
      {!version ? (
        <p className="text-[13px] text-umber">No checked version yet</p>
      ) : (
        <>
          <p className="text-[12px] text-umber">
            Checked {when(version.checks?.at)} ·{' '}
            {version.checks?.passed ? (
              <span className="text-success">every signed check passed</span>
            ) : (
              <span className="text-danger">{version.checks?.failed.length} check(s) not met</span>
            )}
          </p>
          <ul className="mt-2 divide-y divide-line">{terms.checklist.map(row)}</ul>
        </>
      )}
    </DealCardShell>
  )
}
