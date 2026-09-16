import { describe, expect, it } from 'vitest';
import { buildEpodsystemMcpEntry } from './resolver.js';

// ISS-1071 removed `applyEpodsystemMcpServers`, `resolveEpodsystemMcpEntries`,
// `resolveEpodsystemMcpEntry` and `labelToMcpSuffix` from this file — the sentinel gate they hung
// on is gone (the binding's own `agent_access` answers it now) and the label-to-server-name rule
// is `registry.mcpServerNameFor`. That N-binding walk, the decrypt-skip behaviour and the
// label-suffix naming (including this provider's `epodsystem_store_a` case) all moved to
// `mcp-resolver.test.ts`, which exercises them against the registry rather than against one
// provider. What stays here is the one thing only this file still owns: the shape of an
// Epodsystem entry.

describe('buildEpodsystemMcpEntry', () => {
  it('renders the global MCP host + Bearer + enabled', () => {
    const entry = buildEpodsystemMcpEntry(
      { endpoint: 'https://acme.epodsystem.com', environment: 'prod' },
      'crmk_abc',
    );
    expect(entry).toEqual({
      type: 'http',
      url: 'https://mcp.epodsystem.com/mcp',
      headers: { Authorization: 'Bearer crmk_abc' },
      enabled: true,
    });
  });
});
