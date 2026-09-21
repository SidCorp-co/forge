import type {
  AdapterContext,
  IntegrationAdapterMethods,
  IntegrationDeclaration,
  IntegrationProvider,
  OutboundDispatchInput,
  OutboundDispatchResult,
} from './types.js';

const registry = new Map<IntegrationProvider, IntegrationDeclaration>();

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

export function providerCanDeploy(provider: string): boolean {
  return getIntegration(provider)?.capabilities.canDeploy === true;
}

/** Every declaration whose credential is rendered into a runner's MCP config. */
export function directMcpIntegrations(): IntegrationDeclaration[] {
  return listIntegrations().filter((d) => d.capabilities.agentPath.kind === 'direct-mcp');
}

export function mcpServerNameFor(decl: IntegrationDeclaration, label: string): string | null {
  const path = decl.capabilities.agentPath;
  if (path.kind !== 'direct-mcp') return null;
  if (!decl.capabilities.multiBinding || label === '') return path.serverName;
  return `${path.serverName}_${label.replace(/-/g, '_')}`;
}

/** Whether this provider's adapter implements core's outbound call. */
export function providerImplementsDispatch(provider: string): boolean {
  return typeof getIntegration(provider)?.adapter?.dispatchOutbound === 'function';
}

export async function dispatchThrough(
  provider: string,
  ctx: AdapterContext,
  input: OutboundDispatchInput,
): Promise<OutboundDispatchResult> {
  const decl = getIntegration(provider);
  if (!decl) {
    throw new Error(
      `${provider} is not a provider this deployment declares — declared: ${providerNames().join(', ')}`,
    );
  }
  const dispatch = decl.adapter?.dispatchOutbound;
  if (!dispatch) {
    throw new Error(
      `${provider} implements no outbound dispatch — it declares canDispatch: ${decl.capabilities.canDispatch === true}, and nothing in core can make an API call on its behalf`,
    );
  }
  return dispatch(ctx, input);
}

/** Test-only — drops every declaration so tests can re-register cleanly. */
export function __resetRegistry(): void {
  registry.clear();
}
