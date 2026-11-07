# PayPal Server SDK (APIMatic) in Approved = Paid

The money calls that hold, capture, void and reauthorize a milestone's funds now go through the **PayPal Server SDK** (`@paypal/paypal-server-sdk` 2.5.x), which PayPal generates with [APIMatic](https://www.apimatic.io) from its OpenAPI specs. The hand-written REST adapter is still in the repo as a fallback and still carries the APIs the SDK does not cover.

Code: `apps/api/src/modules/deals/lib/paypal-sdk.cts` (SDK adapter), `lib/paypal-rest.cts` (REST adapter), `lib/gateway.cts` (the interface both implement), `paypal.cts` (`gatewayFromEnv`, `PAYPAL_CLIENT`).

## What moved to the typed SDK

| Gateway call | SDK method | PayPal endpoint |
|---|---|---|
| `createAuthorizeOrder` | `OrdersController.createOrder` (intent `AUTHORIZE`) | `POST /v2/checkout/orders` |
| `getOrder`, `getOrderDetail` | `OrdersController.getOrder` | `GET /v2/checkout/orders/{id}` |
| `authorizeOrder` | `OrdersController.authorizeOrder` | `POST /v2/checkout/orders/{id}/authorize` |
| `getAuthorization` | `PaymentsController.getAuthorizedPayment` | `GET /v2/payments/authorizations/{id}` |
| `capture` (partial and final) | `PaymentsController.captureAuthorizedPayment` | `POST /v2/payments/authorizations/{id}/capture` |
| `voidAuthorization` | `PaymentsController.voidPayment` | `POST /v2/payments/authorizations/{id}/void` |
| `reauthorize` | `PaymentsController.reauthorizePayment` | `POST /v2/payments/authorizations/{id}/reauthorize` |
| `refund` | `PaymentsController.refundCapturedPayment` | `POST /v2/payments/captures/{id}/refund` |

Why:

- **Typed request and response models.** `OrderRequest`, `CaptureRequest`, `Order`, `PaymentAuthorization`, `CapturedPayment` and the enums (`CheckoutPaymentIntent`, `PaypalWalletContextShippingPreference`, ...) are checked by `tsc`. A misspelt field such as `final_captur` or a `purchase_unit` without `amount` is a compile error, not a silent PayPal 400.
- **Built-in retries and timeouts.** The SDK retries 408, 429 and 5xx answers and timeouts with exponential backoff (we use 2 retries, 0.5 s doubling, a 10 s cap, 30 s per request). POST is retried too, which is safe here because every money write carries a `PayPal-Request-Id`, so PayPal answers a repeat with the first result instead of moving money twice.
- **Fewer hand-written JSON bugs.** The SDK maps camelCase models to PayPal's snake_case JSON, handles the OAuth client-credentials token and its refresh, and validates responses against the schema.

What did not change: the engine, the policy code, the sandbox wrapper (pool, simulated approval, request-id salting) and every result and error shape. The adapter passes our idempotency keys as the SDK's `paypalRequestId` (cut to PayPal's 108 characters, as before) and turns SDK errors into the same `GatewayError` the REST adapter throws: `code` is PayPal's `details[0].issue` (or `name`), `status` is the HTTP status, `details.debug_id` is kept. An OAuth failure is `AUTH_FAILED` (502). One small difference: when PayPal never answers (network down after retries) the SDK adapter throws `GatewayError PAYPAL_UNREACHABLE` (502), where the REST adapter let the raw fetch error through.

`apps/api/src/modules/deals/tests/paypal-contract.test.js` runs 19 scenarios (recorded sandbox answers where we have them, 422s, a 404, a 500 and an empty-bodied 503) through both adapters against the same stubbed PayPal and requires identical results, errors, `PayPal-Request-Id`s and JSON request bodies.

## What stays on REST, and why

| Gateway call | PayPal API | Why |
|---|---|---|
| `payout`, `createPayoutBatch` | Payouts v1 `POST /v1/payments/payouts` | Not in the PayPal Server SDK |
| `createInvoiceDraft`, `sendInvoice` | Invoicing v2 | Not in the PayPal Server SDK |
| `verifyWebhook`, `createWebhook`, `listWebhooks`, `deleteWebhook` | Notifications v1 | Not in the PayPal Server SDK |

The SDK 2.5 ships Orders, Payments, Vault, Subscriptions, Transaction Search and OAuth controllers only. The SDK adapter builds a REST adapter with the same credentials and delegates these calls to it, so a sandbox gateway on `PAYPAL_CLIENT=sdk` still sends payout batches and invoices exactly as before.

## Switching: `PAYPAL_CLIENT`

| `PAYPAL_MODE` | `PAYPAL_CLIENT` unset | `PAYPAL_CLIENT=sdk` | `PAYPAL_CLIENT=rest` |
|---|---|---|---|
| `mock` | mock (unchanged) | mock (ignored) | mock (ignored) |
| `sandbox` | **sdk** | sdk | REST adapter |
| `live` | REST adapter | sdk (never run against live) | REST adapter |

- The SDK only talks to `https://api-m.sandbox.paypal.com` or `https://api-m.paypal.com`. With any other `PAYPAL_API_BASE` an unset `PAYPAL_CLIENT` falls back to REST, and `PAYPAL_CLIENT=sdk` refuses to start.
- An unknown value (`PAYPAL_CLIENT=grpc`) refuses to start.
- Going back is one env change: `PAYPAL_CLIENT=rest`, then restart the API.

## What is verified

- Verified with stubs only: request mapping (paths, bodies, `PayPal-Request-Id`, `Prefer`), response mapping, error mapping, the retry on a 503 with the same request id, OAuth token reuse, and REST/SDK parity. The SDK's own HTTP client is used; only its transport is swapped for a stub in tests (`fetchImpl`, an axios adapter).
- **Not yet run against the real PayPal sandbox.** The live sandbox checks in [paypal-sandbox.md](paypal-sandbox.md) (Nov 4, 2026) were made with the REST adapter. The first real check for the SDK path is a demo reset on `PAYPAL_MODE=sandbox` with `PAYPAL_CLIENT` unset, then confirming the capture and void ids in the sandbox dashboard.

## AI-assisted coding

APIMatic recommends its Context Plugin for AI-assisted coding against the SDK:

```bash
npx context-plugins install paypal
```

It gives coding assistants the SDK's models and controllers as context. This migration did not use it: the adapter was written by reading the SDK package itself (its TypeScript sources in `node_modules/@paypal/paypal-server-sdk/src` and typings in `dist/cjs/types`).
