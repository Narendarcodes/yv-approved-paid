import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutGrid,
  ListTodo,
  MessageSquare,
  MessageCircle,
  FolderKanban,
  Lightbulb,
  BarChart3,
  CalendarClock,
  Send,
  Radio,
  Bell,
  Users,
  Settings,
  Search,
  ChevronsUpDown,
  ChevronRight,
  LogOut,
  FileSignature,
  Receipt,
  Menu,
  X,
  Brain,
  Handshake,
  Landmark,
  Wallet,
} from 'lucide-react'
import Avatar from '../components/ui'
import { useViewer } from '../lib/viewer'
import { logout, useAuth } from '../lib/auth'
import { useNotifications, refreshNotifications } from '../lib/notifications'
import { useProjects } from '../lib/data'
import CommandPalette from '../components/CommandPalette'
import BrandLogo from '../components/BrandLogo'
import { API_ORIGIN } from '../services/api'

const iconProps = { size: 17, strokeWidth: 1.75 }

type NavItem = {
  to: string
  label: string
  icon: () => React.ReactNode
  end?: boolean
  badge?: number
  roles?: string[]
  tag?: string
}

const CRUMBS: Record<string, string> = {
  '': 'Pipeline',
  dashboard: 'Pipeline',
  reports: 'Report',
  projects: 'Projects',
  'my-work': 'My work',
  review: 'Review',
  board: 'Board',
  concepts: 'Concepts',
  analytics: 'Analytics',
  'brand-brain': 'Brand Brain',
  schedule: 'Publishing',
  publishing: 'Publishing',
  calendar: 'Calendar',
  compose: 'Compose',
  channels: 'Channels',
  chat: 'Team chat',
  notifications: 'Notifications',
  members: 'Members',
  settings: 'Settings',
  profile: 'Profile',
  contracts: 'Contracts',
  invoices: 'Invoices',
  deals: 'Deals',
  payables: 'Payables',
  'my-money': "Where's my money",
}

