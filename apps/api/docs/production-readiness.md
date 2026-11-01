# Production readiness: status

Tracks the production-readiness audit (2026-10-25) and the architecture plan
(ADR-0010..0017). Updated 2026-10-28 at the end of Phase 1.

| Phase | Status |
| --- | --- |
| 0. Merge and unbreak the build | Done (main @ 9eaa2e0: web tsc + lint in CI, Node 24, strict prod `npm audit`, Docker build job, boundaries check) |
| Pre-commit hooks | Done, PR #6 (`chore/pre-commit`) |
| 1. Security P0/P1 | Done except the items under "Deferred" below (`feat/phase-1-security`) |
| 2. Reliable publishing | Not started |
| 3+. Real channels, affiliate links, ops hardening | Not started |

## Phase 1: Security

| # | Item | Audit severity | Status | Commit |
| --- | --- | --- | --- | --- |
| 1 | Cross-org IDOR on `/projects/:id/*`: org comes from the addressed record, `modules/access` `can()` (TS), non-members get 404 | P0 | Done | 365aa5b |
| 2 | `organizationId` on the nine project-owned collections + migrations runner (`npm run migrate:up`) + 0001 backfill/indexes | P0 (data seam) | Done | ab89091 |
| 3 | Cross-org test matrix generated from the Express route table (82 routes, plain + spoofed `organizationId`) | P0 | Done | 365aa5b |
| 4 | CORS allowlist fails closed; fail-fast production config validation; `TRUST_PROXY`; tighter helmet/CSP | P0 | Done | 917875b |
| 5 | Postiz webhook fails closed (HMAC / header / path token, constant-time) | P0 | Done | 480e6c4 |
| 6 | `/internal` on a separate private listener (`INTERNAL_PORT`, loopback / compose `backend` network) + `X-Internal-Token` | P0 | Done | c6d4186 |
| 7 | Uploads not public; avatars via `GET /users/:id/photo` (authenticated, shares-an-org); migration 0002; password hash no longer leaked by `/auth/me`, `/users/me` | P1 | Done | 248cba2 |
| 8 | httpOnly cookie sessions, rotating refresh tokens with reuse detection (family revocation), signed double-submit CSRF, `GET /auth/csrf`, `?token=` removed, Socket.IO cookie + Origin check, web client off localStorage; migration 0003 (`tokenHash` unique, `expiresAt` TTL, `family`); ADR-0017 | P1 | Done | 1f751c3 |
| 9 | Rate limits on `POST /auth/login`, `/auth/register`, `/auth/refresh`: per IP + per account, 429 + `Retry-After`, in-memory store behind a Redis-ready interface | P1 | Done | c9f9c64 |

Supporting commits: 44c0642 (prettier on touched files), f924fa2 (native `.cts` modules under node + jest).

### Deferred (not in Phase 1)

- **`tenantScoped` Mongoose plugin in warn mode** (ADR-0015, plan Phase 1 step 3). Routes are scoped through `modules/access` and the services; the data-seam plugin that logs (then throws on) unscoped queries is still to do.
- **Password-reset rate limit**: there is no password-reset route yet (forgot-password is UI-only, audit P2). Add the limiter when the route lands.
- **Remaining indexes from plan step 2**: PerformanceMetric unique upsert key, Publication `(provider, externalPostId)` unique sparse, Invoice `(organizationId, number)` unique; `autoIndex` off in production.
- **Shared rate-limit store**: counters are per API process. Add a Redis store (same interface, `utils/rateLimitStore.js`) before running more than one API instance.
- **Compose `RATE_LIMIT_MAX: 100000`** (global limiter) is still set in `infra/docker-compose*.yml`; lower it for production.
- **Storage on R2 / signed URLs** and streaming large uploads instead of multer memory storage (audit P1, uploads).
- **Encrypted OAuth credential storage** and per-org Postiz keys (audit P1; needed only for direct connectors / other agencies).

## Deploying Phase 1

1. Set the new environment variables (see `apps/api/.env.example`, `infra/.env.example`):
   - `JWT_ACCESS_SECRET` (>= 32 chars, not a default) and `MONGO_URI`: production now refuses to start without them
   - `CORS_ORIGIN` (required in production, explicit https origins)
   - `CSRF_SECRET` (required in production, >= 32 chars)
   - `SERVICE_JWT_SECRET` and `INTERNAL_API_TOKEN` (required in production unless `AGENT_ENABLED=false`, >= 32 chars each)
   - `POSTIZ_WEBHOOK_SECRET` (required in production when `POSTIZ_API_URL` is set, >= 32 chars)
   - `TRUST_PROXY` (e.g. `1` behind Caddy/nginx; otherwise every client shares the proxy IP for rate limits)
   - optional: `COOKIE_SECURE`, `COOKIE_SAMESITE` (default `strict`), `COOKIE_DOMAIN`, `AUTH_RATE_LIMIT_ENABLED`, `AUTH_*_{MAX,WINDOW_MS}`
2. Run migrations once before starting the new API: `cd apps/api && npm run migrate:up` (`migrate:status` to check).
3. Web and API must be same-site (e.g. `app.example.com` + `api.example.com`, or same origin behind one proxy): cookies are SameSite=strict.
4. Existing sessions end on deploy: old browser sessions held tokens in localStorage and must sign in again.
