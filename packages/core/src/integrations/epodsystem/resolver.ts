/**
 * How an Epodsystem binding becomes an `mcpServers` entry.
 *
 * ISS-1071 removed `applyEpodsystemMcpServers`, `resolveEpodsystemMcpEntries`,
 * `resolveEpodsystemMcpEntry` and `labelToMcpSuffix` from this file. The sentinel gate they hung on
 * is gone — the binding's own `agent_access` answers it — and the label-to-server-name rule, which
 * was written out four times across three files and named this provider in every one of them, is
 * now `registry.mcpServerNameFor` driven by the declared `multiBinding` flag.
 *
 * The `crmk_` key is rendered ONLY into the dispatch payload, which the runner writes to a temp
 * `--mcp-config` file. It is never persisted to DB jsonb, logs, or an API response.
 */

import { epodsystemMcpUrl } from './endpoints.js';
import type { EpodsystemConfig } from './types.js';

/** Build the `mcpServers` entry the runner merges into its config. */
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
