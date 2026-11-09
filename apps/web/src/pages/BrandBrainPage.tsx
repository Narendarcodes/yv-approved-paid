/**
 * Brand Brain: ask the agent about brand rules and performance; run analyses.
 * Answers stream over SSE from Node (which proxies the private Python agent) and
 * always show the post/metric citations and the data limits the agent stated.
 */
import { useEffect, useState } from 'react'
import { Brain, ListChecks } from 'lucide-react'
import {
  AssistantBlock,
  Composer,
  JumpToLatest,
  Markdown,
  UserBubble,
  useStickToBottom,
} from '../components/chat/Thread'
import { PageHeader } from '../components/ui'
import { ErrorBanner } from '../components/states'
import { useToast } from '../components/toast'
import { primaryOrgId } from '../lib/data'
import { getAppSocket } from '../lib/chat'
import {
  enqueueAgentJob,
  getAgentInsights,
  getBrandMemory,
  type BrandMemory,
  getAgentPosts,
  streamAgentChat,
  type AgentAnswer,
  type AgentInsight,
  type AgentPost,
} from '../services/api'
import { PAGE_LINE } from '../lib/copy'
import { citationHint, citationLabel } from '../lib/citations'

interface Turn {
  q: string
  text: string
  answer?: AgentAnswer
  flow?: string
  error?: string
}

/**
 * What the reader sees when the agent or its model fails: one plain line, never a
 * provider's raw error (billing, 410 Gone, stack text). Display only.
 */
function friendlyError(raw: string): string {
  const m = String(raw || '')
  if (/402|insufficient|billing|quota|budget/i.test(m))
    return 'The assistant is out of model credit right now. Brand memory is still listed on the side.'
  if (/410|404|not found|gone/i.test(m))
    return 'The assistant’s model is unavailable right now. Brand memory is still listed on the side.'
  if (/took too long/i.test(m))
    return 'The assistant took too long to answer. Try again; brand memory is still listed on the side.'
  if (/not configured|unavailable|waking|agent service|503|502|timeout|timed out/i.test(m))
    return 'The assistant is offline right now. Try again in a minute; brand memory is still listed on the side.'
  return 'The assistant could not answer this time. Try again in a moment.'
}

const SUGGESTIONS = [
  'What are our logo and colour rules?',
  "Can we use 'Buy now' as a call to action?",
  'Who is our audience?',
  'Which words should captions avoid?',
]

/** Brand memory groups, in the order a reader scans them. */
const KIND_LABEL: Record<string, string> = {
  purpose: 'Brand',
  voice: 'Voice and tone',
  do: 'Use',
  dont: 'Avoid',
  visual: 'Logo and colour',
  audience: 'Audience',
  resource: 'Products and templates',
}

