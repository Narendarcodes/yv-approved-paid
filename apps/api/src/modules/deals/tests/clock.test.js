/* Fair Review Clock: business days, bank holidays, 18:00 cut-off, schedule, pause, steps, PayPal hold plan. */
const {
  isBusinessDay,
  addBusinessDays,
  normalizeTerms,
  buildSchedule,
  clockState,
  dueSteps,
  holdPlan,
} = require('../engine.cts').clock;

const IN = { country: 'IN', tz: 'Asia/Kolkata' };
const US = { country: 'US', tz: 'America/New_York' };
const HOUR = 3600 * 1000;

describe('isBusinessDay', () => {
  test('weekends are never business days', () => {
    expect(isBusinessDay('2026-11-07', 'IN')).toBe(false); // Sat
    expect(isBusinessDay('2026-11-08', 'IN')).toBe(false); // Sun (also Diwali)
    expect(isBusinessDay('2026-11-14', 'US')).toBe(false);
    expect(isBusinessDay('2026-11-09', 'IN')).toBe(true); // Mon
  });
  test('IN weekday holidays', () => {
    expect(isBusinessDay('2026-11-24', 'IN')).toBe(false); // Guru Nanak, Tue
    expect(isBusinessDay('2026-10-02', 'IN')).toBe(false); // Gandhi Jayanti, Fri
    expect(isBusinessDay('2027-10-29', 'IN')).toBe(false); // Diwali 2027, Fri
    expect(isBusinessDay('2026-11-24', 'US')).toBe(true);
  });
  test('US Federal Reserve holidays', () => {
    expect(isBusinessDay('2026-11-11', 'US')).toBe(false); // Veterans Day
    expect(isBusinessDay('2026-11-26', 'US')).toBe(false); // Thanksgiving
    expect(isBusinessDay('2027-07-05', 'US')).toBe(false); // July 4 observed
    expect(isBusinessDay('2026-11-11', 'IN')).toBe(true);
  });
  test('accepts a Date (UTC calendar day) and rejects junk', () => {
    expect(isBusinessDay(new Date('2026-11-24T05:00:00Z'), 'IN')).toBe(false);
    expect(() => isBusinessDay('soon', 'IN')).toThrow();
    expect(() => isBusinessDay('2026-11-24', 'UK')).toThrow(/UK/);
  });
});

describe('addBusinessDays', () => {
  test('skips the weekend', () => {
    // Fri 13 Nov 10:00 IST: Fri is day 1, Mon 16 is day 2
    expect(addBusinessDays('2026-11-13T04:30:00Z', 2, IN)).toBe('2026-11-16T12:30:00.000Z');
  });
  test('skips an IN weekday holiday', () => {
    // Mon 23 Nov 10:00 IST: Mon day 1, Tue 24 Guru Nanak, Wed 25 day 2
    expect(addBusinessDays('2026-11-23T04:30:00Z', 2, IN)).toBe('2026-11-25T12:30:00.000Z');
    expect(addBusinessDays('2026-11-23T04:30:00Z', 2, { country: 'US', tz: 'Asia/Kolkata' })).toBe(
      '2026-11-24T12:30:00.000Z',
    );
  });
  test('skips US holidays', () => {
    // Tue 10 Nov 09:00 EST: Tue day 1, Wed 11 Veterans Day, Thu 12 day 2
    expect(addBusinessDays('2026-11-10T14:00:00Z', 2, US)).toBe('2026-11-12T23:00:00.000Z');
    // Wed 25 Nov 19:00 EST is after the cut-off; Thu 26 Thanksgiving; Fri 27 is day 1
    expect(addBusinessDays('2026-11-26T00:00:00Z', 1, US)).toBe('2026-11-27T23:00:00.000Z');
  });
  test('18:00 cut-off in Asia/Kolkata', () => {
    expect(addBusinessDays('2026-11-09T12:29:00Z', 1, IN)).toBe('2026-11-09T12:30:00.000Z'); // 17:59 IST
    expect(addBusinessDays('2026-11-09T12:30:00Z', 1, IN)).toBe('2026-11-10T12:30:00.000Z'); // 18:00 IST
    expect(addBusinessDays('2026-11-09T12:31:00Z', 1, IN)).toBe('2026-11-10T12:30:00.000Z'); // 18:01 IST
  });
  test('the same instant counts differently per timezone', () => {
    // 23:30Z Mon 9 Nov = 18:30 EST (after cut-off) but Tue 05:00 IST (before cut-off)
    expect(addBusinessDays('2026-11-09T23:30:00Z', 1, US)).toBe('2026-11-10T23:00:00.000Z');
    expect(addBusinessDays('2026-11-09T23:30:00Z', 1, IN)).toBe('2026-11-10T12:30:00.000Z');
    // 12:29Z = 07:29 EST, still Monday there
    expect(addBusinessDays('2026-11-09T12:29:00Z', 1, US)).toBe('2026-11-09T23:00:00.000Z');
  });
  test('daylight saving: 18:00 EDT in July', () => {
    expect(addBusinessDays('2026-07-06T14:00:00Z', 1, US)).toBe('2026-07-06T22:00:00.000Z');
  });
  test('weekend start begins counting on the next business day', () => {
    // Sat 7 Nov: Sun 8 is Diwali/weekend; Mon 9 day 1, Tue 10 day 2
    expect(addBusinessDays('2026-11-07T13:14:00Z', 2, IN)).toBe('2026-11-10T12:30:00.000Z');
  });
  test('rejects bad input', () => {
    expect(() => addBusinessDays('2026-11-09T04:30:00Z', 0, IN)).toThrow();
    expect(() => addBusinessDays('2026-11-09T04:30:00Z', 1.5, IN)).toThrow();
    expect(() => addBusinessDays('nope', 1, IN)).toThrow();
    expect(() =>
      addBusinessDays('2026-11-09T04:30:00Z', 1, { country: 'IN', tz: 'Mars/Base' }),
    ).toThrow(/timezone/);
  });
});

