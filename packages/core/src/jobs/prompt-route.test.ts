import { describe, expect, it } from 'vitest';
import {
  extractPayloadExtras,
  extractResolvedFlags,
  redactMcpSecrets,
} from './prompt-route.js';

describe('redactMcpSecrets', () => {
  it('redacts Authorization header with length marker', () => {
    const out = redactMcpSecrets({ headers: { Authorization: 'Bearer abc123' } }) as {
      headers: Record<string, string>;
    };
    expect(out.headers.Authorization).toBe('[REDACTED 13 chars]');
  });

  it('matches headers case-insensitively across known scrub keys', () => {
    const value = 'sekrit';
    const out = redactMcpSecrets({
      authorization: value,
      AUTHORIZATION: value,
      'X-Device-Token': value,
      'x-api-key': value,
      Cookie: value,
      'x-csrf-token': value,
    }) as Record<string, string>;
    for (const key of Object.keys(out)) {
      expect(out[key]).toBe(`[REDACTED ${value.length} chars]`);
    }
  });

  it('preserves non-scrub keys verbatim (transport/url/env)', () => {
    const input = {
      url: 'https://example.com/mcp',
      transport: 'sse',
      env: { LOG_LEVEL: 'debug' },
    };
    expect(redactMcpSecrets(input)).toEqual(input);
  });

  it('redacts deeply nested mcpServers.<name>.headers.Cookie', () => {
    const out = redactMcpSecrets({
      mcpServers: {
        forge: {
          url: 'https://api.forge.test/mcp',
          headers: { Cookie: 'session=top-secret' },
        },
      },
    }) as { mcpServers: { forge: { url: string; headers: { Cookie: string } } } };
    expect(out.mcpServers.forge.headers.Cookie).toBe('[REDACTED 18 chars]');
    expect(out.mcpServers.forge.url).toBe('https://api.forge.test/mcp');
  });

  it('handles arrays of server entries', () => {
    const out = redactMcpSecrets([
      { url: 'https://a', headers: { Authorization: 'Bearer aaa' } },
      { url: 'https://b', headers: { Authorization: 'Bearer bbbbb' } },
    ]) as Array<{ url: string; headers: { Authorization: string } }>;
    expect(out[0].headers.Authorization).toBe('[REDACTED 10 chars]');
    expect(out[1].headers.Authorization).toBe('[REDACTED 12 chars]');
    expect(out[0].url).toBe('https://a');
  });

  it('collapses non-string secret values to [REDACTED]', () => {
    const out = redactMcpSecrets({ headers: { Cookie: 42, Authorization: null } }) as {
      headers: Record<string, unknown>;
    };
    expect(out.headers.Cookie).toBe('[REDACTED]');
    expect(out.headers.Authorization).toBe('[REDACTED]');
  });

  it('does not mutate the input', () => {
    const input = { headers: { Authorization: 'Bearer abc' } };
    redactMcpSecrets(input);
    expect(input.headers.Authorization).toBe('Bearer abc');
  });

  it('returns null/undefined unchanged', () => {
    expect(redactMcpSecrets(null)).toBeNull();
    expect(redactMcpSecrets(undefined)).toBeUndefined();
  });

  it('bounds recursion depth without throwing on deeply nested input', () => {
    let nested: unknown = { Authorization: 'Bearer x' };
    for (let i = 0; i < 50; i++) nested = { wrap: nested };
    expect(() => redactMcpSecrets(nested)).not.toThrow();
  });
});

describe('extractPayloadExtras', () => {
  it('strips promptString, skillName, mcpServers; keeps everything else', () => {
    const out = extractPayloadExtras({
      promptString: '/forge-plan iss-1',
      skillName: 'forge-plan',
      mcpServers: [{ url: 'https://x' }],
      preventiveContext: { hint: 'see ISS-42' },
      modelOverride: 'sonnet-4-6',
    });
    expect(out).toEqual({
      preventiveContext: { hint: 'see ISS-42' },
      modelOverride: 'sonnet-4-6',
    });
  });

  it('returns {} for null/undefined input', () => {
    expect(extractPayloadExtras(null)).toEqual({});
    expect(extractPayloadExtras(undefined)).toEqual({});
  });

  it('returns {} when payload contains only stripped keys', () => {
    expect(
      extractPayloadExtras({ promptString: 'x', skillName: 'y', mcpServers: [] }),
    ).toEqual({});
  });

  it('strips dispatcher-stamped resolvedFlags keys so they do not double-render', () => {
    expect(
      extractPayloadExtras({
        model: 'sonnet',
        allowedTools: 'Bash',
        permissionMode: 'acceptEdits',
        timeoutSeconds: 1800,
        sessionGroup: 'impl',
        stageStatus: 'developed',
        claudeSessionId: 'cli-abc',
        mcpServersOverride: { x: 1 },
        // Real extras
        preventiveContext: { hint: 'h' },
      }),
    ).toEqual({ preventiveContext: { hint: 'h' } });
  });
});

describe('extractResolvedFlags', () => {
  it('returns all-null when no dispatcher fields stamped', () => {
    const r = extractResolvedFlags({}, { skillName: null, modelUsed: null });
    expect(r).toEqual({
      state: null,
      skillName: null,
      model: null,
      allowedTools: null,
      permissionMode: null,
      timeoutSeconds: null,
      sessionGroup: null,
      claudeSessionId: null,
      systemPromptMode: null,
    });
  });

  it('prefers job.modelUsed + job.skillName over payload-stamped values', () => {
    const r = extractResolvedFlags(
      { model: 'opus', skillName: 'forge-old' },
      { skillName: 'forge-new', modelUsed: 'sonnet' },
    );
    expect(r.skillName).toBe('forge-new');
    expect(r.model).toBe('sonnet');
  });

  it('normalises allowedTools as comma-joined string', () => {
    const r = extractResolvedFlags(
      { allowedTools: ['Bash', 'mcp__forge__forge_issues'] },
      { skillName: null, modelUsed: null },
    );
    expect(r.allowedTools).toBe('Bash,mcp__forge__forge_issues');
  });

  it('rejects unknown permissionMode strings', () => {
    const r = extractResolvedFlags(
      { permissionMode: 'foo' },
      { skillName: null, modelUsed: null },
    );
    expect(r.permissionMode).toBeNull();
  });

  it('surfaces sessionGroup + claudeSessionId for the Inspector resume badge', () => {
    const r = extractResolvedFlags(
      { sessionGroup: 'impl', claudeSessionId: 'cli-xyz' },
      { skillName: null, modelUsed: null },
    );
    expect(r.sessionGroup).toBe('impl');
    expect(r.claudeSessionId).toBe('cli-xyz');
  });
});
