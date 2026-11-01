---
status: accepted
date: 2026-10-25
deciders: Golla Narendar (owner)
---
# One Post: the agent reads projections of Publication, Feedback and Performance Series

The agent platform added parallel collections: `Post`, `Metric` (time-series), `RetentionPoint` and `ReviewComment` (`models/agent/index.js`). The product's own records are `Publication`, `PerformanceMetric` and `Comment`. Only `scripts/seed-agent-demo.js` writes the agent collections. As a result:
- The Brand Brain analyzes demo data only.
- The browser routes `/organizations/:org/agent/posts/:postId/*` take agent Post ids that no real screen has.

We decided:
- **Publication is the Post.** `/internal/posts`, `/internal/metrics` and `/internal/reviews` become read projections over `Publication`, `PerformanceMetric` and `Comment`, mapped to the existing JSON Schemas so the Python side does not change.
- The agent `Post`, `Metric` and `ReviewComment` collections are deleted.
- `RetentionPoint` becomes one `RetentionCurve` document per Post. It is a curve over video seconds, not a time series.
- `Insight` and `Asset` (transcript, scene cuts) stay as agent-written collections, keyed by `publicationId`.

## Consequences
- Jobs can be triggered from domain events: `post.published` plus 48h → analyze, and `review.locked` → digest. They no longer depend only on buttons.
- The contracts JSON Schemas stay the seam. Only the Node adapter behind `/internal` changes.

## Decisions recorded on acceptance (2026-10-25)
- Q2: **Publication** is called **Post** everywhere, in UI and code, once the agent's separate `Post` is gone.
- Q13: one caption for all Social Accounts, plus an optional per-platform override.
- Q14: daily Performance Series, plus one hourly snapshot field for the first 48h (velocity).
- Q18: Brand Brain analysis runs on spikes only: views > 2× the median of the last 20 Posts.
- Q19: the agent writes Insights only; Concepts it plans are created through a user-confirmed action. It never posts Feedback.

The owner accepted the suggested defaults for all open questions; the full list is in `domain-decisions-2026-10-25.md`.
