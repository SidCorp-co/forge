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
