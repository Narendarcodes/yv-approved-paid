# PayPal sandbox: how Approved = Paid moves money

**AI checks facts, people own taste, the deal decides the money.**

This page covers what runs for real on the PayPal sandbox (`api-m.sandbox.paypal.com`), how the judge demo gets real holds without a PayPal login, how to refill that pool, and what is still simulated. No live money moves; `PAYPAL_MODE=live` is not used for the hackathon.

Code: `apps/api/src/modules/deals/paypal.cts` (mode switch), `lib/paypal-sandbox.cts` (sandbox gateway), `lib/paypal-sdk.cts` (Orders and Payments on the typed PayPal Server SDK, the sandbox default; see [apimatic.md](apimatic.md)), `lib/paypal-rest.cts` (hand-written REST calls: Payouts, Invoicing, Webhooks, and the `PAYPAL_CLIENT=rest` fallback), `pool.cts` (authorization pool), `demo.cts` (demo seed and reset), `lib/engine.cts` (Money Agent), `scripts/paypal-auth-pool.cjs` (pool refill).

## What is real and what is simulated

| Step | PayPal API | Status |
|---|---|---|
| Hold a milestone's funds | Orders v2 `POST /v2/checkout/orders` with `intent: AUTHORIZE` | **Real** |
| Buyer approval | PayPal approve page, a sandbox **Personal** account | **Real** (done ahead of time for the demo pool) |
| Authorize | `POST /v2/checkout/orders/{id}/authorize` | **Real** |
| Approve the video: capture the signed amount | `POST /v2/payments/authorizations/{id}/capture` | **Real** |
| Dispute split / kill fee: partial capture, then void the rest | `.../capture` with the agreed amount, then `POST /v2/payments/authorizations/{id}/void` | **Real** |
| Reject with nothing owed | `.../void` | **Real** |
| Keep a hold alive after the 3-day honor period | `POST /v2/payments/authorizations/{id}/reauthorize`, once per hold | **Real** |
| Change order | Invoicing v2: create, then **send** (`INV2-...`) | **Real** |
| Pay the editor and designer | Payouts `POST /v1/payments/payouts`, ONE batch per release (approve, partial, grace), `sender_batch_id` = `payout:<deal>:<milestone>:<step>` | **Real sandbox batches on the demo since Nov 8, 2026** (`PAYOUTS_MODE=real` on a US Business sandbox app; PayPal Sandbox only, no live money). Code default `PAYOUTS_MODE=simulated` records the batch (`SIM-BATCH-...`) and one "Simulated payout" ledger line + receipt per member without calling PayPal. If PayPal answers `PAYOUT_NOT_AVAILABLE` (as the earlier India sandbox merchant did), the batch is recorded as a labelled simulated batch with that error |
| Demo holds when the pool is empty | none | **Simulated, labelled.** `SIM-AUTH-<real order id>`, `SIM-CAPTURE-...` on an in-memory twin with PayPal's rules; every line says "PayPal sandbox: buyer approval simulated (pre-approved pool empty)" |

In the web app every id carries a tag, `PayPal sandbox` or `PayPal sandbox · simulated`, and the money timeline has a **PayPal ids** panel (authorization and capture ids per milestone).

### Verified live (Nov 4, 2026)

Checked directly on `api-m.sandbox.paypal.com` after a demo reset. These runs used the hand-written REST adapter; the PayPal Server SDK adapter (now the sandbox default) makes the same requests in the stubbed contract tests but has not been run against the real sandbox yet. Set `PAYPAL_CLIENT=rest` to go back to the verified path.

| Milestone | Authorization | PayPal result |
|---|---|---|
| Reel 1, approved | `75944066TD8606012` | Capture `6CX25059D6955990M`, $400.00 COMPLETED; authorization CAPTURED |
| Reel 2, dispute split (80%) | `7LJ85033A19963041` | Partial capture `8L3248257U421871X` ($240); authorization VOIDED (the remaining $60 released) |

