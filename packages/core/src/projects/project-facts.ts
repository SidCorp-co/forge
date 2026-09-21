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
  return `⚠️ \`{{project:${key}}}\` resolves to nothing: project prose moved out of \`agentConfig.projectFacts\` into the knowledge store (ISS-1048). Fetch it where you need it with \`forge_knowledge\` (action \`get\`, slug \`${key}\`), and remove this reference from the skill body.`;
}

export const RETIRED_PROJECT_FACTS_MESSAGE =
  'agentConfig.projectFacts has been removed — project prose lives in knowledge_entries, which models the same text with a kind, a confidence, an author, an embedding and a three-valued injection setting. Write it with the forge_knowledge tool (action `write`), or PUT /api/projects/:id/knowledge/:slug, and remove projectFacts from this request. Migration 0254 already moved every key this project held.';

export const RETIRED_PROJECT_FACTS_CONFIG_MESSAGE =
  'agentConfig.projectFactsConfig has been removed — the always-inject flag it held is now the `injection` field on the knowledge entry itself, which takes `always`, `on_demand` or `none` rather than a boolean in a second map. Set it with the forge_knowledge tool (action `write`), or PUT /api/projects/:id/knowledge/:slug, and remove projectFactsConfig from this request.';

export const ALWAYS_INJECT_MAX_CHARS = 6000;

export const ALWAYS_INJECT_GUARANTEE_NOTE =
  'Flagging a fact always-inject guarantees it is READ, never that it was DONE: the body ' +
  'reaches every agent prompt, and nothing checks whether the agent followed it.';

export const ALWAYS_INJECT_ENFORCEMENT_NOTE =
  'No gate refuses a step that ignored an always-inject rule, no step is asked whether it ' +
  'complied, and no surface counts how often one was obeyed; what was injected is visible ' +
  'afterwards on the job, whether it was followed is recorded nowhere. No obligation on this ' +
  'deployment has a readback today: the one that did was the UX contract, whose rules carried ' +
  'ids for agents to cite back, and ISS-1068 retired it because in sixteen days of always ' +
  'injecting it on twelve projects it was cited back zero times. So the price is known and ' +
  'nobody is paying it: write the rule so that an agent following it leaves evidence a human ' +
  'can look at, and expect no gate to ask for that evidence.';
