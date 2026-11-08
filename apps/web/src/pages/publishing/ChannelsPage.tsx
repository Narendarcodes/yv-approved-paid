import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Plug,
  RefreshCw,
  Unplug,
  FlaskConical,
  Radio,
  ArrowRight,
  AlertTriangle,
  ExternalLink,
  ShieldCheck,
  ChevronRight,
} from 'lucide-react'
import Chip, { Modal } from '../../components/primitives'
import { PageHeader } from '../../components/ui'
import { ErrorBanner, ListSkeleton } from '../../components/states'
import { useToast } from '../../components/toast'
import { useViewer } from '../../lib/viewer'
import { PLATFORMS, PLATFORM_ORDER, usePublishing, canPublish } from '../../lib/publishing'
import {
  checkChannels,
  completeChannelConnect,
  disconnectChannel,
  importPostizChannels,
  reconnectChannel,
  startChannelConnect,
  type PlatformKey,
  type SocialChannel,
} from '../../services/api'
import { PlatformIcon } from '../../components/status'
import { PAGE_LINE } from '../../lib/copy'

export default function ChannelsPage() {
  const toast = useToast()
  const viewer = useViewer()
  const canManage = canPublish(viewer)
  const { orgId, status, channels, loading, error, reload } = usePublishing()
  const [connecting, setConnecting] = useState<PlatformKey | null>(null)
  const [handle, setHandle] = useState('')
  const [busy, setBusy] = useState(false)
  // Postiz OAuth: the authorisation runs in a popup; we wait for it to close
  const [oauth, setOauth] = useState<{ label: string; url: string } | null>(null)
  const popup = useRef<Window | null>(null)

  const openConnect = (p: PlatformKey) => {
    setHandle('')
    setConnecting(p)
  }

  const finishOauth = async () => {
    if (!orgId) return
    setBusy(true)
    try {
      const list = await completeChannelConnect(orgId)
      const live = list.filter((c) => c.status === 'connected').length
      toast(
        'success',
        'Channels refreshed from Postiz',
        `${live} connected channel${live === 1 ? '' : 's'}`,
      )
      setOauth(null)
      await reload()
    } catch (err: any) {
      toast('danger', 'Could not finish connecting', err?.message)
    } finally {
      setBusy(false)
    }
  }

  // auto-finish when the OAuth popup closes
  useEffect(() => {
    if (!oauth) return
    const t = window.setInterval(() => {
      if (popup.current && popup.current.closed) {
        window.clearInterval(t)
        popup.current = null
        void finishOauth()
      }
    }, 800)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauth])

  const handleStart = (
    label: string,
    res: { mode: string; url?: string; channel?: SocialChannel; reconnect?: boolean },
  ) => {
    if (res.mode === 'postiz' && res.url) {
      popup.current = window.open(res.url, 'postiz-connect', 'width=620,height=760')
      setOauth({ label, url: res.url })
      return false
    }
    toast(
      'success',
      `${label} ${res.reconnect ? 'reconnected' : 'connected'}`,
      `${res.channel?.name ?? 'Demo channel'} · simulated sign-in (demo mode)`,
    )
    return true
  }

  const connect = async () => {
    if (!orgId || !connecting) return
    setBusy(true)
    try {
      const res = await startChannelConnect(orgId, { platform: connecting, handle: handle.trim() })
      setConnecting(null)
      if (handleStart(PLATFORMS[connecting].label, res)) await reload()
    } catch (err: any) {
      toast('danger', 'Could not connect', err?.message)
    } finally {
      setBusy(false)
    }
  }

  const reconnect = async (c: SocialChannel) => {
    if (!orgId) return
    setBusy(true)
    try {
      const res = await reconnectChannel(orgId, c.id)
      if (handleStart(PLATFORMS[c.platform].label, res)) await reload()
    } catch (err: any) {
      toast('danger', 'Could not reconnect', err?.message)
    } finally {
      setBusy(false)
    }
  }

  const check = async () => {
    if (!orgId) return
    setBusy(true)
    try {
      const r = await checkChannels(orgId)
      if (r.apiKeyValid === false)
        toast('danger', 'Postiz rejected the API key', 'Check POSTIZ_API_KEY on the server')
      else
        toast(
          r.expired ? 'warning' : 'success',
          'Connections checked',
          r.expired ? `${r.expired} channel(s) need reconnecting` : 'Every channel is healthy',
        )
      await reload()
    } catch (err: any) {
      toast('danger', 'Check failed', err?.message)
    } finally {
      setBusy(false)
    }
  }

  const syncPostiz = async () => {
    if (!orgId) return
    setBusy(true)
    try {
      const linked = await importPostizChannels(orgId)
      toast(
        'success',
        'Synced from Postiz',
        `${linked.length} channel${linked.length === 1 ? '' : 's'} linked`,
      )
      await reload()
    } catch (err: any) {
      toast('danger', 'Postiz sync failed', err?.message)
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (id: string, name: string) => {
    if (!orgId) return
    try {
      await disconnectChannel(orgId, id)
      toast('success', 'Channel disconnected', name)
      await reload()
    } catch (err: any) {
      toast('danger', 'Could not disconnect', err?.message)
    }
  }

  const postiz = status?.mode === 'postiz'

  return (
    <div className="fade-in space-y-6">
      <PageHeader
        title="Channels"
        subtitle={PAGE_LINE['/publishing/channels']}
        actions={
          <Link to="/publishing/compose" className="btn-primary" data-testid="channels-compose">
            Schedule a post <ArrowRight size={14} strokeWidth={1.75} />
          </Link>
        }
      />

      {status && (
        <section
          className="card flex flex-wrap items-start justify-between gap-4 p-5"
          data-testid="publishing-mode"
          style={{ borderLeft: `3px solid ${postiz ? '#035E5E' : '#b45309'}` }}
        >
          <div className="flex items-start gap-3">
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${postiz ? 'bg-tint text-[#035E5E]' : 'bg-warning/10 text-warning'}`}
            >
              {postiz ? (
                <Radio size={18} strokeWidth={1.75} />
              ) : (
                <FlaskConical size={18} strokeWidth={1.75} />
              )}
            </span>
            <div>
              <h2 className="card-title">
                {postiz ? 'Publishing through Postiz' : 'Demo mode - built-in scheduler'}
              </h2>
              <p className="mt-1 max-w-2xl text-sm text-umber" data-testid="publishing-mode-line">
                {postiz
                  ? 'Postiz publishes your posts and reports back the live link and analytics.'
                  : 'No real accounts are touched: demo posts get a demo link and simulated metrics.'}
              </p>
              <details className="group mt-1 max-w-2xl">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12px] font-medium text-teal hover:text-teal-press [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    size={12}
                    strokeWidth={2}
                    className="transition-transform group-open:rotate-90"
                    aria-hidden="true"
                  />
                  Learn more
                </summary>
                <p className="mt-1 text-[12.5px] leading-relaxed text-umber">
                  {postiz
                    ? 'Posts are handed to your Postiz workspace, which holds the account tokens and does the publishing. Link the accounts you connected in Postiz below.'
                    : 'Demo channels are published by yv.\u2019s own scheduler at the chosen time, so the whole flow works without tokens. Set POSTIZ_API_URL and POSTIZ_API_KEY on the server to publish for real.'}
                </p>
              </details>
            </div>
          </div>
          {canManage && (
            <div className="flex flex-wrap gap-2">
              <button
                className="btn-ghost"
                onClick={() => void check()}
                disabled={busy}
                data-testid="channels-check"
              >
                <ShieldCheck size={14} strokeWidth={1.75} /> Check connections
              </button>
              {postiz && (
                <button
                  className="btn-secondary"
                  onClick={syncPostiz}
                  disabled={busy}
                  data-testid="postiz-sync"
                >
                  <RefreshCw size={14} strokeWidth={1.75} /> Sync from Postiz
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {error && <ErrorBanner message={error} onRetry={() => void reload()} />}
      {loading ? (
        <ListSkeleton rows={4} height="h-28" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {PLATFORM_ORDER.map((p) => {
            const list = channels.filter((c) => c.platform === p)
            return (
              <section key={p} className="card p-5" data-testid={`platform-${p}`}>
                <header className="flex items-center gap-3">
                  <PlatformIcon platform={p} size="lg" />
                  <div className="min-w-0 flex-1">
                    <h3 className="font-headline text-base font-semibold tracking-tight text-[#171310]">
                      {PLATFORMS[p].label}
                    </h3>
                    <p className="text-xs text-umber">{PLATFORMS[p].hint}</p>
                  </div>
                  {list.some((c) => c.status === 'expired') ? (
                    <Chip label="Reconnect needed" tone="danger" dot />
                  ) : list.length ? (
                    <Chip label={`${list.length} connected`} tone="teal" dot />
                  ) : (
                    <Chip label="Not connected" />
                  )}
                </header>

                <ul className="mt-4 space-y-2">
                  {list.map((c) => (
                    <li
                      key={c.id}
                      className={`flex flex-wrap items-center gap-3 rounded-[10px] border px-3 py-2.5 ${c.status === 'expired' ? 'border-danger/40 bg-danger/5' : 'border-line'}`}
                      data-testid="channel-row"
                      data-status={c.status}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink">{c.name}</p>
                        <p className="truncate font-mono text-xs text-umber">
                          {c.handle ? `@${c.handle}` : c.externalId || ''}
                        </p>
                        {c.status === 'expired' && (
                          <p className="mt-1 flex items-center gap-1 text-xs text-danger">
                            <AlertTriangle size={12} strokeWidth={2} />{' '}
                            {c.statusReason || 'Authorisation expired'}
                          </p>
                        )}
                      </div>
                      <Chip
                        label={c.mode === 'postiz' ? 'Postiz' : 'Demo'}
                        tone={c.mode === 'postiz' ? 'teal' : 'warning'}
                      />
                      {canManage && c.status === 'expired' && (
                        <button
                          className="btn-secondary !h-8 text-xs"
                          onClick={() => void reconnect(c)}
                          disabled={busy}
                          data-testid="channel-reconnect"
                        >
                          <RefreshCw size={12} strokeWidth={1.75} /> Reconnect
                        </button>
                      )}
                      {canManage && (
                        <button
                          className="icon-btn icon-btn-sm"
                          aria-label={`Disconnect ${c.name}`}
                          title="Disconnect"
                          onClick={() => void disconnect(c.id, c.name)}
                        >
                          <Unplug size={14} strokeWidth={1.75} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>

                {canManage && (
                  <button
                    className={list.length ? 'btn-ghost mt-3' : 'btn-secondary mt-4'}
                    onClick={() => openConnect(p)}
                    data-testid={`connect-${p}`}
                  >
                    <Plug size={14} strokeWidth={1.75} />{' '}
                    {list.length ? 'Add another account' : `Connect ${PLATFORMS[p].label}`}
                  </button>
                )}
              </section>
            )
          })}
        </div>
      )}

      <Modal
        open={!!connecting}
        onClose={() => setConnecting(null)}
        title={connecting ? `Connect ${PLATFORMS[connecting].label}` : 'Connect'}
      >
        {connecting && (
          <div className="space-y-4">
            {postiz ? (
              <p className="text-sm leading-relaxed text-umber">
                You will sign in to {PLATFORMS[connecting].label} in a Postiz window (Postiz holds
                the tokens). When you close it, yv. picks up the new channel automatically.
              </p>
            ) : (
              <p className="text-sm leading-relaxed text-umber">
                Demo mode: the sign-in is simulated, no real account is touched. Posts to it are
                published by the built-in scheduler with a demo link.
              </p>
            )}
            {!postiz && (
              <label className="block">
                <span className="text-xs font-medium text-umber">Account handle</span>
                <div className="mt-1 flex items-center gap-2">
                  <PlatformIcon platform={connecting} size="sm" />
                  <input
                    className="input flex-1"
                    value={handle}
                    autoFocus
                    onChange={(e) => setHandle(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void connect()}
                    placeholder={`@${PLATFORMS[connecting].placeholder}`}
                    data-testid="channel-handle"
                  />
                </div>
              </label>
            )}
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setConnecting(null)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={() => void connect()}
                disabled={busy}
                data-testid="channel-connect-submit"
              >
                {busy
                  ? 'Connecting…'
                  : postiz
                    ? `Continue to ${PLATFORMS[connecting].label}`
                    : 'Connect (simulated sign-in)'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={!!oauth}
        onClose={() => setOauth(null)}
        title={oauth ? `Connecting ${oauth.label}` : 'Connecting'}
      >
        {oauth && (
          <div className="space-y-4" data-testid="oauth-wait">
            <p className="text-sm leading-relaxed text-umber">
              Finish signing in in the Postiz window. If it did not open,{' '}
              <a
                className="font-medium text-[#035E5E] underline"
                href={oauth.url}
                target="_blank"
                rel="noreferrer"
              >
                open it here <ExternalLink size={12} className="inline" />
              </a>
              .
            </p>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setOauth(null)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={() => void finishOauth()}
                disabled={busy}
                data-testid="oauth-done"
              >
                {busy ? 'Checking…' : 'I have connected it'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
