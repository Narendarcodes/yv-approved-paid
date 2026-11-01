---
status: accepted
date: 2026-10-25
deciders: Golla Narendar (owner)
---
# Redis carries queues, fan-out and counters. It holds no state of record.

Redis already ships, for the agent's job streams and its token budget.

**Uses:**
1. **BullMQ for Node-side jobs.** These are delayed Post dispatch at `scheduledFor`, retries with backoff, repeatable reconcile and analytics polls, and per-provider rate limiters.
2. **The Redis Streams `yv:jobs` contract with the Python worker stays as it is.** It is versioned in `contracts/schemas/JobEnvelope.json`, and BullMQ isn't a cross-language contract.
3. **`@socket.io/redis-adapter`.** It lets several `api` replicas and the `worker` emit to the same rooms.
4. **The `rate-limit-redis` store for `express-rate-limit`.**
5. **Click dedupe.** `SET NX EX` keyed on a hashed visitor plus the link.
6. **Short-TTL caches,** only where a measured hotspot exists. Today the only such cache is the agent `whoami`.

**Not used for:**
- Sessions (refresh tokens stay in MongoDB with a TTL index).
- Locks of record. Post claiming is an atomic MongoDB `findOneAndUpdate` with a lease, so a Redis flush can never double-publish.

**Persistence:** run Redis with AOF on. It is still treated as rebuildable. A sweeper re-enqueues any Post whose state in MongoDB says it is due and that has no live job.

## Decisions recorded on acceptance (2026-10-25)
- Q11: failed Posts retry automatically, 3 attempts with exponential backoff (BullMQ in the worker); auth and validation errors are not retried.

The owner accepted the suggested defaults for all open questions; the full list is in `domain-decisions-2026-10-25.md`.
