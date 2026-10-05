import type { BindingRole } from '../../db/schema.js';
import { integrationGuideSlug, loadOrgGuideProviders } from '../../guides/index.js';
import {
  effectiveConfig,
  getIntegration,
  grantHolds,
  listBindingsForProject,
} from '../../integrations/index.js';
import { readDeployMap } from '../../project-config/index.js';

export interface IntegrationRow {
  provider: string;
  role: BindingRole;
  /** The environment of the project document whose deployment names this binding. */
  environment: string | null;
  lastHealthStatus: string | null;
  /** The provider's own extra line, built from its declaration — see `IntegrationUsage.renderExtra`. */
  extraLine?: string | null;
  /** ISS-1071 — does this binding reach an agent at all? Renders as the reason where it does not. */
  agentGranted?: boolean;
  /** Operator text for THIS project's binding, rendered verbatim. */
  instructions?: string | null;
  /** The caller's org authored a runtime guide for this provider. */
  hasOrgGuide?: boolean;
}

export async function loadActiveIntegrationRows(
  projectId: string,
  orgId?: string | null,
): Promise<IntegrationRow[]> {
  const [pairs, deployMap] = await Promise.all([
    listBindingsForProject(projectId),
    readDeployMap(projectId),
  ]);
  const active = pairs.filter((p) => p.binding.active && p.connection.active);
  if (active.length === 0) return [];

  const orgGuides = orgId ? await loadOrgGuideProviders(orgId) : new Set<string>();

  return active.map((p) => ({
    provider: p.binding.provider,
    role: p.binding.role,
    environment: deployMap.environments.get(p.binding.id)?.name ?? null,
    lastHealthStatus: p.connection.lastHealthStatus,
    instructions: p.binding.instructions ?? null,
    hasOrgGuide: orgGuides.has(p.binding.provider),
    extraLine: getIntegration(p.binding.provider)?.usage?.renderExtra?.(effectiveConfig(p)) ?? null,
    agentGranted: grantHolds(getIntegration(p.binding.provider), p.binding),
  }));
}

/** What a provider with nothing of its own to say renders. */
const GENERIC_USAGE = 'Project-specific integration.';

/** The sentence a connected-but-ungranted binding renders in place of its usage hint. */
function ungrantedNote(provider: string): string {
  return `connected, but agents on this project may NOT use it: agent access is off for this \`${provider}\` binding. You will not be given its tools; do not treat their absence as a credential or auth fault, and do not retry. An org owner or admin turns it on beside the integration under Settings → Integrations.`;
}

function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

export function renderIntegrations(rows: IntegrationRow[], projectId: string): string {
  if (rows.length === 0) {
    return '## Project integrations\nNo external integrations are connected to this project.';
  }
  const lines = rows.map((r) => {
    const decl = getIntegration(r.provider);
    const hint = decl?.usage?.hint ?? GENERIC_USAGE;
    const health = r.lastHealthStatus ? ` (health: ${r.lastHealthStatus})` : '';
    const guideSlug = r.hasOrgGuide ? integrationGuideSlug(r.provider) : decl?.usage?.guideSlug;
    const guidePointer = guideSlug
      ? ` Full guide: \`forge-runner api projects/${projectId}/guides/${guideSlug}.md\`.`
      : '';
    const scope = r.role === 'deploy' ? (r.environment ?? 'deploy') : r.role;
    const body = r.agentGranted === false ? ungrantedNote(r.provider) : `${hint}${guidePointer}`;
    const bullet = `- **${r.provider}** [${scope}]${health} — ${body}`;
    const extra: string[] = [];
    if (r.agentGranted !== false && r.extraLine) extra.push(r.extraLine);
    const instructions = r.instructions?.trim();
    if (instructions) {
      extra.push(
        `  - Project-specific instructions for **${r.provider}** (follow these over the general guide where they conflict):\n${indentBlock(instructions)}`,
      );
    }
    return extra.length > 0 ? `${bullet}\n${extra.join('\n')}` : bullet;
  });
  return `## Project integrations\nConnected integrations and how to use them:\n${lines.join('\n')}`;
}
