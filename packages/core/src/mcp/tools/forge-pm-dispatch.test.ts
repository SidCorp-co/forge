import { describe, expect, it, vi } from 'vitest';
import { makeFakeDevice } from '../fake-device.fixture.js';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('./project-authz.js', () => ({ assertPmActor: vi.fn().mockResolvedValue(undefined) }));

const { pmDispatchHandler, pmDispatchInputSchema } = await import('./forge-pm-dispatch.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';

// cm:guard the ~200 lines of enqueue/authz/manual-mode scenarios this replaced tested a path ISS-895 deleted: every job type PM could dispatch was a staged step, and none is in `RUNNER_CAPABILITIES` any more. Restoring those cases would assert a job that no runner can accept, i.e. green on a dispatch that dead-ends.
describe('forge_pm.dispatch after the staged lane was removed (ISS-895)', () => {
  it('refuses every job type by name rather than enqueuing something unrunnable', async () => {
    for (const jobType of ['code', 'plan', 'review', 'test', 'fix', 'release', 'drive'] as const) {
      await expect(
        pmDispatchHandler(makeFakeDevice('dev-1', 'user-1'), {
          projectId: PROJECT_ID,
          issueId: ISSUE_ID,
          jobType,
          reason: 'why',
        }),
      ).rejects.toThrow(/PM step dispatch was removed with the staged lane/);
    }
  });

  it('names the job type asked for, so an operator can tell which call failed', async () => {
    await expect(
      pmDispatchHandler(makeFakeDevice('dev-1', 'user-1'), {
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        jobType: 'code',
        reason: 'why',
      }),
    ).rejects.toThrow(/jobType "code"/);
  });

  it('still validates its input shape before refusing', () => {
    expect(
      pmDispatchInputSchema.safeParse({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        jobType: 'not-a-job-type',
        reason: 'why',
      }).success,
    ).toBe(false);
  });
});
