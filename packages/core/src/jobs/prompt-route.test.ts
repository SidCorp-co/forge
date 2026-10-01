import { describe, expect, it } from 'vitest';
import { extractPayloadExtras, extractResolvedFlags, redactSecretHeaders } from './prompt-route.js';

describe('redactSecretHeaders', () => {
  it('redacts Authorization header with length marker', () => {
    const out = redactSecretHeaders({ headers: { Authorization: 'Bearer abc123' } }) as {
      headers: Record<string, string>;
    };
    expect(out.headers.Authorization).toBe('[REDACTED 13 chars]');
  });

  it('matches headers case-insensitively across known scrub keys', () => {
    const value = 'sekrit';
    const out = redactSecretHeaders({
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
    expect(redactSecretHeaders(input)).toEqual(input);
  });

  it('redacts deeply nested servers.<name>.headers.Cookie', () => {
    const out = redactSecretHeaders({
      servers: {
        forge: {
          url: 'https://api.forge.test/mcp',
          headers: { Cookie: 'session=top-secret' },
        },
      },
    }) as { servers: { forge: { url: string; headers: { Cookie: string } } } };
    expect(out.servers.forge.headers.Cookie).toBe('[REDACTED 18 chars]');
    expect(out.servers.forge.url).toBe('https://api.forge.test/mcp');
  });

  it('handles arrays of server entries', () => {
    const out = redactSecretHeaders([
      { url: 'https://a', headers: { Authorization: 'Bearer aaa' } },
      { url: 'https://b', headers: { Authorization: 'Bearer bbbbb' } },
    ]) as Array<{ url: string; headers: { Authorization: string } }>;
    expect(out[0]?.headers.Authorization).toBe('[REDACTED 10 chars]');
    expect(out[1]?.headers.Authorization).toBe('[REDACTED 12 chars]');
    expect(out[0]?.url).toBe('https://a');
  });

  it('collapses non-string secret values to [REDACTED]', () => {
    const out = redactSecretHeaders({ headers: { Cookie: 42, Authorization: null } }) as {
      headers: Record<string, unknown>;
    };
    expect(out.headers.Cookie).toBe('[REDACTED]');
    expect(out.headers.Authorization).toBe('[REDACTED]');
  });

  it('does not mutate the input', () => {
    const input = { headers: { Authorization: 'Bearer abc' } };
    redactSecretHeaders(input);
    expect(input.headers.Authorization).toBe('Bearer abc');
  });

  it('returns null/undefined unchanged', () => {
    expect(redactSecretHeaders(null)).toBeNull();
    expect(redactSecretHeaders(undefined)).toBeUndefined();
  });

  it('bounds recursion depth without throwing on deeply nested input', () => {
    let nested: unknown = { Authorization: 'Bearer x' };
    for (let i = 0; i < 50; i++) nested = { wrap: nested };
    expect(() => redactSecretHeaders(nested)).not.toThrow();
  });
});

describe('extractPayloadExtras', () => {
  it('strips promptString and skillName; keeps everything else', () => {
    const out = extractPayloadExtras({
      promptString: '/forge-plan iss-1',
      skillName: 'forge-plan',
      preventiveContext: { hint: 'see ISS-42' },
      modelOverride: 'sonnet-4-6',
    });
    expect(out).toEqual({
      preventiveContext: { hint: 'see ISS-42' },
      modelOverride: 'sonnet-4-6',
    });
  });

  it('redacts a secret header inside any extra it keeps', () => {
    const out = extractPayloadExtras({
      servers: [{ url: 'https://x', headers: { Authorization: 'Bearer abc' } }],
    });
    expect(out).toEqual({
      servers: [{ url: 'https://x', headers: { Authorization: '[REDACTED 10 chars]' } }],
    });
  });

  it('returns {} for null/undefined input', () => {
    expect(extractPayloadExtras(null)).toEqual({});
    expect(extractPayloadExtras(undefined)).toEqual({});
  });

  it('returns {} when payload contains only stripped keys', () => {
    expect(extractPayloadExtras({ promptString: 'x', skillName: 'y' })).toEqual({});
  });

  it('strips dispatcher-stamped resolvedFlags keys so they do not double-render', () => {
    expect(
      extractPayloadExtras({
        model: 'sonnet',
        allowedTools: 'Bash',
        permissionMode: 'acceptEdits',
        timeoutSeconds: 1800,
        stageStatus: 'developed',
        claudeSessionId: 'cli-abc',
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
    const r = extractResolvedFlags({ permissionMode: 'foo' }, { skillName: null, modelUsed: null });
    expect(r.permissionMode).toBeNull();
  });

  it('surfaces claudeSessionId for the Inspector resume badge', () => {
    const r = extractResolvedFlags(
      { claudeSessionId: 'cli-xyz' },
      {
        skillName: null,
        modelUsed: null,
      },
    );

    expect(r.claudeSessionId).toBe('cli-xyz');
  });
});
