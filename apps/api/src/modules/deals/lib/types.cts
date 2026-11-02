/** Shared types for the deals module (types only; erased at runtime). */

export type Role = 'client' | 'worker' | 'system' | 'reviewer';

export type MilestoneState =
  | 'DRAFT'
  | 'SIGNED'
  | 'FUNDED'
  | 'STYLE_SAMPLE'
  | 'SUBMITTED'
  | 'CHECKS'
  | 'IN_REVIEW'
  | 'CHANGES_REQUESTED'
  | 'APPROVED'
  | 'AUTO_APPROVED'
  | 'CAPTURED'
  | 'PAID_OUT'
  | 'KILLED'
  | 'CANCELLED'
  | 'DISPUTED';

export type Party = {
  role: 'client' | 'worker';
  userId: string;
  displayName: string;
  country?: string;
  /** PayPal email for payouts (worker side). */
  paypalEmail?: string;
};

export type Measure = {
  /** e.g. duration_s, cut_interval_s, hook_by_s, loudness_lufs, logo_present, caption_present, aspect_ratio, resolution_p */
  metric: string;
  op: '<=' | '>=' | '==' | 'between' | 'present' | 'absent';
  value?: number | string;
  max?: number;
  unit?: string;
  /** Optional window, e.g. logo must be present in [0, 3] seconds. */
  window?: [number, number];
};

export type ChecklistItem = {
  id: string;
  text: string;
  /** check = machine-verifiable; taste = a human judgement (never blocks pay on its own). */
  kind: 'check' | 'taste';
  measure?: Measure;
  /** Words from the brief this line was derived from ("punchy"). */
  source?: string;
};

export type Payee = { userId: string; email: string; shareBp: number; displayName?: string };

export type MilestoneTerms = {
  key: string;
  title: string;
  amountMinor: number;
  dueAt: string; // ISO
  graceHours: number;
  reviewWindowHours: number;
  revisionRoundsIncluded: number;
  styleSample: boolean;
  checklist: ChecklistItem[];
  payees: Payee[];
};

export type RateCardItem = { id: string; label: string; unit: string; unitPriceMinor: number };

export type DealTerms = {
  title: string;
  currency: string;
  client: Party;
  worker: Party;
  milestones: MilestoneTerms[];
  rateCard: RateCardItem[];
  /** Kill fee in basis points of the milestone amount (2500 = 25%). */
  killFeeBp: number;
  /** Captures above this need one human tap. Refunds always do. */
  humanApprovalThresholdMinor: number;
  references?: string[];
  styleChoices?: Record<string, string>;
};

export type Signature = { party: 'client' | 'worker'; userId: string; termsHash: string; at: string };

export type Funding = {
  orderId?: string;
  approveUrl?: string;
  authorizationId?: string;
  authorizedMinor?: number;
  authorizedAt?: string;
  honorExpiresAt?: string;
  expiresAt?: string;
  reauthorizations?: { authorizationId: string; at: string }[];
  status: 'CREATED' | 'APPROVED' | 'AUTHORIZED' | 'PARTIALLY_CAPTURED' | 'CAPTURED' | 'VOIDED' | 'EXPIRED';
};

export type Version = {
  id: string;
  sha256: string;
  submittedAt: string;
  checks?: {
    reportId: string;
    passed: boolean;
    failed: string[];
    at: string;
    /** Per-line results with timestamped evidence (Video QA agent). */
    results?: CheckResultRecord[];
    /** Measurable lines the report did not cover (counted as failed). */
    unmeasured?: string[];
    /** Plain-language notes for failed lines (LLM-written from the facts; never changes pass/fail). */
    notes?: Record<string, string>;
  };
};

export type CheckEvidence = { tStart: number; tEnd: number; note: string; screenshot?: string };
export type CheckResultRecord = {
  checklistId: string;
  metric: string;
  measured: number | string | boolean | null;
  passed: boolean;
  status: 'ok' | 'not_measurable';
  evidence: CheckEvidence[];
};

