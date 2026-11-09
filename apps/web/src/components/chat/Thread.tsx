/**
 * Chat thread kit (Brand Brain, Team chat, deal copilot): a full-height thread
 * the page scrolls, ~720px reading width, plain assistant text with light
 * markdown, a subtle right-aligned bubble for the user, a composer pinned to
 * the bottom, auto-scroll to the newest message and a "jump to latest" button.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { ArrowDown, Send } from 'lucide-react'

/* ------------------------------------------------------------ markdown */

/** Inline: `code`, **bold**, *italic*, [link](https://…). Text only: no HTML is injected. */
function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g
  let last = 0
  let m: RegExpExecArray | null
  let n = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const k = `${key}-${n++}`
    if (m[1])
      out.push(
        <code key={k} className="rounded-xs bg-cream px-1 font-mono text-[0.9em]">
          {m[1].slice(1, -1)}
        </code>,
      )
    else if (m[2])
      out.push(
        <strong key={k} className="font-medium text-ink">
          {m[2].slice(2, -2)}
        </strong>,
      )
    else if (m[3]) out.push(<em key={k}>{m[3].slice(1, -1)}</em>)
    else if (m[4]) {
      const label = m[4].slice(1, m[4].indexOf(']'))
      out.push(
        <a
          key={k}
          href={m[5]}
          target="_blank"
          rel="noreferrer"
          className="text-teal underline underline-offset-2"
        >
          {label}
        </a>,
      )
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Block markdown: paragraphs, #-headings, -/* and 1. lists, ``` fences. */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let b = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
      i++
      blocks.push(
        <pre
          key={b++}
          className="overflow-x-auto rounded-md bg-cream px-3 py-2 font-mono text-[12.5px] leading-5"
        >
          {body.join('\n')}
        </pre>,
      )
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      blocks.push(
        <p key={b++} className="pt-1 text-[15px] font-medium text-ink">
          {inline(h[2], `h${b}`)}
        </p>,
      )
      i++
      continue
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))
      const L = ordered ? 'ol' : 'ul'
      blocks.push(
        <L key={b++} className={`space-y-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `l${b}-${j}`)}</li>
          ))}
        </L>,
      )
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```|^#{1,4}\s|^\s*([-*•]|\d+[.)])\s+/.test(lines[i])
    )
      para.push(lines[i++])
    blocks.push(
      <p key={b++}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p, `p${b}-${j}`)}
          </Fragment>
        ))}
      </p>,
    )
  }
  return <div className={`space-y-3 break-words ${className}`}>{blocks}</div>
}

/* ------------------------------------------------------------ scrolling */

/**
 * Keeps the thread at the newest message while the reader is at the bottom,
 * and reports when they have scrolled up (for "jump to latest").
 * `scroller` is the element that scrolls; omit it when the page scrolls.
 */
export function useStickToBottom(dep: unknown, scroller?: React.RefObject<HTMLElement>) {
  const endRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)

  useEffect(() => {
    const el = endRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      ([e]) => {
        atBottomRef.current = e.isIntersecting
        setAtBottom(e.isIntersecting)
      },
      { root: scroller?.current ?? null, rootMargin: '0px 0px 160px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [scroller])

  const jump = useCallback(
    (smooth = true) => {
      const box = scroller?.current
      // inside a scrolling panel, scroll only the panel (never the page)
      if (box) box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
      else endRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' })
    },
    [scroller],
  )

  useLayoutEffect(() => {
    if (atBottomRef.current) jump(false)
  }, [dep, jump])

  return { endRef, atBottom, jump }
}

export function JumpToLatest({
  show,
  onClick,
  offset = 'bottom-[84px]',
}: {
  show: boolean
  onClick: () => void
  /** Distance from the bottom of the scroller (clears the pinned composer). */
  offset?: string
}) {
  if (!show) return null
  return (
    <div className={`pointer-events-none sticky ${offset} z-10 flex justify-center`}>
      <button
        type="button"
        onClick={onClick}
        className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-pill border border-line-strong bg-surface px-3 text-[13px] text-ink shadow-pop"
        data-testid="jump-to-latest"
      >
        <ArrowDown size={14} strokeWidth={1.75} aria-hidden="true" />
        Jump to latest
      </button>
    </div>
  )
}

/* ------------------------------------------------------------ messages */

export function UserBubble({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[18px] bg-cream px-4 py-2.5 text-[14px] leading-6 text-ink">
        {children}
      </div>
      {meta && <div className="mt-1 text-[12px] text-umber">{meta}</div>}
    </div>
  )
}

export function AssistantBlock({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="min-w-0">
      {meta && <div className="mb-1 text-[12px] text-umber">{meta}</div>}
      <div className="text-[15px] leading-7 text-ink/90">{children}</div>
    </div>
  )
}

/* ------------------------------------------------------------ composer */

export function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  disabled,
  busy,
  label,
  sticky = true,
}: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  placeholder: string
  disabled?: boolean
  busy?: boolean
  label: string
  /** Pinned to the bottom of the page scroll (default). */
  sticky?: boolean
}) {
  const ta = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [value])
  const can = !!value.trim() && !disabled && !busy
  return (
    <div
      className={`${sticky ? 'sticky bottom-0 z-20' : ''} bg-canvas pb-[max(12px,env(safe-area-inset-bottom))] pt-2`}
    >
      <form
        className="flex items-end gap-2 rounded-[16px] border border-line-strong bg-surface px-3 py-2 focus-within:border-teal"
        onSubmit={(e) => {
          e.preventDefault()
          if (can) onSend()
        }}
      >
        <textarea
          ref={ta}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (can) onSend()
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={label}
          enterKeyHint="send"
          className="composer-input max-h-[180px] min-h-[24px] flex-1 resize-none bg-transparent py-1 text-[15px] leading-6 text-ink outline-none placeholder:text-umber/70 sm:text-[14px]"
        />
        <button
          type="submit"
          disabled={!can}
          className="btn-primary !h-8 !w-8 shrink-0 !rounded-pill !p-0"
          aria-label="Send"
        >
          <Send size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </form>
    </div>
  )
}
