import { describe, expect, it } from 'vitest';
import { buildSentryMcpEntry } from './resolver.js';

// ISS-1071 removed `applySentryMcpServers` and `resolveSentryMcpEntry` from this file — the
// sentinel they gated on is gone, and walking a project's granted bindings is now
// `integrations/mcp-resolver.ts`'s job for every direct-mcp provider at once; its coverage lives
// in `mcp-resolver.test.ts`. What stays here is the one thing only this file still owns: the
// shape of a Sentry stdio entry.

describe('buildSentryMcpEntry', () => {
  it('renders the stdio @sentry/mcp-server entry with token + host env', () => {
    const entry = buildSentryMcpEntry(
      { host: 'logs.canawan.com', environment: 'prod' },
      'sntryu_abc',
    );
    expect(entry).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@sentry/mcp-server@latest'],
      env: { SENTRY_ACCESS_TOKEN: 'sntryu_abc', SENTRY_HOST: 'logs.canawan.com' },
      enabled: true,
    });
  });

  it('strips a scheme + trailing slash from the host', () => {
    const entry = buildSentryMcpEntry(
      { host: 'https://sentry.io/', environment: 'prod' },
      'sntryu_abc',
    );
    expect((entry.env as Record<string, string>).SENTRY_HOST).toBe('sentry.io');
  });
});
