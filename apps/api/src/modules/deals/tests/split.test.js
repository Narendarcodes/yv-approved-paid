/* splitCents: crew shares of one release, in integer cents, always summing to the total. */
const { splitCents, payeeSplits } = require('../lib/split.cts');
const { makeRestGateway } = require('../paypal.cts');

const amounts = (r) => r.map((s) => s.amountCents);
const sum = (r) => r.reduce((a, s) => a + s.amountCents, 0);

describe('splitCents', () => {
  test('70/30 of $400 is exact', () => {
    const r = splitCents(40000, [
      { memberId: 'ravi', pct: 70, role: 'lead' },
      { memberId: 'sana', pct: 30, role: 'member' },
    ]);
    expect(amounts(r)).toEqual([28000, 12000]);
    expect(r.map((s) => [s.role, s.bp, s.pct])).toEqual([['lead', 7000, 70], ['member', 3000, 30]]);
  });

  test('1 cent: the lead takes it, nobody else gets a fraction', () => {
    const r = splitCents(1, [
      { memberId: 'a', pct: 50 },
      { memberId: 'b', pct: 30, role: 'lead' },
      { memberId: 'c', pct: 20 },
    ]);
    expect(amounts(r)).toEqual([0, 1, 0]);
    expect(sum(r)).toBe(1);
  });

  test('99.99 split 3 ways at 33.33 / 33.33 / 33.34: floor each, leftover to the lead', () => {
    const r = splitCents(9999, [
      { memberId: 'a', pct: 33.33 },
      { memberId: 'b', pct: 33.33, role: 'lead' },
      { memberId: 'c', pct: 33.34 },
    ]);
    // floor(9999 * .3333) = 3332, floor(9999 * .3334) = 3333; 9999 - 9997 = 2 to the lead
    expect(amounts(r)).toEqual([3332, 3334, 3333]);
    expect(sum(r)).toBe(9999);
  });

  test('no lead marked: the first member takes the leftover', () => {
    const r = splitCents(100, [
      { memberId: 'a', pct: 33.33 },
      { memberId: 'b', pct: 33.33 },
      { memberId: 'c', pct: 33.34 },
    ]);
    expect(amounts(r)).toEqual([34, 33, 33]);
    expect(r[0].role).toBe('lead');
    expect(sum(r)).toBe(100);
  });

  test('100% to a single member', () => {
    expect(amounts(splitCents(12345, [{ memberId: 'solo', pct: 100 }]))).toEqual([12345]);
    expect(amounts(splitCents(0, [{ memberId: 'solo', pct: 100 }]))).toEqual([0]);
  });

  test('shares always add up to the total (many awkward totals and splits)', () => {
    const splits = [
      [{ memberId: 'a', pct: 33.33 }, { memberId: 'b', pct: 33.33 }, { memberId: 'c', pct: 33.34 }],
      [{ memberId: 'a', pct: 0.01 }, { memberId: 'b', pct: 99.99, role: 'lead' }],
      [{ memberId: 'a', pct: 12.5 }, { memberId: 'b', pct: 12.5 }, { memberId: 'c', pct: 75 }],
      Array.from({ length: 7 }, (_, i) => ({ memberId: `m${i}`, pct: i === 6 ? 14.32 : 14.28 })),
    ];
    for (const s of splits)
      for (const total of [0, 1, 2, 3, 7, 99, 100, 101, 9999, 10001, 33333, 40000, 123457, 999999999]) {
        const r = splitCents(total, s);
        expect(sum(r)).toBe(total);
        for (const x of r) expect(Number.isSafeInteger(x.amountCents) && x.amountCents >= 0).toBe(true);
      }
  });

  test('a huge total keeps exact cents (no float rounding)', () => {
    const r = splitCents(9007199254740, [{ memberId: 'a', pct: 33.33 }, { memberId: 'b', pct: 66.67 }]);
    expect(sum(r)).toBe(9007199254740);
  });

  test.each([
    ['shares under 100%', 100, [{ memberId: 'a', pct: 70 }, { memberId: 'b', pct: 20 }], /add up to 100%/],
    ['shares over 100%', 100, [{ memberId: 'a', pct: 70 }, { memberId: 'b', pct: 40 }], /add up to 100%/],
    ['a zero share', 100, [{ memberId: 'a', pct: 100 }, { memberId: 'b', pct: 0 }], /between/],
    ['a negative share', 100, [{ memberId: 'a', pct: 110 }, { memberId: 'b', pct: -10 }], /between/],
    ['finer than 0.01%', 100, [{ memberId: 'a', pct: 50.005 }, { memberId: 'b', pct: 49.995 }], /finer/],
    ['NaN share', 100, [{ memberId: 'a', pct: NaN }], /not a number/],
    ['a share as a string', 100, [{ memberId: 'a', pct: '100' }], /not a number/],
    ['the same member twice', 100, [{ memberId: 'a', pct: 50 }, { memberId: 'a', pct: 50 }], /twice/],
    ['a member without an id', 100, [{ memberId: '', pct: 100 }], /id/],
    ['two leads', 100, [{ memberId: 'a', pct: 50, role: 'lead' }, { memberId: 'b', pct: 50, role: 'lead' }], /one member/],
    ['no members', 100, [], /at least one/],
    ['not a list', 100, null, /at least one/],
    ['a fractional total', 10.5, [{ memberId: 'a', pct: 100 }], /whole/],
    ['a negative total', -1, [{ memberId: 'a', pct: 100 }], /whole/],
  ])('invalid: %s', (_name, total, splits, msg) => {
    expect(() => splitCents(total, splits)).toThrow(msg);
  });

  test('payeeSplits: the deal worker leads unless a payee is marked lead', () => {
    const deal = { terms: { worker: { userId: 'u_worker' } } };
    const payees = [
      { userId: 'u_motion', email: 's@x', shareBp: 3333 },
      { userId: 'u_worker', email: 'r@x', shareBp: 6667 },
    ];
    expect(payeeSplits(deal, payees)).toEqual([
      { memberId: 'u_motion', pct: 33.33, role: 'member' },
      { memberId: 'u_worker', pct: 66.67, role: 'lead' },
    ]);
    const marked = payeeSplits(deal, [{ ...payees[0], role: 'lead' }, payees[1]]);
    expect(marked.map((x) => x.role)).toEqual(['lead', 'member']);
  });
});

