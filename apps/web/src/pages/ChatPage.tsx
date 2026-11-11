import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info, Plus, WifiOff, X, Hash, Users } from 'lucide-react'
import Avatar from '../components/ui'
import { Skeleton, ErrorBanner } from '../components/states'
import { useViewer } from '../lib/viewer'
import { can } from '../lib/roles'
import { useTeam } from '../lib/data'
import { useChat } from '../lib/chat'
import type { ChatChannel } from '../lib/chat'
import { Composer, JumpToLatest, UserBubble, useStickToBottom } from '../components/chat/Thread'
import { PAGE_LINE, EMPTY_LINE } from '../lib/copy'

export default function ChatPage() {
  const viewer = useViewer()
  // creating a channel needs chat.post (admin, editor, reviewer); publishers only read here
  const mayCreateChannel = can(viewer, 'post_chat')
  const chat = useChat()
  const { team, loading: teamLoading } = useTeam()

  const [channelId, setChannelId] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [newChannelOpen, setNewChannelOpen] = useState(false)
  const [newChannelName, setNewChannelName] = useState('')
  const [creatingChannel, setCreatingChannel] = useState(false)
  const [channelError, setChannelError] = useState<string | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)

  const active: ChatChannel | undefined = channels_of(chat.channels, channelId) ?? chat.channels[0]
  const messages = active ? (chat.messagesByChannel[active.id] ?? []) : []
  const memberOf = (id: string) => team.find((m) => m.id === id)

  // Auto-scroll to the newest message while the reader is at the bottom.
  const { endRef, atBottom, jump } = useStickToBottom(`${active?.id}:${messages.length}`)
  useEffect(() => jump(false), [active?.id, jump])

  const submit = async () => {
    if (!draft.trim() || !active || sending) return
    setSending(true)
    try {
      await chat.send(active.id, active.projectId, draft)
      setDraft('')
      requestAnimationFrame(() => jump(false))
    } finally {
      setSending(false)
    }
  }

  const createChannel = async () => {
    if (!newChannelName.trim() || creatingChannel || chat.loading) return
    setCreatingChannel(true)
    setChannelError(null)
    try {
      const chan = await chat.createChannel(newChannelName.trim())
      setChannelId(chan.id)
      setNewChannelOpen(false)
      setNewChannelName('')
    } catch (err: any) {
      setChannelError(String(err?.message || 'Could not create channel.'))
    } finally {
      setCreatingChannel(false)
    }
  }

  const createForm = (
    <div className="border-b border-line p-2">
      <input
        autoFocus
        value={newChannelName}
        onChange={(e) => setNewChannelName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void createChannel()}
        placeholder="channel-name"
        className="input !h-8 font-mono text-[12px]"
      />
      <button
        onClick={() => void createChannel()}
        disabled={!newChannelName.trim() || creatingChannel || chat.loading}
        className="btn-primary mt-1.5 !h-7 w-full text-xs"
      >
        {chat.loading ? 'Loading…' : creatingChannel ? 'Creating…' : 'Create channel'}
      </button>
      {channelError && (
        <p className="mt-1 font-mono text-xs text-danger" role="alert">
          {channelError}
        </p>
      )}
    </div>
  )

  return (
    <div className="fade-in">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="t-display">Team chat</h1>
          <p className="mt-1 text-[14px] text-umber">{PAGE_LINE['/chat']}</p>
        </div>
      </header>
      {/* Mobile channel bar: the channel list is hidden below sm */}
      <div className="card mb-3 p-2 sm:hidden" data-testid="chat-mobile-channels">
        <div className="flex items-center gap-2">
          {chat.channels.length > 0 && (
            <select
              aria-label="Channel"
              value={active?.id ?? ''}
              onChange={(e) => setChannelId(e.target.value)}
              className="input !h-9 flex-1 font-mono text-[13px]"
            >
              {chat.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {mayCreateChannel && (
            <button
              onClick={() => setNewChannelOpen((v) => !v)}
              className={chat.channels.length > 0 ? 'icon-btn' : 'btn-primary w-full'}
              aria-label="New channel"
              title="New channel"
            >
              <Plus size={15} strokeWidth={1.75} />
              {chat.channels.length > 0 ? null : ' New channel'}
            </button>
          )}
        </div>
        {mayCreateChannel && newChannelOpen && (
          <div className="mt-2 rounded-[8px] border border-line">{createForm}</div>
        )}
      </div>
      <div className="flex gap-8">
        {/* Channel list */}
        <aside className="card sticky top-20 hidden max-h-[calc(100dvh-7rem)] w-56 shrink-0 flex-col self-start p-0 sm:flex">
          <header className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="card-title">Channels</h2>
            {mayCreateChannel && (
              <button
                onClick={() => setNewChannelOpen((v) => !v)}
                className="icon-btn icon-btn-sm"
                aria-label="New channel"
                title="New channel"
              >
                <Plus size={15} strokeWidth={1.75} />
              </button>
            )}
          </header>

          {mayCreateChannel && newChannelOpen && createForm}

          <ul className="flex-1 overflow-y-auto p-2">
            {chat.loading || teamLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <li key={i} className="px-2 py-1.5">
                  <Skeleton className="h-5 w-full" />
                </li>
              ))
            ) : chat.error ? (
              <li className="px-2 py-3 text-[13px] text-umber" data-testid="chat-channels-error">
                Channels did not load.{' '}
                <button
                  className="font-medium text-teal hover:underline"
                  onClick={() => void chat.retry()}
                >
                  Retry
                </button>
              </li>
            ) : chat.channels.length === 0 ? (
              <li className="px-2 py-3 text-[13px] text-umber" data-testid="chat-empty-channels">
                No channels yet.
                {mayCreateChannel && (
                  <>
                    {' '}
                    <button
                      className="font-medium text-teal hover:underline"
                      onClick={() => setNewChannelOpen(true)}
                    >
                      Create the first one
                    </button>
                  </>
                )}
              </li>
            ) : (
              chat.channels.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => setChannelId(c.id)}
                    className={`flex w-full items-center gap-2 rounded-[8px] px-3 py-2.5 text-left transition-colors ${
                      c.id === active?.id ? 'bg-tint text-teal' : 'text-ink hover:bg-ink/4'
                    }`}
                  >
                    <span className="truncate font-mono text-sm font-medium">{c.name}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </aside>

        {/* Messages: a full-height thread the page scrolls, composer pinned to the bottom */}
        <section
          className="mx-auto flex min-h-[calc(100dvh-220px)] w-full min-w-0 max-w-[720px] flex-1 flex-col"
          data-testid="chat-thread"
        >
          <header className="flex items-center justify-between gap-3 border-b border-line pb-3">
            <div className="min-w-0">
              <h2 className="truncate font-mono text-[14px] font-medium text-ink">
                {chat.loading
                  ? 'Loading…'
                  : chat.error
                    ? 'Chat unavailable'
                    : (active?.name ?? 'No channel')}
              </h2>
              {active && <p className="text-[12px] text-umber">Live · updates in real time</p>}
            </div>
            <button
              onClick={() => setInfoOpen(true)}
              className="icon-btn icon-btn-sm touch-manipulation focus-visible:ring-2 focus-visible:ring-teal/20"
              aria-label="Channel info"
              aria-expanded={infoOpen}
              aria-haspopup="dialog"
              title="Channel info"
            >
              <Info size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </header>

          <div className="flex-1 space-y-5 py-5" aria-live="polite">
            {chat.loading ? (
              <div className="space-y-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <Skeleton className="h-8 w-8 rounded-full" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3 w-24" />
                      <Skeleton className="h-4 w-2/3" />
                    </div>
                  </div>
                ))}
              </div>
            ) : chat.error ? (
              <ErrorBanner message="Team chat did not load." onRetry={() => void chat.retry()} />
            ) : !chat.channels.length ? (
              <div className="py-10 text-center" data-testid="chat-empty">
                <p className="text-sm text-umber">No channels yet.</p>
                <p className="mt-1 text-[13px] text-umber">{EMPTY_LINE.chatChannels}</p>
                {mayCreateChannel && (
                  <button className="btn-primary mt-3" onClick={() => setNewChannelOpen(true)}>
                    <Plus size={14} strokeWidth={2} /> Create the first one
                  </button>
                )}
              </div>
            ) : messages.length === 0 ? (
              <p className="py-10 text-center text-sm text-umber">
                No messages yet{active ? ` — say hi in ${active.name}` : ''}.
              </p>
            ) : (
              messages.map((m) => {
                const mine = m.author === viewer.id || m.author === 'me'
                const author = memberOf(m.author)
                if (mine)
                  return (
                    <UserBubble
                      key={m.id}
                      meta={
                        <span className="t-num">
                          {m.time}
                          {m.pending && ' · sending…'}
                          {m.failed && (
                            <span className="inline-flex items-center gap-1 text-danger">
                              {' '}
                              · <WifiOff size={10} strokeWidth={2} /> failed
                            </span>
                          )}
                        </span>
                      }
                    >
                      <span className={m.failed ? 'text-danger' : ''}>{m.text}</span>
                    </UserBubble>
                  )
                return (
                  <div key={m.id} className="flex items-start gap-3">
                    <Avatar initials={author?.initials ?? '?'} size="sm" tone="tint" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[13px] font-medium text-ink">
                          {author?.name ?? m.author}
                        </span>
                        <span className="t-num text-[12px] text-umber">{m.time}</span>
                      </div>
                      <p className="mt-0.5 whitespace-pre-wrap break-words text-[14px] leading-6 text-ink/90">
                        {m.text}
                      </p>
                    </div>
                  </div>
                )
              })
            )}
            <div ref={endRef} />
          </div>

          <JumpToLatest show={!atBottom && messages.length > 0} onClick={() => jump()} />
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={() => void submit()}
            placeholder={active ? `Message ${active.name}` : 'Select a channel first'}
            disabled={!active}
            busy={sending}
            label="Message"
          />
        </section>

        {/* Channel info drawer — portal so it escapes card overflow */}
        {infoOpen &&
          createPortal(
            <div className="fixed inset-0 z-[70] flex justify-end">
              <div
                className="absolute inset-0 bg-ink/30 backdrop-blur-[1px]"
                onClick={() => setInfoOpen(false)}
                aria-hidden="true"
              />
              <div
                role="dialog"
                aria-modal="true"
                aria-label="Channel info"
                className="relative flex h-full w-full max-w-sm flex-col border-l border-line bg-surface shadow-pop transition-transform"
                style={{ overscrollBehavior: 'contain' } as any}
              >
                <header className="card-head justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-line bg-canvas text-teal">
                      <Hash size={14} strokeWidth={1.75} aria-hidden="true" />
                    </span>
                    <div>
                      <h3 className="font-headline text-sm font-semibold text-ink">
                        {active?.name ?? 'Channel'}
                      </h3>
                      <p className="font-mono text-xs text-label">
                        {active ? `Project ${active.projectId.slice(0, 8)}…` : ''}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setInfoOpen(false)}
                    className="icon-btn icon-btn-sm touch-manipulation focus-visible:ring-2 focus-visible:ring-teal/20"
                    aria-label="Close channel info"
                  >
                    <X size={14} strokeWidth={2} aria-hidden="true" />
                  </button>
                </header>
                <div className="flex-1 overflow-y-auto p-5">
                  <div className="rounded-xl border border-line bg-canvas/60 p-4">
                    <p className="micro-label">About</p>
                    <p className="mt-2 text-sm leading-relaxed text-ink/80">
                      {active?.name === '#Stories Category'
                        ? 'Imported WhatsApp “Stories Category” — real messages, tasks and feedback from the Stories workflow. Live updates via Socket.IO.'
                        : active
                          ? `${active.name} — team channel for quick updates.`
                          : 'Select a channel to see details.'}
                    </p>
                  </div>
                  <div className="mt-4 rounded-xl border border-line bg-canvas/60 p-4">
                    <p className="micro-label flex items-center gap-1.5">
                      <Users size={11} strokeWidth={1.75} aria-hidden="true" /> Team
                    </p>
                    {teamLoading ? (
                      <p className="mt-2 text-xs text-label">Loading…</p>
                    ) : (
                      <ul className="mt-3 space-y-2">
                        {team.slice(0, 8).map((m) => (
                          <li key={m.id} className="flex items-center gap-2.5">
                            <Avatar initials={m.initials} size="xs" tone="tint" />
                            <span className="min-w-0 flex-1 truncate text-sm text-ink">
                              {m.name}
                            </span>
                            <span className="micro-label">{m.role}</span>
                          </li>
                        ))}
                        {team.length > 8 && (
                          <li className="font-mono text-xs text-label">+{team.length - 8} more</li>
                        )}
                      </ul>
                    )}
                  </div>
                  <div className="mt-4 rounded-xl border border-line bg-canvas/40 px-4 py-3">
                    <p className="micro-label">Details</p>
                    <dl className="mt-2 space-y-1.5 text-xs">
                      <div className="flex justify-between gap-4">
                        <dt className="text-label">Messages</dt>
                        <dd className="font-mono font-medium tabular-nums text-ink">
                          {messages.length}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-label">Channel ID</dt>
                        <dd className="truncate font-mono text-xs text-ink/70">
                          {active?.id ?? '—'}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )}
      </div>
    </div>
  )
}

function channels_of(channels: ChatChannel[], id: string): ChatChannel | undefined {
  return channels.find((c) => c.id === id)
}
