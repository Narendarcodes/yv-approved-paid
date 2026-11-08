import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ArrowRight, Eye, EyeOff, Lock, Mail, PlayCircle } from 'lucide-react'
import { StatusDot, type Stage } from '../components/status'
import { useToast } from '../components/toast'
import { login as apiLogin, demoLogin, LoginError } from '../services/api'
import { rememberDealOrg } from '../lib/deals'
import BrandLogo from '../components/BrandLogo'

const PIPE: { label: string; stage: Stage }[] = [
  { label: 'Idea', stage: 'idea' },
  { label: 'Brief', stage: 'brief' },
  { label: 'Production', stage: 'production' },
  { label: 'Review', stage: 'review' },
  { label: 'Scheduled', stage: 'scheduled' },
  { label: 'Live', stage: 'live' },
]

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // null = not tried yet; false = this API has no demo (404), so the button hides
  const [demoAvailable, setDemoAvailable] = useState<boolean | null>(null)
  const [demoBusy, setDemoBusy] = useState(false)

  /** One tap: the judge session (DEMO_MODE=1 only), then straight to the seeded deal. */
  const tryDemo = async () => {
    setDemoBusy(true)
    setFormError(null)
    try {
      const r = await demoLogin()
      if (!r) {
        setDemoAvailable(false)
        setFormError('The demo is not switched on for this server. Sign in with your own account.')
        return
      }
      rememberDealOrg(r.organizationId)
      toast('success', 'Signed in to the demo')
      navigate(`/deals/${encodeURIComponent(r.dealId)}`, { replace: true })
      window.dispatchEvent(new StorageEvent('storage', { key: 'yv.session' }))
    } catch (e: any) {
      setFormError(e?.message || 'The demo could not start. Try again in a moment.')
    } finally {
      setDemoBusy(false)
    }
  }

  const from = (location.state as { from?: string } | null)?.from ?? '/'

  const signIn = async (emailAddr: string, passwordVal: string) => {
    setBusy(true)
    setFormError(null)
    try {
      await apiLogin(emailAddr, passwordVal)
      toast('success', 'Signed in')
      navigate(from, { replace: true })
    } catch (e) {
      setFormError(loginErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    let ok = true
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailError('Enter a valid work email')
      ok = false
    } else {
      setEmailError(null)
    }
    if (!password) {
      setPasswordError('Enter your password')
      ok = false
    } else {
      setPasswordError(null)
    }
    if (!ok) return
    void signIn(email.trim(), password)
  }

  return (
    <div className="flex min-h-screen bg-canvas">
      {/* Left: quiet typographic brand panel - no illustration */}
      <div className="relative hidden w-[44%] max-w-[640px] flex-col justify-between border-r border-line bg-cream px-12 py-10 lg:flex">
        <BrandLogo to="/" size={36} />

        <div>
          <h1 className=" max-w-md text-[32px] font-medium leading-[1.15] tracking-[-0.01em] text-ink">
            From idea to live post, in one calm workspace.
          </h1>

          <ol
            className="mt-10 max-w-sm divide-y divide-line border-y border-line"
            aria-label="The yv. pipeline"
          >
            {PIPE.map((st, i) => (
              <li key={st.label} className="flex items-center gap-3 py-2.5">
                <span className="w-5 font-mono text-[11px] text-label">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <StatusDot stage={st.stage} />
                <span className="text-sm font-medium text-ink">{st.label}</span>
              </li>
            ))}
          </ol>
        </div>

        <span />
      </div>

      {/* Right: form */}
      <div className="flex flex-1 items-center justify-center px-5 py-12 sm:px-8">
        <div className="w-full max-w-[400px]">
          <div className="mb-8 lg:hidden">
            <BrandLogo to="/" size={36} />
          </div>

          <div className="stagger rounded-[16px] border border-line bg-surface p-6 shadow-card sm:p-8">
            <div>
              <h2 className="t-display !text-[26px]">Sign in</h2>
            </div>

            <form onSubmit={submit} className="mt-7 space-y-5" noValidate>
              <div>
                <label htmlFor="email" className="label">
                  Work email
                </label>
                <div className="relative">
                  <Mail
                    size={16}
                    strokeWidth={1.75}
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-label"
                  />
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@studio.com"
                    className={`input !pl-10 ${emailError ? 'input-error' : ''}`}
                  />
                </div>
                {emailError && (
                  <p className="mt-1.5 text-xs text-st-failed" role="alert">
                    {emailError}
                  </p>
                )}
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label htmlFor="password" className="label !mb-0">
                    Password
                  </label>
                  <Link
                    to="/forgot-password"
                    className="text-xs font-medium text-teal transition-opacity hover:opacity-80"
                  >
                    Forgot password?
                  </Link>
                </div>
                <div className="relative">
                  <Lock
                    size={16}
                    strokeWidth={1.75}
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-label"
                  />
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className={`input !pl-10 !pr-10 ${passwordError ? 'input-error' : ''}`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="icon-btn icon-btn-sm absolute right-1.5 top-1/2 -translate-y-1/2"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? (
                      <EyeOff size={15} strokeWidth={1.75} />
                    ) : (
                      <Eye size={15} strokeWidth={1.75} />
                    )}
                  </button>
                </div>
                {passwordError && (
                  <p className="mt-1.5 text-xs text-st-failed" role="alert">
                    {passwordError}
                  </p>
                )}
              </div>
              {formError && (
                <div
                  className="rounded-[10px] border border-st-failed/20 bg-st-failed-bg px-3.5 py-2.5 text-sm text-st-failed"
                  role="alert"
                >
                  {formError}
                </div>
              )}
              <button type="submit" disabled={busy} className="btn-primary group w-full btn-lg">
                {busy ? 'Signing in…' : 'Sign in'}
                {!busy && (
                  <ArrowRight
                    size={16}
                    strokeWidth={2}
                    className="transition-transform group-hover:translate-x-0.5"
                  />
                )}
              </button>
            </form>

            {demoAvailable !== false && (
              <div className="mt-6 border-t border-line pt-5" data-testid="demo-login">
                <button
                  type="button"
                  onClick={tryDemo}
                  disabled={demoBusy || busy}
                  className="btn-secondary w-full btn-lg"
                >
                  <PlayCircle size={16} strokeWidth={2} />
                  {demoBusy ? 'Opening the demo…' : 'Try the demo'}
                </button>
                <p className="mt-2 text-center text-xs text-umber">
                  Seeded demo deal, no real money
                </p>
              </div>
            )}
          </div>
          <p className="mt-6 text-center text-sm text-umber">
            New to yv.?{' '}
            <Link
              to="/register"
              className="font-medium text-teal underline-offset-4 hover:underline"
            >
              Create your organization
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}

/** Tell a down or misrouted backend apart from a wrong password (ported from postiz-absorption d25400d). */
function loginErrorMessage(e: unknown): string {
  if (!(e instanceof LoginError)) return 'We could not sign you in. Please try again.'
  switch (e.kind) {
    case 'invalid_credentials':
      return 'We could not sign you in. Check your email and password, then try again.'
    case 'unreachable':
      return 'The yv. server is not responding right now. Your details were not checked. Try again in a moment.'
    case 'not_found':
      return `The sign-in service was not found (${e.message}). The app may be pointed at the wrong API address.`
    case 'rate_limited':
      return 'Too many sign-in attempts. Wait a few minutes, then try again.'
    default:
      return `Sign-in failed on the server: ${e.message}`
  }
}
