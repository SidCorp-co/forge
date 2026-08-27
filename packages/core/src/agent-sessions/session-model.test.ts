// Unit tests for the model marker every chat turn reads (ISS-718).
//
// `config/env.js` is stubbed because it throws at import when DATABASE_URL /
// JWT_SECRET / DEVICE_TOKEN_PEPPER are absent, and this suite must stay
// hermetic — the same pattern as chat-turn.test.ts.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const { readSessionModel, modelTierSchema } = await import('./session-model.js');

describe('readSessionModel', () => {
  it('reads each tier the DB enum declares', () => {
    for (const tier of modelTierSchema.options) {
      expect(readSessionModel({ model: tier })).toBe(tier);
    }
  });

  it('keeps an explicit Claude Code default selection', () => {
    expect(readSessionModel({ model: 'default' })).toBe('default');
  });

  it('ignores a model the allow-list does not contain', () => {
    expect(readSessionModel({ model: 'gpt-4' })).toBeNull();
    expect(readSessionModel({ model: 'Sonnet' })).toBeNull();
    expect(readSessionModel({ model: 'claude-sonnet-5' })).toBeNull();
  });

  it('survives malformed metadata instead of throwing on the dispatch path', () => {
    expect(readSessionModel(null)).toBeNull();
    expect(readSessionModel(undefined)).toBeNull();
    expect(readSessionModel({})).toBeNull();
    expect(readSessionModel({ model: null })).toBeNull();
    expect(readSessionModel({ model: 42 })).toBeNull();
    expect(readSessionModel({ model: { tier: 'opus' } })).toBeNull();
    expect(readSessionModel('opus')).toBeNull();
  });

  it('leaves the session s other metadata keys alone', () => {
    const meta = { deviceId: 'dev-1', model: 'opus', pendingSkillName: 'forge-drive' };
    expect(readSessionModel(meta)).toBe('opus');
    expect(meta).toEqual({ deviceId: 'dev-1', model: 'opus', pendingSkillName: 'forge-drive' });
  });
});
