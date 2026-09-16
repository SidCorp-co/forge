/**
 * How a Sentry binding becomes an `mcpServers` entry.
 *
 * ISS-1071 removed `applySentryMcpServers` and `resolveSentryMcpEntry` from this file: the sentinel
 * they gated on is gone and the binding walk belongs to `integrations/mcp-resolver.ts`.
 *
 * Transport = stdio `npx @sentry/mcp-server`, which matches this repo's own `.mcp.json` and works
 * against a self-hosted Sentry; the hosted https MCP is OAuth-only and unsuitable for one. The
 * proven minimal spec is `SENTRY_ACCESS_TOKEN` + `SENTRY_HOST` — org and project slugs stay in
 * config for display and are NOT injected as CLI flags, because an unrecognized flag would fail the
 * server's startup.
 */

import { sentryHost } from './endpoints.js';
import type { SentryConfig } from './types.js';

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
