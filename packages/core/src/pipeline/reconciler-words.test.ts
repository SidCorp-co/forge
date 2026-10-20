import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { buildCapReachedCommentBody } = await import('./autonomous-rescue-comment.js');
const { buildWedgeResetBody } = await import('./wedge-lease.js');

/** Job types and engine words a person reading an issue's comments has no use for. */
const ENGINE_WORDS = /`drive`|\bdrive (job|session)s?\b|\bmint\b|re-entered the driver/i;

// ISS-1229 r16, judge-41: the reconciler told a person about a `drive` job.
describe('what the reconciler says on an issue a person reads', () => {
  it('says why it moved the issue without naming a job type', () => {
    const body = buildWedgeResetBody({
      from: 'in_progress',
      to: 'open',
      grace: '30 minutes',
      reading: { verdict: 'none', holder: null } as Parameters<
        typeof buildWedgeResetBody
      >[0]['reading'],
    });
    expect(body).toContain('the agent that last worked on it has stopped');
    expect(body).not.toMatch(ENGINE_WORDS);
  });

  it('names a lapsed claim and its time as a person reads them', () => {
    const body = buildWedgeResetBody({
      from: 'in_progress',
      to: 'open',
      grace: '30 minutes',
      reading: {
        verdict: 'expired',
        holder: 'iss-run-1',
        expiresAt: new Date('2026-10-18T07:30:00Z'),
      } as Parameters<typeof buildWedgeResetBody>[0]['reading'],
    });
    expect(body).toContain('the claim iss-run-1 held on it ran out at 18 Oct 2026, 07:30 UTC');
    expect(body).not.toMatch(/`|\d{4}-\d\d-\d\dT/);
  });

  it('hands an issue to a person after its tries without naming a job type', () => {
    const body = buildCapReachedCommentBody({
      fromStatus: 'in_progress',
      cap: 3,
      sessions: { completed: 1, failed: 3, stopped: 0, open: 0 },
    });
    expect(body).toContain('Forge sent it back 3 times on this run');
    expect(body).not.toMatch(ENGINE_WORDS);
  });

  // ISS-1228 r20, judge-62: four failed sessions read "finished without an error" and "0 agent sessions".
  it('counts the run\'s sessions and says how they ended, never that a failed one finished cleanly', () => {
    const body = buildCapReachedCommentBody({
      fromStatus: 'open',
      cap: 3,
      sessions: { completed: 0, failed: 4, stopped: 0, open: 0 },
    });
    expect(body).toContain('4 agent sessions worked this run: 4 failed.');
    expect(body).toContain('each one that failed says on its page why it ended');
    expect(body).not.toMatch(/without an error/);
  });

  it('says so where no session worked the run, and lists each way they ended', () => {
    const none = buildCapReachedCommentBody({
      fromStatus: 'open',
      cap: 3,
      sessions: { completed: 0, failed: 0, stopped: 0, open: 0 },
    });
    expect(none).toContain('No agent session has worked this run.');
    const mixed = buildCapReachedCommentBody({
      fromStatus: 'in_progress',
      cap: 3,
      sessions: { completed: 1, failed: 1, stopped: 1, open: 1 },
    });
    expect(mixed).toContain('4 agent sessions worked this run: 1 completed, 1 failed, 1 stopped, 1 still open.');
  });
});
