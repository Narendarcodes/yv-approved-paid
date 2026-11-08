/**
 * LiveChecksCard: what the Video QA agent measured on a submitted version.
 * One slim row per checklist line: pass/fail dot, name, measured vs target,
 * and a time chip. Failed lines open with the evidence frame and the reason;
 * passed lines open on click.
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
import { DealCardShell } from './common'
import { HINT } from '../../lib/copy'

/** Unit for a measure: the signed unit, else the metric's suffix (duration_s -> s). */
function unitOf(m?: DealMeasure): string {
  if (!m) return ''
  if (m.unit) return m.unit
  if (/_s$/.test(m.metric)) return 's'
  if (/_lufs$/.test(m.metric)) return 'LUFS'
  return ''
}
const OP: Record<string, string> = { '<=': '≤', '>=': '≥', '==': '=' }
function target(m?: DealMeasure): string {
  if (!m) return '—'
  const u = unitOf(m) ? ` ${unitOf(m)}` : ''
  const w = m.window ? ` ${ts(m.window[0])}–${ts(m.window[1])}` : ''
  switch (m.op) {
    case 'between':
      return `${m.value} to ${m.max}${u}`
    case 'present':
      return `present${w}`
    case 'absent':
      return `absent${w}`
    default:
      return `${OP[m.op] ?? m.op} ${m.value}${u}${w}`
  }
}
function shown(v: unknown, m?: DealMeasure): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'present' : 'absent'
  const u = typeof v === 'number' && unitOf(m) ? ` ${unitOf(m)}` : ''
  return `${v}${u}`
}
const ts = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** Seek the reel's player when one is on the page; returns false when there is none. */
function seekReel(seconds: number): boolean {
  const v = document.querySelector<HTMLVideoElement>('video[data-reel-player]')
  if (!v) return false
  v.currentTime = seconds
  v.scrollIntoView({ behavior: 'smooth', block: 'center' })
  void v.play?.().catch(() => undefined)
  return true
}

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
  const [open, setOpen] = useState<Record<string, boolean>>({})
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

  const machine = terms.checklist.filter((c) => c.kind !== 'taste')
  const taste = terms.checklist.filter((c) => c.kind === 'taste')
  const verdict = (c: DealChecklistItem): boolean | null => {
    const r = byId.get(c.id)
    if (!r || r.status === 'not_measurable' || version?.checks?.unmeasured?.includes(c.id))
      return null
    return r.passed
  }
  const passedCount = machine.filter((c) => verdict(c) === true).length
  const isOpen = (c: DealChecklistItem) => open[c.id] ?? verdict(c) !== true // failed and unmeasured start open

  const row = (c: DealChecklistItem) => {
    const r = byId.get(c.id)
    const ok = verdict(c)
    const note = version?.checks?.notes?.[c.id]
    const ev = r?.evidence ?? []
    const first = ev[0]
    const expanded = isOpen(c)
    const hasDetail = ok !== true || !!note || ev.length > 0
    const toggle = () => setOpen((o) => ({ ...o, [c.id]: !expanded }))
    const reason =
      ok === null
        ? 'Not measured: counts as not met until it is.'
        : (note ?? (ok === false ? first?.note : undefined))
    return (
      <li key={c.id} data-testid={`check-${c.id}`} data-passed={String(ok)}>
        <div className="flex min-h-10 items-center gap-3 py-2">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${ok === true ? 'bg-success' : ok === false ? 'bg-danger' : 'bg-warning'}`}
            aria-label={ok === true ? 'Passed' : ok === false ? 'Failed' : 'Not measured'}
            role="img"
          />
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-[13px] text-ink disabled:cursor-default"
            onClick={toggle}
            disabled={!hasDetail}
            aria-expanded={hasDetail ? expanded : undefined}
          >
            {c.text}
          </button>
          <span className="t-num hidden shrink-0 text-[12px] text-umber sm:inline">
            {shown(r?.measured, c.measure)} · target {target(c.measure)}
          </span>
          {first && (
            <button
              type="button"
              className="t-num shrink-0 rounded-sm border border-line px-1.5 py-px text-[12px] text-umber hover:border-line-strong hover:text-ink"
              onClick={() => {
                if (!seekReel(first.tStart)) setOpen((o) => ({ ...o, [c.id]: true }))
              }}
              title="Jump to this moment in the reel"
              data-testid={`check-time-${c.id}`}
            >
              {ts(first.tStart)}–{ts(first.tEnd)}
            </button>
          )}
        </div>
        {expanded && hasDetail && (
          <div className="mb-2 flex gap-3 pl-5">
            {first?.screenshot && (
              <a
                href={api.dealEvidenceUrl(orgId, deal.id, first.screenshot)}
                target="_blank"
                rel="noreferrer"
                className="shrink-0"
              >
                <img
                  src={api.dealEvidenceUrl(orgId, deal.id, first.screenshot)}
                  alt={`Evidence ${ts(first.tStart)}–${ts(first.tEnd)}: ${first.note}`}
                  loading="lazy"
                  className="block aspect-video w-[120px] rounded-md border border-line object-cover"
                />
              </a>
            )}
            <div className="min-w-0 text-[12px] leading-5 text-umber">
              <p className="t-num sm:hidden">
                {shown(r?.measured, c.measure)} · target {target(c.measure)}
              </p>
              {reason && <p className={ok === false ? 'text-ink' : ''}>{reason}</p>}
              {ev.slice(reason === first?.note ? 1 : 0).map((e, i) => (
                <p key={i}>
                  <span className="t-num">
                    {ts(e.tStart)}–{ts(e.tEnd)}
                  </span>{' '}
                  {e.note}
                </p>
              ))}
            </div>
          </div>
        )}
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
            {version.id} · {shortHash(version.sha256, 8)}
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
            <span className="text-[12px] text-umber" data-testid="decision-hint">
              {HINT.approve}
            </span>
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
        <p className="text-[13px] text-umber">
          No checked version yet. Checks run when the editor uploads a cut.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[13px] text-ink" data-testid="checks-summary">
              <span className="t-num">
                {passedCount} of {machine.length}
              </span>{' '}
              passed
            </p>
            <p className="text-[12px] text-umber">Checked {when(version.checks?.at)}</p>
          </div>
          <ul className="mt-1 divide-y divide-line">{machine.map(row)}</ul>
          {taste.length > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              <p className="text-[12px] text-umber">
                People decide taste. It costs a revision round, never pay.
              </p>
              <ul className="mt-1">
                {taste.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 py-1.5 text-[13px] text-ink">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full border border-line-strong"
                      aria-hidden="true"
                    />
                    {c.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </DealCardShell>
  )
}
