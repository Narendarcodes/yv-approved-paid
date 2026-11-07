# yv. architecture: MERN + Python agent platform + Approved = Paid

```
 browser ──HTTPS/socket.io──▶ apps/api (Node/Express, system of record, ALL permission checks)
                                 │  ├─ MongoDB (Post, Asset, BrandRule, Metric[time-series], RetentionPoint,
                                 │  │           Insight, ReviewComment, AgentJob + existing collections)
                                 │  ├─ POST /organizations/:org/agent/chat ──SSE proxy──▶ agent /v1/chat
                                 │  └─ XADD yv:jobs (versioned envelopes) ──▶ Redis Streams
                                 ▲
             /internal/* (service JWT: orgId,userId,scopes; aud=yv-internal)
                                 │
 services/agent  ── FastAPI agent (router → flows → tools) ──┐   LiteLLM → any model (env)
                 └─ worker (consumer group, retries, DLQ) ───┴─▶ Qdrant (orgId filter mandatory)
                                                               S3/R2 (SeaweedFS/MinIO locally)
                                                               Whisper STT (HTTP), PySceneDetect
```

## Rules that keep it safe

- **Node is the only thing the browser talks to** and the only writer to Mongo. Python never connects to Mongo.
- **Permission checks live only in Node** (`requireOrg` + `requirePermission('project.view')`). After a check passes, Node mints a
  **short-lived service JWT** (`apps/api/src/agent/serviceToken.js`) with `orgId`, `userId`, and the minimum `scopes`:
  chat gets read-only scopes (TTL 120 s); each job type gets its own scope set (TTL 15 min, so retries fit).
