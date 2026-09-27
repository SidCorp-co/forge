import { describe, expect, it } from 'vitest';

(await import('./register-all.js')).registerAllIntegrations();

const { directMcpIntegrations } = await import('./registry.js');

/**
 * The MCP preview serves `buildEntry(config, previewSecrets)`'s `url` to anyone who can read the
 * project, which is safe only because those secrets are placeholders (ISS-1191).
 */
const PLACEHOLDER = '[redacted]';

/** Which preview-secret fields hold something other than the placeholder. */
function offendingFields(previewSecrets: Record<string, unknown>): string[] {
  return Object.entries(previewSecrets)
    .filter(([, value]) => value !== PLACEHOLDER)
    .map(([field]) => field);
}

describe('a direct-mcp declaration carries no credential in its preview secrets', () => {
  it('names a real-looking credential as an offender, so the guard can fail', () => {
    expect(offendingFields({ authToken: 'sntrys_a_real_looking_token' })).toEqual(['authToken']);
  });

  it('declares at least one direct-mcp provider, so this guard measures something', () => {
    expect(directMcpIntegrations().length).toBeGreaterThan(0);
  });

  for (const decl of directMcpIntegrations()) {
    const path = decl.capabilities.agentPath;
    if (path.kind !== 'direct-mcp') continue;

    it(`${decl.provider}: every preview-secret field holds the literal placeholder`, () => {
      expect(Object.keys(path.previewSecrets).length).toBeGreaterThan(0);
      expect(offendingFields(path.previewSecrets)).toEqual([]);
    });
  }
});
