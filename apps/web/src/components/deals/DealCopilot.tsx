/**
 * DealCopilot: a side panel that answers with deal cards (generative UI).
 * Live AI when the API's deal agent is on (POST .../copilot): an LLM picks the
 * cards, ids only. Otherwise (agent off, slow, down) the offline replay maps
 * the words to cards with no LLM call (lib/copilot.tsx), so the demo always
 * works. Every reply is labelled honestly: "live AI" or "offline replay".
 *
 * The copilot only PROPOSES. Money moves through the card buttons (human
 * routes) and the Money Agent's policy engine; a proposal that policy refuses
 * renders PolicyBlockedChip with "No money moved".
 * AI checks facts, people own taste, the deal decides the money.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Bot, Send } from 'lucide-react'
import * as api from '../../services/api'
import type { DealView } from '../../contracts/types'
import {
  captureDryRun,
  fromLive,
  matchIntent,
  moneyAsk,
  SUGGESTIONS,
  type CopilotAction,
} from '../../lib/copilot'
import {
  blockedSummary,
  groupViolations,
  money,
  useDealLedger,
  useDealRefresh,
} from '../../lib/deals'
import { Skeleton } from '../states'
import { DealCardShell } from './common'
import DealCard from './DealCard'
import LiveChecksCard from './LiveChecksCard'
import ReviewMergeCard from './ReviewMergeCard'
import MoneyTimeline from './MoneyTimeline'
import ChangeOrderCard from './ChangeOrderCard'
import DisputeSplitCard from './DisputeSplitCard'
import PolicyBlockedChip from './PolicyBlockedChip'

type Mode =
  | { kind: 'live'; provider: string | null; model: string | null; cached: boolean }
  | { kind: 'offline'; reason?: string }
  | { kind: 'policy' }
  | { kind: 'thinking' }
type Turn = {
  id: number
  role: 'user' | 'copilot'
  text?: string
  actions?: CopilotAction[]
  mode?: Mode
  note?: string | null
}

/** The web gives the live path this long (the API itself gives up at ~15 s), then replays offline. */
const LIVE_BUDGET_MS = 18_000
/** Reasons that will not change during this visit: stop asking the API for a while. */
const STICKY_OFFLINE = new Set(['agent_disabled', 'not_found'])

function ModeLabel({ mode }: { mode?: Mode }) {
  if (!mode) return null
  if (mode.kind === 'thinking') return <p className=" text-[10px] text-label">asking live AI…</p>
  if (mode.kind === 'policy')
    return (
      <p
        className=" text-[10px] text-label"
        title="A money ask with an amount or a version is dry-run straight through the policy engine; no model call"
        data-testid="copilot-mode"
      >
        policy dry-run · no AI
      </p>
    )
  if (mode.kind === 'live')
    return (
      <p
        className=" text-[10px] text-teal"
        title={mode.model ?? undefined}
        data-testid="copilot-mode"
      >
        live AI{mode.provider ? ` · ${mode.provider}` : ''}
        {mode.cached ? ' · cached' : ''}
      </p>
    )
  return (
    <p
      className=" text-[10px] text-label"
      title={
        mode.reason
          ? `Live AI unavailable (${mode.reason}); matched offline from your words, no model call`
          : 'Matched offline from your words; no model call'
      }
      data-testid="copilot-mode"
    >
      offline replay
    </p>
  )
}