describe('PayPal REST createPayoutBatch', () => {
  test('one POST /v1/payments/payouts; sender_batch_id and PayPal-Request-Id are the release key', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      const key = `${init.method} ${new URL(url).pathname}`;
      calls.push({ key, headers: init.headers || {}, body: init.body && String(init.body).startsWith('{') ? JSON.parse(init.body) : init.body });
      const body =
        key === 'POST /v1/oauth2/token'
          ? { access_token: 'tok', expires_in: 32400 }
          : { batch_header: { payout_batch_id: 'BATCH123', batch_status: 'PENDING' } };
      const text = JSON.stringify(body);
      return { ok: true, status: 201, text: async () => text, json: async () => body };
    };
    const gw = makeRestGateway({ clientId: 'id', clientSecret: 's', fetchImpl });
    const r = await gw.createPayoutBatch({
      senderBatchId: 'payout:deal_1:reel1:release_partial',
      emailSubject: 'Payment',
      items: [
        { receiver: 'ravi@example.com', amountCents: 14000, currency: 'USD', note: 'n', senderItemId: 'reel1-release_partial-u_worker' },
        { receiver: 'sana@example.com', amountCents: 6000, currency: 'USD', note: 'n', senderItemId: 'reel1-release_partial-u_motion' },
      ],
    });
    expect(r).toEqual({ batchId: 'BATCH123', status: 'PENDING' });
    const post = calls.find((c) => c.key === 'POST /v1/payments/payouts');
    expect(calls.filter((c) => c.key === 'POST /v1/payments/payouts')).toHaveLength(1);
    expect(post.headers['PayPal-Request-Id']).toBe('payout:deal_1:reel1:release_partial');
    expect(post.body.sender_batch_header.sender_batch_id).toBe('payout:deal_1:reel1:release_partial');
    expect(post.body.items.map((i) => [i.receiver, i.amount.value, i.amount.currency])).toEqual([
      ['ravi@example.com', '140.00', 'USD'],
      ['sana@example.com', '60.00', 'USD'],
    ]);
  });
});
