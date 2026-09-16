import { describe, expect, it } from 'vitest';
import { buildPostmanMcpEntry } from './resolver.js';

// ISS-1071 removed this file's `applyPostmanMcpServers` and `resolvePostmanMcpEntry` — the
// sentinel they gated on is gone, and walking a project's granted bindings is now
// `integrations/mcp-resolver.ts`'s job for every direct-mcp provider at once. Its own coverage,
// including this provider's contribution under a label, lives in `mcp-resolver.test.ts`. What
// stays here is the one thing only this file still owns: the shape of a Postman entry.

describe('buildPostmanMcpEntry', () => {
  it('US minimal → mcp.postman.com/minimal + Bearer + enabled', () => {
    const entry = buildPostmanMcpEntry(
      { workspaceName: 'Forge Integration', region: 'us', mode: 'minimal', environment: 'prod' },
      'PMAK-abc',
    );
    expect(entry).toEqual({
      type: 'http',
      url: 'https://mcp.postman.com/minimal',
      headers: { Authorization: 'Bearer PMAK-abc' },
      enabled: true,
    });
  });

  it('EU region swaps the host to mcp.eu.postman.com', () => {
    const entry = buildPostmanMcpEntry(
      { workspaceName: 'W', region: 'eu', mode: 'minimal', environment: 'prod' },
      'PMAK-abc',
    );
    expect(entry.url).toBe('https://mcp.eu.postman.com/minimal');
  });

  it('full mode uses the /mcp path', () => {
    const entry = buildPostmanMcpEntry(
      { workspaceName: 'W', region: 'us', mode: 'full', environment: 'prod' },
      'PMAK-abc',
    );
    expect(entry.url).toBe('https://mcp.postman.com/mcp');
  });
});
