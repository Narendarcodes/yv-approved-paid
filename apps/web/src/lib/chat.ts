/**
 * Live team chat state for yv..
 *
 * - Loads the "Team Chat" project's channels, then their messages in parallel,
 *   with a timeout; errors and an empty chat get their own states, never a stuck
 *   "Loading…". A missing Team Chat is provisioned once (never a duplicate).
 * - Opens one Socket.IO connection, authenticated with the session JWT.
 * - Joins a room per open channel; incoming `message:new` events are merged
 *   into state in real time (no refresh needed).
 * - Exposes send() which persists via REST; the socket broadcast delivers it
 *   to everyone else viewing the channel.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import * as api from '../services/api'
import { chatTime as fmtTime } from './format'
import { primaryOrgId } from './data'
import { CHAT_LOAD_TIMEOUT_MS, TEAM_CHAT_TITLE, pickChatProject, withTimeout } from './chatLoad'

export { CHAT_LOAD_TIMEOUT_MS, withTimeout, pickChatProject }

export interface ChatChannel {
  id: string
  name: string
  projectId: string
}

export interface ChatMessage {
  id: string
  author: string
  text: string
  time: string
  pending?: boolean
  failed?: boolean
}

let socket: Socket | null = null

/** Derive the Socket.IO server origin from API_BASE (strips the /api/v1 prefix). */
function getSocketOrigin(): string {
  // API_ORIGIN is '' when the API is same-origin; socket.io then needs the page origin.
  return api.API_ORIGIN || window.location.origin
}

/** True on a same-origin deploy behind Vercel rewrites (*.vercel.app): socket.io must poll. */
export function socketViaRewrite(): boolean {
  return !api.API_ORIGIN && /\.vercel\.app$/i.test(window.location.hostname)
}

function getSocket(): Socket {
  if (socket) return socket
  // ADR-0017: the handshake authenticates with the httpOnly access cookie
  // (withCredentials); no token is readable from JS. If the access cookie has
  // expired the server answers 'unauthorized': refresh the session over REST
  // (which re-sets the cookie) and reconnect once.
  socket = io(
    getSocketOrigin(),
    socketViaRewrite()
      ? {
          // Vercel rewrites /socket.io to the API but cannot proxy websockets, and its
          // /socket.io/:path* rule misses the trailing-slash form "/socket.io/?EIO=4"
          // (that one gets index.html). So: long-polling only, path without the slash.
          withCredentials: true,
          path: '/socket.io',
          addTrailingSlash: false,
          transports: ['polling'],
        }
      : { withCredentials: true, transports: ['websocket', 'polling'] },
  )
  let retried = false
  socket.on('connect_error', async (err) => {
    if (err?.message !== 'unauthorized' || retried) return
    retried = true
    if (await api.refreshSession()) socket?.connect()
  })
  socket.on('connect', () => {
    retried = false
  })
  return socket
}

/** The app's one Socket.IO connection (chat rooms, deal rooms). */
export function sharedSocket(): Socket {
  return getSocket()
}

/** Close the shared socket (e.g. on logout). */
export function closeChatSocket() {
  socket?.disconnect()
  socket = null
}

async function findChatProject(orgId: string): Promise<{ id: string } | undefined> {
  // search by title: the plain list is capped (newest 50), so an old Team Chat would fall off it
  return pickChatProject(await api.listProjects(orgId, { search: TEAM_CHAT_TITLE }))
}

/**
 * One provisioning per org per session, shared by every caller (StrictMode's
 * double effect, a retry, two tabs of the page in one app). It looks again
 * right before creating, and the API returns the existing Team Chat instead of
 * a second one, so a duplicate is never created.
 */
const provisioning: Record<string, Promise<{ id: string } | undefined>> = {}
function provisionChat(orgId: string): Promise<{ id: string } | undefined> {
  provisioning[orgId] ??= (async () => {
    const again = await findChatProject(orgId)
    if (again) return again
    try {
      const p = await api.createProject({ title: TEAM_CHAT_TITLE, organizationId: orgId })
      await api.createChannel(p.id, 'general').catch(() => undefined)
      return p
    } catch {
      // roles that cannot create projects see an empty channel list
      return undefined
    }
  })().finally(() => {
    // keep a success (no second create this session); let a later load retry after a failure
    void provisioning[orgId]?.then((r) => {
      if (!r) delete provisioning[orgId]
    })
  })
  return provisioning[orgId]
}

const toMessage = (m: any): ChatMessage => ({
  id: String(m.id),
  author: String(m.author?._id ?? m.author),
  text: m.body,
  time: fmtTime(m.sentAt || m.createdAt),
})

