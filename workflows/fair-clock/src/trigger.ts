/**
 * Start the fair-clock flows from outside the workflow service: a Render cron job
 * (`npm run trigger`, every 15 minutes) or the API (startDeliveryClock when a
 * delivery is submitted). Needs RENDER_API_KEY and FAIR_CLOCK_WORKFLOW_SLUG
 * (the workflow service's slug, shown on its dashboard page).
 */
import { createWorkflowsClient } from '@renderinc/sdk/workflows';

export type FlowStarter = {
  startFlow(
    flowSlug: string,
    inputData: unknown[],
    options?: { idempotencyKey?: string },
  ): Promise<{ id?: string } & Record<string, unknown>>;
};

function slugFromEnv(env: Record<string, string | undefined> = process.env): string {
  const slug = (env.FAIR_CLOCK_WORKFLOW_SLUG || '').trim();
  if (!slug)
    throw new Error('FAIR_CLOCK_WORKFLOW_SLUG is required (the Render Workflow service slug)');
  return slug;
}

function defaultClient(): FlowStarter {
  return createWorkflowsClient() as unknown as FlowStarter; // RENDER_API_KEY from env
}

/**
 * One advance-clocks run per quarter hour: a cron job that fires twice in the same
 * 15-minute bucket (or retries) gets the run it already started.
 */
export function startAdvanceClocks(
  client: FlowStarter = defaultClient(),
  now: Date = new Date(),
  slug: string = slugFromEnv(),
) {
  const bucket = new Date(Math.floor(now.getTime() / 900_000) * 900_000).toISOString();
  return client.startFlow(`${slug}/advance-clocks`, [], { idempotencyKey: `advance:${bucket}` });
}

/** Per-delivery start: idempotencyKey clock:<deal>:<milestone>. */
export function startDeliveryClock(
  dealId: string,
  milestoneKey: string,
  client: FlowStarter = defaultClient(),
  slug: string = slugFromEnv(),
) {
  return client.startFlow(`${slug}/advance-delivery`, [dealId, milestoneKey], {
    idempotencyKey: `clock:${dealId}:${milestoneKey}`,
  });
}

if (require.main === module) {
  startAdvanceClocks()
    .then((run) => console.log(JSON.stringify({ started: 'advance-clocks', run: run.id ?? run })))
    .catch((e: Error) => {
      console.error(`could not start advance-clocks: ${e.message}`);
      process.exitCode = 1;
    });
}
