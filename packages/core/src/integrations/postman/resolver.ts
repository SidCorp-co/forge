/**
 * ISS-336 — dispatch-time Postman MCP resolver.
 *
 * This is the single bridge between the integration config layer and the
 * existing mcpServers-override pipeline. On EVERY dispatch the dispatcher
 * calls {@link applyPostmanMcpServers}; if the project has an active `postman`
 * integration we decrypt its API key and render a remote-HTTP + Bearer
 * `mcpServers.postman` entry into the per-project override (project-default,
 * all stages — NOT pinned to a single stage). The key is rendered only into
 * the dispatch payload (which the runner writes to a temp `--mcp-config`
 * file); it is never persisted to DB jsonb, logs, or API responses.
 *
 * Drop behaviour: the query filters `active = true`, so disabling
 * (`active=false`) or soft-deleting the integration makes the NEXT dispatch
 * stop injecting the entry — no extra teardown needed.
 */

import { logger } from '../../logger.js';
import {
  type BindingWithConnection,
  decryptConnectionSecrets,
  effectiveConfig,
  listActiveBindingsForProjectProvider,
} from '../store.js';
import { postmanMcpUrl } from './endpoints.js';
import type { PostmanConfig, PostmanSecrets } from './types.js';

/** Build the `mcpServers.postman` entry the runner merges into its config. */
export function buildPostmanMcpEntry(
  config: PostmanConfig,
  apiKey: string,
): Record<string, unknown> {
  return {
    type: 'http',
    url: postmanMcpUrl(config.region ?? 'us', config.mode ?? 'minimal'),
    headers: { Authorization: `Bearer ${apiKey}` },
    enabled: true,
  };
}

/**
 * Resolve the active Postman MCP entry for a project, or `null` when there is
 * no active integration (or the key cannot be decrypted). Pure read — does not
 * mutate the override.
 */
export async function resolvePostmanMcpEntry(
  projectId: string,
): Promise<Record<string, unknown> | null> {
  let pair: BindingWithConnection | undefined;
  try {
    // Single active postman binding per project (env unsplit). Take the first.
    [pair] = await listActiveBindingsForProjectProvider(projectId, 'postman');
  } catch (err) {
    // Injection is best-effort: a DB hiccup must NOT crash a dispatch.
    logger.warn({ err, projectId }, 'postman-resolver: integration lookup failed, skipping inject');
    return null;
  }
  if (!pair || !pair.connection.secretsEnc) return null;

  try {
    const secrets = decryptConnectionSecrets<PostmanSecrets>(pair.connection);
    if (!secrets?.apiKey) return null;
    return buildPostmanMcpEntry(effectiveConfig<PostmanConfig>(pair), secrets.apiKey);
  } catch (err) {
    logger.warn(
      { err, projectId, connectionId: pair.connection.id, bindingId: pair.binding.id },
      'postman-resolver: decrypt failed, skipping inject',
    );
    return null;
  }
}

/**
 * Merge the project's Postman MCP entry (if any) into a resolved mcpServers
 * override. Returns the (possibly new) override object, or the original value
 * unchanged when there is no active Postman integration. Never mutates the
 * caller's object in place.
 */
export async function applyPostmanMcpServers(
  projectId: string,
  current: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  const entry = await resolvePostmanMcpEntry(projectId);
  if (!entry) return current;
  return { ...(current ?? {}), postman: entry };
}
