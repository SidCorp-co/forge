// A key that can be set can be unset. ISS-1127 measured the other state: a
// `releaseRunnerLabel` no credential could remove, because the PATCH kept an
// omitted key and the schema refused `null`.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { releaseChannelFields, withdrawNulls } from './release-channel-schema.js';

const schema = z.object(releaseChannelFields);

describe('a verify block (ISS-1282)', () => {
  const probes = [{ url: 'https://api.example.test/version' }];

  it('accepts stableReads, the consecutive recorded readings a finish believes', () => {
    expect(schema.safeParse({ verify: { probes, stableReads: 3 } }).success).toBe(true);
  });

  it('refuses stableReads outside one to ten', () => {
    expect(schema.safeParse({ verify: { probes, stableReads: 0 } }).success).toBe(false);
    expect(schema.safeParse({ verify: { probes, stableReads: 11 } }).success).toBe(false);
  });

  it('refuses a timeoutSeconds by name rather than stripping it, saying no deadline exists', () => {
    const parsed = schema.safeParse({ verify: { probes, timeoutSeconds: 300 } });

    expect(parsed.success).toBe(false);
    const message = parsed.success ? '' : parsed.error.issues.map((i) => i.message).join(' ');
    expect(message).toContain('`timeoutSeconds` is no longer a setting');
    expect(message).toContain('`look`');
  });

  it('refuses a timeoutSeconds whatever its value, a once-valid one included', () => {
    for (const timeoutSeconds of [10, 300, 3600, 0, null]) {
      expect(schema.safeParse({ verify: { probes, timeoutSeconds } }).success).toBe(false);
    }
  });

  it('still takes a verify block that names no deadline', () => {
    expect(schema.safeParse({ verify: { probes } }).success).toBe(true);
    expect(schema.safeParse({ verify: null }).success).toBe(true);
  });
});

describe('a declared release-channel key', () => {
  it('accepts the value that means not declared', () => {
    const parsed = schema.safeParse({ releaseRunnerLabel: null });

    expect(parsed.success).toBe(true);
  });

  it('still refuses an empty string, which means nothing either way', () => {
    expect(schema.safeParse({ releaseRunnerLabel: '' }).success).toBe(false);
  });

  it('is removed from the merged config rather than stored as null', () => {
    const merged = withdrawNulls({ releaseRunnerLabel: null, verify: { probes: [] } });

    expect('releaseRunnerLabel' in merged).toBe(false);
    expect(merged.verify).toEqual({ probes: [] });
  });

  it('leaves every sibling the caller did not name where it was', () => {
    const merged = withdrawNulls({
      targets: ['app'],
      releaseRunnerLabel: 'prod-box',
      rollback: null,
    });

    expect(merged).toEqual({ targets: ['app'], releaseRunnerLabel: 'prod-box' });
  });

  it('keeps a key whose value is falsy but present, so only null withdraws', () => {
    expect(withdrawNulls({ a: 0, b: false, c: '' })).toEqual({ a: 0, b: false, c: '' });
  });
});
