/**
 * ISS-1038 — the per-PROVIDER injection state behind
 * `GET /:projectId/integrations/mcp-injection`.
 *
 * The question this answers is the one an operator asks on the Integrations
 * tab: does this connected integration reach my agents, and if not, why, and
 * what do I press. Before this, the answer lived in `pipelineConfig.mcpServers`
 * — a map on another tab that no screen could write, while the integration
 * panel beside it reported `Connected`.
 *
 * It reads `projectDeclaredProviders`, the same projection `buildMcpPreview`
 * reads, so the per-binding row and the per-provider header cannot report
 * different things; that projection in turn mirrors the dispatcher's own merge
 * order, so neither can disagree with what a runner receives.
 *
 * Nothing secret is read or returned: the state is three booleans-worth of
 * `pipelineConfig` plus whether any binding exists.
 */
// cm:edge lockstep -> packages/core/src/integrations/mcp-preview-service.ts — both project the same declaration; a provider added to one is a provider the other stops describing

import type { McpInjectionProvider, McpInjectionProviderState } from '@forge/contracts';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import {
  INTEGRATION_SERVER_NAMES,
  type McpDeclarationSource,
  projectDeclaredProviders,
} from '../pipeline/mcp-catalog.js';
import { listBindingsForProject } from './store.js';

/** The providers a project may switch. Same list the dispatcher resolves. */
export const MCP_INJECTION_PROVIDERS = INTEGRATION_SERVER_NAMES;

/** True when `value` names a provider whose adapter injects an MCP server. */
export function isMcpInjectionProvider(value: string): value is McpInjectionProvider {
  return (MCP_INJECTION_PROVIDERS as readonly string[]).includes(value);
}

/** Read a project's `pipelineConfig` in the shape the projection walks. */
export async function readMcpDeclarationSource(projectId: string): Promise<McpDeclarationSource> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const pipelineConfig = (row?.agentConfig as { pipelineConfig?: unknown } | null)?.pipelineConfig;
  return (pipelineConfig ?? {}) as McpDeclarationSource;
}

/**
 * Per-provider: whether the project default declares it, which stages declare
 * it themselves, which stages turn it back off, and whether any binding backs
 * it at all.
 */
export async function buildMcpInjectionState(
  projectId: string,
): Promise<McpInjectionProviderState[]> {
  const [source, pairs] = await Promise.all([
    readMcpDeclarationSource(projectId),
    listBindingsForProject(projectId),
  ]);
  const declarations = projectDeclaredProviders(source, MCP_INJECTION_PROVIDERS);

  return declarations.map((d) => ({
    provider: d.provider as McpInjectionProvider,
    declaredDefault: d.declaredDefault,
    declaredStates: d.declaredStates,
    excludedStates: d.excludedStates,
    configured: pairs.some((p) => p.binding.provider === d.provider),
  }));
}
