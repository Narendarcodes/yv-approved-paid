# Go-live checklist: fair pay suite

What to do, in order, to ship `feat/fair-pay-suite` (the Fair Review Clock, crew payout batches, the payables board and the typed PayPal SDK adapter) to the hackathon demo. Nothing here touches live PayPal: the API stays on `PAYPAL_MODE=sandbox`.

Hosts today: API on Render (`https://yv-approved-paid-api.onrender.com`, deployed by hand), web on Vercel (`https://yv-approved-paid.vercel.app`, rewrites `/api` and `/socket.io` to the API), deal agent on Render (`render.yaml`, `yv-deals-agent`), MongoDB Atlas.

## 1. Merge to main

- [x] CI is green on `feat/fair-pay-suite` (gitleaks, API tests, web build, agent tests).
- [x] Open a PR into `main` and merge it (normal merge, no force-push).

## 2. Refill the PayPal sandbox pool first

Do this **before** the API deploy. The demo seed now funds **4 milestones** (reel 1 $400, reel 2 $300, reel 3 $400, reel 4 $150; reel 3 was $200 before the 70/30 team split), so every seed or demo reset takes **2 more pre-approved holds than before** (4 instead of 2). With too few ready rows, the new milestones fall back to labelled `SIM-` ids.

```bash
cd apps/api
node scripts/paypal-auth-pool.cjs status       # ready / used per amount
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... \
  node scripts/paypal-auth-pool.cjs create --amounts 40000,30000,20000,15000 --pairs 3
```

- [x] Approve each printed link as a sandbox **Personal** buyer whose country is **not India** (the US buyer used before). Use `claim <orderId>` if a return page did not load.
- [x] `status` shows ready rows for **all four** amounts (40000, 30000, 20000, 15000). Authorizations last 29 days; the pool skips rows with under 2 days left.

Details: [paypal-sandbox.md](paypal-sandbox.md#refilling-the-pool).

## 3. Render: manual deploy of the API

Add these env vars on the API service first (Render dashboard > the API service > Environment):

| Variable              | Value                                                | Why                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PAYPAL_CLIENT`       | `sdk` (or leave unset: `sdk` is the sandbox default) | Orders/Payments through the typed PayPal Server SDK. Set `rest` to stay on the adapter verified live on Nov 4                                                            |
| `PAYOUTS_MODE`        | `simulated`                                          | The India sandbox merchant gets `PAYOUT_NOT_AVAILABLE`. Use `real` only with a US Business sandbox account                                                               |
| `CLOCK_SHARED_SECRET` | 32+ random characters (secret)                       | Turns on `POST /api/v1/internal/clock/advance`. Only needed for the Render Workflow (step 5); without it the route is 404 and the Money Agent tick still runs the clocks |

Existing vars stay as they are (`PAYPAL_MODE=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `DEMO_MODE=1`, `MONGO_URI`, the agent vars).

- [x] Manual deploy of the latest `main` commit.
- [x] `GET https://yv-approved-paid-api.onrender.com/api/v1/health` answers OK (the free instance can take about a minute to wake).
- [x] The log shows the demo seed finished with no "did not complete" error.

## 3b. Brand Brain on the deal agent (done Nov 9, 2026)

Brand Brain chat (`POST /v1/chat`) now runs on the same lean `yv-deals-agent` service as the deal copilot, so the API keeps its single `AGENT_URL`. The agent cannot reach the API's private `/internal` listener on Render, so the API pushes the org's brand rules, posts, metrics and review comments with each chat call and the agent verifies the service token itself. Brand memory is an in-process index; the LLM is River -> NIM over plain httpx (no litellm, no Qdrant). Measured locally: about 42-46 MB RSS after chat calls, well inside the 512 MB free instance.

Set these, then redeploy both services:

| Service          | Variable              | Value                                                   | Why                                                                                     |
| ---------------- | --------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| API              | `SERVICE_JWT_SECRET`  | 32+ random characters (secret), **same value as agent** | Turns the agent routes on (`config.agent.enabled`); signs the per-chat service token    |
| API              | `AGENT_URL`           | the `yv-deals-agent` URL (already set)                  | Copilot and Brand Brain both use it                                                     |
| API              | `AGENT_SHARED_SECRET` | already set (same as agent)                             | Also sent on chat calls as `X-Agent-Secret`                                             |
| yv-deals-agent   | `SERVICE_JWT_SECRET`  | the same value as on the API (secret)                   | The agent verifies the chat token locally (HS256, iss `yv-api`, aud `yv-internal`)      |
| yv-deals-agent   | `LLM_MODEL`           | `chain`                                                 | Brand Brain uses the River -> NIM chain (`LLM_CHAIN`, `RIVER_*`, `NIM_*` already set)   |
| yv-deals-agent   | `LLM_TIMEOUT_S`       | `30` (optional; render.yaml has `12`)                   | Per-request httpx timeout; the first-token and stall caps below stop hangs sooner anyway |

