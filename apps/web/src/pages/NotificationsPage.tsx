import { useState } from 'react'
import { Calendar, Check, CircleCheck, Clock, MessageSquare, User } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useNotifications, markRead, markAllRead } from '../lib/notifications'
import { useToast } from '../components/toast'

const typeMeta: Record<string, { icon: JSX.Element; tone: string }> = {
  review: {
    tone: 'bg-tint text-teal',
    icon: <User size={15} strokeWidth={1.75} />,
  },
  approval: {
    tone: 'bg-success/10 text-success',
    icon: <CircleCheck size={15} strokeWidth={1.75} />,
  },
  revision: {
    tone: 'bg-warning/10 text-warning',
    icon: <Clock size={15} strokeWidth={1.75} />,
  },
  schedule: {
    tone: 'bg-ink/5 text-umber',
    icon: <Calendar size={15} strokeWidth={1.75} />,
  },
  published: {
    tone: 'bg-tint text-teal',
    icon: <Check size={15} strokeWidth={2} />,
  },
  comment: {
    tone: 'bg-ink/5 text-umber',
    icon: <MessageSquare size={15} strokeWidth={1.75} />,
  },
}

/** Where each notification type should take the user. Uses real projectId when available. */
function routeFor(n: { type: string; projectId?: string; payload?: any }): string {
  const pid = n.projectId ? String(n.projectId) : null
  if (pid) return `/projects/${pid}`
  const fallback: Record<string, string> = {
    review: '/review',
    comment: '/review',
    revision: '/projects',
    approval: '/projects',
    schedule: '/publishing/calendar',
    published: '/projects',
  }
  return fallback[n.type] ?? '/notifications'
}

export default function NotificationsPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const all = useNotifications()
  const [tab, setTab] = useState<'All' | 'Unread'>('All')
  const unread = all.filter((n) => n.unread).length
  const visible = tab === 'All' ? all : all.filter((n) => n.unread)

  const open = async (n: (typeof all)[number]) => {
    if (n.unread) {
      await markRead(n.id)
      toast('info', 'Marked as read')
    }
    navigate(routeFor(n))
  }

  return (
    <div className="fade-in mx-auto max-w-3xl">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="t-display">Notifications</h1>
          <p className="mt-1 text-sm text-umber" data-testid="notif-summary">
            {all.length === 0
              ? 'Mentions, approvals and deadlines'
              : unread
                ? `${unread} unread of ${all.length}`
                : `All ${all.length} read`}
          </p>
        </div>
        {unread > 0 && (
          <button
            onClick={async () => {
              await markAllRead()
              toast('success', 'All caught up')
            }}
            className="btn-ghost text-teal"
          >
            Mark all as read
          </button>
        )}
      </header>

      <div className="mb-5 flex rounded-[8px] border border-line bg-surface p-0.5 w-fit">
        {(['All', 'Unread'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-[6px] px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
              tab === t ? 'bg-ink text-on-accent' : 'text-umber hover:text-ink'
            }`}
          >
            {t}
            <span className="ml-1.5 font-mono text-[11px] opacity-70">
              {t === 'All' ? all.length : unread}
            </span>
          </button>
        ))}
      </div>

      <div className="card divide-y divide-line p-0">
        {visible.map((n) => {
          const meta = typeMeta[n.type] ?? typeMeta.comment
          return (
            <button
              key={n.id}
              onClick={() => open(n)}
              className={`flex w-full items-start gap-4 px-5 py-4 text-left transition-colors hover:bg-canvas/60 ${
                n.unread ? 'bg-tint/30' : ''
              }`}
            >
              <span
                className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${meta.tone}`}
              >
                {meta.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-ink">{n.title}</p>
                  {n.unread ? (
                    <span className="inline-flex items-center gap-1 text-[10px] text-teal">
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-teal"
                        aria-hidden="true"
                      />
                      Unread
                    </span>
                  ) : (
                    <span className=" text-[10px] text-label">Read</span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-[13px] text-umber">{n.desc}</p>
                <p className="micro-label mt-1">{n.time}</p>
              </div>
            </button>
          )
        })}
        {visible.length === 0 && (
          <p className="px-5 py-10 text-center text-sm text-umber">
            {tab === 'Unread' && all.length
              ? 'Nothing unread. You\u2019re all caught up.'
              : 'No notifications yet.'}
          </p>
        )}
      </div>
    </div>
  )
}