export default function AppShell() {
  const navigate = useNavigate()
  const location = useLocation()
  const viewer = useViewer()
  const { session } = useAuth()
  const notifs = useNotifications()
  const { projects } = useProjects()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // collapsed-by-default groups (More); remembered per browser
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('yv.nav.open') || '{}')
    } catch {
      return {}
    }
  })
  const toggleGroup = (section: string) =>
    setOpenGroups((g) => {
      const next = { ...g, [section]: !g[section] }
      localStorage.setItem('yv.nav.open', JSON.stringify(next))
      return next
    })
  const segments = location.pathname.split('/').filter(Boolean)
  const crumb = CRUMBS[segments[0] ?? ''] ?? 'Overview'

  // Global ⌘K / Ctrl+K - open the command palette from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Close the mobile drawer whenever the route changes
  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname])

  // Fetch notifications from the backend on mount
  useEffect(() => {
    void refreshNotifications()
  }, [])

  // The viewer is the authenticated session user (RequireAuth guarantees a
  // session; this guards the brief moment before the hook hydrates).
  if (!viewer) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <p className="text-sm text-umber">Loading your workspace…</p>
      </div>
    )
  }

  const visibleGroups = navGroups
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.roles || i.roles.includes(viewer.role)) }))
    .filter((g) => g.items.length > 0)

  // Live badge counts, consistent with Dashboard/Review pages
  const inReview = (s: string) =>
    ['FIRST_DRAFT_SUBMITTED', 'UNDER_REVIEW', 'REVISION_SUBMITTED'].includes(s)
  const reviewCount =
    viewer.role === 'admin' || viewer.role === 'reviewer'
      ? projects.filter((p) => inReview(p.status)).length
      : projects.filter((p) => inReview(p.status) && p.reviewers.includes(viewer.id)).length
  const unreadCount = notifs.filter((n) => n.unread).length

  const groups = visibleGroups.map((g) => ({
    ...g,
    items: g.items.map((i) => {
      if (i.to === '/review') return { ...i, badge: reviewCount }
      if (i.to === '/notifications') return { ...i, badge: unreadCount }
      return i
    }),
  }))

  const sidebar = (
    <>
      {/* Brand */}
      <div className="flex items-center gap-3 px-4 pt-5 pb-4">
        <BrandLogo to="/deals" size={36} />
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-4 overflow-y-auto px-3 pb-4">
        {groups.map((group) => {
          const containsActive = group.items.some(
            (i) => location.pathname === i.to || location.pathname.startsWith(`${i.to}/`),
          )
          const expanded = !group.collapsible || openGroups[group.section] || containsActive
          const hiddenBadge = group.items.reduce((a, i) => a + (i.badge || 0), 0)
          return (
            <div key={group.section} data-testid={`nav-group-${group.section.toLowerCase()}`}>
              {group.collapsible ? (
                <button
                  className="nav-section flex w-full items-center gap-1 text-left hover:text-ink"
                  onClick={() => toggleGroup(group.section)}
                  aria-expanded={expanded}
                  data-testid={`nav-toggle-${group.section.toLowerCase()}`}
                >
                  <ChevronRight
                    size={12}
                    strokeWidth={2}
                    className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
                  />
                  <span className="flex-1">{group.section}</span>
                  {!expanded && hiddenBadge > 0 && (
                    <span
                      className="flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-teal px-1 font-mono text-[9.5px] font-medium normal-case text-on-accent"
                      data-testid={`nav-badge-${group.section.toLowerCase()}`}
                      aria-label={`${hiddenBadge} new`}
                    >
                      {hiddenBadge}
                    </span>
                  )}
                </button>
              ) : (
                <p className="nav-section">{group.section}</p>
              )}
              {expanded && (
                <div className="space-y-0.5">
                  {group.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                    >
                      <item.icon />
                      <span className="flex-1">{item.label}</span>
                      {item.tag && (
                        <span className="rounded-full bg-warning/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-warning">
                          {item.tag}
                        </span>
                      )}
                      {item.badge ? (
                        <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-teal px-1 font-mono text-[10px] font-medium text-on-accent shadow-[0_1px_2px_rgba(15,118,110,0.35)]">
                          {item.badge}
                        </span>
                      ) : null}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {/* User footer */}
      <div className="border-t border-line p-3">
        <button
          onClick={() => navigate('/profile')}
          className="group flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-ink/4"
        >
          {(() => {
            const src = (viewer as any).photoUrl || (viewer as any).profileImage
            const url = src ? (src.startsWith('http') ? src : `${API_ORIGIN}${src}`) : null
            return <Avatar initials={viewer.initials} size="md" tone="ink" src={url} />
          })()}
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-sm font-medium text-ink">{viewer.name}</p>
            <p className="truncate text-[11px] text-umber">{viewer.title}</p>
          </div>
          <ChevronsUpDown
            size={14}
            strokeWidth={2}
            className="text-umber/40 transition-transform group-hover:text-label"
          />
        </button>
        <div className="mt-1.5 flex items-center gap-2 border-t border-line px-2 pt-2.5">
          <div className="min-w-0 flex-1 leading-tight">
            <p className="micro-label !text-[10px]">Signed in as</p>
            <p className="truncate text-[11px] text-ink/70">
              {session?.user.email ?? viewer.email}
            </p>
          </div>
          <button
            onClick={async () => {
              await logout()
              navigate('/login', { replace: true })
            }}
            className="icon-btn icon-btn-sm"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut size={15} strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </>
  )

  return (
    <div className="flex min-h-screen bg-canvas">
      {/* ---------- Sidebar ---------- */}
      <aside
        className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-line bg-canvas lg:flex"
        data-testid="sidebar"
      >
        {sidebar}
      </aside>

      {/* Mobile drawer (< lg): same nav, slides in over a scrim */}
      {navOpen && (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <div
            className="fade-in absolute inset-0 bg-ink/40 backdrop-blur-[2px]"
            onClick={() => setNavOpen(false)}
            aria-hidden="true"
          />
          <aside
            className="drawer-in relative flex h-full w-[min(280px,85vw)] flex-col border-r border-line bg-canvas shadow-pop"
            data-testid="mobile-nav"
          >
            <button
              className="icon-btn icon-btn-sm absolute right-3 top-5"
              onClick={() => setNavOpen(false)}
              aria-label="Close navigation"
            >
              <X size={16} strokeWidth={2} />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      {/* ---------- Main ---------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-canvas/85 px-4 backdrop-blur-md sm:gap-4 md:px-8">
          <button
            className="icon-btn -ml-1 lg:hidden"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            aria-expanded={navOpen}
            data-testid="nav-open"
          >
            <Menu size={18} strokeWidth={1.75} />
          </button>
          <span className="lg:hidden">
            <BrandLogo to="/deals" size={26} />
          </span>
          <p className="micro-label hidden items-center lg:flex">{crumb}</p>
          <button
            className="icon-btn ml-auto sm:hidden"
            onClick={() => setPaletteOpen(true)}
            aria-label="Search"
          >
            <Search size={17} strokeWidth={1.75} />
          </button>
          <div className="relative ml-auto hidden w-64 sm:block">
            <Search
              size={15}
              strokeWidth={1.75}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-label"
            />
            <input
              placeholder="Search projects…"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value)
                if (!paletteOpen) setPaletteOpen(true)
              }}
              onFocus={() => setPaletteOpen(true)}
              onClick={() => setPaletteOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  setPaletteOpen(true)
                }
                if (e.key === 'Escape') {
                  setSearchQuery('')
                }
              }}
              name="search"
              type="search"
              autoComplete="off"
              spellCheck={false}
              inputMode="search"
              className="input !h-9 !pl-9 cursor-text touch-manipulation focus-visible:ring-2 focus-visible:ring-teal/20 focus-visible:ring-offset-0"
              aria-label="Search projects"
              aria-expanded={paletteOpen}
              aria-haspopup="dialog"
            />
            <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md border border-line bg-canvas px-1.5 py-0.5 font-mono text-[9px] text-label">
              ⌘K
            </kbd>
          </div>
          <button
            onClick={() => navigate('/notifications')}
            className="icon-btn touch-manipulation focus-visible:ring-2 focus-visible:ring-teal/20"
            aria-label="Notifications"
            data-testid="notifications-button"
          >
            <span className="relative inline-flex">
              <Bell size={17} strokeWidth={1.75} aria-hidden="true" />
              {unreadCount > 0 && (
                <span
                  className="ping-dot absolute right-[-2px] top-[-2px] h-2 w-2 rounded-full bg-danger"
                  aria-hidden="true"
                />
              )}
            </span>
          </button>
          <button
            onClick={() => navigate('/profile')}
            className="rounded-full ring-2 ring-transparent transition-[box-shadow,transform] hover:ring-teal/40 active:scale-95 touch-manipulation focus-visible:ring-2 focus-visible:ring-teal/20"
            aria-label="Profile"
          >
            {(() => {
              const src = (viewer as any).photoUrl || (viewer as any).profileImage
              const url = src ? (src.startsWith('http') ? src : `${API_ORIGIN}${src}`) : null
              return <Avatar initials={viewer.initials} size="sm" tone="ink" src={url} />
            })()}
          </button>
        </header>

        {/* Page content */}
        <main className="flex-1 px-4 py-6 sm:px-6 md:px-8 md:py-8">
          <div className="page-enter mx-auto max-w-[1440px]">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Global command palette */}
      <CommandPalette
        open={paletteOpen}
        initialQuery={searchQuery}
        onClose={() => {
          setPaletteOpen(false)
          setSearchQuery('')
        }}
      />
    </div>
  )
}

/**
 * Sidebar: the deal flow first (Deals, Projects, Review, Invoices), everything
 * else under a collapsible "More" that opens itself on its own pages and shows
 * the badges it hides. No page is removed; every route is still one click away.
 */
const navGroups: { section: string; items: NavItem[]; collapsible?: boolean }[] = [
  {
    section: 'Workspace',
    items: [
      { to: '/deals', label: 'Deals', icon: () => <Handshake {...iconProps} /> },
      {
        // brands approve (admin, reviewer); editors manage deals (deal.manage)
        to: '/payables',
        label: 'Payables',
        icon: () => <Landmark {...iconProps} />,
        roles: ['admin', 'reviewer', 'editor'],
      },
      {
        // crew members: anyone who can be named on a deal's team
        to: '/my-money',
        label: "Where's my money",
        icon: () => <Wallet {...iconProps} />,
        roles: ['admin', 'editor', 'designer', 'publisher', 'member'],
      },
      { to: '/projects', label: 'Projects', icon: () => <FolderKanban {...iconProps} /> },
      {
        to: '/review',
        label: 'Review',
        icon: () => <MessageSquare {...iconProps} />,
        roles: ['admin', 'reviewer'],
      },
      {
        to: '/invoices',
        label: 'Invoices',
        icon: () => <Receipt {...iconProps} />,
        roles: ['admin', 'editor'],
      },
    ],
  },
  {
    section: 'More',
    collapsible: true,
    items: [
      {
        to: '/dashboard',
        label: 'Dashboard',
        icon: () => <LayoutGrid {...iconProps} />,
        end: true,
      },
      {
        to: '/concepts',
        label: 'Concepts',
        icon: () => <Lightbulb {...iconProps} />,
        roles: ['admin', 'editor', 'designer', 'reviewer'],
      },
      { to: '/my-work', label: 'My work', icon: () => <ListTodo {...iconProps} /> },
      {
        to: '/publishing/calendar',
        label: 'Calendar',
        icon: () => <CalendarClock {...iconProps} />,
        roles: ['admin', 'publisher', 'editor', 'designer', 'reviewer'],
      },
      {
        to: '/publishing/compose',
        label: 'Compose',
        icon: () => <Send {...iconProps} />,
        roles: ['admin', 'publisher'],
      },
      {
        to: '/publishing/channels',
        label: 'Channels',
        icon: () => <Radio {...iconProps} />,
        roles: ['admin', 'publisher', 'editor'],
      },
      { to: '/analytics', label: 'Analytics', icon: () => <BarChart3 {...iconProps} /> },
      { to: '/brand-brain', label: 'Brand Brain', icon: () => <Brain {...iconProps} /> },
      { to: '/notifications', label: 'Notifications', icon: () => <Bell {...iconProps} /> },
      { to: '/chat', label: 'Team chat', icon: () => <MessageCircle {...iconProps} /> },
      {
        to: '/contracts',
        label: 'Contracts',
        icon: () => <FileSignature {...iconProps} />,
        roles: ['admin', 'editor'],
      },
      { to: '/members', label: 'Members', icon: () => <Users {...iconProps} />, roles: ['admin'] },
      {
        to: '/settings',
        label: 'Settings',
        icon: () => <Settings {...iconProps} />,
        roles: ['admin'],
      },
    ],
  },
]
