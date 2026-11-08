# AGENTS.md

yv. turns a signed content deal into a payday the code keeps: brands fund each milestone with a PayPal hold, a review clock decides when it is released, and the crew is paid their signed shares.

## App map (web route → page → API module)

| Group | Route | Page (`apps/web/src/pages`) | API |
| --- | --- | --- | --- |
| Home | `/dashboard` | `DashboardPage` | `routes/projects`, `routes/organizations` |
| Create | `/projects`, `/projects/:id`, `/projects/:id/review` | `ProjectsPage`, `ProjectDetailPage`, `ReviewWorkspacePage` | `routes/projects` (tasks, reviews, brief) |
| Create | `/concepts` | `ConceptsPage` | `routes/concepts` |
| Create | `/review` | `ReviewPage` | `routes/projects` (reviews) |
| Create | `/brand-brain` | `BrandBrainPage` | `routes/agent` + Socket.IO |
| Publish | `/publishing/calendar`, `/publishing/compose`, `/publishing/channels` | `pages/publishing/*` | `routes/scheduling` |
| Publish | `/analytics`, `/reports/performance` | `AnalyticsPage`, `PerformanceReportPage` | `routes/analytics` |
| Money | `/deals`, `/deals/:dealId`, `/deals/:dealId/fund/:key` | `DealsPage`, `DealPage` | `modules/deals` |
| Money | `/payables` | `PayablesPage` (AG Grid, lazy) | `modules/deals/payables` |
| Money | `/my-money` | `MyMoneyPage` (lazy) | `modules/deals/team` |
| Money | `/invoices`, `/contracts` | `InvoicesPage`, `ContractsPage` | `routes/invoices`, `routes/contracts` |
| Team | `/my-work`, `/chat`, `/members` (admin) | `MyWorkPage`, `ChatPage`, `MembersPage` | `routes/projects` (tasks, chat), `routes/users` |
| Top bar / avatar menu | `/notifications`, `/profile`, `/settings` (admin) | `NotificationsPage`, `ProfilePage`, `SettingsPage` | `routes/notifications`, `routes/users`, `routes/organizations` |
| Public | `/`, `/login`, `/register`, `/forgot-password` | `LandingPage`, `LoginPage`, … | `routes/auth` |

Nav lives in `apps/web/src/layouts/AppShell.tsx` (grouped by job, role-gated).

Deal page: `DealPage` = one-line header + `ReelRail` + `ReelPanel` (components/deals). The URL holds the view: `/deals/:id?reel=reel3&open=checks,payout,changes,money,terms` (or `open=all`), so tests and agents deep-link instead of scrolling. Cards inside a `DealSection` render frameless via the `BareCards` context. Empty states, auth panels, the landing, the 404 and the Paid moment use `<Illustration name=… />` (8 unDraw SVGs in `apps/web/public/illustrations`); keep them off working screens. Design tokens: `apps/web/src/styles/tokens.css` only. The deal copilot is `services/agent` (FastAPI). The clock workflow is `workflows/fair-clock`.

## Money rules (never break)

- The AI never sets an amount or a verdict. Every amount comes from the signed terms and is computed in Node; agent requests that carry an amount are refused (`ai_amount_refused`).
- Every money move is dry-run through the policy engine first (rules P1 to P9). A blocked attempt is written to the ledger as "No money moved".
- Only the Money Agent executes money moves; big captures and every refund wait for one human tap.
- Taste is decided by people and capped by the signed rounds; machine checks decide facts only.
- The ledger is hash-chained and append-only.

## Tests and smoke run

```bash
cd apps/api && npx jest --runInBand        # API: Jest + mongodb-memory-server, no real PayPal
cd apps/web && npm test                    # web: payables filter parser
npm run typecheck                          # repo root: web + API tsc --noEmit
cd apps/web && npx vite build              # web build (CI runs tsc -b && vite build)
cd services/agent && python -m pytest -q   # deal agent
```

Smoke run (local): API with `DEMO_MODE=1 PAYPAL_MODE=mock npm run dev`, web with `npm run dev`, then `/login` → "Try the demo". Check: `/deals/deal_demo_diwali` (Lumen Coffee, "Autumn launch reels"; the id is kept from an earlier demo) shows reels 1 to 4 in the rail and `?open=money` shows the money timeline; the copilot answers "Capture $450 on reel 1" with "No money moved"; `/payables` loads its grid and exports CSV; `/my-money` loads.

## Never do

- Change money logic (capture, void, payouts, the review clock, policy rules) without an explicit owner request.
- Let a model produce an amount, a share or a verdict.
- Commit secrets, PayPal credentials or `.env` files.
- Approve, reset or move money on the live demo while testing.
- Force-push, merge or deploy without the owner's yes.
- Remove a route or module; group navigation instead.
- Add a colour, font size, spacing or radius outside `styles/tokens.css`.
