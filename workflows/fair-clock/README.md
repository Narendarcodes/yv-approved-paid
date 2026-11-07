# fair-clock: a Render Workflow for the Fair Review Clock

The Fair Review Clock gives a brand a fixed review window per delivery (for example 2 business days), then a reminder, then a grace release. The API owns the rules and the money: `POST /api/v1/internal/clock/advance` runs every clock step that is due, and every step is idempotent (keyed per deal, milestone and step), so calling it twice never releases money twice.

This package is a small [Render Workflow](https://render.com/docs/workflows) (`@renderinc/sdk` 1.7) that calls that endpoint durably: each call is a `ctx.step` with retries and exponential backoff, recorded in the run history on Render.

| Flow | Input | What it does |
|---|---|---|
| `advance-clocks` | none | One retried step `post-advance`: POST the advance endpoint (all deals) |
| `advance-delivery` | `(dealId, milestoneKey)` | Same call, step named `post-advance:<deal>:<milestone>`. Started with `idempotencyKey` `clock:<deal>:<milestone>`, so re-sending a delivery within 24 h returns the first run |

Step retry: 5 retries, 2 s doubling (2, 4, 8, 16, 32 s), about a minute in all, which covers a free-plan API waking up. Network errors, timeouts, 408, 429 and 5xx are retried. A 401 (wrong `X-Clock-Secret`) or 404 (`CLOCK_SHARED_SECRET` unset on the API, so the route does not exist) fails the run once without retrying, because retrying cannot fix configuration.

Files: `src/advance.ts` (the HTTP call), `src/flows.ts` (the flows), `src/trigger.ts` (starting runs from a cron job or the API), `src/index.ts` (service entry), `test/flows.test.ts`.

## The honest limitation: no `ctx.sleep` yet

`@renderinc/sdk` 1.7 flows have `ctx.step` only: there is no durable sleep, and `ctx.invoke` throws "not supported yet". So a flow cannot start when a video is delivered and wait 2 business days by itself. Until `ctx.sleep` ships:

- the long waits are driven by **periodic** `advance-clocks` runs (every 15 minutes from a Render cron job), and the API decides which clocks are due;
- `advance-delivery` is a nudge at delivery time (it makes the "clock started" step show up at once), not a timer;
- the Money Agent tick inside the API still advances clocks in-process, so the workflow is a second, observable driver, not the only one.

When `ctx.sleep` is available, `advance-delivery` can become: step "start", sleep until the window ends, step "remind", sleep until grace, step "grace", each a call to the same idempotent endpoint.

## Create the Render Workflow service

1. In the Render Dashboard: **New > Workflow**, connect this repo.
2. Root directory: `workflows/fair-clock`. Runtime: Node.
3. Build command: `npm ci && npm run build`. Start command: `npm start`.
4. Environment variables (below), then create. The flows show as `<workflow-slug>/advance-clocks` and `<workflow-slug>/advance-delivery`.

With a Blueprint instead, the commented-out `type: workflow` block at the bottom of `/render.yaml` is the starting point. It is not active: nothing deploys from this package until someone creates the service.

## Environment variables

On the **workflow service**:

| Variable | Value |
|---|---|
| `API_URL` | The API origin, e.g. `https://<api-service>.onrender.com` (no trailing path) |
| `CLOCK_SHARED_SECRET` | Same value as `CLOCK_SHARED_SECRET` on the API service (secret) |
| `CLOCK_TIMEOUT_MS` | Optional, per-request timeout (default 20000) |

On the **API service**: `CLOCK_SHARED_SECRET` must be set, otherwise the advance route answers 404.

On whatever **starts runs** (cron job or API):

| Variable | Value |
|---|---|
| `RENDER_API_KEY` | A Render API key (secret) |
| `FAIR_CLOCK_WORKFLOW_SLUG` | The workflow service's slug, from its dashboard page |

## Triggering it

**From a Render cron job (recommended).** Render Workflows have no built-in schedule yet, so create a Cron Job in the same repo:

- Root directory `workflows/fair-clock`, build `npm ci && npm run build`, command `npm run trigger`
- Schedule `*/15 * * * *`
- Env: `RENDER_API_KEY`, `FAIR_CLOCK_WORKFLOW_SLUG`

`npm run trigger` calls `startFlow('<slug>/advance-clocks', [], { idempotencyKey: 'advance:<quarter-hour>' })`, so two firings in the same 15-minute bucket share one run.

**From the API, per delivery.** With `@renderinc/sdk` installed in the caller:

```ts
import { startDeliveryClock } from './trigger'; // or copy its 5 lines
await startDeliveryClock('deal_demo_diwali', 'reel3'); // idempotencyKey clock:deal_demo_diwali:reel3
```

This is not wired into the API in this change; the API keeps its in-process clock.

**By hand.** Dashboard: open the flow and start a run. Or with the Render API:

```bash
curl -X POST https://api.render.com/v1/flow-runs \
  -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
  -d '{"flow": "<workflow-slug>/advance-clocks", "input": []}'
```

(The flow-runs request body shape is from the SDK's generated schema; check the [Render API reference](https://api-docs.render.com) before relying on it.)

## Develop and test

```bash
cd workflows/fair-clock
npm ci
npm run typecheck   # tsc --noEmit
npm test            # tsc, then node --test with fetch stubbed and a fake FlowContext
```

The tests never call the API or Render: `fetch` is stubbed and `ctx.step` is a fake that applies the step's retry policy without waiting.

## What is verified

- Typechecks against the real `@renderinc/sdk` 1.7.0 typings; unit tests cover the request (path, `X-Clock-Secret`), retry on 5xx and network errors, giving up after the budget, no retry on 401/404, step names, and the `startFlow` slugs and idempotency keys.
- **Not run on Render.** No workflow service or cron job has been created; the real step-retry timing and `startFlow` behaviour are Render's and untested here.