/** Channels load first, then every channel's messages in parallel; one channel failing leaves it empty. */
async function loadChat(): Promise<{
  projectId: string | null
  channels: ChatChannel[]
  messages: Record<string, ChatMessage[]>
}> {
  const orgId = await primaryOrgId()
  const chatProject = (await findChatProject(orgId)) ?? (await provisionChat(orgId))
  if (!chatProject) return { projectId: null, channels: [], messages: {} }
  const projectId = String(chatProject.id)
  const chans = await api.listProjectChannels(projectId)
  const lists = await Promise.allSettled(
    chans.map((ch: any) => api.listChannelMessages(projectId, ch.id)),
  )
  const messages: Record<string, ChatMessage[]> = {}
  chans.forEach((ch: any, i: number) => {
    const r = lists[i]
    messages[String(ch.id)] = r.status === 'fulfilled' ? r.value.map(toMessage) : []
  })
  return {
    projectId,
    channels: chans.map((c: any) => ({
      id: String(c.id),
      name: '#' + c.name,
      projectId: String(c.projectId ?? projectId),
    })),
    messages,
  }
}

export function useChat() {
  const [channels, setChannels] = useState<ChatChannel[]>([])
  const [messagesByChannel, setMessagesByChannel] = useState<Record<string, ChatMessage[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [chatProjectId, setChatProjectId] = useState<string | null>(null)
  const joinedRef = useRef<Set<string>>(new Set())
  const runRef = useRef(0)

  const load = useCallback(async () => {
    const run = ++runRef.current
    setLoading(true)
    setError(false)
    try {
      const out = await withTimeout(loadChat(), CHAT_LOAD_TIMEOUT_MS)
      if (run !== runRef.current) return // a newer load (retry) owns the state
      setChatProjectId(out.projectId)
      setChannels(out.channels)
      setMessagesByChannel(out.messages)
    } catch {
      if (run === runRef.current) setError(true)
    } finally {
      if (run === runRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Real-time: join rooms for known channels and merge incoming messages.
  useEffect(() => {
    if (!channels.length) return
    const sock = getSocket()
    const onNew = (payload: { channelId: string; message: any }) => {
      const cid = String(payload.channelId)
      setMessagesByChannel((prev) => {
        const list = prev[cid] ?? []
        const msg = payload.message ?? {}
        const id = String(msg._id ?? msg.id ?? `${Date.now()}`)
        // Drop any optimistic copy with matching text by this author.
        const filtered = list.filter((m) => !(m.pending && m.text === msg.body))
        if (filtered.some((m) => m.id === id)) return prev
        return {
          ...prev,
          [cid]: [
            ...filtered,
            {
              id,
              author: String(msg.author?._id ?? msg.author),
              text: msg.body,
              time: fmtTime(msg.createdAt),
            },
          ],
        }
      })
    }
    sock.on('message:new', onNew)

    for (const c of channels) {
      if (!joinedRef.current.has(c.id)) {
        joinedRef.current.add(c.id)
        sock.emit('channel:join', { channelId: c.id })
      }
    }
    return () => {
      sock.off('message:new', onNew)
    }
  }, [channels])

  /** Persist a message via REST; the socket broadcast merges it into state. */
  const send = useCallback(async (channelId: string, projectId: string, text: string) => {
    if (!text.trim()) return
    const tempId = `pending-${Date.now()}`
    setMessagesByChannel((prev) => ({
      ...prev,
      [channelId]: [
        ...(prev[channelId] ?? []),
        { id: tempId, author: 'me', text: text.trim(), time: fmtTime(), pending: true },
      ],
    }))
    try {
      await api.sendChannelMessage(projectId, channelId, text.trim())
      // The broadcast will replace the optimistic entry. As a fallback for
      // the sender (who may not receive own broadcasts before re-render),
      // reconcile directly too.
    } catch {
      setMessagesByChannel((prev) => ({
        ...prev,
        [channelId]: (prev[channelId] ?? []).map((m) =>
          m.id === tempId ? { ...m, pending: false, failed: true } : m,
        ),
      }))
    }
  }, [])

  /** Create a new channel and select it. */
  const createChannel = useCallback(
    async (name: string) => {
      const chatProject = chatProjectId ?? channels[0]?.projectId
      if (!chatProject)
        throw new Error(
          loading
            ? 'Chat is still loading — try again in a moment.'
            : 'Team chat is not set up yet.',
        )
      const created = await api.createChannel(chatProject, name)
      const chan: ChatChannel = {
        id: String(created.id),
        name: '#' + created.name,
        projectId: chatProject,
      }
      setChannels((prev) => [...prev, chan])
      getSocket().emit('channel:join', { channelId: chan.id })
      return chan
    },
    [channels, chatProjectId, loading],
  )

  return { channels, messagesByChannel, loading, error, retry: load, send, createChannel }
}

/** Shared authenticated socket for org-scoped events (agent `job:update`, `insight:new`). */
export function getAppSocket(): Socket {
  return getSocket()
}
