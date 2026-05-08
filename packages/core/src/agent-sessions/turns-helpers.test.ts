import { describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';
vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: TEST_SECRET,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/test',
    DEVICE_TOKEN_PEPPER: TEST_SECRET,
  },
}));
vi.mock('../db/client.js', () => ({
  db: {},
}));

const {
  messageRoleToTurnRole,
  normalizeTurnContent,
  replaceMessageAt,
  sliceMessagesThrough,
} = await import('./turns-helpers.js');

describe('messageRoleToTurnRole', () => {
  it('passes through user/assistant/tool roles', () => {
    expect(messageRoleToTurnRole({ role: 'user', content: 'hi' })).toBe('user');
    expect(messageRoleToTurnRole({ role: 'assistant', content: 'hi' })).toBe('assistant');
    expect(messageRoleToTurnRole({ role: 'tool', content: 'hi' })).toBe('tool');
  });

  it('coerces legacy system role to tool', () => {
    expect(messageRoleToTurnRole({ role: 'system', content: 'hi' })).toBe('tool');
  });

  it('returns null for malformed entries', () => {
    expect(messageRoleToTurnRole(null)).toBeNull();
    expect(messageRoleToTurnRole(undefined)).toBeNull();
    expect(messageRoleToTurnRole('')).toBeNull();
    expect(messageRoleToTurnRole({})).toBeNull();
    expect(messageRoleToTurnRole({ role: 'unknown' })).toBeNull();
  });
});

describe('normalizeTurnContent', () => {
  it('wraps the original entry under value', () => {
    const input = { role: 'user', content: 'hi', timestamp: 123 };
    expect(normalizeTurnContent(input)).toEqual({ value: input });
  });

  it('handles non-object entries without throwing', () => {
    expect(normalizeTurnContent('plain')).toEqual({ value: 'plain' });
    expect(normalizeTurnContent(null)).toEqual({ value: null });
  });
});

describe('replaceMessageAt', () => {
  it('replaces the entry at the given index via the patch fn', () => {
    const messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    const result = replaceMessageAt(messages, 0, (entry) => ({
      ...(entry as Record<string, unknown>),
      content: 'edited',
    }));
    expect(result).toEqual([
      { role: 'user', content: 'edited' },
      { role: 'assistant', content: 'b' },
    ]);
  });

  it('returns a copy on out-of-bounds index without mutating original', () => {
    const messages = [{ role: 'user', content: 'a' }];
    const result = replaceMessageAt(messages, 99, () => ({ role: 'user', content: 'edited' }));
    expect(result).toEqual([{ role: 'user', content: 'a' }]);
    expect(result).not.toBe(messages);
  });

  it('returns empty array when input is not an array', () => {
    expect(replaceMessageAt(null, 0, () => 'x')).toEqual([]);
    expect(replaceMessageAt(undefined, 0, () => 'x')).toEqual([]);
  });
});

describe('sliceMessagesThrough', () => {
  it('keeps entries 0..keepThrough inclusive', () => {
    const messages = [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }];
    expect(sliceMessagesThrough(messages, 1)).toEqual([{ id: 0 }, { id: 1 }]);
    expect(sliceMessagesThrough(messages, 0)).toEqual([{ id: 0 }]);
  });

  it('returns empty array for keepThrough < 0', () => {
    expect(sliceMessagesThrough([{ id: 0 }], -1)).toEqual([]);
  });

  it('returns empty when input is not an array', () => {
    expect(sliceMessagesThrough(null, 0)).toEqual([]);
  });
});
