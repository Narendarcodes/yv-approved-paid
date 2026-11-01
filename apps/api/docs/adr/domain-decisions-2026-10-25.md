# Domain and architecture decisions, 2026-10-25

The architecture audit raised 20 open questions (domain language, lifecycle, publishing, performance, tenancy, Brand Brain, commercial) and seven ADR drafts (0010–0016). On 2026-10-25 the owner, Golla Narendar, accepted the suggested default for every question and accepted ADRs 0010–0016. This file is the record. Terms are defined in `/GLOSSARY.md`.

## Domain language
1. **SocialChannel → Social Account** and chat **Channel → Chat Room**, in code and UI. Collection names stay (Mongoose `collection` option), so no data migration. Renamed when the module moves.
2. **Publication is called Post** everywhere, in UI and code, once the agent's separate `Post` is gone (ADR-0014).
3. **Client** stays a free-text label on Project now; it becomes an entity (contacts, its own reviewers, its own Contracts and Invoices) in Phase 6.
4. **Chat Rooms belong to the Organization**, with an optional Project. The hidden "Team Chat" Project goes away when chat moves.
5. **One Approved Version per Project**, replaceable before any Post is Published.

## Lifecycle
6. A Project with some Posts Published and the rest Failed shows as **Live with a "N failed" badge** (not stuck in Scheduled).
7. A Live Project **can get new Posts** (repost to another account, affiliate re-push) without leaving Live.
8. **CLOSED is dropped** until someone needs archiving.
9. `/projects/:id/transition` (manual status jump) **stays, admin-only**; everything else uses domain actions.

## Publishing
10. **Native scheduling where the provider has it** (Postiz queue, Meta `scheduled_publish_time`); our own dispatch at time T for YouTube and demo.
11. Failed Posts **retry automatically: 3 attempts, exponential backoff**. Auth and validation errors are not retried.
12. **Postiz is a bridge.** Go direct to Meta in Phase 3 if the Postiz Facebook-Login setup takes more than one day (this is what decides when `Credential` is built).
13. **One caption plus a per-platform override.**

## Performance
14. **Daily Performance Series plus one hourly snapshot field for the first 48h** (velocity).
15. Raw Click events are kept **13 months**; rollups forever.

## Tenancy and agencies
16. A **Client lives inside the agency's Organization**; Client reviewers are limited guests. (One User can still be a Member of several Organizations.)
17. Client reviewers get **Project-scoped access via a `guest` role scoped to a Client**.

## Brand Brain
18. Analysis runs **on spikes only: views > 2× the median of the last 20 Posts**.
19. The agent **writes Insights only**; Concepts come from a user-confirmed action.

## Commercial
20. yv. will **not collect payments or pay out affiliate commissions for the next 6 months**. That is the trigger for revisiting ADR-0011.

## ADRs accepted
| ADR | Decision |
|---|---|
| 0010 | Modular monolith, one image, separate processes per role (`api`, `worker`) |
| 0011 | MongoDB is the only system of record (no Postgres) |
| 0012 | Redis carries queues, fan-out and counters; no state of record |
| 0013 | Incremental TypeScript in `apps/api`, stay on Express (upgrade to 5) |
| 0014 | One Post: the agent reads projections of Publication, Feedback and Performance Series |
| 0015 | Organization scope is enforced in data access, never trusted from the request |
| 0016 | Tracked Links live in the monolith; Clicks go to a MongoDB time-series collection |
