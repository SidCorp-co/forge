/**
 * Mirrors `app_config` row from `forge/core/src/db/schema.ts`. Re-typed here
 * because `@forge/contracts` does not export AppConfig today.
 */
export interface AppConfig {
  id: string;
  projectId: string;
  chatProviderId: string | null;
  chatModel: string | null;
  retrievalTopK: number;
  retrievalMinScore: number;
  enabledChannels: string[];
  systemPromptOverride: string | null;
  lastBackfillAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppConfigPatch {
  chatProviderId?: string | null;
  chatModel?: string | null;
  retrievalTopK?: number;
  retrievalMinScore?: number;
  enabledChannels?: string[];
  systemPromptOverride?: string | null;
}
