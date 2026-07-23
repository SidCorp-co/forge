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

  // ISS-733 re-fix (review 3c4281c2 blocker) — the messages this detector actually
  // sees on the armed (remote, cold-start) path are produced by the CLI runner's
  // `parse_assistant_message` (chat.rs), which emits `{ type: 'assistant', content }`
  // with NO `role` field (packages/web-v2/src/features/session/types.ts:64-83). The
  // `role`-only fixtures above never exercise this shape — these do.
  describe('CLI-runner type-shaped messages (no role field)', () => {
    it('matches an "Unknown command" reply shaped like parse_assistant_message output', () => {
      const messages = [
        { id: 'u1', type: 'user', content: '/forge-onboard\nhi' },
        { id: 'a1', type: 'assistant', content: 'Unknown command: /forge-onboard' },
      ];
      expect(detectUnexpandedSkillFailure(messages, 'forge-onboard', 1)).toBe(true);
    });

    it('does not match a genuine type-shaped skill reply', () => {
      const messages = [
        { id: 'u1', type: 'user', content: '/forge-onboard\nhi' },
        { id: 'a1', type: 'assistant', content: "Here's what I found surveying the repo…" },
      ];
      expect(detectUnexpandedSkillFailure(messages, 'forge-onboard', 1)).toBe(false);
    });

    it('does not match a type-shaped user message', () => {
      const userOnly = [{ id: 'u1', type: 'user', content: 'Unknown command: /forge-onboard' }];
      expect(detectUnexpandedSkillFailure(userOnly, 'forge-onboard', 0)).toBe(false);
    });
  });

  it('escapes regex-special characters in skillName instead of throwing/misparsing', () => {
    const messages = [{ type: 'assistant', content: 'Unknown command: /forge.onboard' }];
    expect(detectUnexpandedSkillFailure(messages, 'forge.onboard', 0)).toBe(true);
    // a literal dot must not match an arbitrary character
    const messages2 = [{ type: 'assistant', content: 'Unknown command: /forgeXonboard' }];
    expect(detectUnexpandedSkillFailure(messages2, 'forge.onboard', 0)).toBe(false);
  });
});
