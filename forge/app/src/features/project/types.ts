import type { BaseEntity } from '@/lib/types';
import type { KnowledgeIndex } from '@/features/knowledge/types';

export type AIProvider = 'anthropic' | 'openai' | 'gemini';

export interface ProjectUser {
  id: number;
  documentId: string;
  username: string;
  email: string;
}

export interface Device {
  id: number;
  documentId: string;
  name: string;
  deviceId: string;
  lastSeen: string | null;
}

export interface PipelineStep {
  enabled: boolean;
  runner: string;
  model?: string;
}

export interface Project extends BaseEntity {
  name: string;
  slug: string;
  description: string;
  defaultProvider: AIProvider;
  knowledgeIndex?: Record<string, KnowledgeIndex> | null;
  knowledgeIndexedAt?: string | null;
  defaultDevice?: Device | null;
  owner?: ProjectUser | null;
  members?: ProjectUser[];
  devices?: Device[];
  repoPath?: string | null;
  baseBranch?: string | null;
  productionBranch?: string | null;
  agentConfig?: {
    pipelineConfig?: {
      enabled: boolean;
      autoTriage?: boolean | PipelineStep;
      autoClarify?: boolean | PipelineStep;
      autoPlan?: boolean | PipelineStep;
      autoCode?: boolean | PipelineStep;
      autoReview?: boolean | PipelineStep;
      autoTest?: boolean | PipelineStep;
      autoFix?: boolean | PipelineStep;
      autoRelease?: boolean | PipelineStep;
    };
    enabledTools?: string[];
  } | null;
  antigravityProjectId?: string | null;
  sentryProject?: string | null;
  webhookUrl?: string | null;
  coolifyResources?: { name: string; uuid: string }[];
}

export interface ProjectFormData {
  name: string;
  slug: string;
  description: string;
}
