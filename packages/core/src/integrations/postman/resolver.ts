/**
 * How a Postman binding becomes an `mcpServers` entry.
 *
 * ISS-1071 removed this file's `applyPostmanMcpServers` and `resolvePostmanMcpEntry`. The opt-in
 * they gated on — a `postman: true` sentinel in `pipelineConfig.mcpServers` — no longer exists, and
 * walking the project's bindings is `integrations/mcp-resolver.ts`'s job for every provider at once.
 * What is left is the one thing only this provider can answer: the shape of its entry.
 *
 * The key is rendered ONLY into the dispatch payload, which the runner writes to a temp
 * `--mcp-config` file. It is never persisted to DB jsonb, logs, or an API response.
 */

import { postmanMcpUrl } from './endpoints.js';
import type { PostmanConfig } from './types.js';

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
