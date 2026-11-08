/**
 * Brand Brain: ask the agent about brand rules and performance; run analyses.
 * Answers stream over SSE from Node (which proxies the private Python agent) and
 * always show the post/metric citations and the data limits the agent stated.
 */
import { useEffect, useRef, useState } from 'react'
import { Brain, Send, ListChecks } from 'lucide-react'
import { PageHeader } from '../components/ui'
import { ErrorBanner } from '../components/states'
import { useToast } from '../components/toast'
import { primaryOrgId } from '../lib/data'
import { getAppSocket } from '../lib/chat'
import {
  enqueueAgentJob,
  getAgentInsights,
  getAgentPosts,
  streamAgentChat,
  type AgentAnswer,
  type AgentInsight,
  type AgentPost,
} from '../services/api'

interface Turn {
  q: string
  text: string
  answer?: AgentAnswer
  flow?: string
  error?: string
}

const SUGGESTIONS = [
  'Why did our best short go viral?',
  "Can we use 'Buy now' as a call to action?",
  "Merge the reviewers' comments on the dads video",
  "Plan next week's posts from what worked",
]

export default function BrandBrainPage() {
  const toast = useToast()
  const [orgId, setOrgId] = useState<string | null>(null)
  const [posts, setPosts] = useState<AgentPost[]>([])
  const [insights, setInsights] = useState<AgentInsight[]>([])
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const titleOf = (id: string) =>
    posts.find((p) => p.id === id)?.title || (id === 'brand' ? 'Brand hub' : id.slice(-6))

  useEffect(() => {
    primaryOrgId().then(async (id) => {
      if (!id) return
      setOrgId(id)
      try {
        const [p, i] = await Promise.all([getAgentPosts(id), getAgentInsights(id)])
        setPosts(p)
        setInsights(i)
      } catch (e: any) {
        setError(e.message)
      }
      const sock = getAppSocket()
      sock.emit('org:join', { organizationId: id })
      const refresh = () =>
        getAgentInsights(id)
          .then(setInsights)
          .catch(() => {})
      sock.on('insight:new', refresh)
      sock.on('job:update', (j: any) => {
        toast(j.status === 'succeeded' ? 'success' : 'danger', `Agent job ${j.status}`, j.type)
      })
    })
    return () => {
      const s = getAppSocket()
      s.off('insight:new')
      s.off('job:update')
    }
  }, [])

  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [turns])

  async function ask(q: string) {
    if (!orgId || !q.trim() || busy) return
    setBusy(true)
    setInput('')
    setTurns((t) => [...t, { q, text: '' }])
    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((all) => all.map((t, i) => (i === all.length - 1 ? fn(t) : t)))
    try {
      await streamAgentChat(orgId, q, (ev, data) => {
        if (ev === 'meta') patch((t) => ({ ...t, flow: data.flow }))
        if (ev === 'token') patch((t) => ({ ...t, text: t.text + data.text }))
        if (ev === 'answer') patch((t) => ({ ...t, answer: data, text: data.answer }))
        if (ev === 'error') patch((t) => ({ ...t, error: data.message }))
      })
    } catch (e: any) {
      patch((t) => ({ ...t, error: e.message }))
    } finally {
      setBusy(false)
    }
  }

  async function run(postId: string, kind: 'analyze' | 'review-digest') {
    if (!orgId) return
    try {
      await enqueueAgentJob(orgId, postId, kind)
      toast(
        'info',
        kind === 'analyze' ? 'Analysis queued' : 'Review digest queued',
        'The result appears under Insights when ready',
      )
    } catch (e: any) {
      setError(e.message)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Brand Brain" />
      {error && <ErrorBanner message={error} />}
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <section className="flex min-h-[520px] flex-col rounded-xl border border-black/10 bg-white">
          <div className="flex-1 space-y-5 overflow-y-auto p-5" aria-live="polite">
            {turns.length === 0 && (
              <div className="space-y-3">
                <p className="flex items-center gap-2 text-sm text-black/60">
                  <Brain size={16} /> Try one of these:
                </p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => ask(s)}
                      className="rounded-full border border-black/10 px-3 py-1.5 text-sm hover:border-[#035E5E] hover:text-[#035E5E]"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className="space-y-2">
                <p className="font-medium text-[#171310]">{t.q}</p>
                {t.flow && (
                  <span className=" text-xs text-[#035E5E]">{t.flow.replace('_', ' ')}</span>
                )}
                <div className="whitespace-pre-wrap text-sm leading-relaxed text-black/80">
                  {t.text || (busy && i === turns.length - 1 ? 'Thinking…' : '')}
                </div>
                {t.error && <p className="text-sm text-red-700">{t.error}</p>}
                {t.answer && t.answer.citations.length > 0 && (
                  <div className="flex flex-wrap gap-1.5" aria-label="Citations">
                    {t.answer.citations.map((c, j) => (
                      <span
                        key={j}
                        title={c.note || ''}
                        className="rounded-md bg-[#035E5E]/8 px-2 py-0.5 text-xs text-[#035E5E]"
                      >
                        {titleOf(c.postId)} · {c.metric} = {String(c.value)}
                      </span>
                    ))}
                  </div>
                )}
                {t.answer && t.answer.dataLimits.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-5 text-xs text-black/55">
                    {t.answer.dataLimits.map((d, j) => (
                      <li key={j}>{d}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <form
            className="flex gap-2 border-t border-black/10 p-3"
            onSubmit={(e) => {
              e.preventDefault()
              ask(input)
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about a post, a rule, or next week's plan…"
              aria-label="Ask Brand Brain"
              className="flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#035E5E]"
            />
            <button
              disabled={busy || !input.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#171310] px-3 py-2 text-sm text-white disabled:opacity-40"
            >
              <Send size={14} /> Ask
            </button>
          </form>
        </section>
        <aside className="space-y-6">
          <div className="rounded-xl border border-black/10 bg-white p-4">
            <h2 className="mb-3 text-xs text-black/60">Posts</h2>
            <ul className="space-y-2">
              {posts.map((p) => (
                <li key={p.id} className="text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[#171310]">{p.title}</span>
                    <span className="shrink-0 text-xs text-black/50">
                      {p.platform} · {(p.metrics.views ?? 0).toLocaleString()} views
                    </span>
                  </div>
                  <div className="mt-1 flex gap-2">
                    <button
                      onClick={() => run(p.id, 'analyze')}
                      className="inline-flex items-center text-xs text-teal hover:underline"
                    >
                      Analyze
                    </button>
                    <button
                      onClick={() => run(p.id, 'review-digest')}
                      className="inline-flex items-center gap-1 text-xs text-[#035E5E] hover:underline"
                    >
                      <ListChecks size={12} /> Review digest
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-black/10 bg-white p-4">
            <h2 className="mb-3 text-xs text-black/60">Insights</h2>
            {insights.length === 0 && (
              <p className="text-sm text-black/50">Run Analyze on a post to get an insight.</p>
            )}
            <ul className="space-y-3">
              {insights.map((i) => (
                <li key={i.id} className="text-sm">
                  <p className=" text-xs text-[#035E5E]">
                    {i.kind.replace('_', ' ')}
                    {i.atSecond != null
                      ? ` @ ${Math.floor(i.atSecond / 60)}:${String(Math.round(i.atSecond % 60)).padStart(2, '0')}`
                      : ''}{' '}
                    · {titleOf(i.postId)}
                  </p>
                  <p className="line-clamp-4 whitespace-pre-wrap text-black/75">{i.summary}</p>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  )
}
