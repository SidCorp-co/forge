/**
 * ISS-524 / ISS-581 — dispatch-time Sentry MCP resolver.
 *
 * Stage opt-in: the resolver injects ONLY when the resolved `mcpServers` map
 * for the current dispatch carries `sentry: true` (sentinel). A stage opts in
 * by listing `sentry: true` in its `pipelineConfig.states.<status>.mcpServers`
 * or the project-default `pipelineConfig.mcpServers`. The sentinel is replaced
 * with the real secret-bearing spec; absent → not injected.
 *
 * Transport = stdio `npx @sentry/mcp-server` (matches this repo's `.mcp.json`
 * and works against the self-hosted Sentry at `logs.canawan.com`; the hosted
 * https MCP is OAuth-only and unsuitable for self-hosted). The proven minimal
 * spec is `SENTRY_ACCESS_TOKEN` + `SENTRY_HOST` — org/project slugs stay in
 * config for display and are NOT injected as CLI flags (an unrecognized flag
 * would fail the server's startup).
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
import { sentryHost } from './endpoints.js';
import type { SentryConfig, SentrySecrets } from './types.js';

/** Build the `mcpServers.sentry` stdio entry the runner merges into its config. */
export function buildSentryMcpEntry(
  config: SentryConfig,
  authToken: string,
): Record<string, unknown> {
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@sentry/mcp-server@latest'],
    env: {
      SENTRY_ACCESS_TOKEN: authToken,
      SENTRY_HOST: sentryHost(config.host ?? ''),
    },
    enabled: true,
  };
}

/**
 * Resolve the active Sentry MCP entry for a project, or `null` when there is no
 * active integration (or the token cannot be decrypted). Pure read — does not
 * mutate the override.
 */
export async function resolveSentryMcpEntry(
  projectId: string,
): Promise<Record<string, unknown> | null> {
  let pair: BindingWithConnection | undefined;
  try {
    // Single active sentry binding per project (env unsplit). Take the first.
    [pair] = await listActiveBindingsForProjectProvider(projectId, 'sentry');
  } catch (err) {
    // Injection is best-effort: a DB hiccup must NOT crash a dispatch.
    logger.warn({ err, projectId }, 'sentry-resolver: integration lookup failed, skipping inject');
    return null;
  }
  if (!pair || !pair.connection.secretsEnc) return null;

  try {
    const secrets = decryptConnectionSecrets<SentrySecrets>(pair.connection);
    if (!secrets?.authToken) return null;
    return buildSentryMcpEntry(effectiveConfig<SentryConfig>(pair), secrets.authToken);
  } catch (err) {
    logger.warn(
      { err, projectId, connectionId: pair.connection.id, bindingId: pair.binding.id },
      'sentry-resolver: decrypt failed, skipping inject',
    );
    return null;
  }
}

/**
 * Merge the project's Sentry MCP entry into a resolved mcpServers override.
 * Injects ONLY when the stage opted in via `sentry: true` sentinel in its
 * resolved map. Strips the sentinel regardless (never leaks `true` to runner).
 * Never mutates the caller's object in place.
 */
export async function applySentryMcpServers(
  projectId: string,
  current: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  if (current?.sentry !== true) return current;
  // Stage declared opt-in — resolve the real entry.
  const entry = await resolveSentryMcpEntry(projectId);
  const { sentry: _sentinel, ...rest } = current;
  if (!entry) {
    // Active integration absent or decrypt failed — drop sentinel, don't inject.
    return Object.keys(rest).length > 0 ? rest : null;
  }
  return { ...rest, sentry: entry };
}
