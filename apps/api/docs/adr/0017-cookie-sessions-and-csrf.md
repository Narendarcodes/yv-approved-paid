---
status: accepted
date: 2026-10-28
deciders: Golla Narendar (owner) - proposed in Phase 1, pending PR review
---
# Browser sessions live in httpOnly cookies; CSRF is a signed double-submit token

## Context
Access **and** refresh tokens were kept in `localStorage` (`apps/web/src/services/api.ts`), so any XSS could
read a 7-day refresh token and take the account over from anywhere. Media used `?token=<access JWT>` URLs,
which leak into logs, history and `Referer`. The refresh collection had no index and no TTL, and the
"grace" path let any rotated token mint new ones forever.

## Decision
1. **Cookies, not JS storage.** Login sets three cookies (`utils/authCookies.js`):

   | cookie | httpOnly | path | lifetime |
   |---|---|---|---|
   | `accessToken` (JWT, 15 min, carries `sid`) | yes | `/` | the JWT's `exp` |
   | `refreshToken` (random, stored hashed) | yes | `/api/v1/auth` | 7 days |
   | `csrfToken` | **no** (the client echoes it) | `/` | 7 days |

   All `Secure` in production (`COOKIE_SECURE=false` is refused there) and `SameSite=Strict` by default
   (`COOKIE_SAMESITE`; `none` requires Secure). `COOKIE_DOMAIN` is optional for a shared parent domain.
   The web client stores only the user's profile (no secrets) as a UI hint.
2. **Rotating refresh families.** Each login is a session (`family`, the `sid`). `POST /auth/refresh`
   revokes the presented token and issues the next one in the family, and re-sets the access cookie
   (so `<video>` keeps playing). Re-presenting a rotated token is treated as theft and revokes the whole
   family, except within a 30 s window for two tabs refreshing at once. Indexes: `tokenHash` unique,
   `expiresAt` TTL, `family` (migration 0003). Logout revokes the family.
3. **CSRF: signed double-submit.** Token = `nonce.HMAC(CSRF_SECRET, sid.nonce)`. A cookie-authenticated
   `POST/PUT/PATCH/DELETE` must send `X-CSRF-Token` equal to the `csrfToken` cookie **and** valid for the
   session in its access token. Refresh/logout bind it to the refresh token's family. A token planted
   through a sibling subdomain or copied from another session fails the HMAC. `SameSite=Strict` is a second
   layer, not the only one. The token survives refreshes (in-flight requests keep working);
   `GET /auth/csrf` returns it after a reload when the cookie is on another host.
4. **Bearer stays for non-browser clients** (scripts, `infra/e2e.py`, tests): `Authorization: Bearer` is
   not cookie-authenticated, so it needs no CSRF token. They get the refresh token in the body only with
   `tokenTransport: 'body'`, and refresh/logout with `{ refreshToken }` in the body. The login body still
   carries the 15-minute access token for them; browsers ignore it.
5. **No tokens in URLs.** `?token=` is no longer accepted on any route. `<video>` and `<img>` (version
   files, avatars) authenticate with the cookie.
6. **Socket.IO** authenticates the handshake with the cookie (`withCredentials`). WebSockets are not
   covered by CORS, so a cookie handshake is accepted only from an allowlisted `Origin` (cross-site
   WebSocket hijacking). Refresh tokens are never accepted in the handshake: on `unauthorized` the client
   refreshes over REST and reconnects.

## Consequences
- Same-site deployment is assumed (one origin behind Caddy, or app/API on the same registrable domain).
  A cross-site API would need `COOKIE_SAMESITE=none` and is not recommended.
- A stolen 15-minute access token is not revocable before expiry (stateless JWT); logout and reuse
  detection end the session at the next refresh.
- Production needs `CSRF_SECRET` (>= 32 chars); the API refuses to start without it.

## Considered options
- **Access token in memory, refresh in a cookie:** lost on every reload (needs a refresh per page load)
  and still JS-readable while the page lives. Rejected for one cookie model.
- **Synchronizer token in the DB:** a DB read on every unsafe request. The HMAC-bound double submit gives
  the same session binding with no lookup.
- **SameSite alone:** not CSRF protection against same-site attackers (sibling subdomains), and `Lax`
  allows top-level GETs.
