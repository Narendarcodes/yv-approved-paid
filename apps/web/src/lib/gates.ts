/**
 * Stage gate view logic for the project lifecycle card (pure, unit-tested in
 * tests/gates.test.mjs). The API decides what is missing (GET /projects/:id/gate);
 * this only turns it into the button state and the "What's missing" rows.
 */

export type GateItemLike = {
  key: string
  label: string
  done: boolean
  href: string
  action: string
}
export type GateLike = {
  next: string | null
  gated: boolean
  ready: boolean
  items: GateItemLike[]
}

/** Where a checklist row points: a section on this project page, or another route. */
export type GateTarget = { kind: 'anchor'; id: string } | { kind: 'route'; to: string }

export type GateRow = {
  key: string
  label: string
  done: boolean
  action: string
  target: GateTarget
}

/** A link to `/projects/<this id>#section` scrolls this page; anything else is a route. */
export function gateTarget(href: string, projectId: string): GateTarget {
  const here = `/projects/${projectId}#`
  if (href.startsWith(here)) return { kind: 'anchor', id: href.slice(here.length) }
  return { kind: 'route', to: href }
}

/** The checklist rows, open items first (in the API's order), then the done ones. */
export function gateRows(gate: GateLike | null | undefined, projectId: string): GateRow[] {
  if (!gate || !gate.gated) return []
  const rows = gate.items.map((i) => ({
    key: i.key,
    label: i.label,
    done: !!i.done,
    action: i.action,
    target: gateTarget(i.href, projectId),
  }))
  return [...rows.filter((r) => !r.done), ...rows.filter((r) => r.done)]
}

/**
 * The "Move to next stage" button: it always shows; `locked` when the next
 * move crosses into a later stage whose checklist still has open items. While
 * the gate is loading (or failed to load) the button is not locked: the API
 * refuses a gated move with the same list anyway.
 */
export function advanceState(gate: GateLike | null | undefined): {
  locked: boolean
  open: number
  total: number
} {
  if (!gate || !gate.gated) return { locked: false, open: 0, total: 0 }
  const open = gate.items.filter((i) => !i.done).length
  return { locked: !gate.ready, open, total: gate.items.length }
}

/** Every milestone of every deal as one picker option ("Deal · Reel"). */
export function dealOptions(
  deals: {
    id: string
    terms?: { title?: string; milestones?: { key: string; title?: string }[] }
  }[],
): { value: string; dealId: string; milestoneKey: string; label: string }[] {
  const out: { value: string; dealId: string; milestoneKey: string; label: string }[] = []
  for (const d of deals || []) {
    for (const m of d.terms?.milestones || []) {
      out.push({
        value: `${d.id}::${m.key}`,
        dealId: d.id,
        milestoneKey: m.key,
        label: `${d.terms?.title || d.id} · ${m.title || m.key}`,
      })
    }
  }
  return out
}
