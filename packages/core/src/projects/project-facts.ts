export const RESERVED_PROJECT_FACT_KEYS = [
  'base-branch',
  'live-branch',
  'production-branch',
  'repo-path',
  'test-urls',
  'test-creds',
  'test-notes',
  'integrations',
] as const;

export function unreservedProjectKeyRefusal(key: string): string {
  return `⚠️ \`{{project:${key}}}\` resolves to nothing: project prose moved out of \`agentConfig.projectFacts\` into the knowledge store (ISS-1048). Fetch it where you need it with \`GET /api/projects/:id/knowledge/${key}\`, and remove this reference from the skill body.`;
}

export const RETIRED_PROJECT_FACTS_MESSAGE =
  'agentConfig.projectFacts has been removed — project prose lives in knowledge_entries, which models the same text with a kind, a confidence, an author, an embedding and a three-valued injection setting. Write it with PUT /api/projects/:id/knowledge/:slug, and remove projectFacts from this request. Migration 0254 already moved every key this project held.';

export const RETIRED_PROJECT_FACTS_CONFIG_MESSAGE =
  'agentConfig.projectFactsConfig has been removed — the always-inject flag it held is now the `injection` field on the knowledge entry itself, which takes `always`, `on_demand` or `none` rather than a boolean in a second map. Set it with PUT /api/projects/:id/knowledge/:slug, and remove projectFactsConfig from this request.';
