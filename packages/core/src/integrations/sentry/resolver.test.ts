import { describe, expect, it } from 'vitest';
import { buildSentryMcpEntry } from './resolver.js';

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
