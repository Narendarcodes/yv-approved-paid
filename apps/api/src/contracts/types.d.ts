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

