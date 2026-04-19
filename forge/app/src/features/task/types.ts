import type { BaseEntity } from '@/lib/types';

export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done';
export type AgentStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface Task extends BaseEntity {
  title: string;
  description: string;
  status: TaskStatus;
  priority: 'critical' | 'high' | 'medium' | 'low' | 'none';
  assignee: string | null;
  isAgentTask: boolean;
  agentStatus: AgentStatus | null;
  agentLog: unknown[] | null;
  acceptanceCriteria: string[] | null;
  issue: { id: number; documentId: string; title: string } | null;
  project: { id: number; documentId: string; name: string } | null;
}

export interface TaskFormData {
  title: string;
  description: string;
  status: TaskStatus;
  issue: string;
}
