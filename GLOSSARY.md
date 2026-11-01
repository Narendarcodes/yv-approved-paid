# yv. Content Ops

Lets a content team (in-house or agency) take a piece of content from idea to live posts on social platforms, measure how it did, and feed what worked back into the next idea. One **Organization** is one tenant.

> Written by the architecture audit (2026-10-25) from the code on `feat/agent-platform`. The owner accepted the proposed terms and the suggested answers to all open questions on 2026-10-25; see `apps/api/docs/adr/domain-decisions-2026-10-25.md`. Terms marked **(new name)** resolve a clash in the current code; code and DTOs are renamed only when their module moves (collection names stay).

## Tenancy and people

**Organization**:
The tenant. It owns every Project, Social Account, Brand Rule, Contract and Invoice. Nothing crosses from one Organization to another.
_Avoid_: workspace, team, org (in prose), account

**Member**:
A User's place in one Organization, with one Role. One User can be a Member of several Organizations.
_Avoid_: membership (in UI copy), seat

**Role**:
A named set of Permissions held by a Member (e.g. admin, reviewer, publisher, editor).
_Avoid_: group

**Permission**:
One thing a Member may do in their Organization, such as `project.approve`. It is always checked against the Organization that owns the thing being acted on.

**Client** (new name):
The brand or customer an agency makes content for. Decided: a free-text label on Project, Contract and Invoice for now; it becomes an entity (contacts, its own reviewers, Contracts and Invoices) in Phase 6. A Client lives inside the agency's Organization, and its reviewers are limited guests scoped to that Client.
_Avoid_: customer, brand (when you mean the paying party)

## Making content

**Concept**:
An idea someone proposed but nobody has committed to yet. It is either approved, which creates a Project, or declined.
_Avoid_: idea card, pitch

**Project**:
One piece of content being made, from approved Concept to live Posts. It moves through one Stage at a time.
_Avoid_: job, task, content item, post

**Stage**:
Where a Project is in its lifecycle: Idea, Brief, Production, Review, Publish, Live. Each Stage covers one or more fine-grained statuses.
_Avoid_: column, phase

**Brief**:
The creative instructions for one Project: goal, audience, references, deliverables, deadline.

**Input**:
Material the Project waits on from someone else, such as raw footage or client assets.
_Avoid_: asset (reserved for Version files), dependency

**Task**:
A to-do inside a Project, with an assignee and a due date.

**Version**:
One uploaded cut of the Project's content (v1, v2…). It holds one or more files.
_Avoid_: draft (except for "first draft", which is Version 1), revision

**Approved Version**:
The Version a reviewer signed off. It is the only Version that can be published.
_Avoid_: final, locked version

## Review

**Feedback**:
A reviewer's comment on a Version. It can be pinned to a timecode.
_Avoid_: comment (in domain prose), note, review comment

**Review Lock**:
The act that freezes all open Feedback on a Version into one Revision Request.

**Revision Request**:
A numbered request for changes to a Version. It has a scope of Feedback items and its own status.
_Avoid_: revision (on its own), change request

**Feedback Digest**:
The agent's deduplicated summary of many reviewers' Feedback on one Version.

## Publishing

**Social Account** (new name):
An Instagram, Facebook Page, YouTube, LinkedIn or X account that an Organization publishes to.
_Avoid_: channel. "Channel" also names a chat room in the code (`Channel` vs `SocialChannel`).

**Publishing Provider**:
The way a Post actually reaches a platform: Postiz, direct Meta Graph API, direct YouTube API, or the demo simulator.
_Avoid_: integration, connector, scheduler

**Post**:
One Project's Approved Version going to one Social Account at one time, with its caption and settings. A Project fans out into one Post per Social Account.
_Avoid_: publication (in prose), agent "Post" (a separate collection today, see ADR-0014)

**Post status**:
Scheduled, Publishing, Published, Failed or Cancelled. Publishing is the claim state that stops a Post going out twice (added in Phase 2). Failed Posts retry up to 3 times with exponential backoff; auth and validation errors are not retried.

**Demo mode**:
Running with simulated Social Accounts, Posts and metrics. Everything it produces is labelled as simulated and never mixed with real data.
_Avoid_: local mode, mock

