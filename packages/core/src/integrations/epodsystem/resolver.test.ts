import { describe, expect, it } from 'vitest';
import { buildEpodsystemMcpEntry } from './resolver.js';

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
