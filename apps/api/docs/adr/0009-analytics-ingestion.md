# ADR 0009 - Analytics ingestion as a daily time series

Date: 2026-10-12
Status: Accepted
Branch: feat/pipeline-analytics (builds on ADR 0008, the Postiz adapter)

## Context
The product north star is one system for a content team: Idea -> Brief ->
Production -> Review -> Publish -> **Analytics**. Until now the last step was
manual: `PerformanceMetric` held one hand-typed number per metric per project,
and the scheduler only copied a post's latest Postiz numbers onto it. The
Analytics page said "entered manually". We could not answer "how did last
week go", "which platform works for this client", or "when should we post".

Postiz exposes two analytics endpoints (https://docs.postiz.com/public-api):

- `GET /analytics/post/{postId}?date=7|30|90` - per post
- `GET /analytics/{integrationId}?date=N` - per channel (followers, impressions...)

Both return `[{ label, data: [{ total, date }], percentageChange }]`. Labels
differ by platform ("Impressions", "Likes", "Reactions", "Watch time"...) and the
values are strings.

## Decision
1. **Store a daily time series, not a latest value.** One `PerformanceMetric`
   row per (post or channel, metric, day):
   `organizationId, projectId, publicationId, channelId, platform, scope
   (post|platform), rawLabel, metric, value, date, cumulative, simulated, source`.
   - `rawLabel` keeps exactly what the source said; `metric` is the normalized key
     (`views, likes, comments, shares, saves, watchTime, followers,
     followersGained, reach`). Unknown labels are kept as `raw:<label>` so no data
     is dropped and a mapping can be added later without re-fetching.
   - Rows are upserted on (scope, publicationId|channelId, metric, date), so
     re-ingesting is idempotent.
2. **Semantics.** Post-level values are read as cumulative "as of that day"
   (the documented example grows day over day). Window figures are therefore
   `value(to) - value(from)` per post, summed. Platform follower counts are
   levels; impressions are per-day flows. When a platform gives no explicit
   "new followers" series we derive `followersGained` from the day-to-day
   difference of the follower level.
3. **Cadence.** A separate scheduler timer (`ANALYTICS_INTERVAL_MS`, default
   5 min) runs `runIngestion()`: a post is due **hourly for the first 48 hours**
   after publish, then **daily**, and stops after 90 days. The window asked of
   Postiz grows with the post's age (7 -> 30 -> 90). Channels are ingested once a
   day. At most 50 posts/channels per pass, oldest-synced first. The analytics
   endpoints are not covered by the 90/hour create-post limit, but we still
   batch conservatively. "Sync metrics" on a post and `POST
   /organizations/:orgId/analytics/ingest` force a pass.
4. **Demo mode is simulated and says so.** Without `POSTIZ_API_URL/KEY`, demo
   channels get a deterministic simulated series in the same Postiz shape
   (`local.provider.simulateSeries / simulatePlatformSeries`). Every such row is
   stored with `simulated: true, source: 'simulated'`, and every analytics
   response carries a `simulated` flag that the UI renders as a visible
   "Simulated (demo mode)" label. Real and simulated data never mix silently.
5. **Read model computed on request.** `analytics.service.js` builds the
   summary (totals with % change vs the previous window, daily trend, top content
   by engagement rate, platform comparison, client/campaign rollups), the
   best-day/hour heatmap (from our own publish history in `TEAM_TIMEZONE`), the
   per-project Performance card, last month's top performers for the Concepts
   board, and client report data. Engagement rate =
   (likes + comments + shares + saves) / views.
6. **API** lives under `/api/v1/organizations/:orgId/analytics/...`
   (`summary, heatmap, top-performers, projects/:id/performance, report,
   ingest`) and is documented in `docs/openapi.yaml`.

## Consequences
- Analytics answers come from our own store, so pages stay fast and keep
  working when Postiz is down; the cost is up to a day of lag after the first 48h.
- Legacy manual metrics still work: they are written as `source: 'manual'`
  rows dated today and read like any other cumulative post series.
- Reads aggregate in Node over the org's rows. Fine for an agency's volume (a
  few thousand posts); if it grows, add a nightly per-day rollup collection -
  the row shape already supports it.
- Real Postiz label names vary by provider; the label map in
  `postiz.provider.js` covers the documented ones. Unmapped labels are
  preserved as `raw:*` and listed nowhere in the UI until mapped.
- Not verified against a live Postiz instance (no keys in this environment);
  covered by unit tests with mocked HTTP.
