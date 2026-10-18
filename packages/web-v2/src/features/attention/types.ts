
import type { StuckIssueKind } from "@forge/contracts/notifications";

export type AttentionKind =
  | "needs_review"
  | "awaiting_input"
  | "mention"
  | "failed_job"
  | "pending_skill_update"
  | "unseen_draft"
  | "runner_offline";

export interface AttentionItem {
  kind: AttentionKind;
  title: string;
  link: string;
  /** ISO timestamp the item entered this state (sorts/relative-time). */
  since: string;
  issueRef?: string;
  issueTitle?: string;
  /** Failed job only: the job a person retries from the row. */
  jobId?: string;
  /** Failed job only: its kind of work, as stored; `failedJobWords` says it in words. */
  jobType?: string;
  failure?: string | null;
  stuckKind?: StuckIssueKind;
  /** `waiting_on_others` only: the person the park waits for. */
  stuckOwedBy?: string;
  failedJob?: { jobType: string; failure: string | null };
  status?: string;
  projectSlug?: string;
  projectName?: string;
  blockerKind?: string | null;
  questionId?: string | null;
  cost?: { claimsHeld: number; workspacesPinned: number; dependents: number };
}

export const ATTENTION_BUCKETS = [
  "needsReview",
  "awaitingInput",
  "mentions",
  "failedJobs",
  "pendingSkillUpdates",
  "unseenDrafts",
] as const;
export type AttentionBucket = (typeof ATTENTION_BUCKETS)[number];

/** Shape of `GET /api/me/attention` (verbatim from the core route). */
export interface AttentionResponse {
  needsReview: AttentionItem[];
  awaitingInput: AttentionItem[];
  mentions: AttentionItem[];
  failedJobs: AttentionItem[];
  pendingSkillUpdates: AttentionItem[];
  /** Agent-filed `draft` issues no human has commented on. Capped by core. */
  unseenDrafts: AttentionItem[];
  /** Unclipped count behind `unseenDrafts` — render it, don't recompute it. */
  unseenDraftsTotal: number;
  /** Each bucket counted whole before its cap: the number a heading or badge says (ISS-1229 r14). */
  bucketTotals: Record<AttentionBucket, number>;
  /** Per project slug, the whole counts the project's Needs you list is made of; none of them, no key. */
  projectTotals: Record<
    string,
    {
      needsReview: number;
      awaitingInput: number;
      awaitingAsked: number;
      failedJobs: number;
      /** Parked issues the health row's list holds that no bucket lists, counted once each. */
      parkedOnly: number;
      parkedAsked: number;
      /** Issues a stuck-issue notice stands for that none of the counts above holds (ISS-1229 r15). */
      stuckOnly: number;
    }
  >;
  total: number;
}

export interface AttentionView extends AttentionResponse {
  offlineRunners: AttentionItem[];
}