- `/internal/*` (`apps/api/src/routes/internal.js`) **takes orgId from the token only**, checks scopes per route, and
  validates writes against the shared JSON Schemas (ajv). `/internal` is **not on the public app**: it runs on a
  separate listener (`apps/api/src/internal-app.js`, `INTERNAL_PORT`=3001 on `INTERNAL_HOST`, loopback by default; in
  compose the api's address on the private `backend` network, port never published) and also requires the shared
  `X-Internal-Token` (`INTERNAL_API_TOKEN`) on top of the service JWT.
- The agent **does not hold the signing secret**: it verifies an incoming token by calling `GET /internal/whoami` (cached 60 s)
  and forwards the same token on every tool call. The worker uses the token embedded in the job envelope.
- Qdrant access goes through `BrandIndex`, which refuses any operation without an `orgId` and always adds the payload filter.
- In production the agent routes return 503 until `SERVICE_JWT_SECRET` is set.

## Approved = Paid: deals, money and the fair pay suite

All deal code lives in `apps/api/src/modules/deals/`. Node is still the only writer; every money move goes through the policy engine (`lib/policy.cts`, rules P1-P9) and is appended to the hash-chained ledger. No amount comes from a request, an agent or a model.

```
 Money Agent tick (in the API) ─┐
 Render Workflow (not deployed) ─┴─► POST /internal/clock/advance (X-Clock-Secret)
                                       │  service.advanceClocks(): hold upkeep + due clock steps (idempotent)
                                       ▼
 lib/clock.cts (pure maths) ◄── lib/review-clock.cts ──► lib/engine.cts ──► lib/policy.cts (dry run)
                                                            │
                                  gateway (lib/gateway.cts) ▼
               PAYPAL_CLIENT=sdk ─► lib/paypal-sdk.cts  (Orders + Payments, @paypal/paypal-server-sdk)
               PAYPAL_CLIENT=rest ─► lib/paypal-rest.cts (Orders + Payments fallback; Payouts, Invoicing, webhooks always)
                                       └─ lib/paypal-sandbox.cts wraps either (pool, simulated approval, request ids)
 payables.cts ──► /organizations/:org/deals/payables, .../my-money, POST .../payables/bulk-approve {dryRun}
```

- **Fair Review Clock.** `lib/clock.cts` is pure (no I/O; "now" is passed in): business days (Mon-Fri minus the brand country's bank holidays from `lib/holidays.json`, IN and US for 2026-2027), an 18:00 cut-off in the deal's timezone, a 15-calendar-day cap, the step schedule (`remind_50`, `remind_80`, `final_24h`, `release_partial`, `release_grace`) and `holdPlan` (3-day honor, 29-day validity). `lib/review-clock.cts` maps it onto the deal document: start on the first passing checks, pause on a change request (which must cite a brief item or failed check and uses a signed round; past the rounds it needs an accepted change order), stop on approve, dispute or kill. `service.advanceClocks()` runs hold upkeep (reauthorize after day 3, warn once before a lapse) and the due steps; each step id is executed once.
- **Payables.** `payables.cts` builds one row per milestone (held amount, clock status, days left, rounds, failed checks, hold age), a crew member's view (`myMoneyRows`), and `planApproval` / `bulkApprove`: a dry run of each approve (capture amount, policy verdict, `splitCents` per person) before anything moves, then each approve through the single-approve path. The web side (`apps/web/src/pages/PayablesPage.tsx`, `MyMoneyPage.tsx`) uses AG Grid Community; `lib/payablesFilter.ts` parses plain-language filters into chips with fixed patterns, no model.
- **Payout batch.** `lib/split.cts` splits a release in integer cents (floor each share, leftover cents to the lead). Each release step pays the whole crew in one Payouts batch with `sender_batch_id` `payout:<deal>:<milestone>:<step>`, so a retry never pays twice; `lib/receipts.cts` writes one receipt per member. `PAYOUTS_MODE=simulated` (default) records the batch with no PayPal call; `real` calls Payouts v1 and still falls back to simulated on `PAYOUT_NOT_AVAILABLE`.
- **SDK adapter.** `lib/paypal-sdk.cts` implements the same gateway interface as the REST adapter on the typed PayPal Server SDK (APIMatic), passing our idempotency keys as `PayPal-Request-Id` and mapping errors to the same `GatewayError`. `paypal.cts` (`gatewayFromEnv`) picks it with `PAYPAL_CLIENT` (default `sdk` on sandbox, `rest` on live). `tests/paypal-contract.test.js` requires both adapters to behave identically. See `docs/apimatic.md`.
- **Workflow.** `workflows/fair-clock` is a Render Workflow (`@renderinc/sdk` 1.7) that calls the advance endpoint as retried steps, started every 15 minutes by a cron job. Code only for now; see its README.

## Contracts (single source)

`contracts/schemas/*.json` (JSON Schema) + `contracts/openapi/internal.yaml`. `contracts/gen.sh` generates
`apps/api/src/contracts/types.d.ts`, `apps/web/src/contracts/types.d.ts` (json-schema-to-typescript) and
`services/agent/app/contracts/*.py` (Pydantic v2 via datamodel-code-generator). CI job `contracts` regenerates and fails on drift.

## Async jobs (Redis Streams)

| type                       | scopes                                               | handler                                                                              |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `insights.analyze_post.v1` | posts/metrics/brand read, insights:write, jobs:write | spike/insight flow → `POST /internal/insights`                                       |
| `review.digest.v1`         | posts/reviews/brand read, insights:write             | merge reviewer comments → digest insight                                             |
| `ingest.transcribe.v1`     | posts:read, assets:write                             | S3 → Whisper (chunked, timestamped) [+ scene cuts] → `PUT /internal/posts/:id/media` |
| `brand.index.v1`           | brand:read                                           | re-embed brand hub into Qdrant                                                       |

Worker (`services/agent/app/worker.py`): consumer group `agent-workers`; on failure it re-enqueues with `attempt+1` and
exponential backoff; after `JOBS_MAX_ATTEMPTS` the envelope goes to `yv:jobs:dead` and Node is told `dead_lettered`.
`XAUTOCLAIM` recovers messages left pending by a crashed consumer. Results are POSTed to `/internal/jobs/:id/result`; Node
updates `AgentJob` and emits socket.io `job:update` / `insight:new` to room `org:<id>` (client joins with `org:join`).

## Agent

`route()` (keyword router) → one of four flows in `app/flows.py`:

- **brand_qa**: Qdrant search over the org's brand hub (rules, resources and what each is for).
- **insight**: post vs org baseline (median views / engagement per platform); for YouTube, finds retention spikes above the
  curve's own decay trend and reports **what is spoken (transcript) and on screen (scene-cut labels) at that second**.
- **planner**: past winners (views vs median) + brand rules → a week's plan.
- **review_digest**: clusters many reviewers' comments into one deduplicated change list and flags brand-rule conflicts.

Tools are Node calls only: `getPosts, getMetrics, getRetention, getMedia, searchBrandKnowledge, getReviewComments, createInsight`.
All numbers, citations (`postId`, `metric`, `value`) and **data limits** are computed in code; the LLM only phrases them.
Stated limits include: Instagram Graph = aggregate reel metrics only (no per-second retention); YouTube Analytics =
audienceWatchRatio curve; transcript/scene-label provenance; fixture data flagged as synthetic.
LLM via LiteLLM (`LLM_MODEL`, `LLM_API_BASE`, `LLM_API_KEY`; `stub` = deterministic offline writer for tests), with a per-org
daily token budget in Redis (`ORG_DAILY_TOKEN_BUDGET`).

## Ingestion connectors

`app/ingest/connectors.py`: YouTube Analytics (retention report), Instagram Graph (reel insights), Postiz (posts). Each uses
the real API when its credential env var is set, otherwise recorded fixtures in `services/agent/fixtures/`.

## Observability

`app/telemetry.py`: OpenTelemetry spans around chat and jobs when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (no-op otherwise).

## Running

- Full stack: `cp infra/.env.example infra/.env && docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --build`
- Shared GPU host (loopback-only sidecars): `infra/docker-compose.hostnet.yml` (host networking, high 127.0.0.1 ports, own project name).
- Seed: `docker compose ... exec api node scripts/seed-agent-demo.js > seed.json`
- E2E: `python3 infra/e2e.py --api http://127.0.0.1:3000/api/v1 --seed seed.json`
- Golden evals: `python3 services/agent/evals/run_evals.py --api ... --seed seed.json`

## Known gaps

On-screen text comes from scene-cut labels, not OCR; the router is keyword-based (an LLM router can slot in behind `route()`);
embeddings default to a hashing embedder (`EMBED_MODEL` switches to a LiteLLM embedding model); connectors are fixture-backed
until credentials exist; no ingestion scheduler yet writes connector output into Metric/RetentionPoint.
