/**
 * ISS-387 — dispatch-time Epodsystem MCP resolver.
 *
 * Bridge between the integration config layer and the existing
 * mcpServers-override pipeline (mirrors `postman/resolver.ts`). On EVERY
 * dispatch the dispatcher calls {@link applyEpodsystemMcpServers}; if the
 * project has an active `epodsystem` integration we decrypt its `crmk_` key
 * and render a remote-HTTP + Bearer `mcpServers.epodsystem` entry into the
 * per-project override. The key is rendered ONLY into the dispatch payload
 * (which the runner writes to a temp `--mcp-config` file); it is never
 * persisted to DB jsonb, logs, or API responses.
 *
 * Drop behaviour: the query filters `active = true`, so disabling
 * (`active=false`) or soft-deleting the integration makes the NEXT dispatch
 * stop injecting the entry — no extra teardown needed (AC#6).
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

/** Build the `mcpServers.epodsystem` entry the runner merges into its config. */
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
 * Resolve the active Epodsystem MCP entry for a project, or `null` when there
 * is no active integration (or the key cannot be decrypted). Pure read — does
 * not mutate the override.
 */
export async function resolveEpodsystemMcpEntry(
  projectId: string,
): Promise<Record<string, unknown> | null> {
  let pair: BindingWithConnection | undefined;
  try {
    // Single active epodsystem binding per project (env unsplit). Take the first.
    [pair] = await listActiveBindingsForProjectProvider(projectId, 'epodsystem');
  } catch (err) {
    // Injection is best-effort: a DB hiccup must NOT crash a dispatch.
    logger.warn(
      { err, projectId },
      'epodsystem-resolver: integration lookup failed, skipping inject',
    );
    return null;
  }
  if (!pair || !pair.connection.secretsEnc) return null;

  try {
    const secrets = decryptConnectionSecrets<EpodsystemSecrets>(pair.connection);
    if (!secrets?.apiKey) return null;
    return buildEpodsystemMcpEntry(effectiveConfig<EpodsystemConfig>(pair), secrets.apiKey);
  } catch (err) {
    logger.warn(
      { err, projectId, connectionId: pair.connection.id, bindingId: pair.binding.id },
      'epodsystem-resolver: decrypt failed, skipping inject',
    );
    return null;
  }
}

/**
 * Merge the project's Epodsystem MCP entry (if any) into a resolved mcpServers
 * override. Returns the (possibly new) override object, or the original value
 * unchanged when there is no active Epodsystem integration. Never mutates the
 * caller's object in place.
 */
export async function applyEpodsystemMcpServers(
  projectId: string,
  current: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  const entry = await resolveEpodsystemMcpEntry(projectId);
  if (!entry) return current;
  return { ...(current ?? {}), epodsystem: entry };
}
