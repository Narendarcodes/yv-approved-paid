# yv. architecture: MERN + Python agent platform

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

## Contracts (single source)
`contracts/schemas/*.json` (JSON Schema) + `contracts/openapi/internal.yaml`. `contracts/gen.sh` generates
`apps/api/src/contracts/types.d.ts`, `apps/web/src/contracts/types.d.ts` (json-schema-to-typescript) and
`services/agent/app/contracts/*.py` (Pydantic v2 via datamodel-code-generator). CI job `contracts` regenerates and fails on drift.

## Async jobs (Redis Streams)
| type | scopes | handler |
|---|---|---|
| `insights.analyze_post.v1` | posts/metrics/brand read, insights:write, jobs:write | spike/insight flow → `POST /internal/insights` |
| `review.digest.v1` | posts/reviews/brand read, insights:write | merge reviewer comments → digest insight |
| `ingest.transcribe.v1` | posts:read, assets:write | S3 → Whisper (chunked, timestamped) [+ scene cuts] → `PUT /internal/posts/:id/media` |
| `brand.index.v1` | brand:read | re-embed brand hub into Qdrant |

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
