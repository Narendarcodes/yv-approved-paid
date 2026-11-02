# PROGRESS: yv. Approved = Paid (PayPal AI Hackathon)

Motto: **AI checks facts, people own taste, the deal decides the money.**

## Real PayPal sandbox (Nov 3, 2026)

`PAYPAL_MODE=sandbox` now runs the demo on the real PayPal sandbox (app `APP-7ML73805E1390660U`). Mock mode is unchanged.

| What | Where | Commit |
|---|---|---|
| Sandbox gateway: real Orders v2 (intent `AUTHORIZE`), real Invoicing v2 invoice created **and sent** (`INV2-...`, UNPAID in the sandbox). Demo only (`DEMO_MODE=1`): buyer approval of the hold is simulated (no sandbox buyer can log in from here), so authorization / capture / void after the real order are `SIM-` ids on an in-memory twin with PayPal's rules, labelled "PayPal sandbox: buyer approval simulated" on the ledger. Payouts are tried for real; the sandbox account's country gets `PAYOUT_NOT_AVAILABLE`, recorded as `SIM-PAYOUT-...` with that error. PayPal-Request-Id is salted per boot in demo mode so a reseed does not replay last boot's invoice. | `modules/deals/lib/paypal-sandbox.cts`, `lib/paypal-rest.cts` (`sendInvoice`), `paypal.cts`, `demo.cts`, `server.js`, `lib/engine.cts`, `lib/explain.cts`, `tests/paypal-sandbox.test.js` | `a5e357d` |
| Web: every money-timeline line shows its PayPal id with a tag (`PayPal sandbox`, `PayPal sandbox · simulated`, or `mock`); sandbox change-order invoices read "Invoice sent" / "Sent · not paid yet". | `components/deals/common.tsx`, `MoneyTimeline.tsx`, `ChangeOrderCard.tsx`, `pages/InvoicesPage.tsx`, `DealPage.tsx`, `lib/deals.ts` | `beeb2dd` |

Verified from the build sandbox against `api-m.sandbox.paypal.com`: OAuth token for the app; order `6HK390168K880724C` (PAYER_ACTION_REQUIRED) -> `SIM-AUTH-6HK390168K880724C` -> `SIM-CAPTURE-0001` -> void; payout refused `PAYOUT_NOT_AVAILABLE` -> `SIM-PAYOUT-0002`; invoice `INV2-LZDF-QZ68-R845-7BJY` created and sent.

Not real (and labelled so): buyer approval, the authorization/capture that depends on it, and payouts (sandbox account country).

## Phase 4 backend (Nov 2, 2026): done

All six backend gaps from `docs/phase4-ui-plan.md` section 5 are closed. Every change goes through the existing deal service (per-deal lock, policy engine, hash-chained ledger); no route takes an amount from an agent, and no test calls real PayPal (mock gateway everywhere).

