/* AUTO-GENERATED from contracts/schemas by contracts/gen.sh. Do not edit. */
export interface AgentAnswer {
  flow: "brand_qa" | "insight" | "planner" | "review_digest" | "unknown";
  answer: string;
  citations: Citation[];
  dataLimits: string[];
  model?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

export interface BrandRule {
  id: string;
  title: string;
  body: string;
  kind?: "voice" | "visual" | "do" | "dont" | "audience" | "resource" | "purpose";
  sourceUrl?: string;
}

export interface Citation {
  postId: string;
  /**
   * metric key, e.g. views, retention@42s, brandRule
   */
  metric: string;
  value: number | string;
  note?: string;
}

export interface Insight {
  postId: string;
  kind: "retention_spike" | "outperformer" | "underperformer" | "review_digest" | "plan";
  summary: string;
  atSecond?: number;
  spokenText?: string;
  onScreen?: string;
  liftVsBaseline?: number;
  citations: Citation[];
  dataLimits: string[];
  jobId?: string;
}

export interface JobEnvelope {
  jobId: string;
  type: "insights.analyze_post.v1" | "ingest.transcribe.v1" | "review.digest.v1" | "brand.index.v1";
  orgId: string;
  userId: string;
  payload: {};
  attempt: number;
  createdAt: string;
  /**
   * short-lived service JWT scoped to this job (orgId,userId,scopes)
   */
  serviceToken: string;
  traceparent?: string;
}

export interface JobResult {
  jobId: string;
  type: string;
  status: "succeeded" | "failed" | "dead_lettered";
  result?: {};
  error?: string;
  attempts?: number;
}

export interface MetricPoint {
  postId: string;
  metric:
    | "views"
    | "likes"
    | "comments"
    | "shares"
    | "saves"
    | "reach"
    | "watchTimeSec"
    | "avgViewDurationSec"
    | "followersGained";
  value: number;
  ts: string;
  source?: string;
}

export interface Post {
  id: string;
  orgId: string;
  platform: "youtube" | "instagram" | "x" | "linkedin";
  externalId?: string;
  title: string;
  caption?: string;
  format?: string;
  durationSec?: number;
  publishedAt?: string;
  tags?: string[];
  source?: "postiz" | "youtube_analytics" | "instagram_graph" | "fixture" | "manual";
}

export interface RetentionPoint {
  postId: string;
  second: number;
  /**
   * YouTube elapsedVideoTimeRatio-based audienceWatchRatio; >1 means rewatches
   */
  audienceWatchRatio: number;
  relativeRetentionPerformance?: number;
}

export interface ReviewComment {
  id: string;
  postId: string;
  author: string;
  role?: string;
  body: string;
  timecodeSec?: number;
  createdAt?: string;
}

export interface SceneCut {
  second: number;
  /**
   * on-screen description / OCR text if known
   */
  label?: string;
}

export interface ServiceTokenClaims {
  orgId: string;
  userId: string;
  scopes: (
    | "posts:read"
    | "metrics:read"
    | "brand:read"
    | "reviews:read"
    | "insights:write"
    | "jobs:write"
    | "assets:write"
    | "digests:write"
    | "deals:read"
    | "deals:checks"
    | "deals:propose"
  )[];
  iss: "yv-api";
  aud: "yv-internal";
  exp: number;
  jti?: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export type DealRole = "client" | "worker";
export type DealMilestoneState =
  | "DRAFT"
  | "SIGNED"
  | "FUNDED"
  | "STYLE_SAMPLE"
  | "SUBMITTED"
  | "CHECKS"
  | "IN_REVIEW"
  | "CHANGES_REQUESTED"
  | "APPROVED"
  | "AUTO_APPROVED"
  | "CAPTURED"
  | "PAID_OUT"
  | "KILLED"
  | "CANCELLED"
  | "DISPUTED";

/**
 * The deal as one party sees it (GET /organizations/:org/deals/:dealId). Amounts are minor units from the signed deal and the ledger, never from a model. Mirrors apps/api/src/modules/deals/lib/types.cts.
 */
export interface DealView {
  id: string;
  orgId: string;
  terms: DealTerms;
  termsHash?: string;
  signatures: DealSignature[];
  lockedAt?: string;
  milestones: DealMilestoneRuntime[];
  executedKeys?: string[];
  pendingApprovals: DealPendingApproval[];
  lastBlocked?: {
    [k: string]: string;
  };
  humanApprovals: string[];
  alerts?: DealAlert[];
  changeOrders: DealChangeOrder[];
  /**
   * Caller's party role, null for a deal manager who is not a party.
   */
  me?: "client" | "worker" | null;
  termsHashNow: string;
  problems?: string[];
  /**
   * all: the brand, or a deal manager not on the crew, sees every member's payout lines. own: a crew member (payee) sees only their own payouts; other members' lines and payout batches are left out and paidOutMinor is their own total.
   */
  payoutScope?: "all" | "own";
}
export interface DealTerms {
  title: string;
  currency: string;
  client: DealParty;
  worker: DealParty;
  milestones: DealMilestoneTerms[];
  rateCard: DealRateCardItem[];
  killFeeBp: number;
  humanApprovalThresholdMinor: number;
  references?: string[];
  styleChoices?: {
    [k: string]: string;
  };
}
export interface DealParty {
  role: DealRole;
  userId: string;
  displayName: string;
  country?: string;
  paypalEmail?: string;
}
export interface DealMilestoneTerms {
  key: string;
  title: string;
  amountMinor: number;
  dueAt: string;
  graceHours: number;
  reviewWindowHours: number;
  revisionRoundsIncluded: number;
  styleSample: boolean;
  checklist: DealChecklistItem[];
  payees: DealPayee[];
}
export interface DealChecklistItem {
  id: string;
  text: string;
  /**
   * check = machine-verifiable; taste = people decide (never blocks pay on its own)
   */
  kind: "check" | "taste";
  measure?: DealMeasure;
  source?: string;
}
export interface DealMeasure {
  metric: string;
  op: "<=" | ">=" | "==" | "between" | "present" | "absent";
  value?: number | string;
  max?: number;
  unit?: string;
  window?: number[];
}
export interface DealPayee {
  userId: string;
  email: string;
  shareBp: number;
  displayName?: string;
}
export interface DealRateCardItem {
  id: string;
  label: string;
  unit: string;
  unitPriceMinor: number;
}
export interface DealSignature {
  party: DealRole;
  userId: string;
  termsHash: string;
  at: string;
}
export interface DealMilestoneRuntime {
  key: string;
  state: DealMilestoneState;
  styleApproved: boolean;
  versions: DealVersion[];
  approvedVersionId?: string;
  revisionRoundsUsed: number;
  tasteRoundsUsed: number;
  reviewStartedAt?: string;
  funding?: DealFunding;
  capturedMinor: number;
  captures: DealCapture[];
  paidOutMinor: number;
  payouts: DealPayout[];
  changeRequests: DealChangeRequest[];
  split?: DealSplit;
  firstSubmittedAt?: string;
  approvedAt?: string;
  proposals?: DealProposals;
  history: DealHistoryEntry[];
}
export interface DealVersion {
  id: string;
  sha256: string;
  submittedAt: string;
  checks?: DealVersionChecks;
}
export interface DealVersionChecks {
  reportId: string;
  passed: boolean;
  failed: string[];
  at: string;
  results?: DealCheckResult[];
  unmeasured?: string[];
  notes?: {
    [k: string]: string;
  };
}
export interface DealCheckResult {
  checklistId: string;
  metric: string;
  measured: number | string | boolean | null;
  passed: boolean;
  status: "ok" | "not_measurable";
  evidence: DealCheckEvidence[];
}
export interface DealCheckEvidence {
  tStart: number;
  tEnd: number;
  note: string;
  screenshot?: string;
}
export interface DealFunding {
  orderId?: string;
  approveUrl?: string;
  authorizationId?: string;
  authorizedMinor?: number;
  authorizedAt?: string;
  honorExpiresAt?: string;
  expiresAt?: string;
  reauthorizations?: DealReauthorization[];
  status: "CREATED" | "APPROVED" | "AUTHORIZED" | "PARTIALLY_CAPTURED" | "CAPTURED" | "VOIDED" | "EXPIRED";
}
export interface DealReauthorization {
  authorizationId: string;
  at: string;
}
export interface DealCapture {
  id: string;
  amountMinor: number;
  versionId?: string;
  reason: string;
  at: string;
}
export interface DealPayout {
  batchId: string;
  amountMinor: number;
  email: string;
  at: string;
  status: string;
}
export interface DealChangeRequest {
  at: string;
  versionId?: string;
  items: DealChangeItem[];
  tasteRound: boolean;
  changeOrderId?: string;
}
export interface DealChangeItem {
  text: string;
  tag: "fix" | "taste";
  checklistId?: string;
  disputed?: boolean;
}
/**
 * Dispute split each side accepted, in minor units owed to the worker.
 */
export interface DealSplit {
  client?: number;
  worker?: number;
}
export interface DealProposals {
  review?: DealReviewProposal;
  dispute?: DealDisputeProposal;
}
export interface DealReviewProposal {
  id: string;
  agent: "review";
  at: string;
  versionId: string;
  items: DealChangeItem[];
  downgraded: string[];
  contradictions: DealContradiction[];
  costsRevisionRound?: boolean;
  roundsLeftAfter?: number;
  rationale?: string;
  decision: DealStoredDecision;
}
export interface DealContradiction {
  a: number;
  b: number;
  why: string;
}
export interface DealStoredDecision {
  allowed: boolean;
  violations: DealPolicyViolation[];
  needsHumanApproval?: boolean;
  assumed?: string[];
}
export interface DealPolicyViolation {
  rule: string;
  message: string;
}
export interface DealDisputeProposal {
  id: string;
  agent: "scope_dispute";
  at: string;
  versionId?: string;
  basis: DealDisputeBasis;
  /**
   * Computed in Node from checklist arithmetic, never by an AI.
   */
  workerMinor: number;
  clientMinor: number;
  evidence: DealDisputeEvidence;
  notes?: string;
  decision: DealStoredDecision;
}
export interface DealDisputeBasis {
  passedChecks: number;
  totalChecks: number;
  shareBp: number;
  amountMinor: number;
  remainingMinor: number;
}
export interface DealDisputeEvidence {
  checks: DealDisputeCheck[];
  unmeasured: string[];
  tasteLines: string[];
  rounds: DealRounds;
  changeRequests: DealChangeRequest[];
  versions: number;
}
export interface DealDisputeCheck {
  id: string;
  text: string;
  passed: boolean | null;
  measured?: number | string | boolean | null;
  evidence: DealCheckEvidence[];
}
export interface DealRounds {
  included: number;
  used: number;
  tasteRounds: number;
}
export interface DealHistoryEntry {
  at: string;
  from: DealMilestoneState;
  to: DealMilestoneState;
  event: string;
  actor: "client" | "worker" | "system" | "reviewer";
}
export interface DealPendingApproval {
  key: string;
  /**
   * The money action waiting for one human tap (amounts come from the deal).
   */
  action: {};
  at: string;
  reason: string;
}
export interface DealAlert {
  at: string;
  milestoneKey: string;
  eventType: string;
  message: string;
}
/**
 * Priced from the signed rate card; the client accepts with one tap.
 */
export interface DealChangeOrder {
  id: string;
  milestoneKey: string;
  rateCardItemId: string;
  quantity: number;
  amountMinor: number;
  reason: string;
  status: "draft" | "invoiced" | "accepted" | "declined";
  invoiceId?: string;
  by?: "agent" | "client" | "worker";
  decidedAt?: string;
  decidedBy?: string;
  at: string;
}
export interface DealChain {
  ok: boolean;
  brokenAt?: number;
  reason?: string;
}
export type DealLedgerType =
  | "authorize"
  | "reauthorize"
  | "capture"
  | "partial_capture"
  | "void"
  | "refund"
  | "payout"
  | "invoice"
  | "blocked"
  | "pending_approval"
  | "webhook"
  | "state";
/**
 * One hash-chained money ledger line. blocked / pending_approval / state lines move no money.
 */
export interface DealLedgerEntry {
  dealId: string;
  orgId: string;
  milestoneKey: string;
  seq: number;
  type: DealLedgerType;
  amountMinor: number;
  currency: string;
  moved: boolean;
  paypalRef?: string;
  idempotencyKey?: string;
  actor: string;
  explanation: string;
  policy?: DealLedgerPolicy;
  at: string;
  prevHash: string;
  hash: string;
}
export interface DealLedgerPolicy {
  allowed: boolean;
  violations: DealPolicyViolation[];
}
/**
 * Socket.IO deal:ledger payload (room deal:<id>).
 */
export interface DealLedgerPush {
  dealId: string;
  entry: DealLedgerEntry;
}
export interface DealLedgerTotals {
  heldMinor: number;
  capturedMinor: number;
  refundedMinor: number;
  paidOutMinor: number;
  invoicedMinor: number;
  blockedCount: number;
}
/**
 * GET /organizations/:org/deals/:dealId/ledger
 */
export interface DealLedgerView {
  entries: DealLedgerEntry[];
  chain: DealChain;
  totals: DealLedgerTotals;
  /**
   * own: a crew member's ledger, with only their own payout lines (no other member's, no batch-level payout lines); totals are recomputed from those entries. The chain is verified on the full ledger.
   */
  scope?: "all" | "own";
}

