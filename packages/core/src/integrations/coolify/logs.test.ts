import { FILTERED } from '@forge/observability';
import { describe, expect, it } from 'vitest';
import { flattenLogs, redactCoolifyEnvDump, tailLog } from './logs.js';

describe('flattenLogs', () => {
  it('parses a JSON-encoded array of { output } lines', () => {
    const logs = JSON.stringify([
      { output: 'step 1', type: 'stdout' },
      { output: "Cannot find module '@codemirror/state'", type: 'stderr' },
    ]);
    expect(flattenLogs(logs)).toBe("step 1\nCannot find module '@codemirror/state'");
  });

  it('handles an already-decoded array', () => {
    expect(flattenLogs([{ output: 'a' }, { output: 'b' }])).toBe('a\nb');
  });

  it('falls back to the raw string when not JSON', () => {
    expect(flattenLogs('plain build log\nline 2')).toBe('plain build log\nline 2');
  });

  it('does not throw on an unexpected JSON shape — returns raw', () => {
    expect(flattenLogs('{"unexpected":true}')).toBe('{"unexpected":true}');
  });

  it('returns empty string for undefined logs', () => {
    expect(flattenLogs(undefined)).toBe('');
  });
});

describe('tailLog', () => {
  it('keeps the last maxLines lines and flags truncated', () => {
    const text = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
    const { text: out, truncated } = tailLog(text, 100, 1024 * 1024);
    const lines = out.split('\n');
    expect(lines).toHaveLength(100);
    expect(lines.at(-1)).toBe('line 249');
    expect(truncated).toBe(true);
  });

  it('does not flag truncated when under both bounds', () => {
    const { text, truncated } = tailLog('short\nlog', 100, 1024);
    expect(text).toBe('short\nlog');
    expect(truncated).toBe(false);
  });

  it('trims from the front to maxBytes, keeping the tail', () => {
    const text = 'x'.repeat(100);
    const { text: out, truncated } = tailLog(text, 1000, 16);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(16);
    expect(truncated).toBe(true);
    // the tail (last bytes) is preserved
    expect(text.endsWith(out)).toBe(true);
  });
});

describe('redactCoolifyEnvDump (ISS-412)', () => {
  it('redacts every KEY=value inside the env-dump block, regardless of suffix', () => {
    const log = [
      'Step 1/8: FROM node:20',
      'Creating .env file with runtime variables for build phase.',
      'POSTGRES_PASSWORD=p@ss',
      'NODE_ENV=production',
      'MY_PROVIDER_LOL=hunter2',
      'export AWS_SECRET_ACCESS_KEY=aws',
      'Container started',
      'fetched https://example.com/health',
    ].join('\n');
    const out = redactCoolifyEnvDump(log);
    expect(out).toBe(
      [
        'Step 1/8: FROM node:20',
        'Creating .env file with runtime variables for build phase.',
        `POSTGRES_PASSWORD=${FILTERED}`,
        `NODE_ENV=${FILTERED}`,
        `MY_PROVIDER_LOL=${FILTERED}`,
        `export AWS_SECRET_ACCESS_KEY=${FILTERED}`,
        'Container started',
        'fetched https://example.com/health',
      ].join('\n'),
    );
  });

  it('is a no-op when the marker is absent', () => {
    const log = [
      'Step 1/8: FROM node:20',
      'POSTGRES_PASSWORD=p@ss',
      'NODE_ENV=production',
      'Container started',
    ].join('\n');
    expect(redactCoolifyEnvDump(log)).toBe(log);
  });

  it('exits the block immediately when the marker is followed by a non-env line', () => {
    const log = [
      'Creating .env file with runtime variables for build phase.',
      'no env vars set',
      'POSTGRES_PASSWORD=p@ss',
    ].join('\n');
    // Block ends at "no env vars set"; the trailing assignment is OUTSIDE the
    // block and passes through (the generic scrubLogText suffix rule still
    // catches it downstream, but redactCoolifyEnvDump alone leaves it).
    expect(redactCoolifyEnvDump(log)).toBe(log);
  });

  it('masks the full value of a quoted multi-word assignment inside the block', () => {
    const log = [
      'Creating .env file with runtime variables for build phase.',
      'GREETING_SECRET="hello world with spaces"',
      'Container started',
    ].join('\n');
    const out = redactCoolifyEnvDump(log);
    expect(out).toContain(`GREETING_SECRET=${FILTERED}`);
    expect(out).not.toContain('hello world');
  });

  it('keeps the block alive across empty-value KEY= lines (live regression)', () => {
    // The real Coolify env-dump emits empty-value lines (`COOLIFY_URL=`,
    // `COOLIFY_FQDN=`) midway through. The first ship's regex required a
    // non-empty value, so the block ended early and everything after lost
    // defense-in-depth — that is how SENTRY_DSN_CORE / _WEB slipped through
    // live deploy 19e21c95. The block MUST stay open across empty values.
    const log = [
      'Creating .env file with runtime variables for build phase.',
      'SOURCE_COMMIT=19e21c95',
      'COOLIFY_URL=',
      'COOLIFY_FQDN=',
      'SERVICE_URL_CORE=https://forge-beta-api.sidcorp.co',
      'SENTRY_DSN_CORE=https://abc@logs.canawan.com/36',
      'Container started',
    ].join('\n');
    const out = redactCoolifyEnvDump(log);
    const lines = out.split('\n');
    // Marker + footer pass through untouched.
    expect(lines[0]).toBe('Creating .env file with runtime variables for build phase.');
    expect(lines.at(-1)).toBe('Container started');
    // Every env line inside the block — including the empty-value ones —
    // is masked. The empty `KEY=` becomes `KEY=[Filtered]`, which is a
    // no-op for leak purposes but proves the block stayed open.
    expect(lines[1]).toBe(`SOURCE_COMMIT=${FILTERED}`);
    expect(lines[2]).toBe(`COOLIFY_URL=${FILTERED}`);
    expect(lines[3]).toBe(`COOLIFY_FQDN=${FILTERED}`);
    expect(lines[4]).toBe(`SERVICE_URL_CORE=${FILTERED}`);
    expect(lines[5]).toBe(`SENTRY_DSN_CORE=${FILTERED}`);
    // No DSN value survives.
    expect(out).not.toContain('logs.canawan.com');
  });
});
