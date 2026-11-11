/**
 * Channels: the accounts posts go out to. Social publishing is in build, so
 * the page lists the channels on file and says plainly that accounts connect
 * on our side; there is no connect, OAuth or sync control here. The
 * scheduling backend (routes/scheduling and its integrations) is unchanged.
 */
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, Hourglass } from 'lucide-react'
import Chip from '../../components/primitives'
import { PageHeader } from '../../components/ui'
import { ErrorBanner, ListSkeleton } from '../../components/states'
import { PLATFORMS, PLATFORM_ORDER, canPublish, usePublishing } from '../../lib/publishing'
import { useViewer } from '../../lib/viewer'
import { PlatformIcon } from '../../components/status'
import { PAGE_LINE, PUBLISHING_IN_BUILD } from '../../lib/copy'

export default function ChannelsPage() {
  const { channels, loading, error, reload } = usePublishing()
  // Compose is admin/publisher only (project.schedule); crew don't get a CTA into a page they can't use
  const mayCompose = canPublish(useViewer())

  return (
    <div className="fade-in space-y-6">
      <PageHeader
        title="Channels"
        subtitle={PAGE_LINE['/publishing/channels']}
        actions={
          mayCompose ? (
            <Link to="/publishing/compose" className="btn-secondary" data-testid="channels-compose">
              Draft a post <ArrowRight size={14} strokeWidth={1.75} />
            </Link>
          ) : undefined
        }
      />

      <p
        className="flex items-center gap-2 rounded-md border border-line px-4 py-3 text-[14px] text-umber"
        data-testid="publishing-mode"
      >
        <Hourglass size={15} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
        <span data-testid="publishing-mode-line">{PUBLISHING_IN_BUILD}</span>
      </p>

      {error && <ErrorBanner message={error} onRetry={() => void reload()} />}
      {loading ? (
        <ListSkeleton rows={4} height="h-14" />
      ) : (
        <ul className="card divide-y divide-line overflow-hidden" data-testid="channel-list">
          {PLATFORM_ORDER.map((p) => {
            const list = channels.filter((c) => c.platform === p)
            return (
              <li key={p} className="px-5 py-4" data-testid={`platform-${p}`}>
                <div className="flex items-center gap-3">
                  <PlatformIcon platform={p} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium text-ink">{PLATFORMS[p].label}</p>
                    <p className="text-[12px] text-umber">{PLATFORMS[p].hint}</p>
                  </div>
                  <Chip label={list.length ? `${list.length} on file` : 'Not set up yet'} />
                </div>
                {list.length > 0 && (
                  <ul className="mt-2 space-y-1 pl-11">
                    {list.map((c) => (
                      <li
                        key={c.id}
                        className="flex min-w-0 items-center gap-2 text-[13px]"
                        data-testid="channel-row"
                        data-status={c.status}
                      >
                        <span className="truncate text-ink">{c.name}</span>
                        {c.handle && <span className="truncate text-umber">@{c.handle}</span>}
                        {c.status === 'expired' && (
                          <span className="inline-flex items-center gap-1 text-[12px] text-warning">
                            <AlertTriangle size={12} strokeWidth={1.75} aria-hidden="true" />
                            Needs a refresh on our side
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
