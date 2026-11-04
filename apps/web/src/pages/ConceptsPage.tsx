import { useEffect, useState } from 'react'
import { Plus, Trophy, ArrowRight } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import Chip, { Modal, PageHeader } from '../components/primitives'
import Avatar from '../components/ui'
import { useViewer, can } from '../lib/viewer'
import { primaryOrgId } from '../lib/data'
import {
  listConcepts,
  createConcept,
  approveConcept,
  declineConcept,
  getTopPerformers,
  type Concept,
  type TopPerformers,
} from '../services/api'
import { compact } from '../lib/publishing'
import { SimulatedBadge, pctText } from '../components/charts'
import { PlatformIcon } from '../components/status'
import { initialsOf } from '../lib/initials'

const TYPE_LABEL: Record<Concept['type'], string> = {
  'New Concept': 'New Concept',
  Experiment: 'Experiment',
  Revision: 'Revision',
}

export default function ConceptsPage() {
  const viewer = useViewer()
  const mayManage = can(viewer, 'manage_concepts')
  // Approve/decline mirror the API (ADR-0019): concept.review, and only admins
  // may approve a concept they proposed themselves.
  const mayReview = can(viewer, 'review_concepts')
  const mayApprove = (c: { proposer?: string | null }) =>
    mayReview && (c.proposer !== viewer.id || can(viewer, 'manage_members'))

  const [concepts, setConcepts] = useState<Concept[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  // propose modal
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [type, setType] = useState<Concept['type']>('New Concept')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const navigate = useNavigate()
  const [top, setTop] = useState<TopPerformers | null>(null)
  // concept -> project conversion (project + pre-filled brief in one step)
  const [converting, setConverting] = useState<Concept | null>(null)
  const [conv, setConv] = useState({
    goal: '',
    audience: '',
    deliverables: '',
    deadline: '',
    client: '',
    campaign: '',
  })

  useEffect(() => {
    primaryOrgId()
      .then((orgId) => (orgId ? getTopPerformers(orgId) : null))
      .then(setTop)
      .catch(() => setTop(null))
  }, [])

  const openConvert = (c: Concept) => {
    setConv({
      goal: c.description,
      audience: '',
      deliverables: '',
      deadline: '',
      client: '',
      campaign: '',
    })
    setConverting(c)
  }

  const load = () => {
    setLoading(true)
    setLoadError(false)
    primaryOrgId()
      .then((orgId) => (orgId ? listConcepts(orgId) : []))
      .then((cs) => {
        setConcepts(cs)
        setLoading(false)
      })
      .catch(() => {
        setLoadError(true)
        setLoading(false)
      })
  }

  useEffect(load, [])

  const openIdeas = concepts.filter((c) => c.status === 'IDEA')
  const decided = concepts.filter((c) => c.status !== 'IDEA')

  const submit = async () => {
    if (!title.trim() || !description.trim() || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const orgId = await primaryOrgId()
      await createConcept(orgId!, {
        title: title.trim(),
        description: description.trim(),
        type,
      })
      setOpen(false)
      setTitle('')
      setDescription('')
      setType('New Concept')
      load() // refetch so the new concept shows immediately
    } catch {
      setSubmitError('Could not save the concept. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const approve = async (id: string) => {
    setBusyId(id)
    try {
      const orgId = await primaryOrgId()
      const { projectId } = await approveConcept(orgId!, id, {
        client: conv.client.trim(),
        campaign: conv.campaign.trim(),
        brief: {
          goal: conv.goal.trim(),
          targetAudience: conv.audience.trim(),
          deliverables: conv.deliverables
            .split(/[,\n]/)
            .map((x) => x.trim())
            .filter(Boolean),
          deadline: conv.deadline || null,
        },
      })
      setConverting(null)
      navigate(`/projects/${projectId}`)
    } catch {
      setSubmitError('Approve failed — is the concept still open?')
    } finally {
      setBusyId(null)
    }
  }

  const decline = async (id: string) => {
    setBusyId(id)
    try {
      const orgId = await primaryOrgId()
      await declineConcept(orgId!, id)
      load()
    } catch {
      setSubmitError('Decline failed — is the concept still open?')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="fade-in space-y-8">
      <PageHeader
        title="Concepts"
        subtitle="Every content idea the team is weighing, before it becomes a project."
        actions={
          mayManage ? (
            <button className="btn-primary" onClick={() => setOpen(true)}>
              <Plus size={14} strokeWidth={2} />
              Propose a concept
            </button>
          ) : undefined
        }
      />

      {loadError && (
        <div className="card flex items-center justify-between gap-4 border-danger/30 p-4">
          <p className="text-sm text-danger">Couldn't load concepts.</p>
          <button className="btn-secondary btn-sm" onClick={load}>
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="card h-24 animate-pulse bg-surface" />
          ))}
        </div>
      ) : (
        <>
          {top && top.items.length > 0 && (
            <section className="card p-5" data-testid="top-performers">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Trophy size={16} strokeWidth={1.75} className="text-teal" />
                <h2 className="card-title">What worked in {top.label}</h2>
                <SimulatedBadge show={!!top.simulated} />
                <Link
                  to="/analytics"
                  className="ml-auto text-xs font-medium text-teal hover:underline"
                >
                  All analytics →
                </Link>
              </div>
              <p className="mb-3 text-xs text-umber">
                Last month's best performers by engagement rate - build the next idea on what
                landed.
              </p>
              <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {top.items.map((t, i) => (
                  <li key={t.projectId} className="rounded-[10px] border border-line p-3">
                    <div className="flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ink font-mono text-[10px] text-white">
                        {i + 1}
                      </span>
                      <Link
                        to={`/projects/${t.projectId}`}
                        className="min-w-0 flex-1 truncate text-sm font-medium text-ink hover:text-teal"
                      >
                        {t.title}
                      </Link>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      {t.platforms.map((p) => (
                        <PlatformIcon key={p} platform={p} size="sm" />
                      ))}
                      <span className="ml-auto font-mono text-xs text-ink">
                        {compact(t.views)} views
                      </span>
                      <span className="font-mono text-xs font-medium text-teal">
                        {pctText(t.engagementRate)}
                      </span>
                    </div>
                    {t.concept && (
                      <p className="mt-1.5 truncate text-[11px] text-umber">
                        From concept: {t.concept.title}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}

          <div className="space-y-4">
            {openIdeas.map((c) => (
              <article key={c.id} className="card flex flex-wrap items-start gap-4 p-5">
                <Avatar initials={initialsOf(c.proposerName)} size="md" tone="tint" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-headline text-[15px] font-semibold tracking-tight text-ink">
                      {c.title}
                    </h3>
                    <Chip label={TYPE_LABEL[c.type]} tone="neutral" />
                    <Chip label="Open for discussion" tone="warning" dot />
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink/80">{c.description}</p>
                  {c.proposerName && (
                    <p className="mt-2 text-xs text-umber">Proposed by {c.proposerName}</p>
                  )}
                </div>

                {mayReview && (
                  <div className="flex items-center gap-2">
                    {mayApprove(c) && (
                      <button
                        className="btn-secondary btn-sm"
                        disabled={busyId === c.id}
                        onClick={() => openConvert(c)}
                        data-testid="concept-convert"
                      >
                        Approve &amp; start project
                      </button>
                    )}
                    <button
                      className="btn-ghost btn-sm text-danger"
                      disabled={busyId === c.id}
                      onClick={() => decline(c.id)}
                    >
                      Decline
                    </button>
                  </div>
                )}
              </article>
            ))}

            {!openIdeas.length && !decided.length && (
              <div className="card p-12 text-center">
                <p className="text-sm text-umber">No concepts in the pipeline right now.</p>
                {mayManage && (
                  <button className="btn-primary mt-4" onClick={() => setOpen(true)}>
                    <Plus size={14} strokeWidth={2} /> Propose the first idea
                  </button>
                )}
              </div>
            )}
          </div>

          {decided.length > 0 && (
            <section>
              <h2 className="micro-label">Decided</h2>
              <div className="mt-3 space-y-2">
                {decided.map((c) => (
                  <div key={c.id} className="card flex flex-wrap items-center gap-3 p-4 opacity-80">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${c.status === 'APPROVED' ? 'bg-success' : 'bg-danger/60'}`}
                    />
                    <p className="min-w-0 flex-1 truncate text-sm text-ink">{c.title}</p>
                    {c.status === 'APPROVED' && c.approvedProjectId ? (
                      <Link
                        to={`/projects/${c.approvedProjectId}`}
                        className="text-xs font-medium text-teal hover:underline"
                      >
                        View project →
                      </Link>
                    ) : (
                      <Chip label="Declined" tone="danger" />
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Concept -> project (+ brief) */}
      <Modal
        open={!!converting}
        onClose={() => setConverting(null)}
        title={converting ? `Start project: ${converting.title}` : 'Start project'}
      >
        {converting && (
          <div className="space-y-3" data-testid="convert-modal">
            <p className="text-xs text-umber">
              Creates the project and its creative brief in one step. Everything here can be edited
              later on the project.
            </p>
            <label className="label block" htmlFor="cv-goal">
              Goal
            </label>
            <textarea
              id="cv-goal"
              rows={3}
              className="input w-full"
              value={conv.goal}
              onChange={(e) => setConv({ ...conv, goal: e.target.value })}
            />
            <label className="label block" htmlFor="cv-aud">
              Audience
            </label>
            <input
              id="cv-aud"
              className="input w-full"
              placeholder="Who is this for?"
              value={conv.audience}
              onChange={(e) => setConv({ ...conv, audience: e.target.value })}
            />
            <label className="label block" htmlFor="cv-del">
              Deliverables
            </label>
            <input
              id="cv-del"
              className="input w-full"
              placeholder="30s reel, cover still"
              value={conv.deliverables}
              onChange={(e) => setConv({ ...conv, deliverables: e.target.value })}
              data-testid="convert-deliverables"
            />
            <div className="grid grid-cols-3 gap-3">
              <label className="label">
                Deadline
                <input
                  type="date"
                  className="input mt-1 w-full"
                  value={conv.deadline}
                  onChange={(e) => setConv({ ...conv, deadline: e.target.value })}
                />
              </label>
              <label className="label">
                Client
                <input
                  className="input mt-1 w-full"
                  value={conv.client}
                  onChange={(e) => setConv({ ...conv, client: e.target.value })}
                />
              </label>
              <label className="label">
                Campaign
                <input
                  className="input mt-1 w-full"
                  value={conv.campaign}
                  onChange={(e) => setConv({ ...conv, campaign: e.target.value })}
                />
              </label>
            </div>
            {submitError && (
              <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{submitError}</p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button className="btn-ghost" onClick={() => setConverting(null)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={busyId === converting.id}
                onClick={() => void approve(converting.id)}
                data-testid="convert-submit"
              >
                {busyId === converting.id ? 'Creating…' : 'Create project & brief'}{' '}
                <ArrowRight size={14} strokeWidth={1.75} />
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Propose a concept */}
      <Modal open={open} onClose={() => setOpen(false)} title="Propose a concept">
        <label className="label" htmlFor="cn-title">
          Title
        </label>
        <input
          id="cn-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          placeholder="e.g. A short series on Puranic mothers"
          className="input mt-1.5 w-full"
        />

        <label className="label mt-4 block" htmlFor="cn-type">
          Type
        </label>
        <select
          id="cn-type"
          value={type}
          onChange={(e) => setType(e.target.value as Concept['type'])}
          className="input mt-1.5 w-full"
        >
          <option value="New Concept">New Concept</option>
          <option value="Experiment">Experiment</option>
          <option value="Revision">Revision</option>
        </select>

        <label className="label mt-4 block" htmlFor="cn-desc">
          What is it?
        </label>
        <textarea
          id="cn-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          placeholder="Describe the idea, format and why it matters for our audience…"
          className="input mt-1.5 w-full"
        />

        {submitError && (
          <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            {submitError}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => void submit()}
            disabled={!title.trim() || !description.trim() || submitting}
          >
            {submitting ? 'Saving…' : 'Propose concept'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