## The flow

```
 sign terms (hash-locked, both parties)
   └─► fund the milestone: Orders v2 AUTHORIZE ─► buyer approves ─► authorize = HOLD
         ├─ client approves the version ─────────► capture the signed amount
         ├─ dispute split / kill fee ────────────► partial capture of the agreed share, then void the rest
         ├─ reject, nothing owed ────────────────► void
         └─ 3-day honor period passed, money still due ─► reauthorize (once)
 change order ─► Invoicing v2 invoice created and sent
 captured money ─► payouts by the signed split (simulated, see above)
```

- Every money move is dry-run through the policy engine first. Amounts come from the signed terms or the checklist arithmetic in Node (lines passed / lines signed × milestone amount, capped at what is held). No route takes an amount from an agent or a model.
- A split is agreed only when both sides accept the same number; the Money Agent then captures and voids on its next tick (it runs every 60 s).
- Each money move is appended to a hash-chained ledger, pushed live to the web over Socket.IO (`deal:ledger`).
- Idempotency: the PayPal-Request-Id on capture, void, reauthorize and refund is scoped to the PayPal object (commit `c47b0a8`), and a capture's `invoice_id` ends with its authorization id (commit `ff71cbd`). Before these fixes, a second demo reset in the same process replayed the previous capture, or PayPal refused it with `DUPLICATE_INVOICE_ID`.

## The judge demo: a pre-approved authorization pool

Judges should not need a sandbox buyer login, so the demo (`DEMO_MODE=1`, `PAYPAL_MODE=sandbox`) draws its holds from a pool of real authorizations that a sandbox buyer approved ahead of time.

- **Storage:** MongoDB collection `paypalauthpools` (`pool.cts`). A row exists only for an order PayPal itself reports as ours (`custom_id` starts with `yv-auth-pool`), intent `AUTHORIZE` and approved by a buyer.
- **Per seed:** one $400 authorization (reel 1) and one $300 authorization (reel 2), oldest first, each still valid for 2+ more days. Before use, the gateway re-checks each one with PayPal (status `CREATED`); a dead row is marked invalid and skipped.
- **Reboots:** an untouched real-sandbox demo deal is kept across API restarts, so a Render free-tier reboot doesn't use up a pair. A reboot can still use one when the stored demo has already been touched.
- **Reset:** `POST /api/v1/demo/deal/reset` (signed in as the demo judge; at most once every 2 minutes for everyone) rebuilds Lumen Coffee's "Autumn launch reels" on a fresh pair and answers `{ holds, real }`. **Each reset uses one pair.**
- **Empty pool:** the seed falls back to the labelled `SIM-` ids above. Nothing breaks; the timeline just says it is simulated.
- **Status:** `GET /api/v1/paypal/pool` returns ready/used counts per amount (no ids).
- `PAYPAL_SANDBOX_POOL=0` turns the pool off.

Non-demo deals don't use the pool: the **Fund** button creates a fresh order and shows the real "Approve in PayPal sandbox" link for anyone with their own sandbox buyer. The return page (`/deals/:id/fund/:key?paypal=approved`) authorizes it and stores the authorization id on the milestone.

## Refilling the pool

Sandbox only; the script refuses any other API base. Credentials come from the environment and are never printed. Never commit them.

1. **Create orders** (default: 3 pairs of $400 + $300, so 3 resets):

   ```bash
   cd apps/api
   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/paypal-auth-pool.cjs create --pairs 3
   ```

   Options: `--api <base>` (default the Render API), `--amounts 40000,30000` (minor units), `--pairs N` (max 10). It prints one approve link per order.

2. **Approve each link** as a sandbox **Personal** (buyer) account whose country is **not India**, and press Continue. Use a fresh browser session: sign in at `sandbox.paypal.com` first, then open the links. PayPal sends the buyer to `GET /api/v1/paypal/pool/return?token=<orderId>`, which verifies the order, authorizes it and answers that it is in the pool and ready.

