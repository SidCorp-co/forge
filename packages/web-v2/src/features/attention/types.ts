
export type AttentionKind =
  | "needs_review"
  | "awaiting_input"
  | "mention"
  | "failed_job"
  | "pending_skill_update"
  | "unseen_draft"
  | "runner_offline"
  | "channel_gate";

export interface AttentionItem {
  kind: AttentionKind;
  title: string;
  link: string;
  since: string;
  issueRef?: string;
  status?: string;
  projectSlug?: string;
  projectName?: string;
  blockerKind?: string | null;
  questionId?: string | null;
  cost?: { claimsHeld: number; workspacesPinned: number; dependents: number };
  documentNumber?: string;
  /** Channel-gate only: the waiting document's type; null when core could not read it. */
  documentType?: string | null;
}

export interface AttentionResponse {
  needsReview: AttentionItem[];
  awaitingInput: AttentionItem[];
  mentions: AttentionItem[];
  failedJobs: AttentionItem[];
  pendingSkillUpdates: AttentionItem[];
  unseenDrafts: AttentionItem[];
  unseenDraftsTotal: number;
  channelGates: AttentionItem[];
  total: number;
}

export interface AttentionView extends AttentionResponse {
  offlineRunners: AttentionItem[];
}
