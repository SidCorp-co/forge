import type { IntegrationAdapter, IntegrationProvider } from './types.js';

const registry = new Map<IntegrationProvider, IntegrationAdapter>();

export function registerAdapter(adapter: IntegrationAdapter): void {
  if (registry.has(adapter.provider)) {
    throw new Error(`integration adapter already registered for provider=${adapter.provider}`);
  }
  registry.set(adapter.provider, adapter);
}

export function getAdapter(provider: string): IntegrationAdapter | undefined {
  return registry.get(provider as IntegrationProvider);
}

export function listAdapters(): IntegrationAdapter[] {
  return [...registry.values()];
}

/** Test-only — drops all registered adapters so tests can re-register cleanly. */
export function __resetRegistry(): void {
  registry.clear();
}
