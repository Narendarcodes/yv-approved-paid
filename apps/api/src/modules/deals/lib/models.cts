/**
 * Mongo persistence for deals.
 *
 *   Deal          one document per deal: the whole DealDoc in `doc`, plus a few
 *                 indexed copies (org, parties, PayPal ids) for lookups, and a
 *                 `rev` counter for optimistic concurrency, so two Money Agent
 *                 ticks can never both act on the same version of a deal.
 *   DealLedger    append-only money ledger. Updates and deletes are refused at
 *                 the model level; (dealId, seq) is unique, so two writers
 *                 cannot both append entry n.
 *   PaypalWebhook every webhook event id we accepted (dedup: PayPal retries).
 *   PaypalAuthPool sandbox only: real PayPal authorizations a sandbox buyer approved
 *                 ahead of time, so the judge demo can hold real money without a
 *                 buyer login (pool.cts). One row per order; a row is used once.
 */
const mongoose = require('mongoose');

const { Schema } = mongoose;

const dealSchema = new Schema(
  {
    _id: { type: String },
    orgId: { type: String, required: true, index: true },
    clientUserId: { type: String, required: true, index: true },
    workerUserId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    /** Order + authorization ids of every milestone, for webhook lookups. */
    paypalIds: { type: [String], default: [], index: true },
    /** True while some milestone may still need a money move (the tick loop only reads these). */
    active: { type: Boolean, default: true, index: true },
    rev: { type: Number, default: 0 },
    lockUntil: { type: Number },
    lockToken: { type: String },
    doc: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true, minimize: false, versionKey: false },
);

const ledgerSchema = new Schema(
  {
    dealId: { type: String, required: true },
    orgId: { type: String, required: true, index: true },
    milestoneKey: { type: String, required: true },
    seq: { type: Number, required: true },
    type: { type: String, required: true },
    amountMinor: { type: Number, required: true },
    currency: { type: String, required: true },
    moved: { type: Boolean, required: true },
    paypalRef: String,
    idempotencyKey: String,
    actor: { type: String, required: true },
    explanation: { type: String, required: true },
    policy: { type: Schema.Types.Mixed },
    at: { type: String, required: true },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },
  },
  { versionKey: false, minimize: false },
);
ledgerSchema.index({ dealId: 1, seq: 1 }, { unique: true });

function refuse(this: unknown) {
  throw Object.assign(new Error('the money ledger is append-only'), {
    status: 409,
    code: 'ledger_append_only',
  });
}
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'findOneAndRemove',
]) {
  ledgerSchema.pre(op, refuse);
}
ledgerSchema.pre('save', function (this: { isNew: boolean }, next: (e?: Error) => void) {
  if (!this.isNew)
    return next(
      Object.assign(new Error('the money ledger is append-only'), {
        status: 409,
        code: 'ledger_append_only',
      }),
    );
  next();
});

const webhookSchema = new Schema(
  {
    _id: { type: String }, // PayPal event id
    eventType: { type: String, required: true },
    resourceId: String,
    dealId: String,
    receivedAt: { type: Date, default: Date.now },
    outcome: String,
  },
  { versionKey: false },
);

const authPoolSchema = new Schema(
  {
    _id: { type: String }, // PayPal order id
    authorizationId: { type: String, required: true },
    amountMinor: { type: Number, required: true },
    currency: { type: String, required: true },
    status: { type: String, enum: ['ready', 'used', 'invalid'], default: 'ready', index: true },
    authorizedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    claimedAt: { type: Date, default: Date.now },
    usedBy: String,
    usedAt: Date,
    note: String,
  },
  { versionKey: false },
);
authPoolSchema.index({ status: 1, amountMinor: 1, currency: 1, authorizedAt: 1 });

const Deal = mongoose.models.Deal || mongoose.model('Deal', dealSchema);
const DealLedger = mongoose.models.DealLedger || mongoose.model('DealLedger', ledgerSchema);
const PaypalWebhook =
  mongoose.models.PaypalWebhook || mongoose.model('PaypalWebhook', webhookSchema);

const PaypalAuthPool =
  mongoose.models.PaypalAuthPool || mongoose.model('PaypalAuthPool', authPoolSchema);

module.exports = { Deal, DealLedger, PaypalWebhook, PaypalAuthPool };
