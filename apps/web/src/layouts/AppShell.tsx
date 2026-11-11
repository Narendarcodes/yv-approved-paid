import { useEffect, useRef, useState } from 'react'
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
  UserRound,
  LogOut,
  FileSignature,
  Receipt,
  Menu,
  X,
  Brain,
  Handshake,
  Landmark,
  Wallet,
  Compass,
  ArrowLeftRight,
} from 'lucide-react'
import Avatar from '../components/ui'
import { useViewer } from '../lib/viewer'
import { logout, useAuth } from '../lib/auth'
import { useNotifications, refreshNotifications } from '../lib/notifications'
import { useProjects } from '../lib/data'
import CommandPalette from '../components/CommandPalette'
import BrandLogo from '../components/BrandLogo'
import { API_ORIGIN, demoLogin } from '../services/api'
import { rememberDealOrg } from '../lib/deals'
import { DEMO_VIEWS, demoLanding, demoViewOf, otherDemoView } from '../lib/demoView'
import Tour from '../components/Tour'
import { TOUR_START_EVENT } from '../lib/tour'

// one icon size and stroke across the shell
const iconProps = { size: 16, strokeWidth: 1.5 }

type NavItem = {
  to: string
  label: string
  icon: () => React.ReactNode
  end?: boolean
  badge?: number
  roles?: string[]
}

