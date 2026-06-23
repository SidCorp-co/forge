/**
 * ISS-387 / ISS-558 — dispatch-time Epodsystem MCP resolver.
 *
 * Bridge between the integration config layer and the existing
 * mcpServers-override pipeline (mirrors `postman/resolver.ts`). On EVERY
 * dispatch the dispatcher calls {@link applyEpodsystemMcpServers}; if the
 * project has active `epodsystem` integrations we decrypt each `crmk_` key
 * and render mcpServers entries:
 *   - The default (label='') binding → bare `epodsystem` key (backward-compat)
 *   - Each labeled binding → `epodsystem_<slug>` (dashes → underscores)
 *
 * Keys are rendered ONLY into the dispatch payload (which the runner writes to
 * a temp `--mcp-config` file); they are never persisted to DB jsonb, logs, or
 * API responses.
 *
 * Drop behaviour: the query filters `active = true`, so disabling
 * (`active=false`) or soft-deleting the integration makes the NEXT dispatch
 * stop injecting the entry — no extra teardown needed (AC#6).
 *
 * ISS-558 skip-bad-key: if one binding's key fails to decrypt, that entry is
 * skipped and the remaining entries are still injected (never crash dispatch).
 */

import { logger } from '../../logger.js';
import {
  type BindingWithConnection,
  decryptConnectionSecrets,
  effectiveConfig,
  listActiveBindingsForProjectProvider,
} from '../store.js';
import { epodsystemMcpUrl } from './endpoints.js';
import type { EpodsystemConfig, EpodsystemSecrets } from './types.js';

/** Build the mcpServers entry the runner merges into its config. */
export function buildEpodsystemMcpEntry(
  _config: EpodsystemConfig,
  apiKey: string,
): Record<string, unknown> {
  return {
    type: 'http',
    url: epodsystemMcpUrl(),
    headers: { Authorization: `Bearer ${apiKey}` },
    enabled: true,
  };
}

/**
 * ISS-558 — convert a binding label to a safe MCP server name component.
 * label='' → '' (bare `epodsystem` key); label='store-a' → '_store_a'.
 * Dashes become underscores so the resulting name is a valid MCP server key.
 */
function labelToMcpSuffix(label: string): string {
  if (!label) return '';
  return `_${label.replace(/-/g, '_')}`;
}

/**
 * ISS-558 — resolve ALL active Epodsystem MCP entries for a project.
 * Returns a Record<serverName, entry> where:
 *   - default (label='') → key 'epodsystem'   (backward-compatible)
 *   - labeled           → key 'epodsystem_<slug>'
 * Skips bindings whose key cannot be decrypted (best-effort, logs warn).
 * Returns an empty record when there are no active integrations.
 */
export async function resolveEpodsystemMcpEntries(
  projectId: string,
): Promise<Record<string, Record<string, unknown>>> {
  let pairs: BindingWithConnection[];
  try {
    pairs = await listActiveBindingsForProjectProvider(projectId, 'epodsystem');
  } catch (err) {
    logger.warn(
      { err, projectId },
      'epodsystem-resolver: integration lookup failed, skipping inject',
    );
    return {};
  }

  const entries: Record<string, Record<string, unknown>> = {};
  for (const pair of pairs) {
    if (!pair.connection.secretsEnc) continue;
    const label = (pair.binding as Record<string, unknown>).label as string ?? '';
    const serverName = `epodsystem${labelToMcpSuffix(label)}`;
    try {
      const secrets = decryptConnectionSecrets<EpodsystemSecrets>(pair.connection);
      if (!secrets?.apiKey) continue;
      entries[serverName] = buildEpodsystemMcpEntry(
        effectiveConfig<EpodsystemConfig>(pair),
        secrets.apiKey,
      );
    } catch (err) {
      logger.warn(
        { err, projectId, connectionId: pair.connection.id, bindingId: pair.binding.id, serverName },
        'epodsystem-resolver: decrypt failed for binding, skipping',
      );
    }
  }
  return entries;
}

/**
 * Resolve the active Epodsystem MCP entry for a project (SINGLE / first).
 * Kept for backward-compat callers (routes mcp-preview) — prefer
 * {@link resolveEpodsystemMcpEntries} for dispatch.
 * Returns null when there is no active integration.
 */
export async function resolveEpodsystemMcpEntry(
  projectId: string,
): Promise<Record<string, unknown> | null> {
  const entries = await resolveEpodsystemMcpEntries(projectId);
  return entries.epodsystem ?? null;
}

/**
 * Merge ALL project Epodsystem MCP entries into a resolved mcpServers override.
 * ISS-558: injects one entry per active binding (epodsystem, epodsystem_<slug>).
 * Returns the (possibly new) override, or the original value unchanged when
 * there are no active integrations. Never mutates the caller's object in place.
 */
export async function applyEpodsystemMcpServers(
  projectId: string,
  current: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  const entries = await resolveEpodsystemMcpEntries(projectId);
  if (Object.keys(entries).length === 0) return current;
  return { ...(current ?? {}), ...entries };
}
