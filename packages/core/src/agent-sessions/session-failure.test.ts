import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub eager env validation (config/env.js throws at import when DATABASE_URL /
// JWT_SECRET / DEVICE_TOKEN_PEPPER are absent) so this unit suite stays hermetic
// — same pattern as chat-turn.test.ts.
vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const redispatchScheduleSessionOnFailoverMock = vi.fn(
  async (_sessionId: string, _opts?: { failureClass?: string | null }) => ({
    ok: true as const,
    status: 'redispatched' as const,
    sessionId: 'retry-sess',
    deviceId: 'device-2',
  }),
);
vi.mock('../schedules/dispatch.js', () => ({
  redispatchScheduleSessionOnFailover: (
    sessionId: string,
    opts?: { failureClass?: string | null },
  ) => redispatchScheduleSessionOnFailoverMock(sessionId, opts),
}));

const { detectUnexpandedSkillFailure, failureClassOf, finalizeScheduleSessionFailure } =
  await import('./session-failure.js');
const { FAILURE_CAUSES } = await import('../pipeline/failure-causes.js');

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

describe('finalizeScheduleSessionFailure', () => {
  beforeEach(() => {
    redispatchScheduleSessionOnFailoverMock.mockClear();
  });

  it('a failure that matches no classifier pattern still persists a reason (never left NULL)', async () => {
    const set: Record<string, unknown> = {};
    const result = await finalizeScheduleSessionFailure({
      sessionId: 'sess-1',
      messages: [{ role: 'assistant', content: 'some unrelated tool error' }],
      note: null,
      baseMetadata: { source: 'schedule.run', scheduleId: 'sched-1' },
      set,
    });
    expect(result.action).not.toBe('failover');
    expect(typeof set.failureReason).toBe('string');
    expect(set.failureReason).toBeTruthy();
    expect(redispatchScheduleSessionOnFailoverMock).not.toHaveBeenCalled();
  });

  // cm:why every other test here authors its transcript as `assistant`, which is why the prompt-as-error defect shipped: the classifier only ever saw runner text in tests. A schedule transcript really opens with the schedule's own prompt as a `user` message.
  it('does NOT classify the schedule prompt — a user message saying "usage limit" must not trigger a failover', async () => {
    const set: Record<string, unknown> = {};
    const result = await finalizeScheduleSessionFailure({
      sessionId: 'sess-1',
      messages: [
        {
          role: 'user',
          content:
            'You are the Forge skill-optimizer agent. Report any usage limit reached or rate limit exceeded condition you observe.',
        },
        { role: 'assistant', content: 'some unrelated tool error' },
      ],
      note: null,
      baseMetadata: { source: 'schedule.run', scheduleId: 'sched-1' },
      set,
    });
    expect(result.action).not.toBe('failover');
    expect(redispatchScheduleSessionOnFailoverMock).not.toHaveBeenCalled();
    expect(set.failureReason).not.toContain('Forge skill-optimizer agent');
  });

  it('classifies a usage/session-limit hit as action:failover, stamps limitResetAt, and recovers the schedule run', async () => {
    const set: Record<string, unknown> = {};
    const result = await finalizeScheduleSessionFailure({
      sessionId: 'sess-1',
      messages: [
        {
          role: 'assistant',
          content: "[RESULT_ERROR] You've hit your weekly limit · resets 11am (Asia/Ho_Chi_Minh)",
        },
      ],
      note: null,
      baseMetadata: { source: 'schedule.run', scheduleId: 'sched-1' },
      set,
    });

    expect(result.action).toBe('failover');
    expect(set.failureReason).toBeTruthy();
    expect((set.metadata as Record<string, unknown>)?.scheduleId).toBe('sched-1');

    await result.recoverAfterWrite({ source: 'schedule.run', scheduleId: 'sched-1' });
    expect(redispatchScheduleSessionOnFailoverMock).toHaveBeenCalledWith('sess-1', {
      failureClass: 'usage/session limit',
    });
  });

  it('does not fail over a non-schedule (plain chat) session even on a failover-classified hit', async () => {
    const set: Record<string, unknown> = {};
    const result = await finalizeScheduleSessionFailure({
      sessionId: 'sess-1',
      messages: [
        {
          role: 'assistant',
          content: "[RESULT_ERROR] You've hit your weekly limit · resets 11am (Asia/Ho_Chi_Minh)",
        },
      ],
      note: null,
      baseMetadata: { source: 'chat' },
      set,
    });
    expect(result.action).toBe('failover');
    await result.recoverAfterWrite({ source: 'chat' });
    expect(redispatchScheduleSessionOnFailoverMock).not.toHaveBeenCalled();
  });
  it('ISS-877: writes a cause token into failureReason and the sentence into failureDetail', async () => {
    const set: Record<string, unknown> = {};
    await finalizeScheduleSessionFailure({
      sessionId: 'sess-1',
      messages: [
        {
          role: 'assistant',
          content:
            "[RESULT_ERROR] You've hit your weekly limit \u00b7 resets 11am (Asia/Ho_Chi_Minh)",
        },
      ],
      note: null,
      baseMetadata: { source: 'schedule.run', scheduleId: 'sched-1' },
      set,
    });
    expect(set.failureReason).toBe('provider_usage_limit');
    expect(FAILURE_CAUSES).toContain(set.failureReason);
    expect(String(set.failureDetail)).toContain('cross-device failover');
  });

  describe('failureClassOf', () => {
    it('keeps the class and drops the predicted disposition', () => {
      expect(failureClassOf('usage/session limit → cross-device failover')).toBe(
        'usage/session limit',
      );
      expect(
        failureClassOf('org/account spend limit → per-account failover with exhaustion memory'),
      ).toBe('org/account spend limit');
    });

    it('returns a reason that carries no disposition unchanged', () => {
      expect(failureClassOf('cc-startup-death (≤3 msgs, no tool use)')).toBe(
        'cc-startup-death (≤3 msgs, no tool use)',
      );
    });
  });

  it('a plain chat session records that no failover exists, not the predicted one', async () => {
    const set: Record<string, unknown> = {};
    await finalizeScheduleSessionFailure({
      sessionId: 'sess-1',
      messages: [
        {
          role: 'assistant',
          content:
            "[RESULT_ERROR] You've hit your weekly limit \u00b7 resets 11am (Asia/Ho_Chi_Minh)",
        },
      ],
      note: null,
      baseMetadata: { source: 'chat' },
      set,
    });
    expect(set.failureReason).toBe('provider_usage_limit');
    expect(set.failureDetail).toBe('usage/session limit → no failover (plain chat session)');
  });

  it("leaves an agent-chat session's detail to its own failover path", async () => {
    const set: Record<string, unknown> = {};
    await finalizeScheduleSessionFailure({
      sessionId: 'sess-1',
      messages: [
        {
          role: 'assistant',
          content:
            "[RESULT_ERROR] You've hit your weekly limit \u00b7 resets 11am (Asia/Ho_Chi_Minh)",
        },
      ],
      note: null,
      baseMetadata: { source: 'rocketchat.agent-chat', agentChat: { rid: 'r1' } },
      set,
    });
    expect(String(set.failureDetail)).toContain('cross-device failover');
  });

  it('ISS-877: a sentence can never land in failureReason again, whatever the transcript says', async () => {
    for (const content of [
      'some unrelated tool error',
      "I'll look at the screenshots and check how CSAT sending decides its window.",
      '[RESULT_ERROR] success: a provider message nobody has a pattern for',
    ]) {
      const set: Record<string, unknown> = {};
      await finalizeScheduleSessionFailure({
        sessionId: 'sess-1',
        messages: [{ role: 'assistant', content }],
        note: null,
        baseMetadata: { source: 'chat' },
        set,
      });
      expect(FAILURE_CAUSES, content).toContain(set.failureReason);
      expect(set.failureReason, content).toBe('unclassified');
      expect(set.failureDetail, content).toBeTruthy();
    }
  });
});
