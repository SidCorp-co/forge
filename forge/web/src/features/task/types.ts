// Aligned with forge/core `tasks` table (Phase 3.3 ISS-257). Flat shape, no
// Strapi envelope.
export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done';
export type TaskAgentStatus = 'idle' | 'running' | 'completed' | 'failed';

// Back-compat alias. Pre-Tier-B1 the status was a superset that included
// 'queued'; keep the union here so legacy UI components still compile.
export type AgentStatus = TaskAgentStatus | 'queued';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low' | 'none';

export interface Task {
  id: string;
  issueId: string;
  projectId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  isAgentTask: boolean;
  agentStatus: TaskAgentStatus | null;
  agentLog: unknown;
  acceptanceCriteria: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCreateInput {
  title: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: string | null;
  isAgentTask?: boolean;
  agentStatus?: TaskAgentStatus | null;
  agentLog?: unknown;
  acceptanceCriteria?: unknown;
}

export type TaskPatchInput = Partial<TaskCreateInput>;