describe('normalizeTerms', () => {
  test('defaults', () => {
    expect(normalizeTerms({})).toEqual({
      reviewWindowBusinessDays: 3,
      partialReleasePct: 50,
      graceBusinessDays: 3,
      includedRevisionRounds: 2,
      country: 'IN',
      tz: 'Asia/Kolkata',
    });
    expect(normalizeTerms(undefined).country).toBe('IN');
    expect(normalizeTerms({ backupReviewerId: 'u-backup' }).backupReviewerId).toBe('u-backup');
  });
  test('throws on invalid values', () => {
    for (const bad of [1, 11, 2.5, '3', -3]) {
      expect(() => normalizeTerms({ reviewWindowBusinessDays: bad })).toThrow(
        /reviewWindowBusinessDays/,
      );
    }
    for (const bad of [91, -1, 50.5, '50']) {
      expect(() => normalizeTerms({ partialReleasePct: bad })).toThrow(/partialReleasePct/);
    }
    expect(() => normalizeTerms({ graceBusinessDays: -1 })).toThrow(/graceBusinessDays/);
    expect(() => normalizeTerms({ includedRevisionRounds: 1.2 })).toThrow(/includedRevisionRounds/);
    expect(() => normalizeTerms({ country: 'UK' })).toThrow(/country/);
    expect(() => normalizeTerms({ tz: 'Mars/Base' })).toThrow(/timezone/);
    expect(() => normalizeTerms({ backupReviewerId: 123 })).toThrow(/backupReviewerId/);
  });
  test('accepts the bounds', () => {
    expect(
      normalizeTerms({ reviewWindowBusinessDays: 2, partialReleasePct: 0 }).partialReleasePct,
    ).toBe(0);
    expect(
      normalizeTerms({ reviewWindowBusinessDays: 10, partialReleasePct: 90 })
        .reviewWindowBusinessDays,
    ).toBe(10);
  });
});

