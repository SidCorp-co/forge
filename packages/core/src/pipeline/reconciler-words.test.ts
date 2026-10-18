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

  it('hands an issue to a person after its tries without naming a job type', () => {
    const body = buildCapReachedCommentBody({ fromStatus: 'in_progress', cap: 3, driveSessions: 4 });
    expect(body).toContain('The agent working on this issue stopped at In progress 3 times');
    expect(body).toContain('4 agent sessions have worked on it so far.');
    expect(body).not.toMatch(ENGINE_WORDS);
  });
});
