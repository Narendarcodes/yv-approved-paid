/**
 * Fair Review Clock flows for Render Workflows (@renderinc/sdk 1.7).
 *
 * Only ctx.step is used: ctx.sleep is not in the SDK yet (and ctx.invoke throws
 * "not supported yet"), so a flow cannot wait out a 2-business-day review window
 * itself. Each run makes one durable, retried call to the API's advance endpoint;
 * the long waits are covered by calling these flows periodically (see README).
 */
import { flow } from '@renderinc/sdk/workflows';
import type { FlowContext, Retry } from '@renderinc/sdk/workflows';
import { configFromEnv, postAdvance } from './advance';
import type { AdvanceResult, ClockConfig } from './advance';

/** 6 attempts over about a minute: 2 s, 4 s, 8 s, 16 s, 32 s. Covers a free-plan cold start. */
export const ADVANCE_RETRY: Retry = { maxRetries: 5, waitDurationMs: 2_000, backoffScaling: 2 };

export const WORKFLOW_SLUG_ENV = 'FAIR_CLOCK_WORKFLOW_SLUG';

function done(r: AdvanceResult): AdvanceResult & { ok: true } {
  if (!r.ok) throw new Error(`clock advance refused (${r.status}): ${r.error}`);
  return r;
}

/** Shared body, exported for tests: run one advance as a retried durable step. */
export async function advanceOnce(
  ctx: FlowContext,
  stepName: string,
  cfg: () => ClockConfig = () => configFromEnv(),
) {
  // read config inside the step so a missing env var shows up as that step's error
  const r = await ctx.step(stepName, () => postAdvance(cfg()), { retry: ADVANCE_RETRY });
  return done(r);
}

/**
 * advance-clocks: run every due clock step on the API (all deals). Trigger it
 * on a schedule (a Render cron job running `npm run trigger`) or from the API.
 */
export const advanceClocks = flow({ name: 'advance-clocks', timeoutSeconds: 300 }, async (ctx) =>
  advanceOnce(ctx, 'post-advance'),
);

/**
 * advance-delivery(dealId, milestoneKey): the per-delivery start. Started with
 * idempotencyKey `clock:<deal>:<milestone>` (trigger.ts startDeliveryClock), so
 * re-sending a delivery within 24 h returns the first run instead of a second.
 * The API endpoint advances every due clock (each step idempotent); the deal and
 * milestone name the step in the run history.
 */
export const advanceDelivery = flow(
  { name: 'advance-delivery', timeoutSeconds: 300 },
  async (ctx, dealId: string, milestoneKey: string) => {
    if (typeof dealId !== 'string' || !dealId || typeof milestoneKey !== 'string' || !milestoneKey)
      throw new Error('advance-delivery needs (dealId, milestoneKey)');
    const r = await advanceOnce(ctx, `post-advance:${dealId}:${milestoneKey}`);
    return { dealId, milestoneKey, ...r };
  },
);
