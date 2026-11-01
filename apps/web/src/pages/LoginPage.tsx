import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ArrowRight, Eye, EyeOff, Lock, Mail } from 'lucide-react'
import { StatusDot, type Stage } from '../components/status'
import { useToast } from '../components/toast'
import { login as apiLogin, LoginError } from '../services/api'
import BrandLogo from '../components/BrandLogo'

const PIPE: { label: string; hint: string; stage: Stage }[] = [
  { label: 'Idea', hint: 'Concepts & votes', stage: 'idea' },
  { label: 'Brief', hint: 'Inputs & owners', stage: 'brief' },
  { label: 'Production', hint: 'Drafts & versions', stage: 'production' },
  { label: 'Review', hint: 'Frame-accurate notes', stage: 'review' },
  { label: 'Scheduled', hint: 'Every channel', stage: 'scheduled' },
  { label: 'Live', hint: 'Results flow back', stage: 'live' },
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
          <p className="micro-label">Content operations</p>
          <h1 className="mt-4 max-w-md font-headline text-[36px] font-semibold leading-[1.1] tracking-[-0.03em] text-ink">
            From idea to live post, in one calm workspace.
          </h1>
          <p className="mt-4 max-w-sm text-[15px] leading-relaxed text-umber">
            Briefs, drafts, reviews, scheduling and results - with the whole team on the same page.
          </p>

          <ol className="mt-10 max-w-sm divide-y divide-line border-y border-line" aria-label="The yv. pipeline">
            {PIPE.map((st, i) => (
              <li key={st.label} className="flex items-center gap-3 py-2.5">
                <span className="w-5 font-mono text-[11px] text-label">{String(i + 1).padStart(2, '0')}</span>
                <StatusDot stage={st.stage} />
                <span className="text-sm font-medium text-ink">{st.label}</span>
                <span className="ml-auto text-xs text-umber">{st.hint}</span>
              </li>
            ))}
          </ol>
        </div>

        <p className="font-mono text-[11px] text-label">Role-based access · Secure sign-in</p>
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
              <p className="mt-1.5 text-sm text-umber">Welcome back. Pick up where you left off.</p>
            </div>

            <form onSubmit={submit} className="mt-7 space-y-5" noValidate>
              <div>
                <label htmlFor="email" className="label">Work email</label>
                <div className="relative">
                  <Mail size={16} strokeWidth={1.75} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-label" />
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
                  <label htmlFor="password" className="label !mb-0">Password</label>
                  <Link to="/forgot-password" className="text-xs font-medium text-teal transition-opacity hover:opacity-80">
                    Forgot password?
                  </Link>
                </div>
                <div className="relative">
                  <Lock size={16} strokeWidth={1.75} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-label" />
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
                    {showPassword ? <EyeOff size={15} strokeWidth={1.75} /> : <Eye size={15} strokeWidth={1.75} />}
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
                {!busy && <ArrowRight size={16} strokeWidth={2} className="transition-transform group-hover:translate-x-0.5" />}
              </button>
            </form>

          </div>
          <p className="mt-6 text-center text-sm text-umber">
            New to yv.?{' '}
            <Link to="/register" className="font-medium text-teal underline-offset-4 hover:underline">
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
