// A key that can be set can be unset. ISS-1127 measured the other state: a
// `releaseRunnerLabel` no credential could remove, because the PATCH kept an
// omitted key and the schema refused `null`.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { releaseChannelFields, withdrawNulls } from './release-channel-schema.js';

const schema = z.object(releaseChannelFields);

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