export default function BrandBrainPage() {
  const toast = useToast()
  const [orgId, setOrgId] = useState<string | null>(null)
  const [posts, setPosts] = useState<AgentPost[]>([])
  const [insights, setInsights] = useState<AgentInsight[]>([])
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [memory, setMemory] = useState<BrandMemory | null>(null)
  const [agentOffline, setAgentOffline] = useState(false)
  const titleOf = (id: string) =>
    posts.find((p) => p.id === id)?.title || (id === 'brand' ? 'Brand hub' : id.slice(-6))

  useEffect(() => {
    primaryOrgId().then(async (id) => {
      if (!id) return
      setOrgId(id)
      getBrandMemory(id)
        .then(setMemory)
        .catch(() => setMemory({ rules: [], sample: [] }))
      try {
        const [p, i] = await Promise.all([getAgentPosts(id), getAgentInsights(id)])
        setPosts(p)
        setInsights(i)
      } catch {
        // the agent service is optional: the memory and the sample still show
        setAgentOffline(true)
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

  const lastText = turns.length ? turns[turns.length - 1].text.length : 0
  const { endRef, atBottom, jump } = useStickToBottom(`${turns.length}:${lastText}`)

  async function ask(q: string) {
    if (!orgId || !q.trim() || busy) return
    setBusy(true)
    setInput('')
    setTurns((t) => [...t, { q, text: '' }])
    requestAnimationFrame(() => jump(false))
    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((all) => all.map((t, i) => (i === all.length - 1 ? fn(t) : t)))
    try {
      await streamAgentChat(orgId, q, (ev, data) => {
        if (ev === 'meta') patch((t) => ({ ...t, flow: data.flow }))
        if (ev === 'token') patch((t) => ({ ...t, text: t.text + data.text }))
        if (ev === 'answer')
          patch((t) => ({
            ...t,
            answer: data,
            text: data.answer,
            error: String(data.answer || '').trim()
              ? t.error
              : 'The model returned no text this time. Try again in a moment.',
          }))
        if (ev === 'error') patch((t) => ({ ...t, error: friendlyError(data.message) }))
      })
    } catch (e: any) {
      patch((t) => ({ ...t, error: friendlyError(e.message) }))
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

  const groups = Object.keys(KIND_LABEL)
    .map((k) => ({ k, rules: (memory?.rules ?? []).filter((r) => r.kind === k) }))
    .filter((g) => g.rules.length > 0)
  const side = (
    <div className="space-y-6">
      <section data-testid="brand-memory">
        <h2 className="text-[13px] font-medium text-ink">
          Brand memory{memory ? ` (${memory.rules.length})` : ''}
        </h2>
        {memory && memory.rules.length === 0 && (
          <p className="mt-2 text-[13px] text-umber">No brand rules saved yet.</p>
        )}
        <div className="mt-2 space-y-3">
          {groups.map((g) => (
            <div key={g.k}>
              <p className="text-[12px] text-teal">{KIND_LABEL[g.k]}</p>
              <ul className="mt-1 space-y-1">
                {g.rules.map((r) => (
                  <li key={r.id} className="text-[13px]">
                    <details>
                      <summary className="cursor-pointer text-ink">{r.title}</summary>
                      <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-umber">{r.body}</p>
                    </details>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
      {agentOffline && (
        <p className="text-[12px] text-umber" data-testid="agent-offline">
          The assistant is offline right now; brand memory still shows here.
        </p>
      )}
      <section>
        <h2 className="text-[13px] font-medium text-ink">Posts</h2>
        <ul className="mt-2 divide-y divide-line">
          {posts.map((p) => (
            <li key={p.id} className="py-2 text-[13px]">
              <p className="text-ink">{p.title}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[12px] text-umber">
                <span className="t-num">
                  {p.platform} · {(p.metrics.views ?? 0).toLocaleString()} views
                </span>
                <button onClick={() => run(p.id, 'analyze')} className="text-teal hover:underline">
                  Analyze
                </button>
                <button
                  onClick={() => run(p.id, 'review-digest')}
                  className="inline-flex items-center gap-1 text-teal hover:underline"
                >
                  <ListChecks size={12} aria-hidden="true" /> Review digest
                </button>
              </p>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="text-[13px] font-medium text-ink">Insights</h2>
        {insights.length === 0 && (
          <p className="mt-2 text-[13px] text-umber">Run Analyze on a post to get an insight.</p>
        )}
        <ul className="mt-2 space-y-3">
          {insights.map((i) => (
            <li key={i.id} className="text-[13px]">
              <p className="text-[12px] text-teal">
                {i.kind.replace('_', ' ')}
                {i.atSecond != null
                  ? ` @ ${Math.floor(i.atSecond / 60)}:${String(Math.round(i.atSecond % 60)).padStart(2, '0')}`
                  : ''}{' '}
                · {titleOf(i.postId)}
              </p>
              <p className="line-clamp-4 whitespace-pre-wrap text-ink/80">{i.summary}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )

  return (
    <div>
      <PageHeader title="Brand Brain" subtitle={PAGE_LINE['/brand-brain']} />
      {error && <ErrorBanner message={error} />}
      <details className="mb-4 rounded-md border border-line px-3 py-2 lg:hidden">
        <summary className="cursor-pointer text-[13px] text-umber">
          Brand memory, posts and insights
        </summary>
        <div className="pt-3">{side}</div>
      </details>
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-10">
        <section
          className="mx-auto flex min-h-[calc(100dvh-220px)] w-full max-w-[720px] flex-col"
          aria-label="Brand Brain conversation"
          data-testid="brand-brain-thread"
        >
          <div className="flex-1 space-y-8 pb-6" aria-live="polite">
            {turns.length === 0 && (memory?.sample.length ?? 0) > 0 && (
              <div className="space-y-6 pt-2" data-testid="brand-brain-sample">
                <p className="text-[12px] text-label">Sample conversation</p>
                {memory!.sample.map((t, i) => (
                  <div key={i} className="space-y-4">
                    <UserBubble>{t.q}</UserBubble>
                    <AssistantBlock meta="brand qa">
                      <Markdown text={t.a} />
                      {t.cites.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5" aria-label="From brand memory">
                          {t.cites.map((c) => (
                            <span
                              key={c}
                              className="rounded-sm border border-line px-2 py-0.5 text-[12px] text-umber"
                            >
                              Brand memory · {c}
                            </span>
                          ))}
                        </div>
                      )}
                    </AssistantBlock>
                  </div>
                ))}
              </div>
            )}
            {turns.length === 0 && (
              <div className="space-y-3 pt-6">
                <p className="flex items-center gap-2 text-[14px] text-umber">
                  <Brain size={16} strokeWidth={1.5} aria-hidden="true" /> Try one of these
                </p>
                <div className="flex flex-col items-start gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => ask(s)}
                      className="rounded-md border border-line px-3 py-2 text-left text-[14px] text-ink hover:border-line-strong"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className="space-y-4">
                <UserBubble>{t.q}</UserBubble>
                <AssistantBlock meta={t.flow ? t.flow.replace('_', ' ') : undefined}>
                  {t.text ? (
                    <Markdown text={t.text} />
                  ) : busy && i === turns.length - 1 ? (
                    <p className="text-umber">Thinking…</p>
                  ) : null}
                  {t.error && <p className="mt-2 text-[14px] text-danger">{t.error}</p>}
                  {t.answer && t.answer.citations.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Citations">
                      {t.answer.citations.map((c, j) => (
                        <span
                          key={j}
                          title={citationHint(c) || undefined}
                          className="rounded-sm border border-line px-2 py-0.5 text-[12px] text-umber"
                        >
                          {citationLabel(c, titleOf)}
                        </span>
                      ))}
                    </div>
                  )}
                  {t.answer && t.answer.dataLimits.length > 0 && (
                    <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[12px] text-umber">
                      {t.answer.dataLimits.map((d, j) => (
                        <li key={j}>{d}</li>
                      ))}
                    </ul>
                  )}
                </AssistantBlock>
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <JumpToLatest show={!atBottom && turns.length > 0} onClick={() => jump()} />
          <Composer
            value={input}
            onChange={setInput}
            onSend={() => void ask(input)}
            placeholder="Ask about a post, a rule, or next week's plan…"
            label="Ask Brand Brain"
            busy={busy}
          />
        </section>
        <aside className="hidden lg:block">
          <div className="sticky top-20">{side}</div>
        </aside>
      </div>
    </div>
  )
}
