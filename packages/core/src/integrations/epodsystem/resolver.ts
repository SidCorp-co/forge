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

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { projectIntegrations } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { decryptJson } from '../vault.js';
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
  let row: typeof projectIntegrations.$inferSelect | undefined;
  try {
    [row] = await db
      .select()
      .from(projectIntegrations)
      .where(
        and(
          eq(projectIntegrations.projectId, projectId),
          eq(projectIntegrations.provider, 'epodsystem'),
          eq(projectIntegrations.active, true),
        ),
      )
      .limit(1);
  } catch (err) {
    // Injection is best-effort: a DB hiccup must NOT crash a dispatch.
    logger.warn(
      { err, projectId },
      'epodsystem-resolver: integration lookup failed, skipping inject',
    );
    return null;
  }
  if (!row || !row.secretsEnc) return null;

  try {
    const secrets = decryptJson<EpodsystemSecrets>(row.secretsEnc);
    if (!secrets?.apiKey) return null;
    return buildEpodsystemMcpEntry(row.config as EpodsystemConfig, secrets.apiKey);
  } catch (err) {
    logger.warn(
      { err, projectId, integrationId: row.id },
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
