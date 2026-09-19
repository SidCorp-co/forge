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

/** The sentence a caller gets for granting access on a provider no agent can reach. */
export function noAgentPathMessage(provider: string): string {
  return `\`${provider}\` declares no agent path, so there is nothing for an agent to be granted. Whether agents may use an integration is only a question for a provider core answers tools from, or one whose credential reaches the runner.`;
}

/** The sentence an agent-facing tool gives for a binding nobody has granted. */
export function notGrantedMessage(provider: string, bindingId: string): string {
  return `binding ${bindingId} (${provider}) is connected but no agent on this project may use it: its agent access is \`none\`. An org owner or admin turns it on where the integration is connected — Settings → Integrations — and connection health does not gate it.`;
}
