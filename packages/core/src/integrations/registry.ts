/**
 * The one door onto what this deployment knows about a provider.
 *
 * Every generic path — schema dispatch, MCP resolution, status cards, health sweep, the prompt
 * renderer, the two conformance checkers — asks a question here rather than naming a provider. The
 * unit is a DECLARATION rather than an adapter because `agent` has schemas and an agent path and no
 * adapter methods at all, so a registry keyed on adapters could never be the whole vocabulary.
 */

import type {
  IntegrationAdapterMethods,
  IntegrationDeclaration,
  IntegrationProvider,
} from './types.js';

const registry = new Map<IntegrationProvider, IntegrationDeclaration>();

export function registerIntegration(decl: IntegrationDeclaration): void {
  if (registry.has(decl.provider)) {
    throw new Error(`integration already declared for provider=${decl.provider}`);
  }
  registry.set(decl.provider, decl);
}

export function getIntegration(provider: string): IntegrationDeclaration | undefined {
  return registry.get(provider as IntegrationProvider);
}

export function listIntegrations(): IntegrationDeclaration[] {
  return [...registry.values()];
}

/** Every provider name this deployment declares, for a refusal that names the legal set. */
export function providerNames(): IntegrationProvider[] {
  return [...registry.keys()];
}

/**
 * The adapter METHODS for a provider, or undefined where the provider integrates nothing.
 *
 * Deliberately not named `getAdapter(...) -> declaration`: a caller asking for an adapter wants
 * something it can call, and answering with an object that has no methods is the affordance defect
 * this repo refuses. `agent` answers `undefined` here, which every caller already guards.
 */
export function getAdapter(provider: string): IntegrationAdapterMethods | undefined {
  return registry.get(provider as IntegrationProvider)?.adapter;
}

/** Every provider Forge can push code or content TO, derived rather than listed. */
export function deployCapableProviders(): IntegrationProvider[] {
  return listIntegrations()
    .filter((d) => d.capabilities.canDeploy)
    .map((d) => d.provider);
}

// cm:guard this reads a DECLARED capability and is NOT a release-gate discriminator — the direction
// is what keeps it on the right side of `release-batch/gate.ts`'s prohibition: that guard forbids
// provider identity from making a binding a release target, and this only refuses one that could
// never be. A sentry binding is not a place code goes on ANY project, so `role: 'deploy'` on it is a
// caller error to be named rather than a declaration to store. What it must never become is a rule
// saying an epodsystem binding IS a deploy — that is the project owner's declaration, and forge-dev
// carries one purely to hand agents the storefront MCP.
export function providerCanDeploy(provider: string): boolean {
  return getIntegration(provider)?.capabilities.canDeploy === true;
}

/** Every declaration whose credential is rendered into a runner's MCP config. */
export function directMcpIntegrations(): IntegrationDeclaration[] {
  return listIntegrations().filter((d) => d.capabilities.agentPath.kind === 'direct-mcp');
}

/**
 * The MCP server name one binding of one provider renders under.
 *
 * THE one place the label suffix rule lives. Until ISS-1071 it was written out four times — the
 * epodsystem resolver's `labelToMcpSuffix`, that resolver's `startsWith('epodsystem_')` gate,
 * `isIntegrationSentinelName`'s prefix test, and an inline `label.replace(/-/g,'_')` in the preview
 * service — and every one of them named epodsystem, so a second multi-binding provider would have
 * had to be added to all four.
 */
export function mcpServerNameFor(decl: IntegrationDeclaration, label: string): string | null {
  const path = decl.capabilities.agentPath;
  if (path.kind !== 'direct-mcp') return null;
  if (!decl.capabilities.multiBinding || label === '') return path.serverName;
  return `${path.serverName}_${label.replace(/-/g, '_')}`;
}

/** Test-only — drops every declaration so tests can re-register cleanly. */
export function __resetRegistry(): void {
  registry.clear();
}
