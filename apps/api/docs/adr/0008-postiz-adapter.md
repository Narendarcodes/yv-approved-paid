# ADR 0008 - Postiz behind a publishing adapter (supersedes "full brand absorption")

Date: 2026-10-12
Status: Accepted
Branch: feat/postiz-scheduling (reworks origin/postiz-absorption)

## Context
PRD §17 treats Postiz as an **external publishing/analytics capability behind an
internal adapter boundary**: sync publication state and analytics back into the
Content Project, keep a manual fallback, and keep the project record as the
source of truth.

The `postiz-absorption` branch went further: vendor-copied Postiz NestJS
providers (AGPL), a trimmed Prisma schema on a second database (Postgres),
Redis/Temporal sidecars in docker-compose, and placeholder Calendar/Composer
pages. None of the vendored providers were wired in, the Prisma client was never
generated, and the local "fallback" only minted fake ids - so scheduling never
worked end to end, and the stack needed three extra services.

## Decision
Keep one database (MongoDB) and talk to Postiz only through its documented
public REST API (https://docs.postiz.com/public-api).

- `src/integrations/postiz/client.js` - thin public-API client (integrations,
  upload, posts create/list/delete, post analytics). Carried over from the
  absorption branch's `postiz.service.js` and extended.
- `src/services/scheduling/` - the adapter. `PostizProvider` (used for channels
  linked to a Postiz integration) and `LocalSchedulerProvider` (used for demo
  channels, and the only provider when `POSTIZ_API_URL`/`POSTIZ_API_KEY` are
  unset). Routing is per channel.
- `src/services/scheduling.service.js` - channels, scheduling, state sync,
  manual fallback, metrics mirroring into `PerformanceMetric`.
- `src/services/scheduler.js` - interval loop (SCHEDULER_INTERVAL_MS):
  publishes due local posts, polls Postiz `GET /posts` as a safety net for the
  webhook, refreshes metrics.
- `POST /api/v1/webhooks/postiz` - Postiz publish callback; idempotent;
  optional shared secret (`POSTIZ_WEBHOOK_SECRET`).

Project lifecycle sync: APPROVED -> SCHEDULED when the first post is scheduled,
-> PUBLISHED when the first post goes live (scheduler, webhook, poll, "Publish
now" or manual URL); cancelling the last pending post returns it to APPROVED.

## Discarded from postiz-absorption
Vendored `*.provider.ts` (AGPL), `LICENSE.AGPL`, Prisma schema / generated
client / `SchedulingOrganization` mirror on org create, Postgres/Redis/Temporal
compose services and CI Postgres, the placeholder React pages. Kept: the API
client, the provider label table, the settings validation rules, the webhook
idea, the Publication fields for external ids.

## Consequences
- No AGPL code in the repo; no second database.
- Real social tokens live in Postiz; yv. stores only integration ids.
- Demo mode works with zero external services (simulated metrics are flagged
  `metricsSimulated: true` and labelled in the UI).
- Postiz webhook payload shapes vary by version; the receiver accepts
  `{id|postId, state, releaseURL|postUrl|url}` single/array/{posts|data}.
