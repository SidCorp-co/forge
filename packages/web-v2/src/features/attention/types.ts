
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
  status?: string;
  projectSlug?: string;
  projectName?: string;
  blockerKind?: string | null;
  questionId?: string | null;
  cost?: { claimsHeld: number; workspacesPinned: number; dependents: number };
}

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
  total: number;
}

export interface AttentionView extends AttentionResponse {
  offlineRunners: AttentionItem[];
}
