/**
 * The PayPal boundary. Both adapters (mock and sandbox REST) implement this
 * interface, so every test that passes on the mock is re-run against the
 * sandbox once credentials exist. Amounts cross this boundary in minor units.
 */

export type OrderResult = { orderId: string; status: string; approveUrl?: string };
export type AuthorizationResult = {
  authorizationId: string;
  status: string; // CREATED | CAPTURED | PARTIALLY_CAPTURED | VOIDED | EXPIRED | DENIED | PENDING
  amountMinor: number;
  createdAt: string;
  expiresAt?: string;
};
export type CaptureResult = { captureId: string; status: string; amountMinor: number; finalCapture: boolean };
export type SimpleResult = { id: string; status: string };
export type PayoutBatchResult = { batchId: string; status: string };

export type PaymentGateway = {
  name: 'mock' | 'paypal-sandbox' | 'paypal-live';
  createAuthorizeOrder(input: {
    amountMinor: number;
    currency: string;
    referenceId: string;
    customId: string;
    description: string;
    returnUrl: string;
    cancelUrl: string;
    requestId: string;
  }): Promise<OrderResult>;
  getOrder(orderId: string): Promise<{ orderId: string; status: string; authorizationId?: string }>;
  authorizeOrder(orderId: string, requestId: string): Promise<AuthorizationResult>;
  getAuthorization(authorizationId: string): Promise<AuthorizationResult>;
  reauthorize(authorizationId: string, requestId: string): Promise<AuthorizationResult>;
  capture(
    authorizationId: string,
    input: { amountMinor: number; currency: string; finalCapture: boolean; invoiceId?: string; note?: string; requestId: string },
  ): Promise<CaptureResult>;
  voidAuthorization(authorizationId: string, requestId: string): Promise<SimpleResult>;
  refund(captureId: string, input: { amountMinor: number; currency: string; note?: string; requestId: string }): Promise<SimpleResult>;
  payout(input: {
    senderBatchId: string;
    items: { email: string; amountMinor: number; currency: string; note: string; senderItemId: string }[];
    emailSubject: string;
  }): Promise<SimpleResult>;
  /**
   * One PayPal Payouts batch (POST /v1/payments/payouts). senderBatchId is the
   * release's idempotency key; PayPal refuses a second batch with the same
   * sender_batch_id, and the same key is sent as PayPal-Request-Id.
   */
  createPayoutBatch(input: {
    senderBatchId: string;
    emailSubject?: string;
    items: { receiver: string; amountCents: number; currency: string; note: string; senderItemId: string }[];
  }): Promise<PayoutBatchResult>;
  createInvoiceDraft(input: {
    currency: string;
    invoiceNumber?: string;
    note: string;
    recipientEmail?: string;
    items: { name: string; description?: string; quantity: number; unitAmountMinor: number }[];
    requestId: string;
  }): Promise<SimpleResult & { href?: string }>;
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean>;
};

class GatewayError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, message: string, status = 422, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

module.exports = { GatewayError };
