import type { BaseEntity } from '@/lib/types';
import type { ReleaseNotes } from '@forge/contracts';

export type IssueStatus =
  | 'open'
  | 'confirmed'
  | 'waiting'
  | 'approved'
  | 'in_progress'
  | 'developed'
  | 'deploying'
  | 'testing'
  | 'tested'
  | 'pass'
  | 'staging'
  | 'released'
  | 'closed'
  | 'reopen'
  | 'on_hold'
  | 'needs_info';

export type IssuePriority = 'critical' | 'high' | 'medium' | 'low' | 'none';

// ISS-42 C2 — t-shirt sizing matches the core Drizzle enum
// (`packages/core/src/db/schema.ts:issueComplexities`).
export type IssueComplexity = 'xs' | 's' | 'm' | 'l' | 'xl';

export type PipelineWaitingReason =
  | 'issue_busy'
  | 'manual_hold'
  | 'waiting_on_dep'
  | 'waiting_on_decomp_parent'
  | 'project_full'
  | 'runner_full';

export interface PipelineHealth {
  stage: IssueStatus;
  activeSession?: { id: string; status: 'queued' | 'running'; skill: string };
  waitingOn?: {
    reason: PipelineWaitingReason;
    since: string;
    details: Record<string, unknown>;
  };
  queuedAt?: string;
  lastTickAt?: string;
}

export interface IssueHistoryEntry {
  field: string;
  from: string | null;
  to: string;
  at: string;
  by: string;
}

export interface Issue extends BaseEntity {
  displayId?: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  category: string | null;
  reportedBy: string | null;
  project: { id: number; documentId: string; slug: string; name: string } | null;
  attachments: { id: number; url: string; mime: string; name: string }[];
  acceptanceCriteria: string | null;
  suggestedSolution: string | null;
  aiSummary: string | null;
  aiSuggestedSolution: string | null;
  aiAcceptanceCriteria: string[] | null;
  aiConfidence: number | null;
  plan: string | null;
  isAgentTask: boolean;
  agentStatus: 'idle' | 'running' | 'completed' | 'failed' | null;
  agentLog: unknown[] | null;
  changeHistory: IssueHistoryEntry[];
  tasks: { id: number; documentId: string; title: string; status: string }[];
  comments: { id: number }[];
  agentSessions?: { id: number; documentId: string; title: string; status: string; createdAt: string; metadata?: Record<string, any> | null }[];
  labels?: { id: number; documentId: string; name: string; color: string }[];
  relations?: { type: string; targetDocumentId: string; reason?: string; targetId?: number; targetTitle?: string; targetStatus?: string }[];
  complexity?: IssueComplexity | null;
  manualHold?: boolean;
  pipelineHealth?: PipelineHealth;
  releaseNotes?: ReleaseNotes | null;
}

export interface IssueAttachment {
  id: string;
  issueId: string;
  uploaderId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
  url: string;
}

export interface IssueCostStep {
  step: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  turns: number;
  sessionCount: number;
}

export interface IssueCostSession {
  documentId: string;
  title: string;
  step: string;
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface IssueCostSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalTurns: number;
  totalCost: number;
  sessionCount: number;
  byStep: IssueCostStep[];
  sessions: IssueCostSession[];
}

export interface StepTimingStat {
  step: string;
  avg: number;
  p90: number;
  median: number;
  count: number;
  outliers: { issueId: number; documentId: string; title: string; duration: number }[];
}

export interface PipelineTimingResponse {
  steps: StepTimingStat[];
  totalIssuesAnalyzed: number;
  window: { from: string | null; to: string | null };
}

export interface IssueFormData {
  title: string;
  description: string;
  priority: IssuePriority;
  project: string; // documentId
  acceptanceCriteria?: string;
  suggestedSolution?: string;
  attachments?: number[]; // media IDs
}
