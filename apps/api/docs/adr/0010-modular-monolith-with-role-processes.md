---
status: accepted
date: 2026-10-25
deciders: Golla Narendar (owner)
---
# Modular monolith, with one image and separate processes per role

yv. stays one Node codebase, `apps/api`. Inside it are modules with enforced entry points: `apps/api/src/modules/<name>/`, checked by dependency-cruiser.

The same image runs as separate **processes**:
- `api`: HTTP and socket.io. It can run as several replicas.
- `worker`: BullMQ consumers for publishing, provider reconcile, analytics polling and click rollups.

The Python `agent` and `agent-worker` stay as they are.

We chose this over microservices because:
- One solo developer owns everything.
- The domain has one system of record (MongoDB, ADR-0008) and multi-document invariants (Project ↔ Posts) that need transactions, not network calls.
- Today's failure mode is double-publishing from in-process timers (`services/scheduler.js`), and a separate worker process fixes that without a service split.

## Considered options
- **Microservices** (publishing, analytics, billing services). Rejected: it adds distributed transactions, N deploys and N sets of auth for a single developer, and there is no team or scaling boundary that needs it.
- **Keep timers inside `api`**. Rejected: it makes horizontal scaling unsafe (prior audit §2.2), and a slow Postiz call blocks HTTP latency.

## Consequences
- `server.js` becomes `main-api.js` plus `main-worker.js`. `SCHEDULER_INTERVAL_MS` goes away.
- Splitting a module out later (for example a `links` redirector) is a deploy decision. The module's entry point is already its seam.

## Decisions recorded on acceptance (2026-10-25)
- Q9: the manual `/projects/:id/transition` status jump stays, **admin-only**; everything else goes through domain actions.
- Q10: use the provider's native scheduling where it exists (Postiz queue, Meta `scheduled_publish_time`); our worker dispatches at time T for YouTube and demo.

The owner accepted the suggested defaults for all open questions; the full list is in `domain-decisions-2026-10-25.md`.
