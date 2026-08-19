import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectLimit = vi.fn();
const insertAndEnqueueJob = vi.fn(async (_args: Record<string, unknown>) => ({ jobId: 'job-1' }));
const openIssueRun = vi.fn(async () => ({ id: 'run-1', startedAt: new Date() }));

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }),
  },
}));
vi.mock('./enqueue-helper.js', () => ({
  insertAndEnqueueJob,
  ActiveJobConflictError: class ActiveJobConflictError extends Error {},
}));
vi.mock('./runs.js', () => ({ openIssueRun }));

const { autonomousStepFor, dispatchAutonomous, isAutonomous } = await import(
  './autonomous-dispatch.js'
);

const ACTOR = { type: 'user', id: 'user-1' } as const;
const BASE = {
  projectId: 'proj-1',
  issueId: 'issue-1',
  actor: ACTOR,
  projectCreatedBy: 'user-1',
} as const;

beforeEach(() => {
  selectLimit.mockReset();
  insertAndEnqueueJob.mockClear();
  openIssueRun.mockClear();
});

describe('autonomousStepFor', () => {
  it('produces the drive step only at the entry status', () => {
    expect(autonomousStepFor('open')).toEqual({ type: 'drive', skillName: 'forge-drive' });
    for (const status of ['confirmed', 'approved', 'developed', 'testing', 'closed'] as const) {
      expect(autonomousStepFor(status)).toBeNull();
    }
  });
});

describe('isAutonomous', () => {
  it('is false for every project that has not said otherwise', () => {
    expect(isAutonomous(null)).toBe(false);
    expect(isAutonomous({ enabled: true })).toBe(false);
    expect(isAutonomous({ enabled: true, mode: 'staged' })).toBe(false);
    expect(isAutonomous({ enabled: true, mode: 'autonomous' })).toBe(true);
  });
});

describe('dispatchAutonomous', () => {
  it('declines the decision on a staged project so the caller walks its own path', async () => {
    expect(await dispatchAutonomous({ ...BASE, status: 'open', cfg: { enabled: true } })).toBe(
      false,
    );
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
  });

  it('enqueues exactly one drive job at the entry status', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'open' }]);

    expect(await dispatchAutonomous({ ...BASE, status: 'open', cfg: { mode: 'autonomous' } })).toBe(
      true,
    );

    expect(insertAndEnqueueJob).toHaveBeenCalledTimes(1);
    expect(insertAndEnqueueJob.mock.calls[0]?.[0]).toMatchObject({
      type: 'drive',
      skillName: 'forge-drive',
      pipelineRunId: 'run-1',
      payloadExtras: { mode: 'autonomous' },
    });
  });

  // cm:guard forge_phase takes runId as a REQUIRED argument, so a prompt without it instructs the agent to make a call it cannot make — and the failure looks like the agent ignoring its skill
  it('tells the agent which run it is on, since forge_phase cannot be called without it', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'open' }]);

    await dispatchAutonomous({ ...BASE, status: 'open', cfg: { mode: 'autonomous' } });

    const prompt = String(insertAndEnqueueJob.mock.calls[0]?.[0]?.promptString ?? '');
    expect(prompt).toContain('run-1');
    expect(prompt).toContain('resume_point');
  });

  // cm:guard the property the whole branch exists for: falling through at a non-entry status makes the staged resolver report "no skill registered", which pauses the run and comments on the issue every time the agent moves it
  it('owns the decision at every other status, and enqueues nothing there', async () => {
    for (const status of ['confirmed', 'developed', 'testing', 'closed'] as const) {
      expect(await dispatchAutonomous({ ...BASE, status, cfg: { mode: 'autonomous' } })).toBe(true);
    }
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
    expect(openIssueRun).not.toHaveBeenCalled();
  });

  it('does not enqueue when the issue has already moved off the entry status', async () => {
    selectLimit.mockResolvedValueOnce([{ status: 'in_progress' }]);

    expect(await dispatchAutonomous({ ...BASE, status: 'open', cfg: { mode: 'autonomous' } })).toBe(
      true,
    );
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
  });

  it('refuses rather than inventing an author when the project has no creator', async () => {
    expect(
      await dispatchAutonomous({
        ...BASE,
        actor: { type: 'device', id: 'dev-1' },
        projectCreatedBy: null,
        status: 'open',
        cfg: { mode: 'autonomous' },
      }),
    ).toBe(true);
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
  });
});
