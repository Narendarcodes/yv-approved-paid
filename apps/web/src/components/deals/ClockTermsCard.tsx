/**
 * ClockTermsCard ("Review terms"): the Fair Review Clock terms of one
 * milestone. Before both sides sign, either party can set them (defaults: 3
 * business days, 50% on silence, 3 grace days, 2 included rounds, an optional
 * backup reviewer); every change is dry-run on the server, which previews
 * "if you deliver today, review ends ...". Saving clears the signatures, so both
 * sides sign the new terms. Once signed the terms are shown read-only with a lock.
 */
import { useEffect, useMemo, useState } from 'react'
import { Lock, Timer } from 'lucide-react'
import { useToast } from '../toast'
import * as api from '../../services/api'
import type { ClockTermsPlan, ClockTermsSpec } from '../../services/api'
import type { DealView } from '../../contracts/types'
import { useTeam } from '../../lib/data'
import { money } from '../../lib/deals'
import { CLOCK_DEFAULTS, clockTermsOf } from '../../lib/clock'
import { DealCardShell } from './common'

type NumKey = keyof typeof CLOCK_DEFAULTS
const FIELDS: {
  key: NumKey
  label: string
  min: number
  max: number
  unit: string
  help: (n: number) => string
}[] = [
  {
    key: 'reviewWindowBusinessDays',
    label: 'Review window',
    min: 2,
    max: 10,
    unit: 'business days',
    help: (n) =>
      `The client has ${n} business days (to 6 PM their time) to approve or ask for changes once checks pass.`,
  },
  {
    key: 'partialReleasePct',
    label: 'Released on silence',
    min: 0,
    max: 90,
    unit: '%',
    help: (n) =>
      n > 0
        ? `If the window ends with no reply, ${n}% of the milestone releases to the team right away.`
        : 'Nothing releases when the window ends; only the grace release pays.',
  },
  {
    key: 'graceBusinessDays',
    label: 'Grace period',
    min: 0,
    max: 10,
    unit: 'business days',
    help: (n) =>
      n > 0
        ? `After the window, ${n} more business days before the rest releases too.`
        : 'No grace: the rest releases when the window ends.',
  },
  {
    key: 'includedRevisionRounds',
    label: 'Included revision rounds',
    min: 0,
    max: 10,
    unit: 'rounds',
    help: (n) =>
      `${n} change request${n === 1 ? '' : 's'} included; each one pauses the clock. More become a paid change order.`,
  },
]