describe('buildSchedule', () => {
  const START = '2026-11-09T04:30:00Z'; // Mon 9 Nov 10:00 IST
  const s = buildSchedule(START, { backupReviewerId: 'u-backup' }, 999999);

  test('deadline and grace deadline', () => {
    expect(s.deadline).toBe('2026-11-11T12:30:00.000Z'); // Wed 18:00 IST
    expect(s.capped).toBe(false);
    expect(s.graceDeadline).toBe('2026-11-16T12:30:00.000Z'); // Thu, Fri, Mon
    expect(s.currency).toBe('INR');
  });
  test('reminder times: 50%, 80% (with backup), 24 h before', () => {
    // window = 56 h
    const byId = Object.fromEntries(s.reminders.map((r) => [r.id, r]));
    expect(byId.remind_50.atISO).toBe('2026-11-10T08:30:00.000Z');
    expect(byId.remind_50.to).toEqual(['reviewer']);
    expect(byId.remind_80.atISO).toBe('2026-11-11T01:18:00.000Z');
    expect(byId.remind_80.to).toEqual(['reviewer', 'u-backup']);
    expect(byId.final_24h.atISO).toBe('2026-11-10T12:30:00.000Z');
    expect(byId.final_24h.partialAmountCents).toBe(499999);
  });
  test('steps are in time order with stable ids', () => {
    expect(s.steps.map((x) => x.id)).toEqual([
      'remind_50',
      'final_24h',
      'remind_80',
      'release_partial',
      'release_grace',
    ]);
  });
  test('integer cents, partial floored', () => {
    expect(s.partialAmountCents).toBe(499999);
    expect(s.remainderCents).toBe(500000);
    const third = buildSchedule(START, { partialReleasePct: 33 }, 100);
    expect([third.partialAmountCents, third.remainderCents]).toEqual([33, 67]);
    const tiny = buildSchedule(START, { partialReleasePct: 90 }, 1);
    expect([tiny.partialAmountCents, tiny.remainderCents]).toEqual([0, 1]);
    const odd = buildSchedule(START, { partialReleasePct: 50 }, 101);
    expect([odd.partialAmountCents, odd.remainderCents]).toEqual([50, 51]);
    for (const x of [third, tiny, odd, s]) {
      expect(Number.isInteger(x.partialAmountCents)).toBe(true);
      expect(x.partialAmountCents + x.remainderCents).toBe(x.amountCents);
    }
    expect(() => buildSchedule(START, {}, 10.5)).toThrow(/amountCents/);
    expect(() => buildSchedule(START, {}, -1)).toThrow(/amountCents/);
  });
  test('0% partial has no partial release step', () => {
    const none = buildSchedule(START, { partialReleasePct: 0 }, 5000);
    expect(none.steps.map((x) => x.id)).not.toContain('release_partial');
    expect(none.remainderCents).toBe(5000);
  });
  test('15-calendar-day cap: holiday plus a 10-day window (IN)', () => {
    // Fri 13 Nov 18:30 IST: day 1 Mon 16 ... Tue 24 Guru Nanak ... day 10 Mon 30 = 17 days
    const c = buildSchedule('2026-11-13T13:00:00Z', { reviewWindowBusinessDays: 10 }, 1000);
    expect(c.capped).toBe(true);
    expect(c.deadline).toBe('2026-11-28T13:00:00.000Z');
  });
  test('15-calendar-day cap: Veterans Day + weekend cluster (US)', () => {
    // Fri 6 Nov 19:00 EST: day 1 Mon 9, Wed 11 off, day 10 Mon 23 = 17 days
    const c = buildSchedule('2026-11-07T00:00:00Z', { reviewWindowBusinessDays: 10, ...US }, 1000);
    expect(c.capped).toBe(true);
    expect(c.deadline).toBe('2026-11-22T00:00:00.000Z');
    expect(c.currency).toBe('USD');
    // and a 10-day window with no holidays stays uncapped
    const ok = buildSchedule('2026-12-01T14:00:00Z', { reviewWindowBusinessDays: 10, ...US }, 1000);
    expect(ok.capped).toBe(false);
    expect(ok.deadline).toBe('2026-12-14T23:00:00.000Z');
  });
});

