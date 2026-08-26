import { describe, expect, it, vi } from 'vitest';

// cm:why the module reaches `db/client` for `loadPriorAttempts`, so importing it for the pure renderer alone would otherwise demand a real DATABASE_URL
vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { renderPriorAttemptsBlock } = await import('./prior-attempts.js');
type PriorAttempt = import('./prior-attempts.js').PriorAttempt;

function attempt(over: Partial<PriorAttempt> = {}): PriorAttempt {
  return {
    attempt: 2,
    sessionId: 'sess-parent',
    messageCount: 645,
    failureReason: 'org/account spend limit',
    salvage: null,
    ...over,
  };
}

describe('renderPriorAttemptsBlock', () => {
  it('renders nothing when there is no prior attempt, so the caller can splice unconditionally', () => {
    expect(renderPriorAttemptsBlock([], 1)).toBe('');
  });

  it('names the failure reason and the session to read, with its message count', () => {
    const out = renderPriorAttemptsBlock([attempt()], 3);
    expect(out).toContain('This is attempt 3. Attempt 2 failed: org/account spend limit.');
    expect(out).toContain("forge_agent_sessions.get({ sessionId: 'sess-parent' })");
    expect(out).toContain('645 messages');
    expect(out).toContain('Do NOT redo work');
  });

  it('points at a pushed salvage commit and marks it unreviewed', () => {
    const out = renderPriorAttemptsBlock(
      [
        attempt({
          salvage: {
            outcome: 'pushed',
            branch: 'ISS-862-runner-health',
            sha: 'a1b2c3d',
            files: 7,
            insertions: 214,
          },
        }),
      ],
      3,
    );
    expect(out).toContain('ISS-862-runner-health');
    expect(out).toContain('a1b2c3d');
    expect(out).toContain('7 file(s), +214');
    expect(out).toContain('WIP, not reviewed work');
  });

  it('tells the agent to redo the work when the salvage commit never reached the remote', () => {
    const out = renderPriorAttemptsBlock(
      [attempt({ salvage: { outcome: 'committed_not_pushed', sha: 'deadbee' } })],
      3,
    );
    expect(out).toContain('push FAILED');
    expect(out).toContain('Treat that work as lost');
  });

  it('says the edits are gone when salvage was refused', () => {
    const out = renderPriorAttemptsBlock(
      [attempt({ salvage: { outcome: 'refused', detail: 'detached HEAD' } })],
      3,
    );
    expect(out).toContain('detached HEAD');
    expect(out).toContain('are gone');
  });

  it('stays silent about salvage when the attempt had nothing uncommitted', () => {
    const out = renderPriorAttemptsBlock([attempt({ salvage: { outcome: 'none' } })], 3);
    expect(out).not.toContain('salvage');
    expect(out).not.toContain('WIP');
  });

  it('lists earlier attempts in the chain, not only the parent', () => {
    const out = renderPriorAttemptsBlock(
      [
        attempt({ attempt: 3, sessionId: 'sess-c', messageCount: 4 }),
        attempt({ attempt: 2, sessionId: 'sess-b', messageCount: 1031 }),
        attempt({ attempt: 1, sessionId: 'sess-a', messageCount: 869 }),
      ],
      4,
    );
    expect(out).toContain('attempt 2 `sess-b` (1031 messages)');
    expect(out).toContain('attempt 1 `sess-a` (869 messages)');
  });

  it('omits the transcript pointer when the failed attempt recorded no session', () => {
    const out = renderPriorAttemptsBlock([attempt({ sessionId: null })], 2);
    expect(out).not.toContain('forge_agent_sessions.get');
    expect(out).toContain('Attempt 2 failed');
  });
});
