import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { CalendarClock, Check, Film, ImageIcon, Plug, Send, FileText, Sparkles } from 'lucide-react'
import Chip, { EmptyState } from '../../components/primitives'
import { PageHeader } from '../../components/ui'
import { ErrorBanner, ListSkeleton } from '../../components/states'
import { useToast } from '../../components/toast'
import { useViewer } from '../../lib/viewer'
import { invalidateProjectData } from '../../lib/data'
import { PLATFORMS, PlatformGlyph, fmtDateTime, toLocalInput, usePublishing, canPublish } from '../../lib/publishing'
import {
  ApiError,
  listEligibleProjects,
  schedulePost,
  suggestPostTime,
  versionFileUrl,
  type EligibleProject,
  type PlatformKey,
  type PlatformSettings,
  type TimeSuggestion,
} from '../../services/api'
import { PlatformSettingsPanel, defaultSettings, validateSettings, type FieldError } from '../../components/PlatformSettingsPanel'
import { PlatformIcon, StatusChip } from '../../components/status'

const LIMITS: Partial<Record<PlatformKey, number>> = { x: 280, instagram: 2200, linkedin: 3000, youtube: 5000 }

function tomorrowAt(h: number) {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(h, 0, 0, 0)
  return d
}

export default function ComposerPage() {
  const toast = useToast()
  const viewer = useViewer()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const canSchedule = canPublish(viewer)
  const { orgId, channels, status, loading: loadingChannels, error: channelError } = usePublishing()
  const [projects, setProjects] = useState<EligibleProject[]>([])
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [projectId, setProjectId] = useState(params.get('project') || '')
  const [fileId, setFileId] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [caption, setCaption] = useState('')
  const [when, setWhen] = useState(() => toLocalInput(tomorrowAt(10)))
  const [busy, setBusy] = useState(false)
  const [platformSettings, setPlatformSettings] = useState<PlatformSettings>({})
  const [serverErrors, setServerErrors] = useState<FieldError[]>([])
  const [suggestion, setSuggestion] = useState<TimeSuggestion | null>(null)
  const [suggesting, setSuggesting] = useState(false)

  useEffect(() => {
    if (!orgId) return
    listEligibleProjects(orgId)
      .then((list) => {
        setProjects(list)
        const cur = params.get('project')
        const initial = (cur && list.find((p) => p.id === cur)) || list.find((p) => p.status === 'APPROVED') || list[0]
        if (initial) {
          setProjectId(initial.id)
          setCaption((c) => c || initial.description || '')
        }
      })
      .catch((err) => setProjectError(err?.message || 'Could not load approved projects'))
      .finally(() => setLoadingProjects(false))
  }, [orgId, params])

  const project = projects.find((p) => p.id === projectId) || null
  const files = project?.approvedVersion?.files || []
  const file = files.find((f) => f.id === fileId) || files[0] || null

  const selectProject = (id: string) => {
    setProjectId(id)
    setFileId('')
    const next = projects.find((p) => p.id === id)
    if (next && !caption.trim()) setCaption(next.description || '')
  }

  const selectedChannels = channels.filter((c) => selected.includes(c.id))
  const tightest = useMemo(() => {
    const limits = selectedChannels.map((c) => ({ c, max: LIMITS[c.platform] ?? 5000 }))
    return limits.sort((a, b) => a.max - b.max)[0]
  }, [selectedChannels])
  const overLimit = tightest ? caption.length > tightest.max : false
  const selectedPlatforms = useMemo(() => [...new Set(selectedChannels.map((c) => c.platform))].sort(), [selectedChannels])
  const platformKey = selectedPlatforms.join(',')
  useEffect(() => {
    setPlatformSettings((prev) => defaultSettings(selectedPlatforms, { title: project?.title || '', file }, prev))
    setServerErrors([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platformKey, project?.id, file?.id])
  const clientErrors = useMemo(() => validateSettings(platformSettings, { caption, file, files }), [platformSettings, caption, file, files])
  const settingErrors = [...clientErrors, ...serverErrors.filter((e) => !clientErrors.some((c) => c.platform === e.platform && c.field === e.field))]
  const blockedChannels = selectedChannels.filter((c) => c.status === 'expired')

  const suggest = async () => {
    if (!orgId || !selected.length) return
    setSuggesting(true)
    try {
      const s = await suggestPostTime(orgId, selected)
      setSuggestion(s)
      setWhen(toLocalInput(new Date(s.suggestedAt)))
    } catch (err: any) {
      toast('danger', 'No suggestion', err?.message)
    } finally {
      setSuggesting(false)
    }
  }
  const whenDate = new Date(when)
  const inPast = isNaN(whenDate.getTime()) || whenDate.getTime() < Date.now() - 30000

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  const quick = [
    { label: 'In 2 minutes', at: () => new Date(Date.now() + 2 * 60000) },
    { label: 'Tomorrow 10:00', at: () => tomorrowAt(10) },
    { label: 'Tomorrow 18:00', at: () => tomorrowAt(18) },
  ]

  const submit = async () => {
    if (!orgId || !project || !selected.length || inPast || overLimit || clientErrors.length || blockedChannels.length) return
    setBusy(true)
    setServerErrors([])
    try {
      const posts = await schedulePost(orgId, {
        projectId: project.id,
        channelIds: selected,
        caption,
        scheduledAt: whenDate.toISOString(),
        fileId: file?.id || null,
        settings: platformSettings,
      })
      invalidateProjectData(project.id)
      const failed = posts.filter((p) => p.status === 'failed')
      if (failed.length) toast('warning', 'Scheduled with problems', `${failed.length} channel(s) failed: ${failed[0].failureReason}`)
      else toast('success', 'Post scheduled', `${project.title} · ${fmtDateTime(whenDate)} · ${posts.length} channel${posts.length === 1 ? '' : 's'}`)
      navigate(`/publishing/calendar?month=${whenDate.getFullYear()}-${whenDate.getMonth() + 1}`)
    } catch (err: any) {
      if (err instanceof ApiError && err.details?.length) setServerErrors(err.details)
      toast('danger', 'Could not schedule', err?.message)
    } finally {
      setBusy(false)
    }
  }

  const isVideo = file?.mimeType?.startsWith('video/')
  const isImage = file?.mimeType?.startsWith('image/')
  const loading = loadingChannels || loadingProjects

  return (
    <div className="fade-in space-y-6">
      <PageHeader
        title="Compose"
        subtitle="Schedule an approved project's final cut to your channels. The project moves to Scheduled now and to Published when it goes live."
        actions={
          <Link to="/publishing/calendar" className="btn-secondary">
            <CalendarClock size={14} strokeWidth={1.75} /> Calendar
          </Link>
        }
      />
      {(channelError || projectError) && <ErrorBanner message={channelError || projectError || ''} />}
      {loading ? (
        <ListSkeleton rows={3} height="h-32" />
      ) : !projects.length ? (
        <EmptyState
          icon={<FileText size={22} strokeWidth={1.5} />}
          title="No approved projects yet"
          description="A project can be scheduled once a reviewer approves its final version."
          action={<Link to="/projects" className="btn-primary">Go to projects</Link>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px] [&>*]:min-w-0">
          <div className="space-y-5">
            {/* 1. Project */}
            <section className="card p-5">
              <StepTitle n={1} title="Approved project" />
              <select className="input mt-3 w-full" value={projectId} onChange={(e) => selectProject(e.target.value)} data-testid="composer-project">
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title} {p.approvedVersion ? `· ${p.approvedVersion.label}` : ''} {p.status === 'SCHEDULED' ? '· already scheduled' : ''}
                  </option>
                ))}
              </select>
              {project && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-umber">
                  <Chip label={project.status === 'SCHEDULED' ? 'Scheduled' : 'Approved'} tone={project.status === 'SCHEDULED' ? 'warning' : 'teal'} dot />
                  <span>Final asset: {project.approvedVersion?.label ?? '-'}</span>
                  {project.approvedVersion?.changeSummary && <span className="truncate">· {project.approvedVersion.changeSummary}</span>}
                </div>
              )}
              {files.length > 1 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {files.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setFileId(f.id)}
                      className={`rounded-full border px-3 py-1 text-xs ${file?.id === f.id ? 'border-[#035E5E] bg-tint text-[#035E5E]' : 'border-line text-umber'}`}
                    >
                      {f.filename}
                    </button>
                  ))}
                </div>
              )}
              {project && !files.length && <p className="mt-3 text-xs text-warning">The approved version has no file attached - the post will go out as text only.</p>}
            </section>

            {/* 2. Channels */}
            <section className="card p-5">
              <StepTitle n={2} title="Channels" />
              {!channels.length ? (
                <div className="mt-3 flex items-center justify-between gap-3 rounded-[10px] border border-dashed border-line-strong px-4 py-3">
                  <p className="text-sm text-umber">No channels connected yet.</p>
                  <Link to="/publishing/channels" className="btn-secondary">
                    <Plug size={14} strokeWidth={1.75} /> Connect channels
                  </Link>
                </div>
              ) : (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {channels.map((c) => {
                    const on = selected.includes(c.id)
                    const expired = c.status === 'expired'
                    return (
                      <button
                        key={c.id}
                        onClick={() => !expired && toggle(c.id)}
                        disabled={expired}
                        title={expired ? `${c.name} needs to be reconnected on the Channels page` : undefined}
                        aria-pressed={on}
                        data-testid="composer-channel"
                        className={`flex items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left transition-colors ${
                          on ? 'border-teal bg-tint' : expired ? 'border-line bg-canvas/60' : 'border-line hover:border-line-strong hover:bg-canvas/40'
                        }`}
                      >
                        <PlatformIcon platform={c.platform} size="sm" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink">{c.name}</span>
                          <span className="micro-label block truncate">
                            {PLATFORMS[c.platform].label} · {c.mode === 'postiz' ? 'Postiz' : 'Demo'}
                          </span>
                        </span>
                        {expired ? (
                          <StatusChip status="failed" label="Reconnect needed" />
                        ) : (
                          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-200 ${on ? 'border-teal bg-teal text-white' : 'border-line-strong'}`}>
                            {on && <Check size={12} strokeWidth={2.5} />}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </section>

            {/* 3. Platform settings */}
            <section className="card p-5">
              <StepTitle n={3} title="Platform settings" />
              <PlatformSettingsPanel value={platformSettings} onChange={setPlatformSettings} errors={settingErrors} files={files} />
            </section>

            {/* 4. Caption */}
            <section className="card p-5">
              <div className="flex items-center justify-between">
                <StepTitle n={4} title="Caption" />
                <span className={`font-mono text-[11px] ${overLimit ? 'text-danger' : 'text-label'}`}>
                  {caption.length}
                  {tightest ? ` / ${tightest.max} (${PLATFORMS[tightest.c.platform].label})` : ''}
                </span>
              </div>
              <textarea
                className="input mt-3 min-h-32 w-full resize-y py-2.5 leading-relaxed"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Write the caption, hashtags and call to action…"
                data-testid="composer-caption"
              />
            </section>

            {/* 4. When */}
            <section className="card p-5">
              <StepTitle n={5} title="Date & time" />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input type="datetime-local" className="input w-auto" value={when} onChange={(e) => setWhen(e.target.value)} data-testid="composer-when" />
                {quick.map((q) => (
                  <button key={q.label} className="btn-ghost !h-9 text-xs" onClick={() => setWhen(toLocalInput(q.at()))} data-testid={`quick-${q.label.replace(/\W+/g, '-').toLowerCase()}`}>
                    {q.label}
                  </button>
                ))}
                <button
                  className="btn-secondary !h-9 text-xs"
                  onClick={() => void suggest()}
                  disabled={!selected.length || suggesting}
                  data-testid="suggest-time"
                  title={selected.length ? undefined : 'Pick channels first'}
                >
                  <Sparkles size={13} strokeWidth={1.75} /> {suggesting ? 'Thinking…' : 'Suggest best time'}
                </button>
              </div>
              {suggestion && (
                <p className="mt-2 text-xs leading-relaxed text-umber" data-testid="suggest-reason">
                  <span className="font-medium text-[#035E5E]">{fmtDateTime(suggestion.suggestedAt)}</span> · {suggestion.reason}
                  {suggestion.source === 'heuristic' ? ' (no history yet - platform default)' : ''}
                </p>
              )}
              {inPast && <p className="mt-2 text-xs text-danger">Pick a time in the future.</p>}
            </section>
          </div>

          {/* Preview */}
          <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card" data-testid="composer-preview">
              <div className="flex items-center gap-2 bg-[#171310] px-4 py-3 text-white">
                <span className="font-headline text-sm font-semibold tracking-tight">Preview</span>
                <span className="ml-auto flex gap-1.5">
                  {selectedChannels.map((c) => (
                    <PlatformGlyph key={c.id} platform={c.platform} size={14} className="opacity-90" />
                  ))}
                </span>
              </div>
              <div className="aspect-[4/5] bg-cream">
                {project && file && isVideo ? (
                  <video key={file.id} src={versionFileUrl(project.id, project.approvedVersion!.id, file.id)} className="h-full w-full object-cover" muted playsInline controls preload="metadata" />
                ) : project && file && isImage ? (
                  <img src={versionFileUrl(project.id, project.approvedVersion!.id, file.id)} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-umber">
                    {file ? <Film size={28} strokeWidth={1.25} /> : <ImageIcon size={28} strokeWidth={1.25} />}
                    <span className="px-6 text-center text-xs">{file ? file.filename : 'No asset on the approved version'}</span>
                  </div>
                )}
              </div>
              <div className="space-y-2 p-4">
                <p className="font-headline text-sm font-semibold text-[#171310]">{project?.title ?? 'Pick a project'}</p>
                <p className="line-clamp-5 whitespace-pre-wrap text-sm leading-relaxed text-ink/80">{caption || <span className="text-label">Your caption appears here.</span>}</p>
                <p className="pt-1 font-mono text-[11px] text-[#035E5E]">{inPast ? '-' : fmtDateTime(whenDate)}</p>
              </div>
            </section>

            <button
              className="btn-primary w-full justify-center"
              disabled={!canSchedule || busy || !project || !selected.length || inPast || overLimit || clientErrors.length > 0}
              onClick={() => void submit()}
              data-testid="composer-submit"
              title={canSchedule ? undefined : 'Your role cannot schedule posts'}
            >
              <Send size={14} strokeWidth={1.75} /> {busy ? 'Scheduling…' : `Schedule${selected.length ? ` to ${selected.length} channel${selected.length === 1 ? '' : 's'}` : ''}`}
            </button>
            {clientErrors.length > 0 && selected.length > 0 && (
              <p className="text-center text-xs text-danger" data-testid="settings-blocking">
                Fix {clientErrors.length} setting{clientErrors.length === 1 ? '' : 's'} above to schedule.
              </p>
            )}
            {status && (
              <p className="text-center text-[11px] leading-relaxed text-umber">
                {status.mode === 'postiz'
                  ? 'Postiz channels are handed to Postiz; demo channels use the built-in scheduler.'
                  : 'Demo mode: the built-in scheduler publishes at the chosen time with a demo link.'}
              </p>
            )}
          </aside>
        </div>
      )}
    </div>
  )
}

function StepTitle({ n, title }: { n: number; title: string }) {
  return (
    <h2 className="card-title flex items-center gap-2">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#035E5E] font-mono text-[10px] text-white">{n}</span>
      {title}
    </h2>
  )
}
