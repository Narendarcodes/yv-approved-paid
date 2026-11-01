/**
 * Milestone lifecycle. One table is the whole truth: every event names the
 * states it may leave, the state it enters and who may trigger it. Anything
 * not in the table is refused, so no agent can move a milestone sideways.
 *
 *   DRAFT → SIGNED → FUNDED → (STYLE_SAMPLE →) SUBMITTED → CHECKS → IN_REVIEW
 *     → APPROVED | AUTO_APPROVED → CAPTURED → PAID_OUT
 *   side paths: CHANGES_REQUESTED, KILLED, CANCELLED, DISPUTED
 */
import type { MilestoneState, Role, MilestoneRuntime } from './types.cts';

export type EventName =
  | 'sign'
  | 'fund'
  | 'submit_style_sample'
  | 'approve_style'
  | 'redo_style'
  | 'submit_version'
  | 'start_checks'
  | 'checks_done'
  | 'request_changes'
  | 'approve'
  | 'review_window_lapsed'
  | 'captured'
  | 'paid_out'
  | 'kill'
  | 'cancel'
  | 'deadline_void'
  | 'open_dispute'
  | 'resolve_dispute_split'
  | 'resolve_dispute_void'
  | 'closed_without_pay'
  | 'mutual_cancel';

type Edge = { from: MilestoneState[]; to: MilestoneState; actors: Role[] };

const WORKING: MilestoneState[] = ['FUNDED', 'STYLE_SAMPLE', 'SUBMITTED', 'CHECKS', 'IN_REVIEW', 'CHANGES_REQUESTED'];

const TRANSITIONS: Record<EventName, Edge> = {
  sign: { from: ['DRAFT'], to: 'SIGNED', actors: ['system'] },
  fund: { from: ['SIGNED'], to: 'FUNDED', actors: ['system'] }, // after PayPal authorization succeeds
  submit_style_sample: { from: ['FUNDED'], to: 'STYLE_SAMPLE', actors: ['worker'] },
  approve_style: { from: ['STYLE_SAMPLE'], to: 'FUNDED', actors: ['client'] },
  redo_style: { from: ['STYLE_SAMPLE'], to: 'FUNDED', actors: ['client'] },
  submit_version: { from: ['FUNDED', 'CHANGES_REQUESTED'], to: 'SUBMITTED', actors: ['worker'] },
  start_checks: { from: ['SUBMITTED'], to: 'CHECKS', actors: ['system'] },
  checks_done: { from: ['CHECKS'], to: 'IN_REVIEW', actors: ['system'] },
  request_changes: { from: ['IN_REVIEW'], to: 'CHANGES_REQUESTED', actors: ['client'] },
  approve: { from: ['IN_REVIEW'], to: 'APPROVED', actors: ['client'] },
  review_window_lapsed: { from: ['IN_REVIEW'], to: 'AUTO_APPROVED', actors: ['system'] },
  captured: { from: ['APPROVED', 'AUTO_APPROVED', 'DISPUTED', 'KILLED'], to: 'CAPTURED', actors: ['system'] },
  paid_out: { from: ['CAPTURED'], to: 'PAID_OUT', actors: ['system'] },
  kill: { from: WORKING, to: 'KILLED', actors: ['client'] },
  cancel: { from: ['DRAFT', 'SIGNED'], to: 'CANCELLED', actors: ['client', 'worker'] },
  deadline_void: { from: ['FUNDED', 'STYLE_SAMPLE', 'CHANGES_REQUESTED'], to: 'CANCELLED', actors: ['client'] },
  open_dispute: { from: ['IN_REVIEW', 'CHANGES_REQUESTED', 'SUBMITTED', 'CHECKS'], to: 'DISPUTED', actors: ['client', 'worker'] },
  resolve_dispute_split: { from: ['DISPUTED'], to: 'CAPTURED', actors: ['system'] },
  resolve_dispute_void: { from: ['DISPUTED'], to: 'CANCELLED', actors: ['system'] },
  mutual_cancel: { from: WORKING, to: 'CANCELLED', actors: ['system'] }, // both sides agreed
  closed_without_pay: { from: ['KILLED'], to: 'CANCELLED', actors: ['system'] }, // kill with a 0% kill fee
};

const TERMINAL: MilestoneState[] = ['PAID_OUT', 'CANCELLED'];

class TransitionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function canTransition(state: MilestoneState, event: EventName, actor: Role): { ok: boolean; reason?: string } {
  const edge = TRANSITIONS[event];
  if (!edge) return { ok: false, reason: `unknown event ${event}` };
  if (!edge.from.includes(state)) return { ok: false, reason: `cannot ${event} from ${state}` };
  if (!edge.actors.includes(actor)) return { ok: false, reason: `${actor} may not ${event}` };
  return { ok: true };
}

/** Returns a NEW milestone runtime with the transition applied and recorded in history. */
function transition(m: MilestoneRuntime, event: EventName, actor: Role, at: string): MilestoneRuntime {
  const check = canTransition(m.state, event, actor);
  if (!check.ok) throw new TransitionError('invalid_transition', check.reason || 'invalid transition');
  const to = TRANSITIONS[event].to;
  return {
    ...m,
    state: to,
    history: [...m.history, { at, from: m.state, to, event, actor }],
  };
}

/** Every (state, event) pair that is legal, for docs and exhaustive tests. */
function legalPairs(): { state: MilestoneState; event: EventName; to: MilestoneState }[] {
  const out: { state: MilestoneState; event: EventName; to: MilestoneState }[] = [];
  for (const [event, edge] of Object.entries(TRANSITIONS) as [EventName, Edge][]) {
    for (const s of edge.from) out.push({ state: s, event, to: edge.to });
  }
  return out;
}

const ALL_STATES: MilestoneState[] = [
  'DRAFT', 'SIGNED', 'FUNDED', 'STYLE_SAMPLE', 'SUBMITTED', 'CHECKS', 'IN_REVIEW', 'CHANGES_REQUESTED',
  'APPROVED', 'AUTO_APPROVED', 'CAPTURED', 'PAID_OUT', 'KILLED', 'CANCELLED', 'DISPUTED',
];

module.exports = { TRANSITIONS, TERMINAL, ALL_STATES, canTransition, transition, legalPairs, TransitionError };
