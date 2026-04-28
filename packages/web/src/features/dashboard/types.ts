export type AttentionKind = 'needs_review' | 'awaiting_input' | 'mention' | 'failed_job';

export interface AttentionItem {
  kind: AttentionKind;
  title: string;
  link: string;
  since: string;
  issueRef?: string;
  status?: string;
  projectSlug?: string;
  projectName?: string;
}

export interface AttentionResponse {
  needsReview: AttentionItem[];
  awaitingInput: AttentionItem[];
  mentions: AttentionItem[];
  failedJobs: AttentionItem[];
  total: number;
}

export interface ProjectHealth {
  projectName: string;
  projectSlug: string;
  projectMeta: Record<string, unknown>;
  throughput: number;
  totalActive: number;
  statusDistribution: Record<string, number>;
  blockers: Array<{
    issueId: string;
    documentId: string;
    status: string;
  }>;
  pendingEscalations: number;
  avgCycleTimeDays: number;
}
