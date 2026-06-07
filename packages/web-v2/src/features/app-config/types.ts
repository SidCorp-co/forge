// web-v2 feature module: app-config — local TS types.
//
// Mirrors the `app_config` row from `packages/core/src/db/schema.ts`, re-typed
// here because `@forge/contracts` does not export AppConfig (same reasoning as
// the v1 `packages/web/src/features/app-config/types.ts`). web-v2 keeps its OWN
// local types — keep field names verbatim in sync with core, since the shared
// `apiClient<T>` is generic and won't catch a drift at compile time.

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

/** Partial upsert body for `PUT /api/app-config/:projectId`. Only the keys
 *  present are written (insert-on-conflict on the server). */
export interface AppConfigPatch {
  chatProviderId?: string | null;
  chatModel?: string | null;
  retrievalTopK?: number;
  retrievalMinScore?: number;
  enabledChannels?: string[];
  systemPromptOverride?: string | null;
}
