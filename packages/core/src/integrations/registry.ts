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

/**
 * An EMPTY registry is never a legitimate state to read from, so reading one throws.
 *
 * Without this, every derived question answers something that looks like data: `providerNames()`
 * returns `[]`, `deployCapableProviders()` returns `[]`, and the refusal a caller gets reads
 * "Deploy-capable providers: ." — a sentence that names the empty set as though it were the answer.
 * The process that forgot to call `registerAllIntegrations()` then refuses every provider in the
 * product with a message blaming the provider. That is the silent substitution this whole issue
 * exists to delete, reintroduced one layer down: the failure has to name its own cause instead.
 *
 * `getIntegration` is on this list for the same reason. `undefined` there means "no such provider"
 * and is acted on as such by the schema door; an unpopulated registry would make every provider
 * mean that.
 */
function assertPopulated(): void {
  if (registry.size > 0) return;
  throw new Error(
    'integration registry is empty — registerAllIntegrations() was never called in this process. ' +
      'Every provider would otherwise read as undeclared. Production registers in src/index.ts; a ' +
      'test that reaches a registry-backed path registers in its own setup.',
  );
}

export function registerIntegration(decl: IntegrationDeclaration): void {
  if (registry.has(decl.provider)) {
    throw new Error(`integration already declared for provider=${decl.provider}`);
  }
  registry.set(decl.provider, decl);
}

/**
 * Is this provider already declared? The one read that does NOT assert the registry is populated,
 * because the registrar asks it WHILE filling an empty registry. Not a substitute for
 * `getIntegration` anywhere else: it cannot tell a caller what the provider declares, only that
 * something did.
 */
export function isRegistered(provider: string): boolean {
  return registry.has(provider as IntegrationProvider);
}

export function getIntegration(provider: string): IntegrationDeclaration | undefined {
  assertPopulated();
  return registry.get(provider as IntegrationProvider);
}

export function listIntegrations(): IntegrationDeclaration[] {
  assertPopulated();
  return [...registry.values()];
}

/** Every provider name this deployment declares, for a refusal that names the legal set. */
export function providerNames(): IntegrationProvider[] {
  assertPopulated();
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
  assertPopulated();
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