const CRUMBS: Record<string, string> = {
  '': 'Dashboard',
  dashboard: 'Dashboard',
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
  'my-money': 'My money',
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
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  // Judge demo only: flip between Nora's brand view and Leo's crew view
  const demoSide = demoViewOf(session?.user.email)
  const [switching, setSwitching] = useState(false)
  const switchDemoSide = async () => {
    if (!demoSide || switching) return
    setSwitching(true)
    try {
      const r = await demoLogin(otherDemoView(demoSide))
      if (!r) return
      rememberDealOrg(r.organizationId)
      // a full load so every cached query belongs to the new person
      window.location.assign(demoLanding(r.as, r.dealId))
    } catch {
      setSwitching(false)
    }
  }
  const segments = location.pathname.split('/').filter(Boolean)
  const crumb = CRUMBS[segments[0] ?? ''] ?? 'Overview'

  // Global ⌘K / Ctrl+K - open the command palette from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Close the avatar menu on an outside click
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  // Close the mobile drawer and avatar menu whenever the route changes
  useEffect(() => {
    setNavOpen(false)
    setMenuOpen(false)
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
        <p className="text-sm text-umber">Loading…</p>
      </div>
    )
  }

  // A role-gated nav item opened by URL: a calm note instead of a page whose API answers 403
  const gated = navGroups
    .flatMap((g) => g.items)
    .find(
      (i) =>
        i.roles &&
        !i.roles.includes(viewer.role) &&
        (location.pathname === i.to || location.pathname.startsWith(`${i.to}/`)),
    )

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
    items: g.items.map((i) => (i.to === '/review' ? { ...i, badge: reviewCount } : i)),
  }))

  const avatarSrc = (viewer as any).photoUrl || (viewer as any).profileImage
  const avatarUrl = avatarSrc
    ? avatarSrc.startsWith('http')
      ? avatarSrc
      : `${API_ORIGIN}${avatarSrc}`
    : null

  const sidebar = (
    <>
      {/* Brand */}
      <div className="flex items-center px-4 pt-5 pb-4">
        <BrandLogo to="/deals" size={32} />
      </div>

      {/* Nav, grouped by job */}
      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        {groups.map((group, gi) => (
          <div
            key={group.section}
            className={gi ? 'mt-5' : ''}
            data-testid={`nav-group-${group.section.toLowerCase()}`}
          >
            {group.section !== 'Home' && <p className="nav-section">{group.section}</p>}
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  data-tour={`nav-${item.to}`}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                >
                  <item.icon />
                  <span className="flex-1">{item.label}</span>
                  {item.badge ? (
                    <span className="nav-badge" aria-label={`${item.badge} waiting`}>
                      {item.badge}
                    </span>
                  ) : null}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
    </>
  )

  return (
    <div className="flex min-h-screen bg-canvas">
      {/* ---------- Sidebar ---------- */}
      <aside
        className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-canvas lg:flex"
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
            className="fade-in absolute inset-0 bg-ink/40"
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
              <X {...iconProps} />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      {/* ---------- Main ---------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-canvas px-4 sm:gap-3 md:px-8">
          <button
            className="icon-btn -ml-1 lg:hidden"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            aria-expanded={navOpen}
            data-testid="nav-open"
          >
            <Menu {...iconProps} />
          </button>
          <span className="lg:hidden">
            <BrandLogo to="/deals" size={24} />
          </span>
          <p className="hidden text-sm text-umber lg:block">{crumb}</p>
          <button
            className="icon-btn ml-auto sm:hidden"
            onClick={() => setPaletteOpen(true)}
            aria-label="Search"
          >
            <Search {...iconProps} />
          </button>
          <div className="relative ml-auto hidden w-64 sm:block">
            <Search
              {...iconProps}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-umber"
            />
            <input
              placeholder="Search"
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
              className="input !h-9 !pl-9 cursor-text touch-manipulation"
              aria-label="Search projects"
              aria-expanded={paletteOpen}
              aria-haspopup="dialog"
            />
            <kbd className="kbd pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
              ⌘K
            </kbd>
          </div>
          <NavLink
            to="/notifications"
            className={({ isActive }) =>
              `icon-btn relative touch-manipulation ${isActive ? 'text-ink' : ''}`
            }
            aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications'}
            data-testid="notifications-button"
          >
            <Bell {...iconProps} aria-hidden="true" />
            {unreadCount > 0 && (
              <span className="nav-badge absolute -right-0.5 -top-0.5" aria-hidden="true">
                {unreadCount}
              </span>
            )}
          </NavLink>
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="rounded-full touch-manipulation"
              aria-label="Account menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-testid="avatar-menu-button"
              data-tour="avatar"
            >
              <Avatar initials={viewer.initials} size="sm" tone="ink" src={avatarUrl} />
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="fade-in absolute right-0 top-11 z-40 w-60 rounded-xl border border-line bg-surface p-1 shadow-pop"
                data-testid="avatar-menu"
              >
                <div className="px-3 py-2">
                  <p className="truncate text-sm font-medium text-ink">{viewer.name}</p>
                  <p className="truncate text-xs text-umber">
                    {session?.user.email ?? viewer.email}
                  </p>
                </div>
                <div className="my-1 border-t border-line" />
                <button role="menuitem" className="menu-item" onClick={() => navigate('/profile')}>
                  <UserRound {...iconProps} />
                  Profile
                </button>
                <button
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    window.dispatchEvent(new Event(TOUR_START_EVENT))
                  }}
                  data-testid="take-tour"
                >
                  <Compass {...iconProps} />
                  Take the tour
                </button>
                {demoSide && (
                  <button
                    role="menuitem"
                    className="menu-item"
                    onClick={switchDemoSide}
                    disabled={switching}
                    data-testid="demo-switch"
                  >
                    <ArrowLeftRight {...iconProps} />
                    {switching
                      ? 'Switching…'
                      : `Switch to ${DEMO_VIEWS[otherDemoView(demoSide)].label}`}
                  </button>
                )}
                {viewer.role === 'admin' && (
                  <button
                    role="menuitem"
                    className="menu-item"
                    onClick={() => navigate('/settings')}
                  >
                    <Settings {...iconProps} />
                    Settings
                  </button>
                )}
                <div className="my-1 border-t border-line" />
                <button
                  role="menuitem"
                  className="menu-item"
                  onClick={async () => {
                    await logout()
                    navigate('/login', { replace: true })
                  }}
                >
                  <LogOut {...iconProps} />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 px-4 py-6 sm:px-6 md:px-8 md:py-8">
          <div className="page-enter mx-auto max-w-[1440px]">
            {gated ? <NotForRole label={gated.label} /> : <Outlet />}
          </div>
        </main>
      </div>

      {/* First-visit guided tour (restart: avatar menu) */}
      <Tour projects={projects} />

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
 * Sidebar grouped by job. Every route stays one click away; notifications sit
 * in the top bar, settings and profile in the avatar menu.
 */
const navGroups: { section: string; items: NavItem[] }[] = [
  {
    section: 'Home',
    items: [
      {
        to: '/dashboard',
        label: 'Dashboard',
        icon: () => <LayoutGrid {...iconProps} />,
        end: true,
      },
    ],
  },
  {
    section: 'Create',
    items: [
      { to: '/projects', label: 'Projects', icon: () => <FolderKanban {...iconProps} /> },
      {
        to: '/concepts',
        label: 'Concepts',
        icon: () => <Lightbulb {...iconProps} />,
        roles: ['admin', 'editor', 'designer', 'reviewer'],
      },
      {
        to: '/review',
        label: 'Review',
        icon: () => <MessageSquare {...iconProps} />,
        roles: ['admin', 'reviewer'],
      },
      { to: '/brand-brain', label: 'Brand Brain', icon: () => <Brain {...iconProps} /> },
    ],
  },
  {
    section: 'Publish',
    items: [
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
    ],
  },
  {
    section: 'Money',
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
        label: 'My money',
        icon: () => <Wallet {...iconProps} />,
        roles: ['admin', 'editor', 'designer', 'publisher', 'member'],
      },
      {
        to: '/invoices',
        label: 'Invoices',
        icon: () => <Receipt {...iconProps} />,
        roles: ['admin', 'editor'],
      },
      {
        to: '/contracts',
        label: 'Contracts',
        icon: () => <FileSignature {...iconProps} />,
        roles: ['admin', 'editor'],
      },
    ],
  },
  {
    section: 'Team',
    items: [
      { to: '/my-work', label: 'My work', icon: () => <ListTodo {...iconProps} /> },
      { to: '/chat', label: 'Team chat', icon: () => <MessageCircle {...iconProps} /> },
      { to: '/members', label: 'Members', icon: () => <Users {...iconProps} />, roles: ['admin'] },
    ],
  },
]

/** Shown when a role opens a page its nav does not offer (the route stays; the page is not for this role). */
function NotForRole({ label }: { label: string }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center" data-testid="not-for-role">
      <h1 className="text-[20px] font-medium text-ink">{label} isn&apos;t part of your role</h1>
      <p className="mt-2 text-[14px] text-umber">
        Your workspace admin can change your role on the Members page.
      </p>
      <NavLink to="/dashboard" className="btn-secondary mt-6 inline-flex">
        Back to the dashboard
      </NavLink>
    </div>
  )
}
