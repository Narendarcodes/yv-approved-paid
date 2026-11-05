/**
 * AssignPicker: choose an org member for a project or a task.
 *
 * Shows the current assignee (avatar + name). People who may assign get a
 * button that opens the member list (avatar, name, role, pending); everyone
 * else sees the assignee read-only. The API is the real check (project.assign,
 * task.update, members of this org only); this only keeps the UI honest.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, UserPlus } from 'lucide-react'
import Avatar from './ui'
import type { TeamMember } from '../lib/types'

const roleLabel = (r: string) => (r ? r.charAt(0).toUpperCase() + r.slice(1) : 'Member')

export default function AssignPicker({
  team,
  value,
  onAssign,
  canAssign,
  size = 'md',
  label = 'Assign',
  testId,
}: {
  team: TeamMember[]
  value: string | null | undefined
  onAssign: (userId: string) => Promise<void>
  canAssign: boolean
  size?: 'sm' | 'md'
  label?: string
  testId?: string
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const current = team.find((m) => m.id === value)
  const choices = team.filter((m) => !m.disabled)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = async (id: string) => {
    if (id === value) {
      setOpen(false)
      return
    }
    setBusy(id)
    try {
      await onAssign(id)
      setOpen(false)
    } catch {
      // onAssign already told the person (toast); keep the menu open so they can retry
    } finally {
      setBusy(null)
    }
  }

  const who = current ? (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar initials={current.initials} size={size === 'sm' ? 'xs' : 'sm'} tone="tint" />
      <span className="truncate font-medium text-ink">{current.name}</span>
    </span>
  ) : (
    <span className="text-umber">Not assigned yet</span>
  )

  if (!canAssign) {
    return (
      <span className={`inline-flex items-center gap-2 ${size === 'sm' ? 'text-[12.5px]' : 'text-sm'}`} data-testid={testId} title="You can't change who this is assigned to">
        {who}
      </span>
    )
  }

  return (
    <div ref={ref} className="relative inline-block" data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex max-w-[260px] items-center gap-2 rounded-full border border-line bg-surface px-2.5 py-1 transition-colors hover:border-teal/50 ${size === 'sm' ? 'text-[12.5px]' : 'text-sm'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={current ? `Assigned to ${current.name}. Change` : label}
      >
        {current ? who : (
          <span className="flex items-center gap-1.5 font-medium text-teal">
            <UserPlus size={14} strokeWidth={2} /> {label}
          </span>
        )}
        <ChevronDown size={13} strokeWidth={2} className="shrink-0 text-label" />
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label="Org members"
          className="absolute left-0 z-30 mt-1.5 max-h-72 w-72 overflow-auto rounded-xl border border-line bg-surface p-1 shadow-lg"
        >
          {choices.length === 0 && <li className="px-3 py-2 text-[13px] text-umber">No members yet. Invite someone from Members.</li>}
          {choices.map((m) => (
            <li key={m.id} role="option" aria-selected={m.id === value}>
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void pick(m.id)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-canvas disabled:opacity-60"
              >
                <Avatar initials={m.initials} size="sm" tone={m.role === 'admin' ? 'ink' : 'tint'} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">{m.name}</span>
                  <span className="block truncate text-[11.5px] text-umber">
                    {roleLabel(m.role)}
                    {m.pending ? ' · pending' : ''}
                  </span>
                </span>
                {busy === m.id ? (
                  <span className="font-mono text-[10px] text-label">saving…</span>
                ) : m.id === value ? (
                  <Check size={14} strokeWidth={2} className="text-teal" />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