| # | What | Where | Commit |
|---|---|---|---|
| 1 | Review Agent + Scope & Dispute Agent proposals stored on the milestone. `POST /internal/deals/:id/milestones/:key/review` and `.../dispute-proposal` (service JWT, `deals:propose`). Each is dry-run through policy **before** it is saved; the stored proposal keeps `decision { allowed, violations, needsHumanApproval, assumed }`. The split is computed in Node (passed / total signed check lines x milestone amount, capped at what is held); any amount-like field from an agent is refused (`ai_amount_refused`). Shown in `GET /deals/:dealId` (`milestones[].proposals.review / .dispute`) and the agents' `GET /internal/deals/:id`. Cross-org token -> 404, nothing stored. | `modules/deals/lib/proposals.cts` (`storeReview`, `storeDispute`), `lib/service.cts` (`storeProposal`), `internal.cts`, `lib/types.cts` | `8fbb31d` |
| 2 | Evidence screenshot route `GET /organizations/:org/deals/:dealId/evidence/:file`: signed in, party or `deal.manage`, org-scoped; serves only image names this deal's stored check results reference; strict filename pattern; real-path containment in `DEALS_EVIDENCE_DIR` (flat or `<dir>/<dealId>/`), symlinks out are refused; 404 for everything else. | `modules/deals/lib/evidence.cts`, `http.cts` | `9bd8d2c` |
| 3 | `apps/api/scripts/seed-deal-demo.cjs` (`npm run seed:deals`), built on the new `modules/deals/demo.cts` entry point. Mock gateway only, fixed id `deal_demo_diwali`, idempotent (rebuilds that one deal + its ledger rows). States: reel 1 held -> v1 fails loudness at -20.1 LUFS with frames -> review merge ("too quiet" = Fix on `loud`, "more festive" = Taste) -> changes requested -> $60 change order (+15 s, rate card), accepted, invoice drafted -> v2 passes -> $400 captured, paid 70/30 -> blocked `P3_amount` ($450) and `P6_version` (old v1) attempts on the ledger, no money moved. Reel 2 held -> 4/5 checks (no captions) -> dispute -> 80% ($240) proposed, editor accepted, client tap left. | `modules/deals/demo.cts`, `scripts/seed-deal-demo.cjs` | `573e8a6` |
| 4 | `POST /api/v1/auth/demo-login`: 404 unless `DEMO_MODE=1`; per-IP limit (`AUTH_DEMO_IP_MAX`, default 20 / 15 min); logs in as the seeded judge through the normal cookie session + CSRF; returns `demo { dealId, organizationId }`; 503 `demo_not_seeded` before seeding. With `DEMO_MODE=1` + `PAYPAL_MODE=mock` the API seeds the demo in-process on boot, so the mock that holds the authorizations is the one the Money Agent uses when the judge clicks. | `controllers/auth.controller.js`, `routes/auth.js`, `middleware/authRateLimit.js`, `services/auth.service.js` (`startSession`), `config/index.js`, `server.js` | `2715f03` |
| 5 | Socket.IO room `deal:<id>`: `deal:join { dealId }` after the org-membership + party/`deal.manage` check (`not_found` otherwise), `deal:leave`; every ledger append is pushed as `deal:ledger { dealId, entry }`. | `modules/deals/events.cts` (new entry), `lib/service.cts` (emit on append), `realtime/socket.js`, `modules/access/index.cts` (`permissionsIn`) | `fce932f` |

### Tests

- API jest: **570 passed, 1 skipped** (571) locally, up from 539 / 1 skipped. New: `deals/tests/agent-proposals.test.js` (10), `deals/tests/evidence.test.js` (7), `deals/tests/demo-seed.test.js` (6), `tests/demo-login.test.js` (4), `tests/deal-socket.test.js` (3), plus the new route in the `tests/cross-org.test.js` matrix (1).
- `services/agent` pytest: untouched in this phase.
- Typecheck (`tsc --noEmit`) and `npm run lint:boundaries` (dependency-cruiser) clean; eslint has no errors (two `no-console` warnings in the seed CLI, like the other seed scripts).
- Local note: under heavy sandbox load some suites hit Jest's 5 s hook timeout; they pass with `--testTimeout=30000` and are unaffected in CI.

### Running the judge demo

```
cd apps/api
DEMO_MODE=1 PAYPAL_MODE=mock npm run dev      # seeds "Diwali launch reels" on boot
curl -X POST localhost:3000/api/v1/auth/demo-login -c jar.txt   # judge cookie session
```

## Next phase (not started)

- **CopilotKit generative-UI cards in `apps/web`** (DealCard, LiveChecksCard, ReviewMergeCard, MoneyTimeline, ChangeOrderCard, DisputeSplitCard, PolicyBlockedChip), the `/deals` pages, the "Try the demo" button on `/login` calling `/auth/demo-login`, the MoneyTimeline subscribing to `deal:join` / `deal:ledger`, and the CopilotKit runtime route (section 4 of the plan).
- Python side: `services/agent/app/deals/node_deals.py` should post Review / Scope & Dispute output to the two new internal routes (the dispute call must send no `workerMinor`; Node computes it).
- `contracts/`: a `deal.schema.json` so web and API share the deal view types (plan section 2).

