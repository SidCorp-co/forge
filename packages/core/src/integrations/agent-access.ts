/**
 * Whether an agent working a project may use one of its integrations — the ONE switch, on the
 * binding, asked where the integration is connected.
 *
 * What it replaced: a sentinel key in `pipelineConfig.mcpServers`, a map on a different settings
 * tab, read only by three per-provider resolvers. A binding could report Connected and healthy and
 * reach no agent, and the only surface that edited that map offered a catalog of two secret-free
 * servers whose add-custom form refused the sentinel's only legal value. This module is the whole
 * of the replacement: the grant is a column, the gate is a function, and both are asked at the
 * agent boundary and nowhere else.
 */

import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrationBindings, integrationConnections } from '../db/schema.js';
import { getIntegration } from './registry.js';
import type { BindingWithConnection } from './store.js';
import type { AgentPathKind, IntegrationDeclaration } from './types.js';

/**
 * Two values and no more. Per-tool scoping within a provider is a different question and this
 * deliberately cannot express it: a third value would be a scope nothing reads, which is how the
 * sentinel became a switch nobody could find.
 */
export const AGENT_ACCESS_VALUES = ['none', 'all'] as const;
export type AgentAccess = (typeof AGENT_ACCESS_VALUES)[number];

/** The closed answer, which is what a binding gets for not choosing. */
export const AGENT_ACCESS_CLOSED: AgentAccess = 'none';

export function isAgentAccess(value: unknown): value is AgentAccess {
  return (AGENT_ACCESS_VALUES as readonly unknown[]).includes(value);
}

/**
 * Does this binding reach an agent at all?
 *
 * False for a provider declaring no agent path however the column reads — the column is inert
 * there, and a grant stored on a rocketchat binding by some future careless write must not become
 * a path that did not exist.
 */
export function grantHolds(
  decl: Pick<IntegrationDeclaration, 'capabilities'> | undefined,
  binding: { agentAccess: string },
): boolean {
  if (!decl || decl.capabilities.agentPath.kind === 'none') return false;
  return binding.agentAccess === 'all';
}

/** Which authorization tier a write to this binding's grant takes. */
// cm:guard ISS-1071 rule 5 — a `direct-mcp` grant hands a PROJECT'S CREDENTIAL to a runner box, so
// it takes the org-admin escalation that already guards `active`, `secrets` and `config` on an
// org-owned connection. A `core-mediated` grant only widens which caller may ask core to make a
// call core was already making, so it stays with the project-admin fields. Collapsing the two to
// one tier gets it wrong in one direction or the other: project-admin everywhere lets a project
// admin export an org's shared credential, org-admin everywhere makes a project admin unable to
// turn on a tool Forge performs on their behalf.
export function agentAccessTier(
  decl: Pick<IntegrationDeclaration, 'capabilities'> | undefined,
): 'project-admin' | 'org-admin' | 'refused' {
  const kind: AgentPathKind | undefined = decl?.capabilities.agentPath.kind;
  if (!decl || kind === 'none' || kind === undefined) return 'refused';
  return kind === 'direct-mcp' ? 'org-admin' : 'project-admin';
}

/** The sentence a caller gets for granting access on a provider no agent can reach. */
export function noAgentPathMessage(provider: string): string {
  return `\`${provider}\` declares no agent path, so there is nothing for an agent to be granted. Whether agents may use an integration is only a question for a provider core answers tools from, or one whose credential reaches the runner.`;
}

/** The sentence an agent-facing tool gives for a binding nobody has granted. */
export function notGrantedMessage(provider: string, bindingId: string): string {
  return `binding ${bindingId} (${provider}) is connected but no agent on this project may use it: its agent access is \`none\`. An org owner or admin turns it on where the integration is connected — Settings → Integrations — and connection health does not gate it.`;
}

/**
 * Every binding of one provider on one project that an agent may actually use: granted, with both
 * tiers active and a credential stored, oldest first.
 *
 * Oldest-first because a provider that does NOT declare `multiBinding` takes row zero as its one
 * winner, and that pick has to be stable across dispatches.
 */
export async function listAgentGrantedBindings(
  projectId: string,
  provider: string,
): Promise<BindingWithConnection[]> {
  const decl = getIntegration(provider);
  if (!decl || decl.capabilities.agentPath.kind === 'none') return [];
  const rows = await db
    .select({ binding: integrationBindings, connection: integrationConnections })
    .from(integrationBindings)
    .innerJoin(
      integrationConnections,
      eq(integrationBindings.connectionId, integrationConnections.id),
    )
    .where(
      and(
        eq(integrationBindings.projectId, projectId),
        eq(integrationBindings.provider, provider),
        eq(integrationBindings.active, true),
        eq(integrationBindings.agentAccess, 'all'),
        eq(integrationConnections.active, true),
      ),
    )
    .orderBy(asc(integrationBindings.createdAt));
  return rows as BindingWithConnection[];
}
