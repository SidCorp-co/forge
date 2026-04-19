import type { ToolDefinition } from '../provider';
import type { AgentConfig } from '../tools';

export interface RelevantContextEntry {
  sourceType: string;
  sourceId: string;
  text: string;
  score: number;
  metadata?: Record<string, any>;
}

export interface PromptContext {
  // Project
  projectName: string;
  projectDescription?: string;
  agentPrompt?: string;
  knowledgeIndex?: any;
  repos?: any[];

  // User & Session
  userKey: string;
  sessionSource: 'web' | 'widget';
  edgeContext?: string;
  preferredLanguage?: string;

  // RAG
  relevantContext?: RelevantContextEntry[];
  queryIntent?: string;

  // Rolling Stats
  rollingStats?: any;

  // Runtime
  model: string;

  // Agent Config
  agentConfig?: AgentConfig;

  // Tools
  tools: ToolDefinition[];

  // Stats
  totalToolCalls?: number;

  // Widget hub context
  hubContext?: Record<string, unknown>;
  hasMcpServers?: boolean;
  mcpServers?: Record<string, { url: string; [key: string]: any }>;
  // Skills
  availableSkills?: { name: string; description: string }[];
  // Web page context (e.g. viewing a specific issue)
  pageContext?: Record<string, unknown>;
  // Cross-project health data (CEO agent only)
  crossProjectHealth?: any[];
  // Escalation memories from other projects (CEO agent only)
  escalationMemories?: { project: string; content: string; role: string }[];
}
