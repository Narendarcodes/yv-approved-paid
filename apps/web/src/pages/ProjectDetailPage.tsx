import { useState, useRef, useEffect } from 'react'
import { Play, CircleCheck, TriangleAlert, Circle } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { UploadCloud, X } from 'lucide-react'
import Chip, { Modal } from '../components/primitives'
import Avatar, { AvatarStack } from '../components/ui'
import { projectStatusLabel } from '../lib/format'
import { useViewer, can } from '../lib/viewer'
import { useToast } from '../components/toast'
import {
  assignProject,
  assignTask,
  createVersion,
  listTasks,
  listVersions,
  uploadVersionFile,
  type ProjectVersion,
  type TaskItem,
} from '../services/api'
import AssignPicker from '../components/AssignPicker'
import { ProjectLifecycle, BriefCard } from '../components/ProjectLifecycle'
import { ProjectPublishing } from '../components/ProjectPublishing'
import { ProjectPerformance } from '../components/ProjectPerformance'
import {
  invalidateProjectData,
  useProject,
  useProjectInputs,
  useProjectActivity,
  useProjectPublications,
  useReviews,
  useTeam,
} from '../lib/data'
import { StatusChip } from '../components/status'
import { CardSkeleton, Skeleton } from '../components/states'
import { EMPTY_LINE } from '../lib/copy'