/** Blocked attempts on the ledger (P3_amount, P6_version...), each with its rule chip. */
function BlockedAttempts({ deal, orgId }: { deal: DealView; orgId: string }) {
  const ledger = useDealLedger(orgId, deal.id)
  const blocked = (ledger.data?.entries ?? []).filter((e) => e.type === 'blocked')
  return (
    <DealCardShell testId="blocked-attempts" label="Policy" title="Blocked attempts">
      {ledger.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : !blocked.length ? (
        <p className="text-[13px] text-umber">Nothing has been blocked on this deal.</p>
      ) : (
        <ul className="space-y-3">
          {blocked.map((e) => (
            <li key={e.seq}>
              <p className="text-[13px] font-medium text-danger">
                {blockedSummary(e, deal.terms.currency).title}
              </p>
              <p className="text-[12.5px] text-ink/80">
                {blockedSummary(e, deal.terms.currency).reason}
              </p>
              <div className="mt-1">
                <PolicyBlockedChip
                  violations={e.policy?.violations ?? []}
                  currency={deal.terms.currency}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </DealCardShell>
  )
}

/** proposeCapture: a read-only policy dry-run. Never a button that moves money. */
function CaptureProposal({
  deal,
  orgId,
  action,
}: {
  deal: DealView
  orgId: string
  action: Extract<CopilotAction, { name: 'proposeCapture' }>
}) {
  const plan = captureDryRun(deal, action)
  const q = useQuery({
    queryKey: ['deal-dry-run', orgId, deal.id, JSON.stringify(plan?.body ?? null)],
    queryFn: () => api.dealPolicyCheck(orgId, deal.id, plan!.body),
    enabled: !!plan,
    staleTime: 0,
  })
  const cur = deal.terms.currency
  const ms = deal.terms.milestones.find((m) => m.key === action.milestoneKey)
  return (
    <DealCardShell
      testId="capture-proposal"
      label="Proposal · dry run"
      title={`Capture on ${ms?.title ?? action.milestoneKey}`}
    >
      {!plan ? (
        <p className="text-[13px] text-umber">
          There is no submitted version to capture against yet.
        </p>
      ) : (
        <>
          <p className="text-[13px] text-ink">
            Capture <span className="t-num">{money(plan.amountMinor, cur)}</span>{' '}
            <span className="text-umber">
              ({plan.amountFrom === 'typed' ? 'the number you typed' : 'the signed amount'})
            </span>{' '}
            for version <span className="font-mono">{plan.versionId}</span>
            {plan.latestId && plan.versionId !== plan.latestId && (
              <span className="text-umber"> (latest is {plan.latestId})</span>
            )}
            .
          </p>
          <div className="mt-3">
            {q.isLoading ? (
              <Skeleton className="h-8 w-full" />
            ) : q.isError ? (
              <p className="text-[13px] text-danger">
                The policy check did not answer: {(q.error as Error)?.message}
              </p>
            ) : q.data?.allowed ? (
              <p className="text-[13px] text-umber">
                Policy would allow this{q.data?.needsHumanApproval ? ' after one human tap' : ''}.
                The copilot does not move money: the client approves the version on its card and the
                Money Agent captures the signed amount.
              </p>
            ) : (
              <>
                <p
                  className="mb-2 text-[13px] font-medium text-danger"
                  data-testid="dry-run-headline"
                >
                  Blocked, no money moved
                  {(() => {
                    const ids = groupViolations(q.data?.violations ?? [], cur).map((g) => g.id)
                    return ids.length ? ` · ${ids.join(' ')}` : ''
                  })()}
                </p>
                <PolicyBlockedChip
                  violations={q.data?.violations ?? []}
                  currency={deal.terms.currency}
                />
              </>
            )}
          </div>
        </>
      )}
    </DealCardShell>
  )
}

function Rendered({
  action,
  deal,
  orgId,
  onChanged,
}: {
  action: CopilotAction
  deal: DealView
  orgId: string
  onChanged: () => void
}) {
  switch (action.name) {
    case 'showDeal':
      return <DealCard deal={deal} orgId={orgId} onChanged={onChanged} />
    case 'showChecks':
      return (
        <LiveChecksCard
          deal={deal}
          orgId={orgId}
          milestoneKey={action.milestoneKey}
          onChanged={onChanged}
        />
      )
    case 'showReviewMerge':
      return (
        <ReviewMergeCard
          deal={deal}
          orgId={orgId}
          milestoneKey={action.milestoneKey}
          onChanged={onChanged}
        />
      )
    case 'showMoneyTimeline':
      return (
        <MoneyTimeline
          deal={deal}
          orgId={orgId}
          milestoneKey={action.milestoneKey}
          onChanged={onChanged}
        />
      )
    case 'showChangeOrder':
      return (
        <ChangeOrderCard
          deal={deal}
          orgId={orgId}
          changeOrderId={action.changeOrderId}
          onChanged={onChanged}
        />
      )
    case 'showDisputeSplit':
      return (
        <DisputeSplitCard
          deal={deal}
          orgId={orgId}
          milestoneKey={action.milestoneKey}
          onChanged={onChanged}
        />
      )
    case 'showBlocked':
      return <BlockedAttempts deal={deal} orgId={orgId} />
    case 'proposeCapture':
      return <CaptureProposal deal={deal} orgId={orgId} action={action} />
    default:
      return (
        <p className="text-[13px] text-umber">
          Ask about the deal, checks, notes, money, a change order or the split
        </p>
      )
  }
}

export default function DealCopilot({
  deal,
  orgId,
  autoAsk,
}: {
  deal: DealView
  orgId: string
  /** Ask this once per nonce (the judge tour's step 3). */
  autoAsk?: { text: string; nonce: number } | null
}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [text, setText] = useState('')
  const seq = useRef(0)
  const end = useRef<HTMLDivElement>(null)
  const refresh = useDealRefresh(orgId, deal.id)

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' })
  }, [turns])

  const liveOff = useRef<string | null>(null)
  // null until the first reply: the badge only says "offline replay" once a reply really came from it
  const [lastMode, setLastMode] = useState<Mode['kind'] | null>(null)

  const ask = async (q: string) => {
    const t = q.trim()
    if (!t) return
    const uid = ++seq.current
    const cid = ++seq.current
    setText('')
    // a money verb with an amount or a version: policy answers it, deterministically, no model
    const dry = moneyAsk(t, deal)
    if (dry) {
      setTurns((prev) => [
        ...prev,
        { id: uid, role: 'user', text: t },
        { id: cid, role: 'copilot', actions: [dry], mode: { kind: 'policy' } },
      ])
      setLastMode('policy')
      return
    }
    const offline = (reason?: string) => {
      setTurns((prev) =>
        prev.map((x) =>
          x.id === cid
            ? { ...x, actions: matchIntent(t, deal), mode: { kind: 'offline', reason } }
            : x,
        ),
      )
      setLastMode('offline')
    }
    if (liveOff.current) {
      setTurns((prev) => [
        ...prev,
        { id: uid, role: 'user', text: t },
        {
          id: cid,
          role: 'copilot',
          actions: matchIntent(t, deal),
          mode: { kind: 'offline', reason: liveOff.current ?? undefined },
        },
      ])
      setLastMode('offline')
      return
    }
    setTurns((prev) => [
      ...prev,
      { id: uid, role: 'user', text: t },
      { id: cid, role: 'copilot', mode: { kind: 'thinking' } },
    ])
    try {
      const reply = await Promise.race([
        api.dealCopilot(orgId, deal.id, t),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('live AI timed out')), LIVE_BUDGET_MS),
        ),
      ])
      if (reply?.source !== 'live') {
        const reason = reply && 'reason' in reply ? reply.reason : 'no_answer'
        if (STICKY_OFFLINE.has(reason)) liveOff.current = reason
        return offline(reason)
      }
      const actions = fromLive(reply.actions, t, deal)
      if (!actions.length) return offline('unusable_answer')
      setTurns((prev) =>
        prev.map((x) =>
          x.id === cid
            ? {
                ...x,
                actions,
                note: reply.note,
                mode: {
                  kind: 'live',
                  provider: reply.provider,
                  model: reply.model,
                  cached: reply.cached,
                },
              }
            : x,
        ),
      )
      setLastMode('live')
    } catch (e) {
      // An API without the route (older deploy) answers 404: stop trying this visit.
      if ((e as Error)?.message?.includes('404') || (e as { code?: string })?.code === 'not_found')
        liveOff.current = 'not_found'
      offline('unreachable')
    }
  }
  const asked = useRef(0)
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!autoAsk || asked.current === autoAsk.nonce) return
    asked.current = autoAsk.nonce
    panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    void ask(autoAsk.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAsk?.nonce])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void ask(text)
  }

  return (
    <aside
      ref={panel}
      className="card flex max-h-[calc(100vh-2rem)] scroll-mt-4 flex-col overflow-hidden"
      aria-label="Deal copilot"
      data-testid="deal-copilot"
    >
      <div className="card-head justify-between">
        <div className="flex items-center gap-2">
          <Bot size={16} strokeWidth={1.75} className="text-teal" />
          <h2 className="card-title">Deal copilot</h2>
        </div>
        <span
          className={` text-[10px] ${lastMode === 'live' ? 'text-teal' : 'text-label'}`}
          title={
            lastMode === 'live'
              ? 'The last answer came from a live LLM (cards and ids only; it never sets an amount)'
              : lastMode === 'policy'
                ? 'The last answer was a policy dry-run of a money ask; no model call'
                : lastMode === 'offline'
                  ? 'The last answer was matched offline from your words; no model call. Live AI is used when the agent is on.'
                  : 'Ask about this deal: the live AI answers when the agent is on, otherwise an offline replay does'
          }
          data-testid="copilot-badge"
        >
          {lastMode === 'live'
            ? 'live AI'
            : lastMode === 'offline'
              ? 'offline replay'
              : lastMode === 'policy'
                ? 'policy dry-run'
                : 'ready'}
        </span>
      </div>
      <div className="min-h-[160px] flex-1 space-y-3 overflow-y-auto p-4">
        {turns.length === 0 && <p className="text-[13px] text-umber">Ask about this deal.</p>}
        {turns.map((t) =>
          t.role === 'user' ? (
            <p
              key={t.id}
              className="ml-auto w-fit max-w-[90%] rounded-xl bg-teal/10 px-3 py-2 text-[13px] text-ink"
            >
              {t.text}
            </p>
          ) : (
            <div key={t.id} className="space-y-3">
              <ModeLabel mode={t.mode} />
              {t.mode?.kind === 'live' && t.note && (
                <p className="text-[12.5px] text-umber">{t.note}</p>
              )}
              {(t.actions ?? []).map((a, i) => (
                <Rendered
                  key={i}
                  action={a}
                  deal={deal}
                  orgId={orgId}
                  onChanged={() => void refresh()}
                />
              ))}
            </div>
          ),
        )}
        <div ref={end} />
      </div>
      <div className="border-t border-line p-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => void ask(s.prompt)}
              className="inline-flex items-center rounded-md border border-line px-2 py-1 text-xs text-umber hover:border-line-strong hover:text-ink"
            >
              {s.label}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className="flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ask about this deal…"
            aria-label="Ask the deal copilot"
            className="input flex-1 !h-9 text-[13px]"
          />
          <button
            type="submit"
            className="btn-primary !h-9"
            aria-label="Send"
            disabled={!text.trim()}
          >
            <Send size={14} strokeWidth={2} />
          </button>
        </form>
      </div>
    </aside>
  )
}
