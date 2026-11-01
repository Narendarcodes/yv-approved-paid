---
status: accepted
date: 2026-10-25
deciders: Golla Narendar (owner)
---
# Tracked Links live in the monolith, and Clicks go to a MongoDB time-series collection

**Tracked Links** are an Organization-owned `links` module (`TrackedLink`: slug, destination, UTM, attached postIds). Clicks are recorded like this:
- The public redirect `GET /r/:slug` answers with a 302 at once.
- It dedupes in Redis.
- It writes the Click to `link_clicks`. That is a MongoDB time-series collection, with `timeField: ts`, `metaField: {orgId, linkId}`, and `expireAfterSeconds` for raw clicks.

A daily rollup writes a `clicks` Metric into the Performance Series, so Clicks show beside views with no new read path.

The raw time-series collection fits because Clicks are append-only and never corrected. Time-series collections forbid upserts and unique indexes, and limit updates to the metaField (MongoDB manual, "Time Series Collection Limitations"). That is exactly why Performance Series stays a regular collection.

Split the redirector into its own process only if click volume makes `api` latency suffer. Its module entry point is already the seam.

## Decisions recorded on acceptance (2026-10-25)
- Q15: raw Click events are kept 13 months (TTL on the time-series collection); rollups into Performance Series are kept forever.

The owner accepted the suggested defaults for all open questions; the full list is in `domain-decisions-2026-10-25.md`.
