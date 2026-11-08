/**
 * Lifecycle stepper + "advance" action for a project, and the creative brief
 * card. Both talk to the real API (transition / approve / schedule / publish,
 * GET/PUT brief) and invalidate cached project data after every write.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Check, FileText, Pencil } from 'lucide-react'
import { statusLabel, projectStatusLabel, type PublishProgress } from '../lib/format'
import { can, type Viewer } from '../lib/viewer'
import { useToast } from './toast'
import { invalidateProjectData } from '../lib/data'
import {
  approveVersion,
  getBrief,
  listVersions,
  saveBrief,
  transitionProject,
  type Brief,
} from '../services/api'

/** Macro stages shown in the stepper, each owning a set of backend statuses. */
const STAGES: { key: string; label: string; statuses: string[] }[] = [
  { key: 'idea', label: 'Idea', statuses: ['IDEA', 'APPROVED_CONCEPT'] },
  { key: 'brief', label: 'Brief', statuses: ['ASSIGNED', 'WAITING_FOR_INPUTS', 'INPUTS_READY'] },
  { key: 'production', label: 'Production', statuses: ['IN_PROGRESS'] },
  {
    key: 'review',
    label: 'Review',
    statuses: [
      'FIRST_DRAFT_SUBMITTED',
      'UNDER_REVIEW',
      'REVISION_REQUESTED',
      'REVISION_IN_PROGRESS',
      'REVISION_SUBMITTED',
    ],
  },
  { key: 'approved', label: 'Approved', statuses: ['APPROVED'] },
  { key: 'scheduled', label: 'Scheduled', statuses: ['SCHEDULED'] },
  { key: 'published', label: 'Published', statuses: ['PUBLISHED', 'CLOSED'] },
]

/** The happy-path next status for each state (mirrors ALLOWED_TRANSITIONS on the API). */
const NEXT: Record<string, string> = {
  IDEA: 'ASSIGNED',
  APPROVED_CONCEPT: 'ASSIGNED',
  ASSIGNED: 'IN_PROGRESS',
  WAITING_FOR_INPUTS: 'INPUTS_READY',
  INPUTS_READY: 'IN_PROGRESS',
  IN_PROGRESS: 'FIRST_DRAFT_SUBMITTED',
  FIRST_DRAFT_SUBMITTED: 'UNDER_REVIEW',
  UNDER_REVIEW: 'APPROVED',
  REVISION_REQUESTED: 'REVISION_IN_PROGRESS',
  REVISION_IN_PROGRESS: 'REVISION_SUBMITTED',
  REVISION_SUBMITTED: 'APPROVED',
  APPROVED: 'SCHEDULED',
  SCHEDULED: 'PUBLISHED',
}

function stageIndex(status: string) {
  const i = STAGES.findIndex((s) => s.statuses.includes(status))
  return i === -1 ? 0 : i
}

