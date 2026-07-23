import { describe, expect, it, vi } from 'vitest';

// Stub eager env validation (config/env.js throws at import when DATABASE_URL /
// JWT_SECRET / DEVICE_TOKEN_PEPPER are absent) so this unit suite stays hermetic
// — same pattern as chat-turn.test.ts.
vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const { detectUnexpandedSkillFailure } = await import('./session-failure.js');

// ISS-733 fix — the sync-then-dispatch race: a chat-runs-skill cold start can
// report `completed` even when the skill file hadn't synced to the runner's
// disk yet, so the CLI treated `/<skillName>` as unknown text. This is the
// pure detector the PATCH /:id terminal-report handler uses to catch it.
describe('detectUnexpandedSkillFailure', () => {
  it('matches an "Unknown command" assistant reply for the pending skill', () => {
    const messages = [
      { role: 'user', content: '/forge-onboard\nhi' },
      { role: 'assistant', content: 'Unknown command: /forge-onboard' },
    ];
    expect(detectUnexpandedSkillFailure(messages, 'forge-onboard', 1)).toBe(true);
  });

  it('is case-insensitive', () => {
    const messages = [
      { role: 'user', content: '/forge-onboard\nhi' },
      { role: 'assistant', content: 'unknown COMMAND: /forge-onboard' },
    ];
    expect(detectUnexpandedSkillFailure(messages, 'forge-onboard', 1)).toBe(true);
  });

  it('does not match a genuine skill reply', () => {
    const messages = [
      { role: 'user', content: '/forge-onboard\nhi' },
      { role: 'assistant', content: "Here's what I found surveying the repo…" },
    ];
    expect(detectUnexpandedSkillFailure(messages, 'forge-onboard', 1)).toBe(false);
  });

  it('does not match a different skill name (no cross-skill false positive)', () => {
    const messages = [
      { role: 'user', content: '/forge-onboard\nhi' },
      { role: 'assistant', content: 'Unknown command: /forge-plan' },
    ];
    expect(detectUnexpandedSkillFailure(messages, 'forge-onboard', 1)).toBe(false);
  });

  it('only scans messages appended after priorMessageCount', () => {
    const messages = [
      { role: 'assistant', content: 'Unknown command: /forge-onboard' },
      { role: 'user', content: 'a follow-up' },
      { role: 'assistant', content: 'a genuine reply' },
    ];
    // priorMessageCount=1 means the pre-existing "Unknown command" line is
    // OUT of scope — only messages[1:] (this turn) are checked.
    expect(detectUnexpandedSkillFailure(messages, 'forge-onboard', 1)).toBe(false);
  });

  it('handles non-array messages and user-role matches safely', () => {
    expect(detectUnexpandedSkillFailure(null, 'forge-onboard', 0)).toBe(false);
    const userOnly = [{ role: 'user', content: 'Unknown command: /forge-onboard' }];
    expect(detectUnexpandedSkillFailure(userOnly, 'forge-onboard', 0)).toBe(false);
  });
});
