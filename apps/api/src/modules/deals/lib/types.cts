/** Shared types for the deals module (types only; erased at runtime). */
import type { ClockSchedule } from './clock.cts';

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
  /** IANA timezone (client side): the Fair Review Clock counts business days here. Defaults from country. */
  tz?: string;
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

/** role 'lead' takes the cents left over when a release is split (splitCents); unset = the deal's worker leads. */
export type Payee = { userId: string; email: string; shareBp: number; displayName?: string; role?: 'lead' | 'member' };

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
  /**
   * Fair Review Clock terms (optional). Signed and hashed with the rest of the
   * terms, so they lock at signing like the payees. Country and timezone come
   * from the client (brand) party. A milestone with these uses the clock
   * instead of the plain reviewWindowHours auto-approve.
   */
  clock?: ClockTermsSpec;
};

export type ClockTermsSpec = {
  reviewWindowBusinessDays?: number;
  partialReleasePct?: number;
  graceBusinessDays?: number;
  includedRevisionRounds?: number;
  backupReviewerId?: string;
};

export type ClockStepId = 'remind_50' | 'remind_80' | 'final_24h' | 'release_partial' | 'release_grace';

/** One line on a clock's timeline: a step that ran, or something a person did. */
export type ClockEvent = {
  at: string;
  kind: 'step' | 'action';
  id: string;
  by?: string;
  amountMinor?: number;
  note?: string;
};

/** Persisted Fair Review Clock state for one milestone. */
export type ClockRuntime = {
  startedAt: string;
  /** buildSchedule() output, frozen at start (lib/clock.cts ClockSchedule). */
  schedule: ClockSchedule;
  doneSteps: string[];
  paused: boolean;
  pausedAt?: string;
  pausedMs: number;
  revisionsUsed: number;
  status: 'running' | 'paused' | 'approved' | 'released' | 'disputed' | 'stopped';
  /** Hold upkeep notices already sent (once each). */
  notices?: string[];
  timeline: ClockEvent[];
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
/** Which release a payout batch pays: the review clock's partial or grace release, or the full release after a capture. */
export type PayoutStep = 'release_partial' | 'release_grace' | 'approve' | 'auto_approve' | 'kill_fee' | 'dispute_split' | 'final';
/** One member's line of a payout batch: their receipt. */
export type Payout = {
  batchId: string;
  amountMinor: number;
  email: string;
  at: string;
  status: string;
  tranche?: 'clock_partial';
  userId?: string;
  displayName?: string;
  shareBp?: number;
  step?: PayoutStep;
  /** True when no money left PayPal for this line (mock, PAYOUTS_MODE=simulated, or PAYOUT_NOT_AVAILABLE). */
  simulated?: boolean;
};
/** One PayPal Payouts batch per release: every member's share in one call, sender_batch_id = the release's idempotency key. */
export type PayoutBatch = {
  batchId: string;
  senderBatchId: string;
  step: PayoutStep;
  amountMinor: number;
  currency: string;
  at: string;
  status: string;
  simulated: boolean;
  /** Why it was simulated (PayPal's error, or the mode). */
  reason?: string;
  items: { userId: string; email: string; displayName?: string; shareBp: number; amountMinor: number; senderItemId: string }[];
};

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
  /** Every payout batch sent (or simulated) for this milestone. */
  payoutBatches?: PayoutBatch[];
  changeRequests: { at: string; versionId?: string; items: ChangeItem[]; tasteRound: boolean; changeOrderId?: string }[];
  /** Dispute split proposals in minor units owed to the worker, per side. */
  split?: { client?: number; worker?: number };
  firstSubmittedAt?: string;
  approvedAt?: string;
  /** Fair Review Clock (only on milestones with clock terms, once checks first pass). */
  clock?: ClockRuntime;
  /** The latest agent proposals for this milestone, each dry-run through policy before it was stored. */
  proposals?: { review?: ReviewProposal; dispute?: DisputeProposal };
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

/** What a proposal looked like to policy when it was stored (the UI shows a blocked one as a rule chip, never a button). */
export type StoredDecision = { allowed: boolean; violations: { rule: string; message: string }[]; needsHumanApproval?: boolean; assumed?: string[] };

/** Review Agent: reviewer comments merged into Fix / Taste items, dry-run as a request_changes. */
export type ReviewProposal = {
  id: string;
  agent: 'review';
  at: string;
  versionId: string;
  items: ChangeItem[];
  /** Items the agent called Fix that the engine would treat as Taste (they cite a line that passed, or none). */
  downgraded: string[];
  /** Pairs of item indexes that ask for opposite things; people settle them. */
  contradictions: { a: number; b: number; why: string }[];
  costsRevisionRound?: boolean;
  roundsLeftAfter?: number;
  rationale?: string;
  decision: StoredDecision;
};

/** Scope & Dispute Agent: the evidence pack plus a split computed in Node from the checklist arithmetic. */
export type DisputeProposal = {
  id: string;
  agent: 'scope_dispute';
  at: string;
  versionId?: string;
  /** passed / total signed check lines -> shareBp of the milestone amount (never an AI number). */
  basis: { passedChecks: number; totalChecks: number; shareBp: number; amountMinor: number; remainingMinor: number };
  workerMinor: number;
  clientMinor: number;
  evidence: {
    checks: { id: string; text: string; passed: boolean | null; measured?: number | string | boolean | null; evidence: CheckEvidence[] }[];
    unmeasured: string[];
    tasteLines: string[];
    rounds: { included: number; used: number; tasteRounds: number };
    changeRequests: { at: string; versionId?: string; items: ChangeItem[]; tasteRound: boolean }[];
    versions: number;
  };
  notes?: string;
  decision: StoredDecision;
};

/** One member in a payout batch action: amounts come from splitCents over the signed shares, never from a request. */
export type PayoutItem = { userId: string; email: string; amountMinor: number };

/** A money action an agent (or a human) asks to run. */
export type MoneyAction =
  | { kind: 'authorize'; milestoneKey: string; amountMinor: number }
  | { kind: 'reauthorize'; milestoneKey: string }
  | { kind: 'capture'; milestoneKey: string; amountMinor: number; versionId: string; final: boolean; reason: 'approval' | 'auto_approval' | 'clock_grace' }
  | { kind: 'partial_capture'; milestoneKey: string; amountMinor: number; reason: 'kill_fee' | 'dispute_split' | 'clock_partial' }
  | { kind: 'void'; milestoneKey: string; reason: 'missed_deadline' | 'cancelled' | 'remainder_after_partial' | 'dispute_split' | 'mutual' }
  | { kind: 'refund'; milestoneKey: string; captureId: string; amountMinor: number }
  | { kind: 'payout'; milestoneKey: string; amountMinor: number; step: PayoutStep; items: PayoutItem[] }
  | { kind: 'invoice'; milestoneKey: string; rateCardItemId: string; quantity: number; amountMinor: number };

export type PolicyDecision = {
  allowed: boolean;
  /** Rule ids that blocked the action ("P5_already_ran"). */
  violations: { rule: string; message: string }[];
  /** True when the action is allowed but must wait for one human tap. */
  needsHumanApproval: boolean;
  idempotencyKey: string;
};