Optional knobs (defaults are fine): agent `LLM_FIRST_TOKEN_S=12`, `LLM_DEADLINE_S=22` (no text by then: the answer lists the matching brand entries word for word), `LLM_STALL_S=10`, `LLM_ANSWER_MAX_S=45`, `LLM_MAX_TOKENS=400`; API `AGENT_CHAT_FIRST_BYTE_MS=30000` (no reply by then: "waking up" 504). The web gives up after 35 s of silence.

Check after deploy: `GET <agent>/health` shows `"chat": {"model": "chain", "configured": true}`; on the web, Brand Brain answers "What are our logo and colour rules?" with chips like "Brand hub · Logo and colour rules". The first call after the free instance sleeps can return the "waking up" message; ask again a minute later.

## 4. Vercel: deploy the web app

Build with the memory cap (the build host runs out of memory without it), copy the build into `work/webdist`, then deploy with `work/vercel_deploy.py` (it uploads `work/webdist` to the `yv-approved-paid` project as production; the token is injected on the wire, never written in the script).

```bash
cd apps/web
npm ci
NODE_OPTIONS=--max-old-space-size=1200 npx vite build
# keep work/webdist/vercel.json (the /api and /socket.io rewrites to the Render API)
rsync -a --delete --exclude vercel.json dist/ ../../../webdist/
cd ../../.. && python3 vercel_deploy.py      # prints id, url, readyState
```

- [x] `work/webdist/vercel.json` still rewrites `/api/*` and `/socket.io` to `https://yv-approved-paid-api.onrender.com`.
- [x] The deploy reports `READY` and `https://yv-approved-paid.vercel.app` serves the new build.

## 5. Optional: Render Workflow and cron for the clock