**Manual Post**:
A Post someone published by hand, recorded afterwards with its live URL.

## Performance

**Metric**:
A normalized measurement of a Post or a Social Account: views, likes, comments, shares, saves, watch time, reach, followers, followers gained, clicks.
_Avoid_: stat, KPI, insight (reserved, see below)

**Performance Series**:
The daily values of one Metric for one Post or Social Account.
_Avoid_: analytics row, metric row

**Engagement Rate**:
(likes + comments + shares + saves) ÷ views over a window.

**Retention Curve**:
For one video Post, the share of viewers still watching at each second.
_Avoid_: retention points

**Insight**:
A finding the Brand Brain wrote about a Post, with citations to the Metrics behind it.
_Avoid_: analysis, recommendation

## Brand Brain

**Brand Brain**:
The Organization's agent. It answers questions about its brand, explains why Posts performed, and drafts plans and Feedback Digests.
_Avoid_: AI, bot, assistant

**Brand Rule**:
One rule or resource in the Organization's brand hub (voice, visual, do, don't, audience, purpose, resource).

**Agent Job**:
One asynchronous piece of Brand Brain work (analyze a Post, transcribe, digest Feedback, re-index the brand).

## Affiliate (upcoming)

**Tracked Link** (new name):
A short link that an Organization puts in a Post. It redirects to an affiliate destination and counts clicks.
_Avoid_: affiliate link (when you mean the short link rather than the destination), short URL

**Destination**:
The affiliate or product URL a Tracked Link redirects to, with its UTM parameters.

**Click**:
One visit through a Tracked Link.

## Commercial

**Contract**:
An agreement with a Client: draft, sent, viewed, signed.

**Invoice**:
A request for payment to a Client: draft, sent, paid, overdue, void.

## Team chat

**Chat Room** (new name):
A conversation space for an Organization's Members. Decided: Chat Rooms belong to the Organization, with an optional Project. (Today a hidden Project titled "Team Chat" still holds the Organization-wide rooms, until the move.)
_Avoid_: channel.

## Relationships

- An **Organization** has many **Members**, **Projects**, **Social Accounts**, **Brand Rules**, **Contracts**, **Invoices** and **Tracked Links**.
- A **Concept**, once approved, creates exactly one **Project** and its **Brief**.
- A **Project** has many **Versions**. At most one of them is the **Approved Version**.
- A **Review Lock** on a **Version** turns its open **Feedback** into one **Revision Request**.
- A **Project** fans out into one **Post** per **Social Account**. Every Post publishes the Approved Version through exactly one **Publishing Provider**.
- A **Post** and a **Social Account** each have **Performance Series**. A video Post may have one **Retention Curve**.
- A **Tracked Link** belongs to one Organization, can be attached to one or more **Posts**, and has many **Clicks**.
- An **Insight** is about one **Post** and cites its **Metrics**.

## Flagged ambiguities

- **"Channel"** means two things in the code: a Social Account (`SocialChannel`) and a chat room (`Channel`, `routes/projects.js /:id/channels`). Decided: rename them to **Social Account** and **Chat Room** (keep the collection names).
- **"Post"** also means two things: the publishing record (`Publication`) and the agent's separate `Post` collection (`models/agent/index.js`). Only the seed script fills the agent `Post` (`scripts/seed-agent-demo.js`), so the Brand Brain never sees real Posts. Decided: one Post (ADR-0014); `Publication` is called Post everywhere once the agent `Post` is gone.
- **"Comment"** is likewise used twice: Feedback (`Comment`) and the agent's `ReviewComment`. Same fix.
- **"Metric"** has three stores: `Publication.metrics` (latest snapshot), `PerformanceMetric` (daily series, ADR-0009), and agent `Metric` (time-series collection, seed only). Decided: one Performance Series store.
- **"Approved"** has two meanings: an approved Concept (`APPROVED_CONCEPT`) and an Approved Version (`APPROVED`). Keep both, but always say which one.
- **"Revision"** means a Revision Request in some places, a Project type (`type: 'revision'`) in others, and a new Version in UI copy. Prefer Revision Request; let a Version simply be a Version.
