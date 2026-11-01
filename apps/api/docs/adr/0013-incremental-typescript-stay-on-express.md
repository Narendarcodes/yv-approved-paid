---
status: accepted
date: 2026-10-25
deciders: Golla Narendar (owner)
---
# Move apps/api to TypeScript one module at a time, and stay on Express (upgrade to 5)

Approach:
- Add `tsconfig.json` with `allowJs`, `checkJs: false`, `noEmit`, `erasableSyntaxOnly`.
- Write new and refactored modules as `.ts`.
- Run them directly on Node 22.18+ or 24 with type stripping. No build step: verified that `require('./x.ts')` works from CommonJS on Node 22.23.
- Run `tsc --noEmit` in CI.
- Use the generated `apps/api/src/contracts/types.d.ts`, which nothing imports today, as the type of `/internal` and job payloads.

Express stays, upgraded to 5 for native async error propagation, which deletes the `wrap()` helpers. We rejected moving to Fastify, Nest or Hono: the rewrite cost buys nothing the product needs.

Mongoose stays and goes up to v8, with `lean()` reads, explicit DTO mappers, a tenant-scope plugin, and `autoIndex` off in production.

## Consequences
- No `enum` and no parameter properties, because type stripping can't erase them. Use `as const` unions.
- Jest keeps running the JS tests. New TS tests run under Jest with type stripping, or under Vitest later. This is not a blocker.

## Decisions recorded on acceptance (2026-10-25)
- No open questions; accepted as written.

The owner accepted the suggested defaults for all open questions; the full list is in `domain-decisions-2026-10-25.md`.
