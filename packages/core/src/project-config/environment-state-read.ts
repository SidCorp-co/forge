import { PROBE_TIMEOUT_MS } from '../lib/runtime-probe.js';
import { deployAdapterForBinding } from './deploy-adapters/index.js';
import { type EnvironmentStateDeps, resolveEnvironmentState } from './environment-state.js';
import type { NamedEnvironment } from './release-path.js';
import type { EnvironmentState, ProjectDocument } from './schema.js';

const PLATFORM_TIMEOUT_MS = 10_000;

export const environmentStateDeps = (projectId: string): EnvironmentStateDeps => ({
  deployAdapterFor: (bindingId) =>
    deployAdapterForBinding(projectId, bindingId, PLATFORM_TIMEOUT_MS),
  fetch,
  probeTimeoutMs: PROBE_TIMEOUT_MS,
});

/** What one declared environment runs now, read off its deployment record. */
export function readEnvironmentState(
  projectId: string,
  document: ProjectDocument,
  env: NamedEnvironment,
  deps: EnvironmentStateDeps = environmentStateDeps(projectId),
): Promise<EnvironmentState> {
  return resolveEnvironmentState(
    env.name,
    env.declaration,
    { sourceType: document.source.type },
    deps,
  );
}
