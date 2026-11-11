const {
  monthKey,
  parseSeed,
  memoryStore,
  makeHourBudget,
  makeAgentRouter,
  runTick,
} = require('../src/agent/routing');
const { askCopilot } = require('../src/modules/deals/copilot.cts');

const P = 'http://render.test';
const F = 'http://azure.test';
const MIN = 60_000;

const res = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const quietLog = () => ({
  lines: [],
  warn(o, m) {
    this.lines.push(['warn', m]);
  },
  info(o, m) {
    this.lines.push(['info', m]);
  },
});

function clock(start) {
  let t = Date.parse(start);
  return { now: () => t, add: (ms) => (t += ms), set: (iso) => (t = Date.parse(iso)) };
}

describe('agent router failover', () => {
  test('503 on the primary retries the same request on the fallback', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push([url, init.body]);
      return url.startsWith(P) ? res(503) : res(200, { ok: 1 });
    };
    const r = makeAgentRouter({ getTargets: () => ({ primary: P, fallback: F }), fetchImpl });
    const { res: out, agent } = await r.fetch('/v1/deals/copilot', { method: 'POST', body: 'q' });
    expect(out.status).toBe(200);
    expect(agent).toBe('azure');
    expect(calls).toEqual([
      [`${P}/v1/deals/copilot`, 'q'],
      [`${F}/v1/deals/copilot`, 'q'],
    ]);
  });

  test('502 and 504 fail over too; a 4xx does not', async () => {
    for (const status of [502, 504]) {
      const r = makeAgentRouter({
        getTargets: () => ({ primary: P, fallback: F }),
        fetchImpl: async (u) => (u.startsWith(P) ? res(status) : res(200)),
      });
      expect((await r.fetch('/x')).agent).toBe('azure');
    }
    const seen = [];
    const r = makeAgentRouter({
      getTargets: () => ({ primary: P, fallback: F }),
      fetchImpl: async (u) => (seen.push(u), res(401)),
    });
    const out = await r.fetch('/x');
    expect(out.res.status).toBe(401);
    expect(seen).toEqual([`${P}/x`]);
  });

  test('a timeout on the primary fails over within the attempt timeout', async () => {
    const hang = (url, init) =>
      url.startsWith(P)
        ? new Promise((_, rej) =>
            init.signal.addEventListener('abort', () => rej(new Error('aborted'))),
          )
        : Promise.resolve(res(200));
    const r = makeAgentRouter({ getTargets: () => ({ primary: P, fallback: F }), fetchImpl: hang });
    const t0 = Date.now();
    const out = await r.fetch('/x', {}, { attemptTimeoutMs: 30 });
    expect(out.agent).toBe('azure');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('a network error fails over; both down throws with the timeout flag', async () => {
    const r = makeAgentRouter({
      getTargets: () => ({ primary: P, fallback: F }),
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(r.fetch('/x')).rejects.toMatchObject({ timedOut: false, agent: 'azure' });
  });

  test('caches the down state ~5 min so later requests skip the primary, then retries it', async () => {
    const c = clock('2026-11-11T10:00:00Z');
    const seen = [];
    let primaryUp = false;
    const fetchImpl = async (url) => {
      seen.push(url.startsWith(P) ? 'render' : 'azure');
      if (url.startsWith(P)) return primaryUp ? res(200) : res(503);
      return res(200);
    };
    const log = quietLog();
    const r = makeAgentRouter({
      getTargets: () => ({ primary: P, fallback: F }),
      fetchImpl,
      now: c.now,
      log,
    });
    await r.fetch('/x');
    expect(seen).toEqual(['render', 'azure']);
    expect(r.active()).toBe('azure');
    expect(r.primaryDownUntil()).toBe('2026-11-11T10:05:00.000Z');
    seen.length = 0;
    c.add(4 * MIN);
    await r.fetch('/x');
    await r.fetch('/x');
    expect(seen).toEqual(['azure', 'azure']); // nobody waits on the primary
    seen.length = 0;
    c.add(2 * MIN); // past 5 min
    primaryUp = true;
    const out = await r.fetch('/x');
    expect(out.agent).toBe('render');
    expect(seen).toEqual(['render']);
    expect(r.active()).toBe('render');
    expect(log.lines.map((l) => l[1])).toEqual(
      expect.arrayContaining([
        'agent render down -> azure',
        'agent call failed over',
        'agent render back up',
      ]),
    );
  });

  test('no fallback configured: one attempt, the 503 comes back as is', async () => {
    const seen = [];
    const r = makeAgentRouter({
      getTargets: () => ({ primary: P, fallback: '' }),
      fetchImpl: async (u) => (seen.push(u), res(503)),
    });
    expect((await r.fetch('/x')).res.status).toBe(503);
    expect(seen).toEqual([`${P}/x`]);
    expect(r.active()).toBe('render');
  });

  test('over budget: every call goes straight to the fallback', async () => {
    const seen = [];
    const r = makeAgentRouter({
      getTargets: () => ({ primary: P, fallback: F }),
      isOverBudget: () => true,
      fetchImpl: async (u) => (seen.push(u), res(200)),
    });
    expect((await r.fetch('/x')).agent).toBe('azure');
    expect(seen).toEqual([`${F}/x`]);
    expect(r.active()).toBe('azure');
  });

  test('copilot answers live from the fallback when the primary returns 503', async () => {
    const deal = {
      id: 'd1',
      terms: {
        title: 't',
        client: {},
        worker: {},
        milestones: [{ key: 'm1', title: 'Reel 1', payees: [] }],
      },
      milestones: [{ key: 'm1', state: 'IN_REVIEW', versions: [] }],
      changeOrders: [],
      signatures: [],
    };
    const fetchImpl = async (url) =>
      url.startsWith(P) ? res(503) : res(200, { actions: [{ name: 'showDeal' }], provider: 'nim' });
    const r = await askCopilot(
      { enabled: true, url: P, fallbackUrl: F, secret: 's'.repeat(40), timeoutMs: 200 },
      deal,
      'client',
      'show',
      fetchImpl,
    );
    expect(r).toMatchObject({
      source: 'live',
      actions: [{ name: 'showDeal' }],
      provider: 'nim',
      agent: 'azure',
    });
  });
});

describe('render hour budget', () => {
  test('month key is the UTC calendar month', () => {
    expect(monthKey(Date.parse('2026-11-30T23:59:59Z'))).toBe('2026-11');
    expect(monthKey(Date.parse('2026-12-01T00:00:00Z'))).toBe('2026-12');
    expect(parseSeed('2026-11:22.6')).toEqual({ month: '2026-11', hours: 22.6 });
    expect(parseSeed('2026-11=23')).toEqual({ month: '2026-11', hours: 23 });
    expect(parseSeed('junk')).toBeNull();
  });

  test('partial ticks count up, never down', async () => {
    const c = clock('2026-11-11T10:00:00Z');
    const store = memoryStore();
    const b = makeHourBudget({ store, now: c.now, startedAt: c.now(), project: false });
    c.add(4 * MIN + 1000); // 4 min 1 s -> 5 min
    expect(await b.countApi()).toBe(5);
    c.add(10); // 10 ms -> 1 min
    expect(await b.countApi()).toBe(1);
    await b.countAgent(3.2);
    expect(store.docs.get('2026-11')).toMatchObject({ apiMin: 6, agentMin: 4 });
  });

  test('switches at 700 (api + agent hours) and stops pinging the Render agent', async () => {
    const c = clock('2026-11-20T00:00:00Z');
    const store = memoryStore();
    await store.inc('2026-11', { apiMin: 21000, agentMin: 20994 }); // 699.9 h
    const budget = makeHourBudget({
      store,
      now: c.now,
      startedAt: c.now() - 0,
      project: false,
      switchHours: 700,
    });
    const pings = [];
    const fetchImpl = async (u) => (pings.push(u), res(200));
    const router = makeAgentRouter({
      getTargets: () => ({ primary: P, fallback: F }),
      isOverBudget: () => budget.overBudget(),
      fetchImpl,
    });
    const getTargets = () => ({ primary: P, fallback: F });

    c.add(1); // a few ms of uptime still counts a whole minute: 699.9 h + 1 min < 700
    let s = await runTick({ budget, router, getTargets, fetchImpl, tickMin: 4 });
    expect(s.overBudget).toBe(false);
    expect(s.pinged).toBe(true);
    expect(pings).toEqual([`${P}/health`]);
    expect(router.active()).toBe('render');

    c.add(4 * MIN); // + 4 min api + the 4 min warm from the last ping -> past 700
    s = await runTick({ budget, router, getTargets, fetchImpl, tickMin: 4 });
    expect(s.overBudget).toBe(true);
    expect(s.hoursCounted).toBeGreaterThanOrEqual(700);
    expect(s.switchedAt).toBe('2026-11-20T00:04:00.001Z');
    expect(s.pinged).toBe(false);
    expect(pings).toHaveLength(1); // no ping once at budget
    expect(router.active()).toBe('azure');

    c.add(4 * MIN);
    s = await runTick({ budget, router, getTargets, fetchImpl, tickMin: 4 });
    expect(s.pinged).toBe(false);
    expect(pings).toHaveLength(1);
    // the switch adds the agent's spin-down tail once
    expect(store.docs.get('2026-11').agentMin).toBe(20994 + 4 + 15);
  });

  test('the switch is sticky for the month, then the next UTC month starts fresh', async () => {
    const c = clock('2026-11-30T23:52:00Z');
    const store = memoryStore();
    await store.inc('2026-11', { apiMin: 701 * 60 });
    const budget = makeHourBudget({ store, now: c.now, startedAt: c.now(), project: false });
    const pings = [];
    const fetchImpl = async (u) => (pings.push(u), res(200));
    const router = makeAgentRouter({
      getTargets: () => ({ primary: P, fallback: F }),
      isOverBudget: () => budget.overBudget(),
      fetchImpl,
    });
    const getTargets = () => ({ primary: P, fallback: F });
    c.add(4 * MIN);
    let s = await runTick({ budget, router, getTargets, fetchImpl });
    expect(s).toMatchObject({ month: '2026-11', overBudget: true, pinged: false });
    expect(router.active()).toBe('azure');

    c.set('2026-12-01T00:00:30Z'); // rollover: routes back to render even before the tick
    expect(budget.status()).toBeNull();
    expect(router.active()).toBe('render');
    s = await runTick({ budget, router, getTargets, fetchImpl });
    expect(s).toMatchObject({ month: '2026-12', overBudget: false, pinged: true });
    expect(store.docs.get('2026-12')).toMatchObject({ apiMin: 5, agentMin: 4 }); // 4.5 min rounds up
    expect(router.active()).toBe('render');
  });

  test('projection counts the API hours still to come this month', async () => {
    const c = clock('2026-12-01T00:00:00Z'); // 31 days = 744 h of API alone
    const store = memoryStore();
    const b = makeHourBudget({
      store,
      now: c.now,
      startedAt: c.now(),
      project: true,
      switchHours: 700,
    });
    await b.countApi();
    expect((await b.evaluate()).overBudget).toBe(true);

    const c2 = clock('2026-11-11T16:00:00Z');
    const store2 = memoryStore();
    const b2 = makeHourBudget({
      store: store2,
      now: c2.now,
      startedAt: c2.now(),
      project: true,
      switchHours: 700,
      seed: parseSeed('2026-11:23'),
    });
    await b2.countApi();
    const s = await b2.evaluate();
    expect(s.seedHours).toBe(23);
    expect(s.projectedApiHoursLeft).toBeCloseTo(464, 0);
    expect(s.overBudget).toBe(false);
  });

  test('a failed health ping marks the primary down and counts no warm time', async () => {
    const c = clock('2026-11-11T10:00:00Z');
    const store = memoryStore();
    const budget = makeHourBudget({ store, now: c.now, startedAt: c.now(), project: false });
    const fetchImpl = async () => {
      throw new Error('down');
    };
    const router = makeAgentRouter({
      getTargets: () => ({ primary: P, fallback: F }),
      fetchImpl,
      now: c.now,
    });
    c.add(MIN);
    const s = await runTick({
      budget,
      router,
      getTargets: () => ({ primary: P, fallback: F }),
      fetchImpl,
    });
    expect(s.pinged).toBe(false);
    expect(router.active()).toBe('azure');
    expect(store.docs.get('2026-11').agentMin).toBeUndefined();
  });

  test('a timed-out ping (cold start) still counts the warm tick', async () => {
    const store = memoryStore();
    const budget = makeHourBudget({ store, project: false });
    const hang = (url, init) =>
      new Promise((_, rej) =>
        init.signal.addEventListener('abort', () => rej(new Error('aborted'))),
      );
    const router = makeAgentRouter({
      getTargets: () => ({ primary: P, fallback: F }),
      fetchImpl: hang,
    });
    const s = await runTick({
      budget,
      router,
      getTargets: () => ({ primary: P, fallback: F }),
      fetchImpl: hang,
      pingTimeoutMs: 20,
      tickMin: 4,
    });
    expect(s.pinged).toBe(false);
    expect(router.active()).toBe('azure');
    expect([...store.docs.values()][0].agentMin).toBe(4);
  });
});
