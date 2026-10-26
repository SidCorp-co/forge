import { WHO_ADMINS, WHO_ORG_ADMINS } from '../lib/authz.js';
import { connectionCalled, providerLabel } from './health-words.js';
import { getIntegration } from './registry.js';
import type { AgentPathKind, IntegrationDeclaration } from './types.js';

export const AGENT_ACCESS_VALUES = ['none', 'all'] as const;
export type AgentAccess = (typeof AGENT_ACCESS_VALUES)[number];

/** The closed answer, which is what a binding gets for not choosing. */
export const AGENT_ACCESS_CLOSED: AgentAccess = 'none';

export function isAgentAccess(value: unknown): value is AgentAccess {
  return (AGENT_ACCESS_VALUES as readonly unknown[]).includes(value);
}

export function grantHolds(
  decl: Pick<IntegrationDeclaration, 'capabilities'> | undefined,
  binding: { agentAccess: string },
): boolean {
  if (!decl || decl.capabilities.agentPath.kind === 'none') return false;
  return binding.agentAccess === 'all';
}

/** Which authorization tier a write to this binding's grant takes. */
export function agentAccessTier(
  decl: Pick<IntegrationDeclaration, 'capabilities'> | undefined,
): 'project-admin' | 'org-admin' | 'refused' {
  const kind: AgentPathKind | undefined = decl?.capabilities.agentPath.kind;
  if (!decl || kind === 'none' || kind === undefined) return 'refused';
  return kind === 'direct-mcp' ? 'org-admin' : 'project-admin';
}

/** The sentence a caller gets for granting access on a provider no agent can reach, in a reader's words. */
export function noAgentPathMessage(provider: string): string {
  const keyless = !getIntegration(provider)?.schemas.primaryCredentialField;
  const credential = keyless ? '' : ' and never sends its credential to a runner box';
  return `No agent can use ${providerLabel(provider)}: Forge gives agents no tools for it${credential}, so there is no agent access to grant on it.`;
}

/** An agent's call through an ungranted binding: the provider by its label, the switch, and who
 *  may turn it on by the rule the binding PATCH enforces (ISS-1421 r31, judge-127 on 348). */
export function notGrantedMessage(
  provider: string,
  connection?: { displayName: string | null; provider: string },
): string {
  const label = providerLabel(provider);
  const who =
    agentAccessTier(getIntegration(provider)) === 'org-admin' ? WHO_ORG_ADMINS : WHO_ADMINS;
  const through = connection ? ` through ${connectionCalled(connection)}` : '';
  return `This project's ${label} binding${through} is connected, but no agent on this project may use it: its "Agents on this project may use this" switch is off. Only ${who} can switch it on, in the ${label} drawer on this project's Integrations tab.`;
}
