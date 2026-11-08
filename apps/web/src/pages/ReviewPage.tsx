import { Link } from 'react-router-dom'
import { CheckCircle2, PlayCircle } from 'lucide-react'
import { EmptyState, PageHeader } from '../components/primitives'
import { Skeleton } from '../components/states'
import { AssigneeAvatar } from '../components/ui'
import { useProjects, useReviews, useTeam } from '../lib/data'
import { projectStatusLabel } from '../lib/format'
import { StatusChip } from '../components/status'

const IN_REVIEW = ['FIRST_DRAFT_SUBMITTED', 'UNDER_REVIEW', 'REVISION_SUBMITTED']

export default function ReviewPage() {
  const { projects, loading } = useProjects()
  const { reviews } = useReviews()
  const { team } = useTeam()

  const memberOf = (id: string) => team.find((m) => m.id === id)

  // Surface projects that are in a review lifecycle state, or that already
  // carry review comments (so published items with feedback threads still show).
  const queue = projects.filter(
    (p) => IN_REVIEW.includes(p.status) || reviews.some((r) => r.projectId === p.id),
  )

  return (
    <div className="fade-in space-y-8">
      <PageHeader title="Review" />

      {loading && !projects.length ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card overflow-hidden">
              <div className="skeleton h-36 !rounded-none" />
              <div className="space-y-3 p-5">
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : queue.length ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {queue.map((p) => {
            const thread = reviews.filter((r) => r.projectId === p.id)
            const open = thread.filter((c) => !c.resolved).length
            return (
              <Link
                key={p.id}
                to={`/projects/${p.id}/review`}
                className="card card-hover overflow-hidden"
                data-testid="review-card"
              >
                {/* Video thumbnail placeholder */}
                <div className="relative flex h-36 items-center justify-center bg-ink text-on-accent/70">
                  <PlayCircle size={40} strokeWidth={1.25} />
                  <span className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white">
                    {thread.length
                      ? `${thread.length} comment${thread.length === 1 ? '' : 's'}`
                      : 'no draft'}
                  </span>
                </div>
                <div className="p-5">
                  <div className="mb-2 flex items-center justify-between">
                    <StatusChip status={p.status} label={projectStatusLabel(p)} />
                    <span className="micro-label">{p.updated}</span>
                  </div>
                  <h3 className="t-title leading-snug">{p.title}</h3>
                  <p className="mt-1 text-xs text-umber">
                    {thread.length
                      ? `${open} open · ${thread.length - open} resolved`
                      : 'No review thread yet'}
                  </p>
                  <div className="mt-4 flex items-center gap-2">
                    <AssigneeAvatar member={memberOf(p.assignee)} size="xs" />
                    {memberOf(p.assignee) && (
                      <span className="text-xs text-umber">by {memberOf(p.assignee)?.name}</span>
                    )}
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      ) : (
        <EmptyState
          icon={<CheckCircle2 strokeWidth={1.5} />}
          title="You’re all caught up"
          description="Nothing is waiting for review. Approved work moves on to publishing."
          action={
            <Link to="/publishing/calendar" className="btn-secondary btn-sm">
              Open the calendar
            </Link>
          }
        />
      )}
    </div>
  )
}
