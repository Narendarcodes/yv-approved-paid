---
status: proposed
date: 2026-10-28
deciders: Golla Narendar (owner) - pending PR review
---
# Every lifecycle edge carries its own permission; concepts need a reviewer; an org keeps an admin

(ADR-0018 is reserved for the identity / Better Auth decision, drafted separately.)

## Context
The 2026-10-28 pentest (Strix + manual, findings M1, M2, L1) found three gaps inside one organization.
None of them crosses tenants; ADR-0015's org scoping held.

- **M1 (High).** `POST /projects/:id/transition` only needed `project.transition`, which editors hold.
  The transition table allowed `UNDER_REVIEW -> APPROVED -> SCHEDULED -> PUBLISHED`, so an editor could mark
  their own draft approved and published with no reviewer, while the dedicated `/approve` route correctly
  answered 403. The project ended `PUBLISHED` with `approvedVersionId: null`.
- **M2 (Medium).** Concept approve/decline only checked membership. Approve creates a project and a brief,
  so a reviewer (no `project.create`) could propose a concept and approve it themselves.
- **L1 (Low).** The member-update route had no validator, and nothing stopped an admin from demoting or
  disabling the last admin, which locks the organization out of member management for good.

## Decision
1. **`TRANSITIONS` in `services/project.service.js` is the single source of truth.** Each edge
   `from -> to` names the permission it needs:

   | edges | permission | extra rule |
   |---|---|---|
   | work-in-progress (assign, inputs, drafting, revision work, cancel, close) | `project.transition` | |
   | `* -> REVISION_REQUESTED` | `project.revision` | same as `POST /:id/revisions` |
   | `IDEA -> APPROVED_CONCEPT` | `concept.review` | a concept decision |
   | `UNDER_REVIEW / REVISION_SUBMITTED -> APPROVED` | `project.approve` | approves the newest uploaded version, exactly like `POST /:id/approve`; 400 `no_version` without one |
   | `APPROVED -> SCHEDULED` | `project.schedule` | 400 `not_approved` unless `approvedVersionId` points at a real version of this project |
   | `SCHEDULED -> PUBLISHED` | `project.publish` | same approved-version rule |

   The route checks membership only (`can(null, { from: 'project' })`, so non-members still get 404) and
   `transitionProject()` checks the edge's permission with `allows(req.ctx.permissions, …)`. It refuses to
   run without the caller's permissions, so no future caller can skip the check by accident.
   `ALLOWED_TRANSITIONS` is now derived from the table and kept only for callers that need the targets.
   A generic transition can therefore never do what the dedicated route for that step would refuse.
2. **Concept decisions need `concept.review`** (granted to `reviewer`; admins have it through `*`).
   Editors and publishers can still propose concepts but can't decide them.
3. **No self-approval of concepts, except for admins.** Approving a concept you proposed also needs
   `concept.approve_own`, which no seeded role lists, so only `*` (admin) has it. This keeps the
   separation of duties for reviewers and still lets a one-person or one-admin org work. Declining your
   own open concept is allowed (it's a withdrawal). Only open (`IDEA`) concepts can be declined; a decided
   one answers 409.
4. **Member update is validated and keeps an admin.** `updateMemberSchema` (Joi) allows only
   `{ role?: lowercase name, disabled?: strict boolean }`, at least one of them, on both
   `PATCH /organizations/:org/members/:user` and the `/users/organizations/...` alias. The service refuses
   (409 `last_admin`) any change that leaves the org with no active member whose role grants `*`. The
   check runs after the write and restores the old values if the org was left without an admin, so two
   concurrent demotions of the last two admins can't both succeed.

## Consequences
- Reviewers can now take the approve and request-revision edges through `/transition` (they could not
  call it at all before). Publishers can take the schedule and publish edges. Editors lose
  `UNDER_REVIEW -> APPROVED`, `APPROVED -> SCHEDULED`, `SCHEDULED -> PUBLISHED` and
  `IDEA -> APPROVED_CONCEPT`.
- The web UI already routed approve/schedule/publish through their dedicated flows; the concepts page now
  shows Approve/Decline only to roles with `review_concepts`, and hides Approve on your own concept unless
  you are an admin.
- `seedDefaultRoles()` syncs role permissions when an org is created, so existing deployments pick up
  `concept.review` for reviewers on the next org creation or seed run. Until then, only admins can decide
  concepts (fail closed).
- Not changed here (follow-ups): `POST /:id/approve` still approves from any status; the web `roles.ts`
  still lists `approve`/`schedule` for editors, which the API has never allowed (UX mismatch only).

## Considered options
- **Remove APPROVED/SCHEDULED/PUBLISHED from the generic endpoint entirely.** Simpler, but it leaves two
  tables (generic vs dedicated) that can drift. One table with per-edge permissions keeps one answer to
  "who may make this move".
- **Gate concept approval with `project.create`** (the pentest's first suggestion). That gives the
  decision to editors, who propose most concepts, and makes self-approval the normal path. A reviewer
  permission matches how projects are approved.
- **Block concept self-approval for everyone.** Deadlocks a one-admin org; rejected.
