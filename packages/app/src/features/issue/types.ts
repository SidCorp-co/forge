import type { BaseEntity } from '@/lib/types';

export type IssueStatus =
  | 'draft'
  | 'open'
  | 'confirmed'
  | 'clarified'
  | 'waiting'
  | 'approved'
  | 'in_progress'
  | 'developed'
  | 'deploying'
  | 'testing'
  | 'staging'
  | 'released'
  | 'closed'
  | 'reopen'
  | 'on_hold'
  | 'needs_info';

export type IssuePriority = 'critical' | 'high' | 'medium' | 'low' | 'none';

export interface IssueHistoryEntry {
  field: string;
  from: string | null;
  to: string;
  at: string;
  by: string;
}

export interface Issue extends BaseEntity {
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  category: string | null;
  reportedBy: string | null;
  project: { id: number; documentId: string; slug: string; name: string } | null;
  attachments: { id: number; url: string; mime: string; name: string }[];
  aiSummary: string | null;
  aiSuggestedSolution: string | null;
  aiAcceptanceCriteria: string[] | null;
  aiConfidence: number | null;
  isAgentTask: boolean;
  agentStatus: 'idle' | 'running' | 'completed' | 'failed' | null;
  agentLog: unknown[] | null;
  changeHistory: IssueHistoryEntry[];
  tasks: { id: number; documentId: string; title: string; status: string }[];
  comments: { id: number }[];
}

export interface IssueFormData {
  title: string;
  description: string;
  priority: IssuePriority;
  project: string;
  attachments?: number[];
}
