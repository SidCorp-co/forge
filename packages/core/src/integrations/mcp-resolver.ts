/**
 * The one place a project's granted integrations become MCP server entries for a runner.
 *
 * It replaced three near-identical `apply*McpServers` functions and the private resolver array that
 * listed them. Each of those read a sentinel key out of `pipelineConfig.mcpServers`, stripped it,
 * and injected only when it found its own name set to literal `true` — so "may this agent use this
 * integration" was answered in a map on another settings tab that no connect surface could write.
 * The question is now a column on the binding and this walks the registry to ask it.
 *
 * Credentials are decrypted here and rendered ONLY into the returned map, which the dispatch path
 * hands to the runner as a temp `--mcp-config`. Nothing here is persisted, logged or returned by an
 * API.
 */

import { logger } from '../logger.js';
import { listAgentGrantedBindings } from './agent-access.js';
import { directMcpIntegrations, mcpServerNameFor } from './registry.js';
import { decryptConnectionSecrets, effectiveConfig } from './store.js';
import type { IntegrationDeclaration } from './types.js';

/**
 * Every MCP entry this project's granted bindings render, keyed by server name.
 *
 * A binding whose credential cannot be decrypted is SKIPPED with a warning and the rest still
 * resolve — one unreadable key must not cost a dispatch every other server it was owed. A provider
 * that does not declare `multiBinding` takes its oldest granted binding and no other, which is the
 * pick `listAgentGrantedBindings` orders for.
 */
export async function resolveGrantedMcpEntries(
  projectId: string,
): Promise<Record<string, Record<string, unknown>>> {
  const entries: Record<string, Record<string, unknown>> = {};
  for (const decl of directMcpIntegrations()) {
    let pairs: Awaited<ReturnType<typeof listAgentGrantedBindings>>;
    try {
      pairs = await listAgentGrantedBindings(projectId, decl.provider);
    } catch (err) {
      // cm:guard injection is best-effort against the DATABASE and never against the grant: a lookup
      // that fails injects nothing, which is the closed answer, so a hiccup cannot widen what an
      // agent reaches. It must also never crash a dispatch.
      logger.warn(
        { err, projectId, provider: decl.provider },
        'mcp-resolver: granted-binding lookup failed, skipping inject',
      );
      continue;
    }
    const usable = decl.capabilities.multiBinding ? pairs : pairs.slice(0, 1);
    for (const pair of usable) {
      if (!pair.connection.secretsEnc) continue;
      const label = ((pair.binding as Record<string, unknown>).label as string) ?? '';
      const serverName = mcpServerNameFor(decl, label);
      if (!serverName) continue;
      try {
        const secrets = decryptConnectionSecrets<Record<string, unknown>>(pair.connection);
        if (!secrets) continue;
        const path = decl.capabilities.agentPath;
        if (path.kind !== 'direct-mcp') continue;
        const entry = path.buildEntry(effectiveConfig(pair), secrets);
        if (entry) entries[serverName] = entry;
      } catch (err) {
        logger.warn(
          {
            err,
            projectId,
            provider: decl.provider,
            connectionId: pair.connection.id,
            bindingId: pair.binding.id,
            serverName,
          },
          'mcp-resolver: decrypt failed for binding, skipping',
        );
      }
    }
  }
  return entries;
}

/**
 * Lay this project's granted integration entries over a resolved `mcpServers` map.
 *
 * Integrations win a name collision with a catalog server, which is the order the three resolvers
 * this replaced already had.
 */
export async function applyGrantedMcpServers(
  projectId: string,
  current: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  const entries = await resolveGrantedMcpEntries(projectId);
  if (Object.keys(entries).length === 0) return current;
  return { ...(current ?? {}), ...entries };
}

/** The server names a project's granted bindings WOULD render, without decrypting anything. */
export function declaredServerNames(
  decl: IntegrationDeclaration,
  labels: readonly string[],
): string[] {
  const names: string[] = [];
  for (const label of labels) {
    const name = mcpServerNameFor(decl, label);
    if (name) names.push(name);
  }
  return names;
}
