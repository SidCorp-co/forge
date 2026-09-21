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
