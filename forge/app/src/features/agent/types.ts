export type AgentSchedule = 'off' | 'weekly' | 'biweekly' | 'monthly';
export type AgentApprovalMode = 'preview' | 'auto-create';

export interface Agent {
  documentId: string;
  name: string;
  type: string;
  enabled: boolean;
  focusAreas: string[];
  customInstructions: string | null;
  schedule: AgentSchedule;
  approvalMode: AgentApprovalMode;
  maxProposals: number;
  excludeCategories: string[];
  promptTemplate: string | null;
  reindexPromptTemplate: string | null;
  definition?: {
    name: string;
    type: string;
    description: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSession {
  documentId: string;
  title: string;
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed';
  messages: unknown[];
  claudeSessionId?: string;
  repoPath?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
