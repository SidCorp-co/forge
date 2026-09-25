import { logger } from '../logger.js';
import { listAgentGrantedBindings } from './agent-access-store.js';
import { directMcpIntegrations, mcpServerNameFor } from './registry.js';
import { decryptConnectionSecrets, effectiveConfig } from './store.js';
import type { IntegrationDeclaration } from './types.js';

export interface ProducedMcpServer {
  name: string;
  bindingId: string;
}

export async function resolveGrantedMcpEntries(
  projectId: string,
  produced?: ProducedMcpServer[],
): Promise<Record<string, Record<string, unknown>>> {
  const entries: Record<string, Record<string, unknown>> = {};
  for (const decl of directMcpIntegrations()) {
    let pairs: Awaited<ReturnType<typeof listAgentGrantedBindings>>;
    try {
      const rows = await listAgentGrantedBindings(projectId, decl.provider);
      // The shape check is INSIDE the try on purpose. The guard below promises this never crashes a
      // dispatch, and until ISS-1071 caught it the `.slice` sat outside, so a lookup that answered
      // something other than a list took the whole dispatch down instead of taking the closed
      // answer — the guard said one thing and the code did another.
      if (!Array.isArray(rows)) {
        throw new TypeError(
          `granted-binding lookup for ${decl.provider} answered ${typeof rows}, not a list`,
        );
      }
      pairs = rows;
    } catch (err) {
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
      // First claim on a name keeps it: `usable` is granted order, oldest first, so a colliding
      // binding never displaces the one already serving agents. The preview calls it `shadowed`.
      if (serverName in entries) continue;
      try {
        const secrets = decryptConnectionSecrets<Record<string, unknown>>(pair.connection);
        if (!secrets) continue;
        const path = decl.capabilities.agentPath;
        if (path.kind !== 'direct-mcp') continue;
        const entry = path.buildEntry(effectiveConfig(pair), secrets);
        if (entry) {
          entries[serverName] = entry;
          produced?.push({ name: serverName, bindingId: pair.binding.id });
        }
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

/** What {@link applyGrantedMcpServers} laid down, and under which names. */
export interface GrantedMcpApplication {
  map: Record<string, unknown> | null;
  /** Every name this pass produced, each carrying the binding that produced it. One can be absent
   *  though its binding is active, credentialed, granted and unshadowed, and two bindings of one
   *  provider can land on one name, so neither a name nor its absence identifies a binding. */
  produced: ProducedMcpServer[];
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
): Promise<GrantedMcpApplication> {
  const produced: ProducedMcpServer[] = [];
  const entries = await resolveGrantedMcpEntries(projectId, produced);
  if (produced.length === 0) return { map: current, produced };
  return { map: { ...(current ?? {}), ...entries }, produced };
}

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