export function ProjectLifecycle({
  projectId,
  status,
  viewer,
  publishProgress,
}: {
  projectId: string
  status: string
  viewer: Viewer
  publishProgress?: PublishProgress | null
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  const current = stageIndex(status)
  const next = NEXT[status]
  const cancelled = status === 'CANCELLED'

  const allowed = (() => {
    if (!next) return false
    if (next === 'APPROVED') return can(viewer, 'approve')
    if (next === 'SCHEDULED') return can(viewer, 'schedule')
    if (next === 'PUBLISHED') return can(viewer, 'publish')
    return can(viewer, 'upload') // editors/admins drive production transitions
  })()

  const advance = async () => {
    if (!next || busy) return
    setBusy(true)
    try {
      if (next === 'APPROVED') {
        const versions = await listVersions(projectId)
        if (!versions.length) throw new Error('Upload a draft version before approving.')
        await approveVersion(projectId, versions[0].id)
      } else if (next === 'SCHEDULED') {
        // Scheduling picks channels, caption and time - that lives in the composer.
        navigate(`/publishing/compose?project=${projectId}`)
        return
      } else if (next === 'PUBLISHED') {
        // Publishing state comes from the scheduled posts themselves (one per
        // channel); a manual publish here would create a duplicate. Send the
        // user to the calendar where each post can be published/marked live.
        navigate(`/publishing/calendar?project=${projectId}`)
        return
      } else {
        await transitionProject(projectId, next)
      }
      invalidateProjectData(projectId)
      toast('success', 'Project moved', `Now: ${statusLabel(next)}`)
    } catch (err: any) {
      toast('danger', 'Could not move project', err?.message || 'Try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card p-5" aria-label="Project lifecycle" data-testid="lifecycle">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="micro-label">Lifecycle</p>
          <p className="mt-1 font-headline text-base font-semibold tracking-tight text-ink">
            {projectStatusLabel({ status, publishProgress })}
          </p>
        </div>
        {next && !cancelled && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={advance}
              disabled={!allowed || busy}
              className="btn-primary"
              data-testid="advance-stage"
              title={allowed ? undefined : 'Your role cannot make this move'}
            >
              {busy
                ? 'Moving…'
                : next === 'APPROVED'
                  ? 'Approve latest version'
                  : next === 'PUBLISHED'
                    ? 'Open scheduled posts'
                    : next === 'SCHEDULED'
                      ? 'Schedule post'
                      : `Move to ${statusLabel(next)}`}
              {!busy && <ArrowRight size={14} strokeWidth={1.75} />}
            </button>
          </div>
        )}
      </div>

      <ol className="mt-5 grid grid-cols-7 gap-2">
        {STAGES.map((s, i) => {
          const done = !cancelled && i < current
          const active = !cancelled && i === current
          return (
            <li key={s.key} className="min-w-0">
              <div
                className={`h-1.5 rounded-full transition-colors duration-500 ${done ? 'bg-teal' : active ? 'bg-teal/60' : 'bg-line'}`}
              />
              <div className="mt-2 flex items-center gap-1.5">
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-xs ${
                    done
                      ? 'bg-teal text-on-accent'
                      : active
                        ? 'border-2 border-teal bg-surface'
                        : 'border border-line bg-surface'
                  }`}
                  aria-hidden="true"
                >
                  {done && <Check size={10} strokeWidth={3} />}
                </span>
                <span
                  className={`truncate text-[12px] ${active ? 'font-semibold text-ink' : done ? 'text-ink/80' : 'text-label'}`}
                >
                  {s.label}
                </span>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

const EMPTY_BRIEF: Brief = {
  goal: '',
  targetAudience: '',
  videoType: '',
  deliverables: [],
  references: [],
  deadline: null,
  specialInstructions: '',
}

export function BriefCard({ projectId, viewer }: { projectId: string; viewer: Viewer }) {
  const toast = useToast()
  const [brief, setBrief] = useState<Brief | null>(null)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<Brief>(EMPTY_BRIEF)
  const [deliverablesText, setDeliverablesText] = useState('')
  const [saving, setSaving] = useState(false)
  const canEdit = can(viewer, 'upload')

  useEffect(() => {
    let active = true
    getBrief(projectId).then((b) => {
      if (!active) return
      const real = b && (b as any).exists !== false ? b : null
      setBrief(real)
    })
    return () => {
      active = false
    }
  }, [projectId])

  const startEdit = () => {
    const b = brief ?? EMPTY_BRIEF
    setForm({ ...EMPTY_BRIEF, ...b })
    setDeliverablesText((b.deliverables ?? []).join('\n'))
    setEditing(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      const payload: Brief = {
        goal: form.goal || '',
        targetAudience: form.targetAudience || '',
        videoType: form.videoType || '',
        deliverables: deliverablesText
          .split('\n')
          .map((d) => d.trim())
          .filter(Boolean),
        references: form.references ?? [],
        deadline: form.deadline ? new Date(form.deadline).toISOString() : null,
        specialInstructions: form.specialInstructions || '',
      }
      const saved = await saveBrief(projectId, payload)
      setBrief(saved)
      setEditing(false)
      toast('success', 'Brief saved', 'Everyone on the project sees the same brief.')
    } catch (err: any) {
      toast('danger', 'Could not save brief', err?.message || 'Try again')
    } finally {
      setSaving(false)
    }
  }

  const deadline = brief?.deadline ? new Date(brief.deadline) : null

  return (
    <div className="card p-0" data-testid="brief-card">
      <header className="card-head justify-between">
        <h2 className="card-title flex items-center gap-2">
          <FileText size={16} strokeWidth={1.75} className="text-teal" /> Creative brief
        </h2>
        {canEdit && !editing && (
          <button onClick={startEdit} className="btn-ghost btn-sm" data-testid="edit-brief">
            <Pencil size={13} strokeWidth={1.75} /> {brief ? 'Edit' : 'Write brief'}
          </button>
        )}
      </header>

      {editing ? (
        <div className="space-y-3 px-5 py-4">
          <div>
            <label className="label" htmlFor="brief-goal">
              Goal
            </label>
            <textarea
              id="brief-goal"
              rows={2}
              className="input w-full"
              value={form.goal ?? ''}
              onChange={(e) => setForm({ ...form, goal: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="brief-aud">
                Audience
              </label>
              <input
                id="brief-aud"
                className="input"
                value={form.targetAudience ?? ''}
                onChange={(e) => setForm({ ...form, targetAudience: e.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="brief-type">
                Format
              </label>
              <input
                id="brief-type"
                className="input"
                value={form.videoType ?? ''}
                onChange={(e) => setForm({ ...form, videoType: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="brief-del">
              Deliverables (one per line)
            </label>
            <textarea
              id="brief-del"
              rows={3}
              className="input w-full"
              value={deliverablesText}
              onChange={(e) => setDeliverablesText(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="brief-deadline">
              Deadline
            </label>
            <input
              id="brief-deadline"
              type="date"
              className="input w-auto"
              value={form.deadline ? String(form.deadline).slice(0, 10) : ''}
              onChange={(e) => setForm({ ...form, deadline: e.target.value || null })}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button className="btn-ghost" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={save}
              disabled={saving}
              data-testid="save-brief"
            >
              {saving ? 'Saving…' : 'Save brief'}
            </button>
          </div>
        </div>
      ) : brief ? (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="micro-label">Goal</dt>
            <dd className="mt-1 text-sm leading-relaxed text-ink/85">{brief.goal || '—'}</dd>
          </div>
          <div>
            <dt className="micro-label">Audience</dt>
            <dd className="mt-1 text-sm text-ink/85">{brief.targetAudience || '—'}</dd>
          </div>
          <div>
            <dt className="micro-label">Format · deadline</dt>
            <dd className="mt-1 text-sm text-ink/85">
              {brief.videoType || '—'}
              {deadline && !isNaN(deadline.getTime())
                ? ` · ${deadline.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
                : ''}
            </dd>
          </div>
          {!!brief.deliverables?.length && (
            <div className="sm:col-span-2">
              <dt className="micro-label">Deliverables</dt>
              <dd className="mt-1.5 flex flex-wrap gap-1.5">
                {brief.deliverables.map((d) => (
                  <span key={d} className="rounded-full bg-tint px-2.5 py-1 text-[12px] text-teal">
                    {d}
                  </span>
                ))}
              </dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="px-5 py-8 text-center text-sm text-umber">No brief yet</p>
      )}
    </div>
  )
}