describe('clockState', () => {
  const START = '2026-11-09T04:30:00Z';
  const s = buildSchedule(START, {}, 999999);

  test('waiting for checks', () => {
    expect(clockState({ schedule: null, now: START }).status).toBe('waiting_checks');
    expect(clockState({ schedule: s, now: '2026-11-09T04:00:00Z' }).status).toBe('waiting_checks');
  });
  test('running: days left, next step, plain line', () => {
    const st = clockState({ schedule: s, now: START });
    expect(st.status).toBe('running');
    expect(st.businessDaysLeft).toBe(3);
    expect(st.nextStep).toEqual({ id: 'remind_50', atISO: '2026-11-10T08:30:00.000Z' });
    expect(st.line).toBe(
      'If no reply by Wed 11 Nov 6:00 PM IST, ₹4,999.99 (50%) releases to the team.',
    );
    expect(clockState({ schedule: s, now: '2026-11-09T13:30:00Z' }).businessDaysLeft).toBe(2); // Mon 19:00 IST
  });
  test('US line uses dollars and the local zone', () => {
    const us = buildSchedule('2026-11-10T14:00:00Z', { ...US, partialReleasePct: 40 }, 50000);
    expect(clockState({ schedule: us, now: '2026-11-10T15:00:00Z' }).line).toBe(
      'If no reply by Fri 13 Nov 6:00 PM EST, $200.00 (40%) releases to the team.',
    );
  });
  test('after the deadline and after grace', () => {
    expect(clockState({ schedule: s, now: '2026-11-12T00:00:00Z' }).status).toBe(
      'released_partial',
    );
    expect(clockState({ schedule: s, now: '2026-11-16T12:30:00Z' }).status).toBe('released_full');
    const zero = buildSchedule(START, { partialReleasePct: 0 }, 1000);
    expect(clockState({ schedule: zero, now: '2026-11-12T00:00:00Z' }).status).toBe('grace');
  });
  test('pausing shifts the deadlines by the paused time', () => {
    const st = clockState({
      schedule: s,
      now: '2026-11-10T06:00:00Z',
      paused: true,
      pausedAtISO: '2026-11-10T00:00:00Z',
      pausedMs: HOUR,
    });
    expect(st.status).toBe('paused');
    expect(st.shiftMs).toBe(7 * HOUR);
    expect(st.deadline).toBe('2026-11-11T19:30:00.000Z');
    expect(st.graceDeadline).toBe('2026-11-16T19:30:00.000Z');
    // resumed after 7 h paused in total: one hour past the original deadline is still running
    const later = clockState({ schedule: s, now: '2026-11-11T13:30:00Z', pausedMs: 7 * HOUR });
    expect(later.status).toBe('running');
    expect(later.line).toContain('Thu 12 Nov 1:00 AM IST');
  });
});

describe('dueSteps', () => {
  const s = buildSchedule('2026-11-09T04:30:00Z', {}, 10000);
  test('returns due steps in order and skips done ones', () => {
    expect(dueSteps(s, '2026-11-09T05:00:00Z')).toEqual([]);
    expect(dueSteps(s, '2026-11-11T12:30:00Z')).toEqual([
      'remind_50',
      'final_24h',
      'remind_80',
      'release_partial',
    ]);
    expect(dueSteps(s, '2026-11-11T12:30:00Z', ['remind_50', 'final_24h'])).toEqual([
      'remind_80',
      'release_partial',
    ]);
    expect(
      dueSteps(
        s,
        '2026-11-20T00:00:00Z',
        new Set(['remind_50', 'final_24h', 'remind_80', 'release_partial']),
      ),
    ).toEqual(['release_grace']);
  });
  test('a pause shift delays due steps', () => {
    expect(dueSteps(s, '2026-11-11T12:30:00Z', [], 2 * HOUR)).toEqual([
      'remind_50',
      'final_24h',
      'remind_80',
    ]);
  });
});

describe('holdPlan', () => {
  test('PayPal: reauthorize after day 3, lapses on day 29', () => {
    const p = holdPlan('2026-11-01T10:00:00Z', '2026-11-20T10:00:00Z');
    expect(p).toEqual({
      reauthorizeAfterISO: '2026-11-04T10:00:00.000Z',
      lapsesISO: '2026-11-30T10:00:00.000Z',
      needsRefund: false,
    });
    expect(holdPlan('2026-11-01T10:00:00Z', '2026-11-30T10:00:00Z').needsRefund).toBe(false);
    expect(holdPlan('2026-11-01T10:00:00Z', '2026-11-30T10:00:01Z').needsRefund).toBe(true);
    expect(() => holdPlan('x', '2026-11-30T10:00:00Z')).toThrow();
  });
});
