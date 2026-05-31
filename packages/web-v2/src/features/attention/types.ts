// web-v2 feature module: attention / inbox. Types mirror the EXISTING core
// endpoint `GET /api/me/attention` (`packages/core/src/me/attention-routes.ts`)
// — do NOT guess field names. The `runner_offline` kind is web-v2-only: it is
// derived client-side from `GET /api/me/devices` (the core endpoint has no
// offline-runner bucket), then folded into the same grouped view + rail count.

/** Buckets surfaced by `/me/attention`, plus the client-derived offline-runner
 *  bucket. `failed_job` covers deploy failures (deploy is a job type). */
export type AttentionKind =
  | "needs_review"
  | "awaiting_input"
  | "mention"
  | "failed_job"
  | "runner_offline";

/** One actionable row. `link` is a basePath-relative href (router.push handles
 *  the `/v2` prefix). For issues it points at the issue detail; for failed jobs
 *  the issue (or project) it belongs to; for offline runners the Runners page. */
export interface AttentionItem {
  kind: AttentionKind;
  title: string;
  link: string;
  /** ISO timestamp the item entered this state (sorts/relative-time). */
  since: string;
  issueRef?: string;
  status?: string;
  projectSlug?: string;
  projectName?: string;
}

/** Shape of `GET /api/me/attention` (verbatim from the core route). */
export interface AttentionResponse {
  needsReview: AttentionItem[];
  awaitingInput: AttentionItem[];
  mentions: AttentionItem[];
  failedJobs: AttentionItem[];
  total: number;
}

/** The core response widened with the client-derived offline-runner bucket and
 *  a `total` that includes it — what `useAttention()` returns to consumers. */
export interface AttentionView extends AttentionResponse {
  offlineRunners: AttentionItem[];
}
