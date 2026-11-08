import { useState } from 'react'
import { Check } from 'lucide-react'
import { useViewer } from '../lib/viewer'
import { ROLES, PERMISSION_LABELS } from '../lib/roles'
import { useToast } from '../components/toast'
import { useTeam } from '../lib/data'

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 rounded-full transition-colors ${on ? 'bg-teal' : 'bg-ink/15'}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-[left] ${on ? 'left-[22px]' : 'left-0.5'}`}
      />
    </button>
  )
}

function Row({
  title,
  desc,
  children,
}: {
  title: string
  desc: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-4">
      <div>
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="mt-0.5 text-[13px] text-umber">{desc}</p>
      </div>
      {children}
    </div>
  )
}

const PREFS_KEY = 'yv.settings'
type Prefs = { notifEmail: boolean; notifDigest: boolean; mentions: boolean }
const DEFAULT_PREFS: Prefs = { notifEmail: true, notifDigest: true, mentions: true }

/** Notification preferences live on this browser only (there is no settings API yet). */
function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null')
    if (!raw || typeof raw !== 'object') return DEFAULT_PREFS
    return {
      notifEmail: typeof raw.notifEmail === 'boolean' ? raw.notifEmail : DEFAULT_PREFS.notifEmail,
      notifDigest:
        typeof raw.notifDigest === 'boolean' ? raw.notifDigest : DEFAULT_PREFS.notifDigest,
      mentions: typeof raw.mentions === 'boolean' ? raw.mentions : DEFAULT_PREFS.mentions,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export default function SettingsPage() {
  const viewer = useViewer()
  const toast = useToast()
  const { org } = useTeam()
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [saved, setSaved] = useState<Prefs>(prefs)
  const dirty = JSON.stringify(prefs) !== JSON.stringify(saved)
  const set = (k: keyof Prefs) => (v: boolean) => setPrefs((p) => ({ ...p, [k]: v }))

  const save = () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
      setSaved(prefs)
      toast(
        'success',
        'Saved on this browser',
        'Your notification preferences are kept on this device.',
      )
    } catch {
      toast('danger', 'Could not save', 'This browser does not allow local storage.')
    }
  }

  return (
    <div className="fade-in mx-auto max-w-2xl">
      <header className="mb-6">
        <h1 className="t-display">Settings</h1>
        <p className="mt-1 text-sm text-umber">Manage your workspace and notifications</p>
      </header>

      <div className="space-y-6">
        {/* Organization */}
        <section className="card p-6">
          <h2 className="card-title">Organization</h2>
          <div className="mt-4 space-y-4">
            <div>
              <label className="label">Organization name</label>
              <input
                value={org?.name ?? ''}
                readOnly
                aria-readonly="true"
                className="input bg-canvas/60 text-umber"
                data-testid="org-name"
              />
              <p className="mt-1 text-[12px] text-label">Set when the workspace was created.</p>
            </div>
            <div>
              <label className="label">Workspace slug</label>
              <input
                value={org?.slug ?? ''}
                readOnly
                className="input bg-canvas/60 font-mono text-umber"
              />
            </div>
          </div>
        </section>

        {/* Roles & permissions */}
        <section className="card overflow-hidden">
          <header className="border-b border-line px-6 py-4">
            <h2 className="card-title">Roles & permissions</h2>
            <p className="mt-0.5 text-[13px] text-umber">
              What each role can do in this workspace - this mirrors the permissions the backend
              enforces.
            </p>
          </header>
          <div className="divide-y divide-line">
            {ROLES.map((r) => (
              <div
                key={r.role}
                className={`px-6 py-5 transition-colors ${r.role === viewer.role ? 'bg-tint/40' : 'hover:bg-canvas/40'}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="font-headline text-sm font-semibold tracking-[-0.01em] text-ink">
                      {r.label}
                    </span>
                    {r.role === viewer.role && (
                      <span className="rounded-full bg-teal/10 px-2 py-0.5 text-[10px] font-medium text-teal">
                        You
                      </span>
                    )}
                  </div>
                  <p className="max-w-md text-[13px] text-umber">{r.blurb}</p>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {r.permissions.map((p) => (
                    <span
                      key={p}
                      className="micro-label inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1"
                    >
                      <Check size={10} strokeWidth={2.5} className="text-teal" />
                      {PERMISSION_LABELS[p]}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Notifications */}
        <section className="card p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="card-title">Notifications</h2>
            <span className=" text-[10.5px] text-label" data-testid="prefs-scope">
              Saved on this browser
            </span>
          </div>
          <div className="mt-2 divide-y divide-line">
            <Row title="Email notifications" desc="Receive important updates by email">
              <Toggle on={prefs.notifEmail} onChange={set('notifEmail')} />
            </Row>
            <Row title="Weekly digest" desc="A summary of the week every Monday">
              <Toggle on={prefs.notifDigest} onChange={set('notifDigest')} />
            </Row>
            <Row title="Mentions" desc="Get notified when someone mentions you">
              <Toggle on={prefs.mentions} onChange={set('mentions')} />
            </Row>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button onClick={save} className="btn-primary" disabled={!dirty}>
              Save preferences
            </button>
            {!dirty && <span className="text-[12px] text-label">Up to date</span>}
          </div>
        </section>
      </div>
    </div>
  )
}
