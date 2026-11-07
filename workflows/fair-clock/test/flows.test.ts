/**
 * fair-clock flows with fetch stubbed and a fake FlowContext whose step() runs the
 * function with the step's retry policy (no waiting), the way Render runs an inline step.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FlowContext, StepOptions } from '@renderinc/sdk/workflows';
import { postAdvance, configFromEnv, ADVANCE_PATH } from '../src/advance';
import { advanceClocks, advanceDelivery, advanceOnce, ADVANCE_RETRY } from '../src/flows';
import { startAdvanceClocks, startDeliveryClock } from '../src/trigger';
import type { FlowStarter } from '../src/trigger';

type Reply = { status: number; body?: unknown } | Error;

function stubFetch(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    const text =
      r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status });
  }) as typeof fetch;
  return { impl, calls };
}

function fakeCtx() {
  const steps: { name: string; attempts: number }[] = [];
  const ctx = {
    metadata: { flowRunId: 'frn-test' },
    invoke: async () => {
      throw new Error('not supported');
    },
    async step(
      name: string,
      fn: (...a: unknown[]) => unknown,
      argsOrOpts?: unknown,
      maybeOpts?: StepOptions,
    ) {
      const args = Array.isArray(argsOrOpts) ? argsOrOpts : [];
      const opts =
        (Array.isArray(argsOrOpts) ? maybeOpts : (argsOrOpts as StepOptions | undefined)) || {};
      const max = 1 + (opts.retry?.maxRetries ?? 0);
      const rec = { name, attempts: 0 };
      steps.push(rec);
      let last: unknown;
      for (let i = 0; i < max; i += 1) {
        rec.attempts += 1;
        try {
          return await fn(...args);
        } catch (e) {
          last = e;
        }
      }
      throw last;
    },
  } as unknown as FlowContext;
  return { ctx, steps };
}

const OK = {
  status: 200,
  body: {
    data: {
      advanced: [
        { dealId: 'd1', steps: ['start'] },
        { dealId: 'd2', steps: ['remind', 'grace'] },
      ],
      steps: 3,
    },
  },
};
const cfg = (impl: typeof fetch) => () => ({
  apiUrl: 'https://api.example.com',
  secret: 's3cret',
  fetchImpl: impl,
});

test('postAdvance: POSTs the advance path with X-Clock-Secret and counts steps', async () => {
  const f = stubFetch([OK]);
  const r = await postAdvance(cfg(f.impl)());
  assert.deepEqual(r, { ok: true, status: 200, deliveries: 2, steps: 3 });
  assert.equal(f.calls[0].url, `https://api.example.com${ADVANCE_PATH}`);
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal((f.calls[0].init.headers as Record<string, string>)['X-Clock-Secret'], 's3cret');
});

test('advance-clocks retries 5xx and network errors with the step retry policy, then succeeds', async () => {
  const f = stubFetch([
    { status: 502, body: '<html>Bad Gateway</html>' },
    new Error('ECONNRESET'),
    { status: 503 },
    OK,
  ]);
  const { ctx, steps } = fakeCtx();
  const r = await advanceOnce(ctx, 'post-advance', cfg(f.impl));
  assert.equal(r.steps, 3);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(steps, [{ name: 'post-advance', attempts: 4 }]);
  assert.deepEqual(ADVANCE_RETRY, { maxRetries: 5, waitDurationMs: 2000, backoffScaling: 2 });
});

test('advance-clocks gives up after the retry budget', async () => {
  const f = stubFetch([{ status: 503 }]);
  const { ctx, steps } = fakeCtx();
  await assert.rejects(
    advanceOnce(ctx, 'post-advance', cfg(f.impl)),
    /clock advance failed \(503\)/,
  );
  assert.equal(steps[0].attempts, 1 + ADVANCE_RETRY.maxRetries);
});

test('a wrong secret (401) or a disabled driver (404) fails once, without retries', async () => {
  for (const [status, msg] of [
    [401, 'X-Clock-Secret did not match'],
    [404, 'Not found'],
  ] as const) {
    const f = stubFetch([{ status, body: { error: { code: 'x', message: msg } } }]);
    const { ctx, steps } = fakeCtx();
    await assert.rejects(
      advanceOnce(ctx, 'post-advance', cfg(f.impl)),
      new RegExp(`refused \\(${status}\\): ${msg}`),
    );
    assert.equal(f.calls.length, 1);
    assert.equal(steps[0].attempts, 1);
  }
});

test('flows are registered under their names and only use ctx.step', async () => {
  assert.equal(advanceClocks.name, 'advance-clocks');
  assert.equal(advanceDelivery.name, 'advance-delivery');
  const { ctx } = fakeCtx();
  await assert.rejects(
    Promise.resolve(advanceDelivery.func(ctx, '', 'reel1')),
    /needs \(dealId, milestoneKey\)/,
  );
});

test('advance-delivery names its step after the deal and milestone', async () => {
  const saved = { ...process.env };
  process.env.API_URL = 'https://api.example.com/';
  process.env.CLOCK_SHARED_SECRET = 's3cret';
  const f = stubFetch([OK]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.impl;
  try {
    const { ctx, steps } = fakeCtx();
    const r = await advanceDelivery.func(ctx, 'deal_demo_diwali', 'reel3');
    assert.equal(r.dealId, 'deal_demo_diwali');
    assert.equal(r.steps, 3);
    assert.equal(steps[0].name, 'post-advance:deal_demo_diwali:reel3');
    assert.equal(f.calls[0].url, `https://api.example.com${ADVANCE_PATH}`);
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
  }
});

test('configFromEnv needs API_URL and CLOCK_SHARED_SECRET', () => {
  assert.throws(() => configFromEnv({ CLOCK_SHARED_SECRET: 'x' }), /API_URL/);
  assert.throws(() => configFromEnv({ API_URL: 'https://a' }), /CLOCK_SHARED_SECRET/);
  assert.equal(
    configFromEnv({ API_URL: 'https://a//', CLOCK_SHARED_SECRET: 'x' }).apiUrl,
    'https://a',
  );
});

test('trigger: startFlow slugs and idempotency keys', async () => {
  const seen: { slug: string; input: unknown[]; key?: string }[] = [];
  const client: FlowStarter = {
    async startFlow(slug, input, options) {
      seen.push({ slug, input, key: options?.idempotencyKey });
      return { id: 'frn-1' };
    },
  };
  await startDeliveryClock('deal_1', 'reel2', client, 'fair-clock');
  await startAdvanceClocks(client, new Date('2026-11-07T10:07:30Z'), 'fair-clock');
  await startAdvanceClocks(client, new Date('2026-11-07T10:14:59Z'), 'fair-clock');
  assert.deepEqual(seen[0], {
    slug: 'fair-clock/advance-delivery',
    input: ['deal_1', 'reel2'],
    key: 'clock:deal_1:reel2',
  });
  assert.equal(seen[1].slug, 'fair-clock/advance-clocks');
  assert.equal(seen[1].key, 'advance:2026-11-07T10:00:00.000Z');
  assert.equal(seen[2].key, seen[1].key);
});
