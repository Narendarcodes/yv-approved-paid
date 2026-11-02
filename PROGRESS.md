# PROGRESS: yv. Approved = Paid (PayPal AI Hackathon)

Motto: **AI checks facts, people own taste, the deal decides the money.**

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
