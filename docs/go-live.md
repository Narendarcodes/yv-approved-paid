# Go-live checklist: fair pay suite

What to do, in order, to ship `feat/fair-pay-suite` (the Fair Review Clock, crew payout batches, the payables board and the typed PayPal SDK adapter) to the hackathon demo. Nothing here touches live PayPal: the API stays on `PAYPAL_MODE=sandbox`.

Hosts today: API on Render (`https://yv-approved-paid-api.onrender.com`, deployed by hand), web on Vercel (`https://yv-approved-paid.vercel.app`, rewrites `/api` and `/socket.io` to the API), deal agent on Render (`render.yaml`, `yv-deals-agent`), MongoDB Atlas.

## 1. Merge to main

- [ ] CI is green on `feat/fair-pay-suite` (gitleaks, API tests, web build, agent tests).
- [ ] Open a PR into `main` and merge it (normal merge, no force-push).

## 2. Refill the PayPal sandbox pool first

Do this **before** the API deploy. The demo seed now funds **4 milestones** (reel 1 $400, reel 2 $300, reel 3 $200, reel 4 $150), so every seed or demo reset takes **2 more pre-approved holds than before** (4 instead of 2). With too few ready rows, the new milestones fall back to labelled `SIM-` ids.

```bash
cd apps/api
node scripts/paypal-auth-pool.cjs status       # ready / used per amount
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... \
  node scripts/paypal-auth-pool.cjs create --amounts 40000,30000,20000,15000 --pairs 3
```

- [ ] Approve each printed link as a sandbox **Personal** buyer whose country is **not India** (the US buyer used before). Use `claim <orderId>` if a return page did not load.
- [ ] `status` shows ready rows for **all four** amounts (40000, 30000, 20000, 15000). Authorizations last 29 days; the pool skips rows with under 2 days left.

Details: [paypal-sandbox.md](paypal-sandbox.md#refilling-the-pool).

## 3. Render: manual deploy of the API

Add these env vars on the API service first (Render dashboard > the API service > Environment):

| Variable              | Value                                                | Why                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PAYPAL_CLIENT`       | `sdk` (or leave unset: `sdk` is the sandbox default) | Orders/Payments through the typed PayPal Server SDK. Set `rest` to stay on the adapter verified live on Nov 4                                                            |
| `PAYOUTS_MODE`        | `simulated`                                          | The India sandbox merchant gets `PAYOUT_NOT_AVAILABLE`. Use `real` only with a US Business sandbox account                                                               |
| `CLOCK_SHARED_SECRET` | 32+ random characters (secret)                       | Turns on `POST /api/v1/internal/clock/advance`. Only needed for the Render Workflow (step 5); without it the route is 404 and the Money Agent tick still runs the clocks |

Existing vars stay as they are (`PAYPAL_MODE=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `DEMO_MODE=1`, `MONGO_URI`, the agent vars).

- [ ] Manual deploy of the latest `main` commit.
- [ ] `GET https://yv-approved-paid-api.onrender.com/api/v1/health` answers OK (the free instance can take about a minute to wake).
- [ ] The log shows the demo seed finished with no "did not complete" error.

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

- [ ] `work/webdist/vercel.json` still rewrites `/api/*` and `/socket.io` to `https://yv-approved-paid-api.onrender.com`.
- [ ] The deploy reports `READY` and `https://yv-approved-paid.vercel.app` serves the new build.

## 5. Optional: Render Workflow and cron for the clock

The clock already runs inside the API (Money Agent tick). The workflow is a second, observable driver with durable retries. It is code-only today; skip this step for the demo if time is short. Full guide: [workflows/fair-clock/README.md](../workflows/fair-clock/README.md).

- [ ] Render > **New > Workflow**, this repo, root `workflows/fair-clock`, build `npm ci && npm run build`, start `npm start`. Env: `API_URL=https://yv-approved-paid-api.onrender.com`, `CLOCK_SHARED_SECRET` (same value as the API).
- [ ] Render > **New > Cron Job**, root `workflows/fair-clock`, build `npm ci && npm run build`, command `npm run trigger`, schedule `*/15 * * * *`. Env: `RENDER_API_KEY`, `FAIR_CLOCK_WORKFLOW_SLUG`.
- [ ] Start one `advance-clocks` run by hand and check it succeeds (a 401 means the secrets differ; a 404 means `CLOCK_SHARED_SECRET` is unset on the API).

(The `type: workflow` / `type: cron` blocks in `render.yaml` are commented out; uncomment them instead if you deploy by Blueprint.)

## 6. Smoke tests

On `https://yv-approved-paid.vercel.app`:

- [ ] **Try the demo** logs in and opens "Diwali launch reels".
- [ ] Reel 1: captured $400, ids tagged `PayPal sandbox` (not `simulated`) in the PayPal ids panel.
- [ ] Reel 2: accept the 80% split; the Money Agent captures $240 and voids the rest.
- [ ] Reel 3: review clock shows about 2 business days left. Reel 4: 50% released, in grace.
- [ ] **Request changes** asks for a citation (a brief item or a failed check); sending one pauses the clock.
- [ ] Team payout card shows one batch with receipts labelled **Simulated payout**.
- [ ] **Payables:** type "held over $50 and in grace", chips appear; bulk approve opens the dry run; **Export CSV** downloads.
- [ ] **Where's my money** lists the crew member's shares.
- [ ] Copilot "capture $450" comes back blocked (`P3_amount`), "No money moved".
- [ ] In the PayPal sandbox dashboard, the new capture and void ids exist. This is the **first real check of the SDK path**.
- [ ] `node scripts/paypal-auth-pool.cjs status` shows 4 fewer ready rows (one per amount).

## Rollback

- **SDK problem** (PayPal errors on capture or void after the deploy): set `PAYPAL_CLIENT=rest` on the API and restart. Orders and Payments go back to the REST adapter verified live on Nov 4. No code change, no redeploy of the web.
- **Anything else:** Render > the API service > redeploy the previous commit; Vercel > promote the previous production deployment.
- Payouts stay simulated either way (`PAYOUTS_MODE=simulated`).