The clock already runs inside the API (Money Agent tick). The workflow is a second, observable driver with durable retries. It is code-only today; skip this step for the demo if time is short. **Not created (Nov 9, 2026):** Render Workflows have no free allowance (each run is billed by the second, `flex` $0.20/CPU-hour + $0.05/GB-hour, plus $0.25/GB state retention; see https://render.com/docs/workflows-limits), the Cron Job trigger is a paid service too, and the Hobby workspace has no card on file. Full guide: [workflows/fair-clock/README.md](../workflows/fair-clock/README.md).

- [ ] Render > **New > Workflow**, this repo, root `workflows/fair-clock`, build `npm ci && npm run build`, start `npm start`. Env: `API_URL=https://yv-approved-paid-api.onrender.com`, `CLOCK_SHARED_SECRET` (same value as the API).
- [ ] Render > **New > Cron Job**, root `workflows/fair-clock`, build `npm ci && npm run build`, command `npm run trigger`, schedule `*/15 * * * *`. Env: `RENDER_API_KEY`, `FAIR_CLOCK_WORKFLOW_SLUG`.
- [ ] Start one `advance-clocks` run by hand and check it succeeds (a 401 means the secrets differ; a 404 means `CLOCK_SHARED_SECRET` is unset on the API).

(The `type: workflow` / `type: cron` blocks in `render.yaml` are commented out; uncomment them instead if you deploy by Blueprint.)

## 6. Smoke tests

On `https://yv-approved-paid.vercel.app`:

- [x] **Try the demo** logs in and opens Lumen Coffee's "Autumn launch reels".
- [x] Reel 1: captured $400, ids tagged `PayPal sandbox` (not `simulated`) in the PayPal ids panel.
- [x] Reel 2: accept the 80% split; the Money Agent captures $240 and voids the rest.
- [x] Reel 3: review clock shows about 2 business days left. Reel 4: 50% released, in grace.
- [x] **Request changes** asks for a citation (a brief item or a failed check); sending one pauses the clock.
- [x] Team payout card shows one batch per release. With `PAYOUTS_MODE=real` (Nov 8) the receipts carry real batch ids, not **Simulated payout**.
- [x] **Payables:** type "held over $50 and in grace", chips appear; bulk approve opens the dry run; **Export CSV** downloads.
- [x] **Where's my money** lists the crew member's shares.
- [x] Copilot "capture $450" comes back blocked (`P3_amount`), "No money moved".
- [x] Checked on `api-m.sandbox.paypal.com` (Nov 8): captures COMPLETED, payout batches SUCCESS. This is the **first real check of the SDK path**.
- [x] `node scripts/paypal-auth-pool.cjs status` shows 4 fewer ready rows per seed/reset (one per amount).

## Rollback

- **SDK problem** (PayPal errors on capture or void after the deploy): set `PAYPAL_CLIENT=rest` on the API and restart. Orders and Payments go back to the REST adapter verified live on Nov 4. No code change, no redeploy of the web.
- **Anything else:** Render > the API service > redeploy the previous commit; Vercel > promote the previous production deployment.
- **Payout problem:** set `PAYOUTS_MODE=simulated` (batches recorded, no Payouts call). Full rollback to the pre-suite API: redeploy `928878b`, remove `PAYPAL_CREDENTIALS` (the India `PAYPAL_CLIENT_ID/SECRET` come back) and set `PAYOUTS_MODE=simulated`.

## Done on Nov 8, 2026 (go-live record)

- **Main:** `8917483` (fair pay suite + `PAYPAL_CREDENTIALS` boot split), then `bd9320d` (sandbox payout `sender_batch_id` scoped to the funding authorization, so a second demo reset in the same process no longer gets "Batch with given sender_batch_id already exists"). CI green on both.
- **Render env:** `PAYPAL_CREDENTIALS` (US sandbox app `APP-07J57849KD9337143`, overrides the old India `PAYPAL_CLIENT_ID/SECRET` at boot) and `PAYOUTS_MODE=real`. `PAYPAL_CLIENT` unset (`sdk`). `CLOCK_SHARED_SECRET` **not set** (step 5 skipped; the Money Agent tick drives the clock, and `/internal/clock/advance` stays 404).
- **Render deploys:** `dep-dbnnda3m8hqs73cn1p3g` (8917483, live 00:37 IST), `dep-dbnnqgjrjlhs739cbfj0` (bd9320d, live 01:05 IST).
- **Pool:** 24 orders created with the US app and approved by the US sandbox buyer (`sb-jjzj953715477@personal.example.com`); every return page said "ready", which also proves the deployed API holds the US credentials. The old India-app rows were re-checked by the seed and marked `invalid` on their own (no clean-up needed). Expiry of the new rows: Mon 7 Dec 2026 ~01:00 IST.
- **Vercel:** `dpl_EVLa4EBGg37VXGvvfwxzt9AK5BS2` (bundle `index-DBj1jEbZ.js`).
- **Real sandbox release on live (earlier seed, before the 70/30 team split):** reel 3 ($200 then) approved in the web app: capture `82250670EG2217747` ($200 COMPLETED), Payouts batch `UZ6D4CNLJWKUE` (SUCCESS). Seed batches: reel 1 `CY4K8FYX7WN68` ($280 + $120), reel 4 partial `EN7Y2GCJBUQ2Y` ($52.50 + $22.50). Items are UNCLAIMED because the demo crew emails are not sandbox accounts.
- **Smoke:** 14/14 browser checks passed (screenshots in the build workspace `work/fairpay-shots/live/`). Editor-only receipts were not checked on live (the seeded editor has no password there); covered by tests from `a93b2db`.

## Done on Nov 9, 2026 (Round 2 go-live)

- **Main:** merge commit `c7923fb` (`feat/polish-r2` at `a1f2c4e`, normal merge). CI green: https://github.com/Narendarcodes/yv-approved-paid/actions/runs/42552425195
- **Render env:** API `SERVICE_JWT_SECRET` was already set and kept; `yv-deals-agent` got `SERVICE_JWT_SECRET` (same value, carried in the browser, never printed), `LLM_MODEL=chain`, `LLM_TIMEOUT_S=30`. Agent builds from `main` with `services/agent/Dockerfile.deals`. `CLOCK_SHARED_SECRET` still unset (Workflow not created, see step 5).
- **Render deploys:** API `dep-dboj7ps9v7es73fenjag` (c7923fb, live ~08:16 IST), agent `dep-dboj8nc9v7es73feps50` (c7923fb, live 08:18 IST). `/api/v1/health` 200 with `db.connected`; agent `/health` shows `"chat": {"model": "chain", "configured": true}`.
- **Vercel:** `dpl_53h4SCiufRmTB8UjHwjVHb9S9MA7` (bundle `index-FLF516PM.js`), READY, aliased to `yv-approved-paid.vercel.app`. Previous: `dpl_EVLa4EBGg37VXGvvfwxzt9AK5BS2`.
- **Live checks (read-only, no approve/reset):** golive 12/12 PASS; demo login lands on the deal in ~3 s with the 13-step tour (13/13 anchored); Lumen Coffee, reels 1-4, $575.00 held; Brand Brain answered in 5.9 s with "Brand hub · Voice and tone / Logo and colour rules / Brief template"; Team chat #autumn-launch shows the seeded thread; payables 5 rows. Reel mp4s are served 200 `video/mp4` (H.264/AAC); playback was not provable in the test browser (headless shell has no H.264).
