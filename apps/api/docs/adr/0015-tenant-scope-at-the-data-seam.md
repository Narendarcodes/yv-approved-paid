---
status: accepted
date: 2026-10-25
deciders: Golla Narendar (owner)
---
# Organization scope is enforced in the data access, not trusted from the request

The cross-org IDOR (prior audit §2.1) happened because `requirePermission` takes `organizationId` from the request, and the services load children by `projectId` alone.

We decided:
1. **Every org-owned document carries `organizationId`.** That includes Brief, Comment, Task, Input, RevisionRequest, ProjectVersion, chat Channel and ChatMessage, and ActivityEvent, none of which have it today. A one-off migration backfills them from their Project.
2. **A single `access` module resolves `{orgId, member, permissions}`** from the route's addressed resource: project → its org, publication → its org. A client-supplied `organizationId` only ever *selects* among the user's memberships. It never overrides the resource's org.
3. **A Mongoose `tenantScoped` plugin** makes `find*`, `count*`, `update*`, `delete*` and `aggregate` throw when the filter lacks `organizationId`, unless the call is explicitly marked `{ crossTenant: true }`. Only the scheduler sweep and migrations use that mark.

## Considered options
Per-route fixes plus tests only. Rejected: that defends 30+ routes one at a time, and the next route added is unguarded by default.

## Decisions recorded on acceptance (2026-10-25)
- Q16: a Client lives inside the agency's Organization (not its own Organization); Client reviewers are limited guests.
- Q17: Client reviewers get Project-scoped access through a `guest` role scoped to one Client (Phase 6).

The owner accepted the suggested defaults for all open questions; the full list is in `domain-decisions-2026-10-25.md`.