function strId(v: unknown): string {
  if (!v) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object' && '_id' in (v as any)) return String((v as any)._id)
  return String(v)
}
function fmtDate(iso?: string | Date): string {
  if (!iso) return ''
  const d = new Date(iso as string)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
function describeEvent(e: any): string {
  const m = e.metadata ?? {}
  switch (e.action) {
    case 'created':
      return 'created this project'
    case 'transitioned':
      return `moved it to ${m.to ?? 'a new stage'}`
    case 'version_uploaded':
      return `uploaded ${m.label ?? 'a new version'}`
    case 'comment_added':
      return 'commented on the draft'
    case 'revision_requested':
      return 'requested a revision'
    case 'approved':
      return `approved ${m.label ?? 'the draft'}`
    case 'scheduled':
      return 'scheduled it for publishing'
    case 'published':
      return 'published the project'
    case 'metric_recorded':
      return 'recorded metrics'
    default:
      return e.action
  }
}

export default function ProjectDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const viewer = useViewer()
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadNote, setUploadNote] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { project, loading: projectLoading } = useProject(id)
  const { team } = useTeam()
  const { inputs: rawInputs } = useProjectInputs(id)
  const { activity: activityRaw } = useProjectActivity(id)
  const { publications } = useProjectPublications(id)
  const [realVersions, setRealVersions] = useState<ProjectVersion[]>([])
  const versionsKey = `${project?.status ?? ''}|${project?.updated ?? ''}|${project?.approvedVersion ?? ''}`
  useEffect(() => {
    let active = true
    if (!id) return
    listVersions(id)
      .then((v) => active && setRealVersions(v))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [id, versionsKey])
  const [tasks, setTasks] = useState<TaskItem[]>([])
  useEffect(() => {
    let active = true
    if (!id) return
    listTasks(id)
      .then((t) => active && setTasks(t))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [id])
  const { reviews: allReviews } = useReviews()
  const memberOf = (mid: string) => team.find((m) => m.id === mid)

  const assignTo = async (userId: string) => {
    if (!project) return
    try {
      await assignProject(project.id, userId)
      invalidateProjectData(project.id)
      toast(
        'success',
        'Assigned',
        `${memberOf(userId)?.name ?? 'A teammate'} is now responsible for ${project.title}.`,
      )
    } catch (err: any) {
      toast('danger', 'Could not assign', err?.message || 'Try again')
      throw err
    }
  }
  const assignTaskTo = async (task: TaskItem, userId: string) => {
    try {
      await assignTask(id, task.id, userId)
      setTasks((ts) => ts.map((t) => (t.id === task.id ? { ...t, assignee: userId } : t)))
      invalidateProjectData(id)
      toast('success', 'Task assigned', `“${task.title}” → ${memberOf(userId)?.name ?? 'teammate'}`)
    } catch (err: any) {
      toast('danger', 'Could not assign the task', err?.message || 'Try again')
      throw err
    }
  }

  // Show loading before 404 — useProject is async via org lookup
  if (projectLoading) {
    return (
      <div className="fade-in space-y-6" aria-busy="true" aria-label="Loading project">
        <div className="space-y-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-72" />
          <Skeleton className="h-3 w-48" />
        </div>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-6">
            <CardSkeleton lines={4} />
            <CardSkeleton lines={3} />
          </div>
          <CardSkeleton lines={5} />
        </div>
      </div>
    )
  }
  // Unknown project id - a real 404 instead of silently showing the first project
  if (!project) {
    return (
      <div className="fade-in card mx-auto max-w-md p-12 text-center">
        <h1 className="font-headline text-lg font-semibold text-ink">Project not found</h1>
        <p className="mt-1 text-sm text-umber">This project doesn&apos;t exist or was removed.</p>
        <Link to="/projects" className="btn-secondary mt-5 inline-flex">
          Back to projects
        </Link>
      </div>
    )
  }

  const isInReview = [
    'FIRST_DRAFT_SUBMITTED',
    'UNDER_REVIEW',
    'REVISION_SUBMITTED',
    'REVISION_IN_PROGRESS',
  ].includes(project.status)
  const reviewsForProject = allReviews.filter((r) => r.projectId === id)
  const hasReview = reviewsForProject.length > 0 || isInReview
  const openComments = reviewsForProject.filter((c) => !c.resolved).length
  const inputs = rawInputs.map((i: any) => ({
    id: strId(i.id ?? i._id),
    title: i.title,
    owner: strId(i.owner),
    state: i.state,
    requestedAt: fmtDate(i.requestedAt),
    receivedAt: i.receivedAt ? fmtDate(i.receivedAt) : undefined,
  }))
  const livePubs = publications.filter((pub: any) => !pub.status || pub.status === 'published')
  const sortedVersions = [...realVersions].sort((x, y) => y.versionNumber - x.versionNumber)
  const versions = sortedVersions.length
    ? sortedVersions.map((v: any) => ({
        id: v.id,
        label: `v${v.versionNumber}`,
        uploadedBy: strId(v.uploader) || project.assignee,
        uploadedAt: fmtDate(v.createdAt) || project.updated,
        summary: v.changeSummary || 'New version uploaded',
      }))
    : [
        {
          id: 'v1',
          label: project.approvedVersion ?? 'v1.0',
          uploadedBy: project.assignee,
          uploadedAt: project.updated,
          summary: 'Current working draft',
        },
      ]
  const projectActivity = activityRaw.map((e: any) => ({
    actor: strId(e.actor),
    text: describeEvent(e),
    time: fmtDate(e.createdAt) || '-',
  }))

  const canComment = can(viewer, 'comment')
  const canUpload = can(viewer, 'upload')
  const canApprove = can(viewer, 'approve')
  const canAssign = can(viewer, 'assign')

  return (
    <div className="fade-in space-y-6">
      {/* Breadcrumb + header */}
      <nav className="micro-label flex items-center gap-1.5">
        <Link to="/projects" className="hover:text-teal">
          Projects
        </Link>
        <span>/</span>
        <span className="text-ink">{project.title}</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="t-display">{project.title}</h1>
            <StatusChip status={project.status} label={projectStatusLabel(project)} />
            <Chip label={project.type} tone="neutral" />
          </div>
          <div
            id="assign"
            className="mt-2 flex scroll-mt-20 flex-wrap items-center gap-2 text-sm text-umber"
          >
            <span className="micro-label">Responsible</span>
            <AssignPicker
              team={team}
              value={project.assignee}
              onAssign={assignTo}
              canAssign={canAssign}
              label="Assign"
              testId="project-assign"
            />
            <span>· updated {project.updated}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {project.status === 'PUBLISHED' && project.postUrl && (
            <a href={project.postUrl} target="_blank" rel="noreferrer" className="btn-secondary">
              View live post on {project.platform}
            </a>
          )}
          {hasReview && (
            <Link to={`/projects/${project.id}/review`} className="btn-primary">
              <Play size={14} strokeWidth={1.75} />
              Open review workspace{openComments ? ` (${openComments})` : ''}
            </Link>
          )}
          {isInReview && canComment && !hasReview && (
            <button
              onClick={() => navigate(`/projects/${project.id}/review`)}
              className="btn-primary"
              title="Open the review workspace for this draft"
            >
              Review draft
            </button>
          )}
          {canUpload && (
            <button
              onClick={() => setUploadOpen(true)}
              className="btn-secondary"
              title="Upload a new cut of this video"
            >
              Upload new version
            </button>
          )}
          {canApprove && !isInReview && project.status !== 'PUBLISHED' && (
            <button
              onClick={() => navigate(`/projects/${project.id}/review`)}
              className="btn-secondary"
              title="Approval happens in the review workspace"
            >
              Approve latest
            </button>
          )}
        </div>
      </div>

      {/* Lifecycle: idea → brief → production → review → approved → scheduled → published */}
      <ProjectLifecycle
        projectId={project.id}
        status={project.status}
        viewer={viewer}
        publishProgress={project.publishProgress}
      />

      {/* Upload new version */}
      <Modal
        open={uploadOpen}
        onClose={() => {
          if (!uploading) setUploadOpen(false)
        }}
        title="Upload a new version"
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            if (!selectedFile || uploading) return
            if (!project?.id) {
              toast('danger', 'No project selected', 'Open a project first, then upload.')
              return
            }
            setUploading(true)
            setUploadProgress(0)
            try {
              // Step 1: create a version entry
              const version = await createVersion(project.id, uploadNote.trim() || 'New version')
              // Step 2: upload the file to that version
              await uploadVersionFile(project.id, version.id, selectedFile, (pct) =>
                setUploadProgress(pct),
              )
              toast(
                'success',
                'Version uploaded',
                `${project.title} · ${uploadNote.trim() || 'New cut'}`,
              )
              setUploadOpen(false)
              setUploadNote('')
              setSelectedFile(null)
              setUploadProgress(0)
              if (fileInputRef.current) fileInputRef.current.value = ''
              // Open the review workspace automatically
              navigate(`/projects/${project.id}/review`)
            } catch (err: any) {
              toast('danger', 'Upload failed', err?.message || 'Could not upload version')
              setUploading(false)
              setUploadProgress(0)
            }
          }}
          className="space-y-4 px-6 py-5"
        >
          <div
            className="flex h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-canvas/60 text-center transition-colors hover:border-teal/50"
            onClick={() => !uploading && fileInputRef.current?.click()}
          >
            <input
              type="file"
              ref={fileInputRef}
              accept="video/mp4,video/quicktime,.mp4,.mov"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) setSelectedFile(f)
              }}
              disabled={uploading}
            />
            {selectedFile ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-ink">{selectedFile.name}</span>
                  <span className="rounded bg-tint px-1.5 py-0.5 font-mono text-xs text-teal">
                    {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
                  </span>
                  {!uploading && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedFile(null)
                        if (fileInputRef.current) fileInputRef.current.value = ''
                      }}
                      className="icon-btn icon-btn-sm"
                      aria-label="Remove file"
                    >
                      <X size={12} strokeWidth={2} />
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-tint text-teal">
                  <UploadCloud size={18} strokeWidth={1.75} />
                </span>
                <p className="text-sm font-medium text-ink">Drop your video here</p>
                <p className="text-[13px] text-umber">
                  MP4 or MOV, up to 2 GB. The review workspace opens automatically.
                </p>
              </>
            )}
          </div>

          {uploading && (
            <div className="space-y-2">
              <div className="flex items-center justify-between font-mono text-xs text-umber">
                <span>Uploading…</span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="h-1 w-full rounded-full bg-line overflow-hidden">
                <div
                  className="h-full bg-teal transition-all"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}

          <div>
            <label htmlFor="upload-note" className="label">
              Version note (optional)
            </label>
            <input
              id="upload-note"
              value={uploadNote}
              onChange={(e) => setUploadNote(e.target.value)}
              placeholder="e.g. Fixed the subtitle timing"
              disabled={uploading}
              className="input"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setUploadOpen(false)}
              disabled={uploading}
              className="btn-ghost"
            >
              Cancel
            </button>
            <button type="submit" disabled={!selectedFile || uploading} className="btn-primary">
              {uploading ? 'Uploading…' : 'Upload version'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Summary cards */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card p-5">
          <p className="micro-label">Current version</p>
          <p className="mt-2 font-mono text-xl font-medium text-ink">{versions[0].label}</p>
          <p className="mt-0.5 text-xs text-umber">
            {memberOf(versions[0].uploadedBy)?.name} · {versions[0].uploadedAt}
          </p>
        </div>
        <div className="card p-5">
          <p className="micro-label">Approved version</p>
          <p className="mt-2 font-mono text-xl font-medium text-ink">
            {project.approvedVersion ?? '-'}
          </p>
          <p className="mt-0.5 text-xs text-umber">
            {project.approvedVersion ? 'Exact version locked for publishing' : 'Not approved yet'}
          </p>
        </div>
        <div className="card p-5">
          <p className="micro-label">Team</p>
          <div className="mt-3">
            <AvatarStack
              initials={[project.creator, project.assignee, ...project.reviewers]
                .filter((u, i, a) => u && a.indexOf(u) === i)
                .map((u) => memberOf(u)?.initials ?? '?')}
              max={4}
            />
          </div>
        </div>
        <div className="card p-5">
          <p className="micro-label">{project.status === 'PUBLISHED' ? 'Published' : 'Schedule'}</p>
          {project.status === 'PUBLISHED' ? (
            <>
              <p className="mt-2 font-mono text-xl font-medium text-ink">
                {project.publishedAt ?? '-'}
              </p>
              <p className="mt-0.5 text-xs text-umber">
                {livePubs.length
                  ? `Live on ${[...new Set(livePubs.map((p: any) => p.platform))].join(', ')}`
                  : 'Live'}
              </p>
            </>
          ) : (
            <>
              <p className="mt-2 font-mono text-xl font-medium text-ink">
                {project.scheduleDate ?? 'Not set'}
              </p>
              <p className="mt-0.5 text-xs text-umber">
                {project.status === 'SCHEDULED'
                  ? 'Waiting to go live'
                  : project.status === 'APPROVED'
                    ? 'Ready to schedule'
                    : 'Approval required before scheduling'}
              </p>
            </>
          )}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {/* Left: description + inputs */}
        <div className="space-y-6 xl:col-span-2">
          <div className="card p-5">
            <h2 className="card-title mb-3">About this project</h2>
            <p className="text-sm leading-relaxed text-ink/80">{project.description}</p>
            <p className="mt-4 rounded-[8px] bg-canvas/70 px-3 py-2.5 text-xs text-umber">
              Proposed by {memberOf(project.creator)?.name ?? 'a teammate'}
              {project.reviewers.length > 0 &&
                ` · reviewed by ${project.reviewers
                  .map((r) => memberOf(r)?.name)
                  .filter(Boolean)
                  .join(', ')}`}
            </p>
          </div>

          {['SCHEDULED', 'PUBLISHED', 'CLOSED'].includes(project.status) && (
            <ProjectPerformance projectId={project.id} status={project.status} />
          )}

          <ProjectPublishing projectId={project.id} status={project.status} viewer={viewer} />

          <BriefCard projectId={project.id} viewer={viewer} />

          {/* Tasks: each one has its own assignee */}
          <div className="card p-0" data-testid="project-tasks">
            <header className="card-head justify-between">
              <h2 className="card-title">Tasks</h2>
              {tasks.length > 0 && (
                <span className="font-mono text-xs text-label">
                  {tasks.filter((t) => t.assignee).length}/{tasks.length} assigned
                </span>
              )}
            </header>
            {tasks.length ? (
              <ul className="divide-y divide-line">
                {tasks.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">{t.title}</p>
                      <p className="text-xs text-umber">
                        {t.status.replace(/_/g, ' ')} · {t.priority} priority
                      </p>
                    </div>
                    <AssignPicker
                      team={team}
                      value={strId(t.assignee)}
                      onAssign={(uid) => assignTaskTo(t, uid)}
                      canAssign={canAssign}
                      size="sm"
                      label="Assign"
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-8 text-center text-sm text-umber">
                No tasks on this project yet.
              </p>
            )}
          </div>

          {/* Inputs */}
          <div className="card p-0">
            <header className="card-head justify-between">
              <h2 className="card-title">Required inputs</h2>
              {inputs.length > 0 && (
                <span className="font-mono text-xs text-label">
                  {inputs.filter((i) => i.state === 'received').length}/{inputs.length} received
                </span>
              )}
            </header>
            {inputs.length ? (
              <ul className="divide-y divide-line">
                {inputs.map((inp) => (
                  <li key={inp.id} className="flex items-center gap-4 px-5 py-3.5">
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs ${inp.state === 'received' ? 'bg-success/10 text-success' : inp.state === 'blocked' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning'}`}
                    >
                      {inp.state === 'received' ? (
                        <CircleCheck size={16} strokeWidth={1.75} />
                      ) : inp.state === 'blocked' ? (
                        <TriangleAlert size={16} strokeWidth={1.75} />
                      ) : (
                        <Circle size={14} strokeWidth={1.75} />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">{inp.title}</p>
                      <p className="text-xs text-umber">
                        {memberOf(inp.owner)?.name} ·{' '}
                        {inp.state === 'received'
                          ? `received ${inp.receivedAt}`
                          : `${inp.state} since ${inp.requestedAt}`}
                      </p>
                    </div>
                    <Chip
                      label={inp.state}
                      tone={
                        inp.state === 'received'
                          ? 'success'
                          : inp.state === 'blocked'
                            ? 'danger'
                            : 'warning'
                      }
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-8 text-center text-sm text-umber">
                No inputs tracked for this project yet.
              </p>
            )}
          </div>

          {/* Activity */}
          <div className="card p-0">
            <header className="border-b border-line px-5 py-4">
              <h2 className="card-title">Project history</h2>
            </header>
            {projectActivity.length ? (
              <ul className="divide-y divide-line">
                {projectActivity.map((a, i) => (
                  <li key={i} className="flex gap-3 px-5 py-3.5">
                    <Avatar
                      initials={memberOf(a.actor)?.initials ?? '?'}
                      size="sm"
                      tone={i % 2 ? 'tint' : 'teal'}
                    />
                    <div className="min-w-0">
                      <p className="text-sm leading-snug text-ink">
                        <span className="font-medium">{memberOf(a.actor)?.name}</span> {a.text}
                      </p>
                      <p className="micro-label mt-0.5">{a.time}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-8 text-center text-sm text-umber">
                No activity recorded yet. {EMPTY_LINE.activity}
              </p>
            )}
          </div>
        </div>

        {/* Versions timeline */}
        <div id="versions" className="card h-fit scroll-mt-20 p-5">
          <header className="mb-4 flex items-center justify-between">
            <h2 className="card-title">Versions</h2>
            {hasReview && (
              <Link
                to={`/projects/${project.id}/review`}
                className="text-xs font-medium text-teal hover:underline"
              >
                Review draft
              </Link>
            )}
          </header>
          <ol className="relative space-y-5 border-l border-line pl-5">
            {versions.map((v, i) => (
              <li key={v.id} className="relative">
                <span
                  className={`absolute -left-[25.5px] top-1 h-3 w-3 rounded-full border-2 border-surface ${i === 0 ? 'bg-teal' : 'bg-ink/20'}`}
                  aria-hidden="true"
                />
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-medium text-teal">{v.label}</span>
                  {i === 0 && (
                    <Chip
                      label={project.approvedVersion === v.label ? 'Approved' : 'Latest'}
                      tone={project.approvedVersion === v.label ? 'teal' : 'neutral'}
                    />
                  )}
                </div>
                <p className="mt-1 text-sm leading-snug text-ink/80">{v.summary}</p>
                <div className="mt-1.5 flex items-center gap-2">
                  <Avatar
                    initials={memberOf(v.uploadedBy)?.initials ?? '?'}
                    size="xs"
                    tone="tint"
                  />
                  <p className="micro-label">{v.uploadedAt}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  )
}
