// Per-integration usage guidance surfaced into the pipeline system prompt
// (the "router" tier — see ISS-484). Data-driven so adding a new integration
// only edits THIS table, never the prompt-rendering code in
// `prompt/facts/resolve.ts`.
//
// Keep each `usage` SHORT (1-3 lines): which entry tool to reach for + one
// cardinal rule. A rich per-service playbook does NOT belong here — a long
// guide in the always-injected preamble taxes every job on a project that has
// the integration connected. That belongs in an on-demand reference skill;
// `guideSkill` is the forward pointer to it (ISS-484 Tier 2, not yet built).

export interface IntegrationUsage {
  /** Short router hint injected into the preamble when the provider is connected. */
  usage: string;
  /** Name of the on-demand reference skill carrying the full guide (ISS-484 Tier 2). */
  guideSkill?: string;
}

export const INTEGRATION_USAGE: Record<string, IntegrationUsage> = {
  coolify: {
    usage: 'Deploy / redeploy and poll deployment status via the `forge_coolify_deploy` tool.',
  },
  postman: {
    usage:
      'Run API collections / target requests via `forge_postman_target` and the `mcp__postman__*` tools.',
  },
  epodsystem: {
    usage:
      'Read store + theme context via `forge_storefront_target` and customize the storefront via the `mcp__epodsystem__*` shop tools. Always build on the DRAFT theme; publishing promotes draft → main.',
  },
};

const FALLBACK_USAGE = 'Project-specific integration.';

/** Short usage hint for a connected provider, or a generic fallback. */
export function getIntegrationUsage(provider: string): string {
  return INTEGRATION_USAGE[provider]?.usage ?? FALLBACK_USAGE;
}
