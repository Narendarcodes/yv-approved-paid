/* Every state transition, legal and illegal (exhaustive over the table). */
const { states } = require('../engine.cts');

const EVENTS = Object.keys(states.TRANSITIONS);
const ROLES = ['client', 'worker', 'system', 'reviewer'];

function runtime(state) {
  return { key: 'm', state, styleApproved: false, versions: [], revisionRoundsUsed: 0, tasteRoundsUsed: 0, capturedMinor: 0, captures: [], paidOutMinor: 0, payouts: [], changeRequests: [], history: [] };
}

describe('milestone state machine', () => {
  test('the lifecycle in the brief exists end to end', () => {
    const path = [
      ['sign', 'system', 'SIGNED'],
      ['fund', 'system', 'FUNDED'],
      ['submit_style_sample', 'worker', 'STYLE_SAMPLE'],
      ['approve_style', 'client', 'FUNDED'],
      ['submit_version', 'worker', 'SUBMITTED'],
      ['start_checks', 'system', 'CHECKS'],
      ['checks_done', 'system', 'IN_REVIEW'],
      ['request_changes', 'client', 'CHANGES_REQUESTED'],
      ['submit_version', 'worker', 'SUBMITTED'],
      ['start_checks', 'system', 'CHECKS'],
      ['checks_done', 'system', 'IN_REVIEW'],
      ['approve', 'client', 'APPROVED'],
      ['captured', 'system', 'CAPTURED'],
      ['paid_out', 'system', 'PAID_OUT'],
    ];
    let m = runtime('DRAFT');
    for (const [event, actor, to] of path) {
      m = states.transition(m, event, actor, '2026-11-02T00:00:00Z');
      expect(m.state).toBe(to);
    }
    expect(m.history).toHaveLength(path.length);
  });

  describe.each(states.legalPairs())('legal: $state --$event--> $to', ({ state, event, to }) => {
    test('allowed for its actors, refused for everyone else', () => {
      const edge = states.TRANSITIONS[event];
      for (const actor of ROLES) {
        if (edge.actors.includes(actor)) {
          expect(states.transition(runtime(state), event, actor, 'now').state).toBe(to);
        } else {
          expect(() => states.transition(runtime(state), event, actor, 'now')).toThrow(/may not/);
        }
      }
    });
  });

  test('every illegal (state, event) pair is refused', () => {
    let refused = 0;
    for (const s of states.ALL_STATES) {
      for (const e of EVENTS) {
        const edge = states.TRANSITIONS[e];
        if (edge.from.includes(s)) continue;
        expect(() => states.transition(runtime(s), e, edge.actors[0], 'now')).toThrow(/cannot/);
        refused += 1;
      }
    }
    expect(refused).toBeGreaterThan(200);
  });

  test('terminal states have no way out except none', () => {
    for (const t of states.TERMINAL) {
      for (const e of EVENTS) expect(states.canTransition(t, e, 'system').ok && states.TRANSITIONS[e].from.includes(t)).toBe(false);
    }
  });

  test('side paths: kill, cancel, deadline void, dispute, auto-approve', () => {
    expect(states.transition(runtime('IN_REVIEW'), 'review_window_lapsed', 'system', 'n').state).toBe('AUTO_APPROVED');
    expect(states.transition(runtime('IN_REVIEW'), 'kill', 'client', 'n').state).toBe('KILLED');
    expect(states.transition(runtime('SIGNED'), 'cancel', 'worker', 'n').state).toBe('CANCELLED');
    expect(states.transition(runtime('FUNDED'), 'deadline_void', 'client', 'n').state).toBe('CANCELLED');
    expect(states.transition(runtime('IN_REVIEW'), 'open_dispute', 'worker', 'n').state).toBe('DISPUTED');
    expect(states.transition(runtime('DISPUTED'), 'resolve_dispute_split', 'system', 'n').state).toBe('CAPTURED');
    expect(states.transition(runtime('DISPUTED'), 'resolve_dispute_void', 'system', 'n').state).toBe('CANCELLED');
    expect(() => states.transition(runtime('APPROVED'), 'kill', 'client', 'n')).toThrow();
    expect(() => states.transition(runtime('IN_REVIEW'), 'deadline_void', 'client', 'n')).toThrow();
  });

  test('transition returns a new object (no mutation)', () => {
    const m = runtime('DRAFT');
    const n = states.transition(m, 'sign', 'system', 'n');
    expect(m.state).toBe('DRAFT');
    expect(n).not.toBe(m);
  });
});