export default function ClockTermsCard({
  deal,
  orgId,
  milestoneKey,
  onChanged,
}: {
  deal: DealView
  orgId: string
  milestoneKey: string
  onChanged?: () => void
}) {
  const toast = useToast()
  const { team } = useTeam()
  const t = deal.terms.milestones.find((m) => m.key === milestoneKey)
  const signed = clockTermsOf(t)
  const locked = !!deal.termsHash
  const canEdit = !locked && !!deal.me
  const cur = deal.terms.currency
  const initial = useMemo(
    () =>
      ({
        ...CLOCK_DEFAULTS,
        ...Object.fromEntries(Object.entries(signed || {}).filter(([, v]) => v !== undefined)),
      }) as typeof CLOCK_DEFAULTS & { backupReviewerId?: string },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(signed)],
  )
  const [on, setOn] = useState(!!signed || canEdit)
  const [form, setForm] = useState(initial)
  const [plan, setPlan] = useState<ClockTermsPlan | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setForm(initial)
    setOn(!!signed || canEdit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial])

  const spec: ClockTermsSpec | null = on
    ? {
        reviewWindowBusinessDays: form.reviewWindowBusinessDays,
        partialReleasePct: form.partialReleasePct,
        graceBusinessDays: form.graceBusinessDays,
        includedRevisionRounds: form.includedRevisionRounds,
        ...(form.backupReviewerId ? { backupReviewerId: form.backupReviewerId } : {}),
      }
    : null
  const specKey = JSON.stringify(spec)

  // live preview: dry run on the server (business days, bank holidays, the reviewer's timezone)
  useEffect(() => {
    if (!t || (!spec && !signed)) {
      setPlan(null)
      return
    }
    const body = spec ?? signed ?? null
    let alive = true
    const h = window.setTimeout(() => {
      api
        .checkClockTerms(orgId, deal.id, milestoneKey, body)
        .then((p) => alive && setPlan(p))
        .catch(() => alive && setPlan(null))
    }, 250)
    return () => {
      alive = false
      window.clearTimeout(h)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, orgId, deal.id, milestoneKey])

  if (!t) return null
  if (locked && !signed) return null

  const dirty = JSON.stringify(spec) !== JSON.stringify(signed ? { ...signed } : null)
  const reviewers = team.filter(
    (m) => !m.disabled && m.id !== deal.terms.worker.userId && m.id !== deal.terms.client.userId,
  )
  const backupName = (id?: string) =>
    id ? team.find((m) => m.id === id)?.name || 'A team member' : 'None'

  const save = async () => {
    setBusy(true)
    try {
      await api.setClockTerms(orgId, deal.id, milestoneKey, spec)
      toast(
        'success',
        spec ? 'Review terms saved' : 'Review clock removed',
        'Signatures were cleared: both sides sign the new terms.',
      )
      onChanged?.()
    } catch (e: any) {
      toast('danger', 'Could not save the review terms', e?.message || 'Try again')
    } finally {
      setBusy(false)
    }
  }

  const values = signed ? { ...CLOCK_DEFAULTS, ...signed } : form
  const preview = plan?.preview

  return (
    <DealCardShell
      testId="clock-terms-card"
      label="Review terms"
      title={`Fair review clock · ${t.title}`}
      meta={
        locked ? (
          <span className="chip chip-neutral" title="Signed by both sides">
            <Lock size={12} strokeWidth={2} aria-hidden="true" className="mr-1" /> Locked at signing
          </span>
        ) : (
          <span className="chip chip-warning">Draft</span>
        )
      }
      footer={
        canEdit ? (
          <>
            <button
              className="btn-primary"
              disabled={busy || !dirty || (!!spec && plan?.allowed === false)}
              onClick={save}
              data-testid="save-clock-terms"
            >
              Save review terms
            </button>
            <label className="ml-auto flex items-center gap-2 text-[13px] text-umber">
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => setOn(e.target.checked)}
                className="accent-[#035E5E]"
              />
              Use the review clock
            </label>
          </>
        ) : undefined
      }
    >
      {locked && signed ? (
        <>
          <ul className="flex flex-wrap gap-2" data-testid="clock-terms-locked">
            {FIELDS.map((f) => (
              <li key={f.key} className="chip chip-neutral" title={f.help(Number(values[f.key]))}>
                {f.label}: {values[f.key]}
                {f.unit === '%' ? '%' : ` ${f.unit}`}
              </li>
            ))}
            <li className="chip chip-neutral">
              Backup reviewer: {backupName(signed.backupReviewerId)}
            </li>
          </ul>
          <p className="mt-2 flex items-center gap-1.5 text-[12px] text-umber">
            <Lock size={16} strokeWidth={1.5} aria-hidden="true" /> Signed with the deal
          </p>
        </>
      ) : !on && canEdit ? (
        <p className="text-[13px] text-umber">No review clock</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <div key={f.key} className="min-w-0">
                <label className="label" htmlFor={`ct-${milestoneKey}-${f.key}`}>
                  {f.label}
                </label>
                {canEdit ? (
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      id={`ct-${milestoneKey}-${f.key}`}
                      type="number"
                      inputMode="numeric"
                      min={f.min}
                      max={f.max}
                      step={1}
                      className="input w-24"
                      value={form[f.key]}
                      onChange={(e) =>
                        setForm((s) => ({
                          ...s,
                          [f.key]:
                            e.target.value === '' ? f.min : Math.round(Number(e.target.value)),
                        }))
                      }
                    />
                    <span className="text-[13px] text-umber">{f.unit}</span>
                  </div>
                ) : (
                  <p className="t-num mt-1 text-[16px]">
                    {values[f.key]}{' '}
                    <span className="text-[13px] font-normal text-umber">{f.unit}</span>
                  </p>
                )}
                <p className="mt-1 text-[12px] leading-snug text-umber">
                  {f.help(Number(values[f.key]))}
                </p>
              </div>
            ))}
            <div className="min-w-0">
              <label className="label" htmlFor={`ct-${milestoneKey}-backup`}>
                Backup reviewer
              </label>
              {canEdit ? (
                <select
                  id={`ct-${milestoneKey}-backup`}
                  className="input mt-1 w-full max-w-xs"
                  value={form.backupReviewerId || ''}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, backupReviewerId: e.target.value || undefined }))
                  }
                >
                  <option value="">None</option>
                  {reviewers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="mt-1 text-[14px] text-ink">{backupName(signed?.backupReviewerId)}</p>
              )}
            </div>
          </div>

          <div
            className="mt-4 flex items-start gap-2.5 rounded-[10px] bg-canvas px-3 py-2.5"
            data-testid="clock-terms-preview"
            aria-live="polite"
          >
            <Timer size={16} className="mt-0.5 shrink-0 text-teal" aria-hidden="true" />
            <div className="min-w-0 text-[13px] text-ink">
              {plan && !plan.allowed ? (
                <p className="text-danger">{plan.problems[0]}</p>
              ) : preview ? (
                <>
                  <p>
                    {locked
                      ? 'Under these terms, a delivery today is reviewed by'
                      : 'If you deliver today, review ends'}{' '}
                    <span className="font-medium">{preview.deadlineText}</span>.
                  </p>
                  <p className="mt-0.5 text-[12px] text-umber">
                    {preview.partialAmountMinor > 0
                      ? `${money(preview.partialAmountMinor, cur)} releases then on silence, `
                      : ''}
                    the rest ({money(preview.remainderMinor, cur)}) by {preview.graceText}.
                  </p>
                </>
              ) : (
                <p className="text-umber">Working out the dates…</p>
              )}
            </div>
          </div>
        </>
      )}
    </DealCardShell>
  )
}
