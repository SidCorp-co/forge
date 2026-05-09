export type AIProvider = "anthropic" | "openai" | "gemini";

export interface RepoConfig {
  name: string;
  path: string;
  branch: string;
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

export interface Project {
  id: number;
  documentId: string;
  slug: string;
  name: string;
  description: string;
  defaultProvider: AIProvider;
  openIssuesCount?: number;
  runningAgents?: number;
  apiKey?: string;
  repos?: RepoConfig[];
  knowledgeIndex?: Record<string, KnowledgeIndex>;
  repoPath?: string;
  baseBranch?: string;
  productionBranch?: string;
  sentryProject?: string;
}

export type IssueStatus =
  | "draft"
  | "open"
  | "confirmed"
  | "clarified"
  | "waiting"
  | "approved"
  | "in_progress"
  | "developed"
  | "deploying"
  | "testing"
  | "staging"
  | "released"
  | "closed"
  | "reopen"
  | "on_hold"
  | "needs_info";

export type IssuePriority = "critical" | "high" | "medium" | "low" | "none";

export interface IssueHistoryEntry {
  field: string;
  from: string | null;
  to: string;
  at: string;
  by: string;
}

export interface Issue {
  id: number;
  documentId: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  category: string | null;
  reportedBy: string | null;
  acceptanceCriteria: string | null;
  suggestedSolution: string | null;
  aiSummary: string | null;
  aiSuggestedSolution: string | null;
  aiAcceptanceCriteria: string[] | null;
  aiConfidence: number | null;
  plan: string | null;
  isAgentTask: boolean;
  agentStatus: "idle" | "running" | "completed" | "failed" | null;
  agentLog: unknown[] | null;
  changeHistory: IssueHistoryEntry[];
  attachments: { id: number; url: string; mime: string; name: string }[] | null;
  project?: Project;
  tasks?: Task[];
  comments?: Comment[];
  agentSessions?: { id: number; documentId: string; title: string; status: string; createdAt: string }[];
  createdAt: string;
  relations?: { type: string; targetDocumentId: string; reason?: string; targetId?: number; targetTitle?: string; targetStatus?: string }[];
  updatedAt: string;
}

export interface Comment {
  id: number;
  documentId: string;
  body: string;
  author: string;
  isAI: boolean;
  parent: { id: number; documentId: string } | null;
  replies: Comment[];
  mentions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: number;
  documentId: string;
  title: string;
  description: string;
  status: "backlog" | "todo" | "in_progress" | "in_review" | "done";
  priority: IssuePriority;
  assignee: string | null;
  isAgentTask: boolean;
  agentStatus: "idle" | "running" | "completed" | "failed" | null;
  agentLog: unknown[] | null;
  acceptanceCriteria: string[] | null;
  issue?: { id: number; documentId: string; title: string } | null;
  project?: { id: number; documentId: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  output?: string;
}

export interface AgentTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface ContentBlock {
  type: "text" | "tool" | "todos";
  text?: string;
  toolCall?: ToolCall;
  todos?: AgentTodo[];
}

export interface AgentMessage {
  id: string;
  type: "assistant" | "tool_use" | "tool_result" | "system" | "user";
  timestamp: number;
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  toolCalls?: ToolCall[];
  blocks?: ContentBlock[];
  subtype?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface McpServerConfig {
  // Local stdio server
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // Remote HTTP server
  type?: "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
  // Common
  enabled?: boolean;
}

export type SkillType = "guide" | "full";

export interface SkillLibraryEntry {
  name: string;
  description: string;
  version: string;
  gitUrl?: string;
  subfolder?: string;
  sourcePath: string;
  contentHash?: string;
  skillType: SkillType;
}

// Skill types removed — desktop only handles execution via WebSocket push

export interface ProjectConfig {
  slug: string;
  repoPath: string;
  branch?: string;
  instructions?: string;
  repos?: RepoConfig[];
  mcpServers?: Record<string, McpServerConfig>;
  enabledSkills?: string[];
  enabledMcpServers?: string[];
}

export interface AppConfig {
  coreUrl: string;
  authToken: string;
  deviceId: string;
  /** Parent directory for auto-created project folders (e.g. ~/forge-projects) */
  projectsRoot?: string;
  projects: Record<string, ProjectConfig>;
  skillLibrary?: Record<string, SkillLibraryEntry>;
  mcpLibrary?: Record<string, McpServerConfig>;
}

export type AgentSchedule = 'off' | 'weekly' | 'biweekly' | 'monthly';
export type AgentApprovalMode = 'preview' | 'auto-create';

export interface AgentDefinition {
  id: number;
  documentId: string;
  name: string;
  type: string;
  description: string | null;
  promptTemplate: string;
  reindexPromptTemplate: string | null;
  focusAreas: string[];
  customInstructions: string | null;
  schedule: AgentSchedule;
  approvalMode: AgentApprovalMode;
  maxProposals: number;
  excludeCategories: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: number;
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
  knowledge: string | null;
  memory: string | null;
  definition?: AgentDefinition | null;
  createdAt: string;
  updatedAt: string;
}

export type KanbanColumn = Task["status"];

export interface IssueFormData {
  title: string;
  description: string;
  priority: IssuePriority;
  attachments?: number[]; // packages/core ignores; kept for back-compat with callers
}

export interface UsageDailyRecord {
  date: string;
  input: number;
  output: number;
  cost: number;
  requests: number;
}

export interface UsageModelRecord {
  model: string;
  input: number;
  output: number;
  cost: number;
  requests: number;
}

export interface UsageSourceRecord {
  source: string;
  input: number;
  output: number;
  cost: number;
  requests: number;
}

export interface UsageSummary {
  totals: { inputTokens: number; outputTokens: number; estimatedCost: number; requests: number };
  daily: UsageDailyRecord[];
  byModel: UsageModelRecord[];
  bySource: UsageSourceRecord[];
}

export interface UsageRecordInput {
  source: "cli" | "api" | "desktop";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requestCount: number;
  sessionId?: string;
  recordedAt: string;
}

export type NotificationType = "issue_status_changed" | "comment_added" | "agent_completed" | "mention" | "pm_escalation";

export interface Notification {
  id: string;
  userId: string;
  projectId: string | null;
  type: NotificationType;
  title: string;
  body: string | null;
  read: boolean;
  issueId: string | null;
  agentSessionId: string | null;
  createdAt: string;
}

// Mirror of packages/core's jobEventKinds enum (packages/core/src/db/schema.ts).
export type JobEventKind = "stdout" | "stderr" | "tool_call" | "tool_result" | "progress" | "result";

export type JobType = "plan" | "code" | "review" | "fix" | "triage";

export interface JobAssignedPayload {
  jobId: string;
  projectId: string;
  issueId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
  dispatchedAt?: string;
  /**
   * Linked `agent_sessions` row id (optional). When present, the runner uses
   * it to PATCH the canonical session row on completion (messages,
   * claudeSessionId, diff). Absent for older server builds and legacy paths.
   */
  agentSessionId?: string | null;
}