## Phase 4 frontend (Nov 2, 2026): done, CopilotKit packages deferred

Motto on every new screen: **AI checks facts, people own taste, the deal decides the money.** Amounts on screen come only from the deal doc and the ledger the API returns; no UI logic computes or picks a money amount.

| # | What | Where | Commit |
|---|---|---|---|
| 1 | `deal.schema.json` (DealView, terms, milestones, proposals, change orders, ledger entry/view/totals, `deal:ledger` push). `gen-ts.js` now declares a schema's local `definitions` (once each), so web/API get every Deal* type; Pydantic `deal_schema.py` for the agent. Drift check green. | `contracts/schemas/deal.schema.json`, `contracts/gen-ts.js`, generated `types.d.ts` x2, `services/agent/app/contracts/deal_schema.py` | `4bf93db` |
| 2 | `/deals` list and `/deals/:dealId` page (+ `/deals/:dealId/fund/:key` PayPal return -> `fund/confirm`), "Deals" in the Business nav. Cards: DealCard, LiveChecksCard (evidence thumbnails via the evidence route, version tabs so v1's loudness fail stays visible), ReviewMergeCard, MoneyTimeline (`deal:join` + `deal:ledger`, totals recomputed like `ledger.totals()`, chain badge, blocked lines with rule chips + "No money moved", one-tap release for pending approvals), ChangeOrderCard, DisputeSplitCard, PolicyBlockedChip. Deal states added to `STAGE_OF` / status labels. Typed deal calls in `services/api.ts`, React Query hooks in `lib/deals.ts`. | `apps/web/src/pages/Deal*.tsx`, `components/deals/*`, `lib/deals.ts` | `67c6be5` |
| 3 | "Try the demo" on `/login`: `POST /auth/demo-login`, remembers the demo org, lands on `/deals/deal_demo_diwali`; on 404 the button hides and says the demo is off. | `pages/LoginPage.tsx`, `services/api.ts` (`demoLogin`) | `2c9bc96` |
| 4 | Deal copilot panel (generative UI): actions `showDeal`, `showChecks`, `showReviewMerge`, `showMoneyTimeline`, `showChangeOrder`, `showDisputeSplit`, `showBlocked`, `proposeCapture` (read-only `policy-check` dry-run; blocked -> PolicyBlockedChip). Offline replay (deterministic intent match + suggested prompts), no LLM call. **CopilotKit packages not added** (weight + audit risk, see plan section 4 "As built"); the actions map 1:1 onto `useCopilotAction` later. | `lib/copilot.tsx`, `components/deals/DealCopilot.tsx` | `55f44c7` |
| 5 | `node_deals.py`: Review merge stored via `POST /internal/deals/:id/milestones/:key/review` (items, contradictions mapped onto merged items, rationale); Scope & Dispute proposal via `.../dispute-proposal` with **no amount** (`versionId`/`notes` only; amount-like keys refused before sending). Both still `for_human`. | `services/agent/app/deals/node_deals.py`, `agents.py` (`merged_from`), `tests/test_deals_node_wiring.py` | `34b8fff` |

### Tests / checks

- `services/agent` pytest: 58 passed, 2 skipped locally (4 new wiring tests; the review test now expects the stored merge).
- `apps/web`: `tsc -b`, eslint (0 errors) and `vite build` clean locally. No web test runner exists in the repo; the copilot intent matcher was smoke-checked against the eight suggested prompts.
- API: untouched in this phase except the copied `contracts/schemas/deal.schema.json` (ajv loads it with `strict: false`).
- Not verified in a browser: no headless browser in the build sandbox. First thing to click: `DEMO_MODE=1 PAYPAL_MODE=mock` API + web dev, "Try the demo".

### Left

- CopilotKit runtime/packages and the LLM path (`/deals/:dealId/copilot` -> agent `llm_router` River -> NIM -> OmniRoute) are not wired; the copilot runs offline only.
- No web unit/e2e tests for the cards.
