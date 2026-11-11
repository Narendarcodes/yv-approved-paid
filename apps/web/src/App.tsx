import { lazy, Suspense, type ReactNode } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { DEMO_DEAL_PATH, isDemoJudge } from './lib/deals'
import { demoViewOf } from './lib/demoView'
import AppShell from './layouts/AppShell'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import ForgotPasswordPage from './pages/ForgotPasswordPage'
import { useAuth } from './lib/auth'
import DashboardPage from './pages/DashboardPage'
import MyWorkPage from './pages/MyWorkPage'
import ReviewPage from './pages/ReviewPage'
import ProjectsPage from './pages/ProjectsPage'
import ProjectDetailPage from './pages/ProjectDetailPage'
import ReviewWorkspacePage from './pages/ReviewWorkspacePage'
import ConceptsPage from './pages/ConceptsPage'
import AnalyticsPage from './pages/AnalyticsPage'
import BrandBrainPage from './pages/BrandBrainPage'
import PublishingCalendarPage from './pages/publishing/CalendarPage'
import PublishingComposerPage from './pages/publishing/ComposerPage'
import PublishingChannelsPage from './pages/publishing/ChannelsPage'
import NotificationsPage from './pages/NotificationsPage'
import ChatPage from './pages/ChatPage'
import MembersPage from './pages/MembersPage'
import SettingsPage from './pages/SettingsPage'
import ProfilePage from './pages/ProfilePage'
import LandingPage from './pages/LandingPage'
import ContractsPage from './pages/ContractsPage'
import InvoicesPage from './pages/InvoicesPage'
import DealsPage from './pages/DealsPage'
import DealPage from './pages/DealPage'
import PerformanceReportPage from './pages/PerformanceReportPage'
import BackendErrorPage from './pages/BackendErrorPage'
import { ListSkeleton } from './components/states'

// The money grids pull in AG Grid; loaded on demand so it stays out of the main bundle.
const PayablesPage = lazy(() => import('./pages/PayablesPage'))
const MyMoneyPage = lazy(() => import('./pages/MyMoneyPage'))
const lazyPage = (el: ReactNode) => (
  <Suspense fallback={<ListSkeleton rows={4} height="h-12" />}>{el}</Suspense>
)
import { useBackendHealth } from './lib/health'

/** Blocks the app shell until a session exists - redirects to /login. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { authenticated } = useAuth()
  const location = useLocation()
  if (!authenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return <>{children}</>
}

/**
 * Hides the signed-in app while the API is unreachable, so a backend outage
 * shows an explicit error instead of an empty dashboard. Public pages
 * (landing, login, register) are never gated; login reports its own errors.
 */
function RequireBackend({ children }: { children: ReactNode }) {
  const { healthy, checking, error } = useBackendHealth(30000)
  if (checking && healthy === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas" aria-busy="true">
        <span className="text-sm text-umber">Connecting to yv.…</span>
      </div>
    )
  }
  if (healthy === false)
    return <BackendErrorPage error={error} onRetry={() => window.location.reload()} />
  return <>{children}</>
}

/** Keeps signed-in users out of the auth screens - returns them to where they were headed. */
function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { authenticated, session } = useAuth()
  const location = useLocation()
  if (authenticated) {
    const from = (location.state as { from?: string } | null)?.from
    // the demo judge always lands on the demo deal, whichever way they got signed in;
    // the demo crew member (Leo, crew view) on his "My money"
    const email = session?.user?.email
    const home = isDemoJudge(email)
      ? DEMO_DEAL_PATH
      : demoViewOf(email) === 'editor'
        ? '/my-money'
        : '/dashboard'
    return <Navigate to={from && from !== '/' ? from : home} replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      {/* Public marketing home — the tunnel hero landing (no auth gate) */}
      <Route path="/" element={<LandingPage />} />
      <Route
        path="/login"
        element={
          <RedirectIfAuthed>
            <LoginPage />
          </RedirectIfAuthed>
        }
      />
      <Route
        path="/register"
        element={
          <RedirectIfAuthed>
            <RegisterPage />
          </RedirectIfAuthed>
        }
      />
      <Route
        path="/forgot-password"
        element={
          <RedirectIfAuthed>
            <ForgotPasswordPage />
          </RedirectIfAuthed>
        }
      />

      {/* Printable client report (no app chrome) */}
      <Route
        path="/reports/performance"
        element={
          <RequireAuth>
            <RequireBackend>
              <PerformanceReportPage />
            </RequireBackend>
          </RequireAuth>
        }
      />

      {/* Authenticated app shell */}
      <Route
        element={
          <RequireAuth>
            <RequireBackend>
              <AppShell />
            </RequireBackend>
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/my-work" element={<MyWorkPage />} />
        <Route path="/review" element={<ReviewPage />} />
        <Route path="/board" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/projects/:id/review" element={<ReviewWorkspacePage />} />
        <Route path="/concepts" element={<ConceptsPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/brand-brain" element={<BrandBrainPage />} />
        <Route path="/schedule" element={<Navigate to="/publishing/calendar" replace />} />
        <Route path="/publishing" element={<Navigate to="/publishing/calendar" replace />} />
        <Route path="/publishing/calendar" element={<PublishingCalendarPage />} />
        <Route path="/publishing/compose" element={<PublishingComposerPage />} />
        <Route path="/publishing/channels" element={<PublishingChannelsPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/contracts" element={<ContractsPage />} />
        <Route path="/invoices" element={<InvoicesPage />} />
        <Route path="/deals" element={<DealsPage />} />
        <Route path="/deals/:dealId" element={<DealPage />} />
        <Route path="/deals/:dealId/fund/:key" element={<DealPage />} />
        <Route path="/payables" element={lazyPage(<PayablesPage />)} />
        <Route path="/my-money" element={lazyPage(<MyMoneyPage />)} />
        <Route path="/members" element={<MembersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
      </Route>

      <Route path="*" element={<BackendErrorPage notFound />} />
    </Routes>
  )
}