/** A paid change order, priced from the signed rate card. The client accepts it with one tap. */
export type ChangeOrder = {
  id: string;
  milestoneKey: string;
  rateCardItemId: string;
  quantity: number;
  amountMinor: number;
  reason: string;
  status: 'draft' | 'invoiced' | 'accepted' | 'declined';
  invoiceId?: string;
  by?: 'agent' | 'client' | 'worker';
  decidedAt?: string;
  decidedBy?: string;
  at: string;
};

export type Capture = { id: string; amountMinor: number; versionId?: string; reason: string; at: string };
export type Payout = { batchId: string; amountMinor: number; email: string; at: string; status: string };

export type ChangeItem = {
  text: string;
  tag: 'fix' | 'taste';
  checklistId?: string;
  disputed?: boolean;
};

export type MilestoneRuntime = {
  key: string;
  state: MilestoneState;
  styleApproved: boolean;
  versions: Version[];
  approvedVersionId?: string;
  revisionRoundsUsed: number;
  tasteRoundsUsed: number;
  reviewStartedAt?: string;
  funding?: Funding;
  capturedMinor: number;
  captures: Capture[];
  paidOutMinor: number;
  payouts: Payout[];
  changeRequests: { at: string; versionId?: string; items: ChangeItem[]; tasteRound: boolean; changeOrderId?: string }[];
  /** Dispute split proposals in minor units owed to the worker, per side. */
  split?: { client?: number; worker?: number };
  firstSubmittedAt?: string;
  approvedAt?: string;
  history: { at: string; from: MilestoneState; to: MilestoneState; event: string; actor: Role }[];
};

export type DealDoc = {
  id: string;
  orgId: string;
  terms: DealTerms;
  termsHash?: string;
  signatures: Signature[];
  lockedAt?: string;
  milestones: MilestoneRuntime[];
  /** Idempotency keys of money actions that already ran (mirrors the ledger). */
  executedKeys: string[];
  /** Big moves waiting for one human tap. */
  pendingApprovals: { key: string; action: MoneyAction; at: string; reason: string }[];
  /** When a planned action was last blocked or refused (so the agent does not retry every tick). */
  lastBlocked?: Record<string, string>;
  /** Keys a human approved (one tap). */
  humanApprovals: string[];
  /** Things PayPal told us that a person has to look at (reversed capture, failed payout, hold voided outside yv.). */
  alerts?: { at: string; milestoneKey: string; eventType: string; message: string }[];
  /** Change orders drafted by the Scope Agent (priced from the rate card). */
  changeOrders: ChangeOrder[];
};

/** A money action an agent (or a human) asks to run. */
export type MoneyAction =
  | { kind: 'authorize'; milestoneKey: string; amountMinor: number }
  | { kind: 'reauthorize'; milestoneKey: string }
  | { kind: 'capture'; milestoneKey: string; amountMinor: number; versionId: string; final: boolean; reason: 'approval' | 'auto_approval' }
  | { kind: 'partial_capture'; milestoneKey: string; amountMinor: number; reason: 'kill_fee' | 'dispute_split' }
  | { kind: 'void'; milestoneKey: string; reason: 'missed_deadline' | 'cancelled' | 'remainder_after_partial' | 'dispute_split' | 'mutual' }
  | { kind: 'refund'; milestoneKey: string; captureId: string; amountMinor: number }
  | { kind: 'payout'; milestoneKey: string; amountMinor: number; email: string }
  | { kind: 'invoice'; milestoneKey: string; rateCardItemId: string; quantity: number; amountMinor: number };

export type PolicyDecision = {
  allowed: boolean;
  /** Rule ids that blocked the action ("P5_already_ran"). */
  violations: { rule: string; message: string }[];
  /** True when the action is allowed but must wait for one human tap. */
  needsHumanApproval: boolean;
  idempotencyKey: string;
};