3. **Claim** only if a return page did not load:

   ```bash
   node scripts/paypal-auth-pool.cjs claim <orderId> [<orderId> ...]
   ```

4. **Check:** `node scripts/paypal-auth-pool.cjs status` (or `GET /api/v1/paypal/pool`).

## Known limits

- **India buyer → India merchant fails.** A sandbox buyer registered in India gets `UNSUPPORTED_PAYEE_CURRENCY` ("This seller doesn't accept payments in your currency") on every order from this India merchant. A browser that still holds that buyer's PayPal session shows the same error before any login form. Approve with a buyer from another country (the pool was filled with a United States buyer).
- **Payouts (sandbox).** Since Nov 8, 2026 the demo sends real PayPal Sandbox Payouts batches from a US Business sandbox app (`PAYOUTS_MODE=real`; no live money). The notes below describe the earlier India app. Each release is one Payouts batch split by `splitCents` (floor per member, leftover cents to the lead). With `PAYOUTS_MODE=simulated` (default) no Payouts call is made; with `PAYOUTS_MODE=real` PayPal returns `PAYOUT_NOT_AVAILABLE` for this India sandbox merchant and the batch is recorded as `SIM-BATCH-...` with that error. A US sandbox Business account with `PAYOUTS_MODE=real` would send real sandbox batches.
- **Each reset uses a pair**, and so can some reboots. When `ready` reaches 0 the demo falls back to labelled `SIM-` ids until the pool is refilled.
- **Authorizations expire.** A PayPal authorization lasts 29 days: the first 3 are the honor period, and it can be reauthorized once after that. The pool skips rows with less than 2 days left.
- **Orphaned holds.** Holds from the runs before `c47b0a8`/`ff71cbd` stay AUTHORIZED in the sandbox until they expire. They move no money.
- **Sandbox only.** Live mode (`api-m.paypal.com`) exists in code but was not used for the hackathon.

## Configuration

| Variable | Meaning |
|---|---|
| `PAYPAL_MODE` | `mock` (in-memory PayPal with the real rules; tests and offline demo), `sandbox`, or `live` |
| `PAYPAL_CLIENT=sdk\|rest` | Which adapter makes the Orders/Payments calls. `sdk` (default when `PAYPAL_MODE=sandbox`): the APIMatic-generated PayPal Server SDK (`@paypal/paypal-server-sdk`), with typed models, retries and timeouts. `rest`: the hand-written fetch adapter (default on `live`, and the only choice with a custom `PAYPAL_API_BASE`). Payouts, Invoicing and webhook checks use REST either way. Ignored when `PAYPAL_MODE=mock` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox app REST credentials (developer.paypal.com > Apps & Credentials). Secrets: set them in the host's dashboard, never in the repo |
| `PAYPAL_WEBHOOK_ID` | Optional: verifies PayPal webhooks |
| `DEMO_MODE=1` | Judge demo: seeds the deal on boot, opens `POST /auth/demo-login` and `POST /demo/deal/reset`, and draws holds from the pool on sandbox |
| `PAYPAL_SANDBOX_POOL=0` | Turn the pool off (the demo then uses the labelled simulation) |
| `PAYOUTS_MODE=simulated\|real` | Crew payout batches: `simulated` (default) records them without calling PayPal; `real` sends them (PAYOUT_NOT_AVAILABLE still falls back to simulated) |
| `PAYPAL_SANDBOX_SIMULATE=1` | Sandbox outside `DEMO_MODE`: allow the pool and the labelled fallback (and simulated payouts) |

Tests never call real PayPal: `apps/api/src/modules/deals/tests/sandbox-pool.test.js` and `.../tests/sandbox-request-id.test.js` use a stateful fake. `.../tests/paypal-sdk.test.js` stubs the SDK's HTTP client, and `.../tests/paypal-contract.test.js` runs the same scenarios through both adapters and expects identical results, errors, request ids and bodies.
