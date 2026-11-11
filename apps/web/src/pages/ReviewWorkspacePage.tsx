import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Clock, Minus, Lock } from 'lucide-react'
import Chip, { Modal } from '../components/primitives'
import Avatar from '../components/ui'
import { formatTime, projectStatusLabel } from '../lib/format'
import { useViewer, can } from '../lib/viewer'
import { useProject, useTeam, useMe, invalidateProjectData } from '../lib/data'
import { useDeal } from '../lib/deals'
import {
  listVersions,
  versionFileUrl,
  listComments,
  addComment,
  setCommentResolved,
  approveVersion,
  requestRevision as apiRequestRevision,
  lockReview,
  type ProjectVersion,
} from '../services/api'
import { useToast } from '../components/toast'
import { pickVersion } from '../lib/reviewVersions'
import { StatusChip } from '../components/status'
import { EMPTY_LINE } from '../lib/copy'

interface LocalComment {
  id: string
  versionId: string | null
  author: string
  time: number
  body: string
  replies: { id: string; author: string; body: string }[]
  resolved: boolean
  createdAt: string
}

export default function ReviewWorkspacePage() {
  const { id = '' } = useParams()
  const viewer = useViewer()
  const { project } = useProject(id)
  // The deal milestone this reel delivers (if any): an approved or paid-out milestone has nothing left to approve.
  const { data: deal } = useDeal(project?.dealId ?? undefined)
  const milestoneState = project?.milestoneKey
    ? deal?.milestones.find((m) => m.key === project.milestoneKey)?.state
    : undefined
  const { team } = useTeam()
  const me = useMe()
  const toast = useToast()
  const memberOf = (mid: string) => team.find((m) => m.id === mid)

  // Comments are persisted on the API (threaded via parentId, anchored via timecode).
  const [comments, setComments] = useState<LocalComment[]>([])
  const reloadComments = async () => {
    if (!id) return
    try {
      const raw: any[] = await listComments(id)
      const sid = (v: any) =>
        v && typeof v === 'object' ? String(v._id ?? v.id) : v ? String(v) : ''
      const top = raw.filter((c) => !c.parentId)
      setComments(
        top.map((c) => ({
          id: String(c.id),
          versionId: c.versionId ? sid(c.versionId) : null,
          author: sid(c.author),
          time: typeof c.timecode === 'number' ? c.timecode : 0,
          body: c.body,
          resolved: !!c.resolved,
          createdAt: c.createdAt
            ? new Date(c.createdAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              })
            : '',
          replies: raw
            .filter((r) => sid(r.parentId) === String(c.id))
            .map((r) => ({ id: String(r.id), author: sid(r.author), body: r.body })),
        })),
      )
    } catch {
      /* keep what we have */
    }
  }
  useEffect(() => {
    void reloadComments()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Real versions from the backend; fall back to a placeholder entry when the
  // project has no uploads yet (so timestamped comments still work).
  const [versions, setVersions] = useState<ProjectVersion[]>([])
  useEffect(() => {
    let active = true
    if (!id) return
    listVersions(id)
      .then((v) => active && setVersions(v))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [id])

  const versionEntries = (() => {
    const real = versions
      .filter((v) => v.files.length > 0)
      .flatMap((v) =>
        v.files
          .filter((f) => f.mimeType.startsWith('video/'))
          .map((f) => ({
            id: `${v.id}:${f.id}`,
            label: `v${v.versionNumber}`,
            url: versionFileUrl(id, v.id, f.id),
            filename: f.filename,
            uploadedAt: v.createdAt,
            summary: v.changeSummary || 'Draft upload',
          })),
      )
    if (real.length > 0) return real
    return []
  })()

  const review = {
    fileName: versionEntries[0]?.filename ?? 'draft.mp4',
    versions: versionEntries.map((v) => ({
      id: v.id,
      label: v.label,
      url: v.url,
      summary: v.summary,
    })),
  }

  const videoRef = useRef<HTMLVideoElement>(null)
  const syncedFor = useRef<string>('')
  const [versionId, setVersionId] = useState(versionEntries[0]?.id ?? '')
  const [currentTime, setCurrentTime] = useState(0)
  const [draft, setDraft] = useState('')
  const [draftTime, setDraftTime] = useState<number | null>(null)
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [revisionOpen, setRevisionOpen] = useState(false)
  const [revisionReason, setRevisionReason] = useState('')
  const [approved, setApproved] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [locking, setLocking] = useState(false)
  const [lockedScope, setLockedScope] = useState<{ number: number; items: string[] } | null>(null)

  useEffect(() => {
    if (!id || review.versions.length === 0) return
    if (syncedFor.current !== id) {
      const first = pickVersion(review.versions, versionId)
      setVersionId(first ? first.id : '')
      syncedFor.current = id
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, review.versions.length])

  if (!project) {
    return (
      <div className="fade-in card p-12 text-center">
        <h1 className="font-headline text-lg font-semibold text-ink">Project not found</h1>
        <p className="mt-1 text-sm text-umber">This project doesn&apos;t exist or was removed.</p>
        <Link to="/projects" className="btn-secondary mt-5 inline-flex">
          Back to projects
        </Link>
      </div>
    )
  }

  const version = pickVersion(review.versions, versionId) // null when no uploads — page renders empty state
  // Entry ids are "<versionId>:<fileId>" - the API wants the version id.
  const realVersionId = version ? version.id.split(':')[0] : null
  const openComments = comments.filter((c) => !c.resolved)
  const lockable = comments.filter((c) => !c.resolved && c.versionId === realVersionId)
  const canComment = can(viewer, 'comment')
  const canApprove = can(viewer, 'approve')
  const paidOut = milestoneState === 'PAID_OUT'
  const alreadyApproved =
    approved ||
    paidOut ||
    milestoneState === 'APPROVED' ||
    milestoneState === 'AUTO_APPROVED' ||
    milestoneState === 'CAPTURED' ||
    (!!realVersionId && project.approvedVersionId === realVersionId)

  const seekTo = (t: number) => {
    const v = videoRef.current
    if (v) {
      v.currentTime = t
      void v.play()
      setCurrentTime(t)
    }
  }

  const captureTime = () => {
    const v = videoRef.current
    const t = v ? Math.floor(v.currentTime) : 0
    setDraftTime(t)
    setNotice(`Commenting at ${formatTime(t)}`)
  }

  const submitComment = async () => {
    if (!draft.trim() || !canComment) return
    const t = draftTime ?? Math.floor(currentTime)
    const body = draft.trim()
    // optimistic row, replaced by the server copy on reload
    setComments((prev) => [
      ...prev,
      {
        id: `c-${Date.now()}`,
        versionId: realVersionId,
        author: me?.id ?? viewer.id,
        time: t,
        body,
        replies: [],
        resolved: false,
        createdAt: 'Just now',
      },
    ])
    setDraft('')
    setDraftTime(null)
    setNotice(null)
    try {
      await addComment(project.id, { body, versionId: realVersionId, timecode: t })
      invalidateProjectData(project.id)
    } catch (err: any) {
      toast('danger', 'Comment not saved', err?.message || 'Try again')
    }
    void reloadComments()
  }

  const submitReply = async (parentId: string) => {
    if (!replyText.trim() || !canComment) return
    const body = replyText.trim()
    setReplyText('')
    setReplyingTo(null)
    try {
      await addComment(project.id, { body, parentId, versionId: realVersionId })
    } catch (err: any) {
      toast('danger', 'Reply not saved', err?.message || 'Try again')
    }
    void reloadComments()
  }

  const toggleResolve = async (commentId: string) => {
    const c = comments.find((x) => x.id === commentId)
    if (!c) return
    setComments((prev) =>
      prev.map((x) => (x.id === commentId ? { ...x, resolved: !x.resolved } : x)),
    )
    try {
      await setCommentResolved(project.id, commentId, !c.resolved)
      invalidateProjectData(project.id)
    } catch (err: any) {
      toast('danger', 'Could not update comment', err?.message || 'Try again')
      void reloadComments()
    }
  }

  const requestRevision = async () => {
    const reason = revisionReason.trim()
    setRevisionOpen(false)
    setRevisionReason('')
    try {
      await apiRequestRevision(project.id, reason || 'Changes requested', realVersionId)
      invalidateProjectData(project.id)
      setNotice(`Revision requested: ${reason || 'no reason given'}. The editor has been notified.`)
    } catch (err: any) {
      toast('danger', 'Revision request failed', err?.message || 'Try again')
    }
  }

  const approve = async () => {
    if (!realVersionId || !canApprove || alreadyApproved) return
    try {
      await approveVersion(project.id, realVersionId)
      setApproved(true)
      invalidateProjectData(project.id)
      toast(
        'success',
        `${version?.label ?? 'Version'} approved`,
        'Locked as the exact version to publish.',
      )
    } catch (err: any) {
      toast('danger', 'Approval failed', err?.message || 'Try again')
    }
  }

  /** Fluit-style "lock feedback": open comments on this version become the next revision's fixed scope. */
  const lockFeedback = async () => {
    if (!realVersionId || locking || lockable.length === 0) return
    setLocking(true)
    try {
      const res = await lockReview(project.id, realVersionId)
      const items = (res.revision?.scopeItems ?? []).map((i: any) => String(i.body))
      setLockedScope({ number: res.revision?.revisionNumber ?? 1, items })
      invalidateProjectData(project.id)
      toast(
        'success',
        'Feedback locked',
        `${res.lockedCommentCount} comment(s) are now the revision scope.`,
      )
      void reloadComments()
    } catch (err: any) {
      toast('danger', 'Could not lock feedback', err?.message || 'Try again')
    } finally {
      setLocking(false)
    }
  }

  return (
    <div className="fade-in space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <nav className="micro-label flex items-center gap-1.5">
            <Link to="/projects" className="hover:text-teal">
              Projects
            </Link>
            <span>/</span>
            <Link to={`/projects/${project.id}`} className="hover:text-teal">
              {project.title}
            </Link>
            <span>/</span>
            <span className="text-ink">Review</span>
          </nav>
          <div className="mt-2 flex items-center gap-3">
            <h1 className="t-display">{project.title}</h1>
            <StatusChip status={project.status} label={projectStatusLabel(project)} />
            {approved && <Chip label="Approved" tone="teal" />}
          </div>
          <p className="mt-1 text-sm text-umber">
            {version
              ? [
                  version.label,
                  'uploadedAt' in version && version.uploadedAt
                    ? `uploaded ${version.uploadedAt}`
                    : '',
                ]
                  .filter(Boolean)
                  .join(' · ') || version.label
              : 'No draft uploaded yet'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            className="btn-secondary"
            onClick={() => can(viewer, 'upload') && setRevisionOpen(true)}
            disabled={!can(viewer, 'upload') || !version}
            title={
              !can(viewer, 'upload')
                ? 'Only editors can request a revision'
                : !version
                  ? 'No draft to revise yet'
                  : undefined
            }
          >
            Request revision
          </button>
          <button
            className="btn-primary"
            onClick={() => void approve()}
            disabled={!canApprove || !version || alreadyApproved}
            title={
              alreadyApproved
                ? paidOut
                  ? 'Approved and paid out: nothing left to approve'
                  : 'Already approved'
                : !canApprove
                  ? 'Only reviewers can approve'
                  : !version
                    ? 'Nothing to approve yet'
                    : undefined
            }
          >
            {alreadyApproved
              ? paidOut
                ? 'Paid'
                : 'Approved'
              : `Approve ${version ? version.label : '—'}`}
          </button>
        </div>
      </div>

      {/* Notice */}
      {notice && (
        <div className="flex items-center justify-between rounded-[8px] border border-line bg-tint/60 px-4 py-2.5 text-sm text-ink">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="text-xs text-teal hover:underline">
            Dismiss
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {/* Video player */}
        <div className="card p-5 xl:col-span-2">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="card-title">Watch &amp; comment</h2>
            <div className="flex items-center gap-2">
              <span className="micro-label">Version</span>
              <select
                value={versionId}
                onChange={(e) => setVersionId(e.target.value)}
                className="input !h-8 w-auto !px-2 text-xs"
                aria-label="Select draft version"
              >
                {review.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label} - {v.summary}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="overflow-hidden rounded-[8px] bg-ink">
            {versionEntries.length === 0 ? (
              <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 bg-ink p-8 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-white/80">
                  <Clock size={20} strokeWidth={1.75} aria-hidden="true" />
                </div>
                <div>
                  <p className="font-headline text-sm font-medium text-white">
                    No draft uploaded yet
                  </p>
                  <p className="mt-1 max-w-sm text-xs leading-relaxed text-white/60">
                    This project has no video versions. Upload a cut from the project page to enable
                    frame-accurate comments.
                  </p>
                </div>
                <Link
                  to={`/projects/${project.id}`}
                  className="btn-secondary btn-sm mt-2 !bg-white !text-ink hover:!bg-white/90"
                >
                  Go to project
                </Link>
              </div>
            ) : (
              <video
                key={version!.id}
                ref={videoRef}
                src={version!.url}
                controls
                playsInline
                preload="metadata"
                className="aspect-video w-full bg-black"
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              />
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="font-mono text-xs text-label">
              Playhead <span className="text-ink">{formatTime(currentTime)}</span> ·{' '}
              {review.fileName}
            </p>
            <button className="btn-secondary btn-sm" onClick={captureTime} disabled={!canComment}>
              <Clock size={15} strokeWidth={1.75} />
              Comment at {formatTime(currentTime)}
            </button>
          </div>

          {/* Composer */}
          <div className="mt-4 rounded-[8px] border border-line bg-canvas/60 p-4">
            {draftTime !== null && (
              <button
                onClick={() => seekTo(draftTime)}
                className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-tint px-2.5 py-1 text-xs font-medium text-teal hover:underline"
              >
                <Clock size={11} strokeWidth={2} />
                {formatTime(draftTime)}
                <Minus
                  size={11}
                  strokeWidth={2}
                  className="ml-0.5 text-umber transition-colors hover:text-ink"
                />
              </button>
            )}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitComment()
              }}
              placeholder={
                canComment
                  ? 'Leave feedback for the editor - use “Comment at time” to anchor it to the video…'
                  : 'You don’t have comment permission for this project.'
              }
              disabled={!canComment}
              rows={3}
              className="w-full resize-none bg-transparent text-sm text-ink outline-none placeholder:text-label"
            />
            <div className="mt-2 flex items-center justify-between">
              <p className="text-xs text-label">⌘/Ctrl + Enter to send</p>
              <button
                className="btn-primary btn-sm"
                onClick={submitComment}
                disabled={!draft.trim() || !canComment}
              >
                Send comment
              </button>
            </div>
          </div>
        </div>

        {/* Comments panel */}
        <div className="card flex max-h-[70vh] flex-col p-0">
          <header className="card-head justify-between">
            <div>
              <h2 className="card-title">Comments</h2>
              <span className="font-mono text-xs text-label">{openComments.length} open</span>
            </div>
            {canComment && (
              <button
                className="btn-secondary btn-sm"
                onClick={() => void lockFeedback()}
                disabled={!realVersionId || locking || lockable.length === 0}
                title={
                  lockable.length
                    ? 'Turn open feedback on this version into a fixed revision scope'
                    : 'No open feedback on this version'
                }
                data-testid="lock-feedback"
              >
                <Lock size={13} strokeWidth={1.75} />
                {locking ? 'Locking…' : 'Lock feedback'}
              </button>
            )}
          </header>
          {lockedScope && (
            <div className="border-b border-line bg-tint/60 px-5 py-3" data-testid="locked-scope">
              <p className="flex items-center gap-1.5 text-sm font-medium text-teal">
                <Lock size={13} strokeWidth={2} /> Revision {lockedScope.number} scope locked
              </p>
              <ul className="mt-1.5 space-y-1">
                {lockedScope.items.map((t, i) => (
                  <li key={i} className="text-[13px] leading-snug text-ink/80">
                    • {t}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-umber">
                New feedback after this point needs a new round - no scope creep.
              </p>
            </div>
          )}
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
            {comments.length ? (
              comments.map((c) => (
                <article
                  key={c.id}
                  className={`rounded-[8px] border p-4 ${c.resolved ? 'border-line bg-canvas/40 opacity-70' : 'border-line bg-surface'}`}
                >
                  <div className="flex items-start gap-3">
                    <Avatar initials={memberOf(c.author)?.initials ?? '?'} size="sm" tone="teal" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-ink">{memberOf(c.author)?.name}</p>
                        <button
                          onClick={() => seekTo(c.time)}
                          className="inline-flex items-center gap-1 rounded-full bg-tint px-2 py-0.5 text-xs font-medium text-teal hover:underline"
                          title="Jump the video to this timestamp"
                        >
                          <Clock size={10} strokeWidth={2} />
                          {formatTime(c.time)}
                        </button>
                        <span className="micro-label">{c.createdAt}</span>
                      </div>
                      <p className="mt-1.5 text-sm leading-relaxed text-ink/85">{c.body}</p>

                      {c.replies.map((r) => (
                        <div key={r.id} className="mt-3 flex gap-2.5 border-l-2 border-line pl-3">
                          <Avatar
                            initials={memberOf(r.author)?.initials ?? '?'}
                            size="xs"
                            tone="tint"
                          />
                          <div>
                            <p className="text-xs font-medium text-ink">
                              {memberOf(r.author)?.name}
                            </p>
                            <p className="text-sm leading-relaxed text-ink/80">{r.body}</p>
                          </div>
                        </div>
                      ))}

                      <div className="mt-3 flex items-center gap-3">
                        {canComment && (
                          <button
                            onClick={() => setReplyingTo(replyingTo === c.id ? null : c.id)}
                            className="text-xs font-medium text-teal hover:underline"
                          >
                            {replyingTo === c.id ? 'Cancel' : 'Reply'}
                          </button>
                        )}
                        <button
                          onClick={() => toggleResolve(c.id)}
                          className="text-xs font-medium text-umber hover:text-ink"
                        >
                          {c.resolved ? 'Reopen' : 'Resolve'}
                        </button>
                      </div>

                      {replyingTo === c.id && canComment && (
                        <div className="mt-3 flex gap-2">
                          <input
                            value={replyText}
                            onChange={(e) => setReplyText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') submitReply(c.id)
                            }}
                            placeholder="Reply…"
                            className="input !h-9 flex-1"
                            autoFocus
                          />
                          <button
                            className="btn-primary btn-sm"
                            onClick={() => submitReply(c.id)}
                            disabled={!replyText.trim()}
                          >
                            Send
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              ))
            ) : (
              <p className="py-10 text-center text-sm text-umber">
                No comments yet. {EMPTY_LINE.comments}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Revision modal */}
      <Modal open={revisionOpen} onClose={() => setRevisionOpen(false)} title="Request a revision">
        <textarea
          value={revisionReason}
          onChange={(e) => setRevisionReason(e.target.value)}
          rows={4}
          placeholder="e.g. Rework the intro hook, fix the audio dip at 0:11, and delay the subtitle to 0:08…"
          className="input mt-4 w-full"
        />
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setRevisionOpen(false)}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={requestRevision}
            disabled={!revisionReason.trim()}
          >
            Send revision request
          </button>
        </div>
      </Modal>
    </div>
  )
}
