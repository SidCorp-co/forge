import type { BaseEntity } from '@/lib/types';

export type AIProvider = 'anthropic' | 'openai' | 'gemini';

export interface Device {
  id: number;
  documentId: string;
  name: string;
  deviceId: string;
  lastSeen: string | null;
  disabledUntil?: string | null;
  projectsRoot?: string | null;
  projectPaths?: Record<string, string> | null;
}

export interface AntigravityRunner {
  id: number;
  documentId: string;
  name: string;
  agentId?: string;
  endpoint?: string;
  excluded?: boolean;
  status: 'online' | 'offline' | 'error';
  lastSeen: string | null;
  healthError: string | null;
  maxProjects?: number;
  projectCount?: number;
  quota?: {
    models: { model: string; refreshLabel: string; segments: number[]; remaining: number; status: 'full' | 'warning' | 'empty' }[];
    fetchedAt: string;
    error: string | null;
  };
  depletedModels?: Record<string, string> | null;
  disabledUntil?: string | null;
  projects?: { projectId: string; forgeProject?: { name: string; slug: string } | null }[];
}

export interface CloudflareAccount {
  id: number;
  documentId: string;
  name: string;
  accountId: string;
  status: 'active' | 'inactive' | 'error';
  lastValidated: string | null;
  validationError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  name_servers: string[];
  plan?: string;
}

export interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  priority?: number;
}

export interface ProjectUser {
  id: number;
  documentId: string;
  username: string;
  email: string;
}

export interface Project extends BaseEntity {
  name: string;
  slug: string;
  description: string;
  apiKey: string | null;
  defaultProvider: AIProvider;
  agentProvider: AIProvider | null;
  agentPrompt: string | null;
  agentMemoryEnabled: boolean;
  coolifyResources: { name: string; uuid: string }[];
  sentryProject: string | null;
  repoPath: string | null;
  baseBranch: string | null;
  productionBranch: string | null;
  antigravityProjectId: string | null;
  webhookUrl: string | null;
  webhookSecret: string | null;
  webhookStatuses: string[];
  previewDeploy: {
    host?: string;
    port?: number;
    user?: string;
    privateKeyPath?: string;
    domain?: string;
    composePath?: string;
    repoUrl?: string;
    basePath?: string;
    envVars?: Record<string, string>;
    useRegistry?: boolean;
    stagingUrl?: string;
    stagingApiUrl?: string;
    testingUrls?: { label: string; url: string }[];
    testCredentials?: { label: string; username: string; password: string }[];
  } | null;
  agentConfig: {
    statuses?: string[];
    priorities?: string[];
    categories?: string[];
    relationTypes?: string[];
    enabledTools?: string[];
    enabledSkills?: string[];
    agentName?: string;
    agentRole?: string;
    behaviorRules?: string[];
    queryStrategies?: Record<string, string>;
    intentExamples?: string[];
    domainTemplate?: string;
    antigravityModel?: string;
    antigravityError?: string | null;
    antigravityErrorAt?: string | null;
    pipelineConfig?: {
      enabled: boolean;
      previewEnabled?: boolean;
      autoTriage?: boolean | { enabled: boolean; runner: string; model?: string };
      autoClarify?: boolean | { enabled: boolean; runner: string; model?: string };
      autoPlan?: boolean | { enabled: boolean; runner: string; model?: string };
      autoCode?: boolean | { enabled: boolean; runner: string; model?: string };
      autoReview?: boolean | { enabled: boolean; runner: string; model?: string };
      autoTest?: boolean | { enabled: boolean; runner: string; model?: string };
      autoFix?: boolean | { enabled: boolean; runner: string; model?: string };
      autoRelease?: boolean | { enabled: boolean; runner: string; model?: string };
    };
  } | null;
  owner: ProjectUser | null;
  members: ProjectUser[];
  knowledgeIndex?: Record<string, KnowledgeIndex> | null;
  knowledgeIndexedAt?: string | null;
  defaultDevice: Device | null;
  devices?: Device[];
  antigravityRunners?: AntigravityRunner[];
  defaultAntigravityRunner?: AntigravityRunner | null;
  antigravityProjectMap?: Record<string, string> | null;
  channels?: ChannelConfig[];
  crossProjectAccess?: boolean;
}

export interface ChannelConfig {
  type: 'rocketchat' | 'telegram';
  name: string;
  enabled: boolean;
  config: Record<string, string>;
}

export interface KnowledgeIndex {
  project?: string;
  architecture?: string;
  paths?: Record<string, string>;
  domains?: Record<string, string[]>;
  conventions?: Record<string, string>;
  recipes?: Record<string, string>;
  commands?: Record<string, string>;
}

export interface KnowledgeEdge {
  documentId: string;
  subject: string;
  predicate: string;
  object: string;
  value?: string;
  confidence?: number;
}

export interface ProjectFormData {
  name: string;
  slug: string;
  description: string;
}
