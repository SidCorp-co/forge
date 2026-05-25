// MIRROR of packages/core/src/jobs/prompt-route.ts — keep in sync.
// Web cannot import @forge/core type-only without pulling drizzle into the
// browser bundle, so the envelope is restated here. Field names and casing
// must match the server response 1:1.

export interface ActualUsage {
  input: number;
  output: number;
  cached: number;
  cacheCreation: number;
  cost: number;
  count: number;
}

export interface ResolvedFlags {
  state: string | null;
  skillName: string | null;
  model: string | null;
  allowedTools: string | null;
  permissionMode: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | null;
  timeoutSeconds: number | null;
  sessionGroup: string | null;
  claudeSessionId: string | null;
  systemPromptMode: 'append' | 'replace' | null;
}

export interface PromptBlock {
  id: string;
  kind: 'system' | 'user';
  chars: number;
  estTokens: number;
}

export interface PromptEnvelope {
  jobId: string;
  systemPrompt: string | null;
  systemPromptHash: string | null;
  userPrompt: string | null;
  blocks: PromptBlock[];
  estTokens: { input: number | null };
  actualUsage: ActualUsage | null;
  mcpConfig: unknown;
  model: string | null;
  payloadExtras: Record<string, unknown>;
  resolvedFlags: ResolvedFlags;
}

export interface PromptArchivedResponse {
  archived: true;
  path: string;
}
