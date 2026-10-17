import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectLimit = vi.fn();
const dbExecute = vi.fn(async (): Promise<unknown[]> => []);
const insertAndEnqueueJob = vi.fn(async (_args: Record<string, unknown>) => ({ jobId: 'job-1' }));
const openIssueRun = vi.fn(async () => ({ id: 'run-1', startedAt: new Date() }));
const wakeMastersForProject = vi.fn(async () => ({ boxes: 1, delivered: 1, reached: 1 }));

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }),
    execute: dbExecute,
  },
}));
vi.mock('./enqueue-helper.js', () => ({
  insertAndEnqueueJob,
  ActiveJobConflictError: class ActiveJobConflictError extends Error {},
}));
vi.mock('./runs.js', () => ({ openIssueRun }));
vi.mock('../ws/master-wake.js', () => ({ wakeMastersForProject }));

const { autonomousStepFor, dispatchAutonomous, dispatchDriveManual, isAutonomous } = await import(
  './autonomous-dispatch.js'
);

const ACTOR = { type: 'user', id: 'user-1', agency: 'human' } as const;
const BASE = {
  projectId: 'proj-1',
  issueId: 'issue-1',
  actor: ACTOR,
} as const;

beforeEach(() => {
  selectLimit.mockReset();
  insertAndEnqueueJob.mockClear();
  openIssueRun.mockClear();
  dbExecute.mockClear();
  wakeMastersForProject.mockClear();
});

describe('autonomousStepFor', () => {
  it('produces the drive step only at the entry status', () => {
    expect(autonomousStepFor('open')).toEqual({ type: 'drive', skillName: 'issue-flow' });
    for (const status of ['confirmed', 'approved', 'developed', 'testing', 'closed'] as const) {
      expect(autonomousStepFor(status)).toBeNull();
    }
  });
});

describe('isAutonomous', () => {
  it('answers false only for an unreadable config', () => {
    expect(isAutonomous(null)).toBe(false);
    expect(isAutonomous({ enabled: true } as never)).toBe(true);
    expect(isAutonomous({ enabled: false } as never)).toBe(true);
  });
});

describe('dispatchAutonomous', () => {
  it('declines the decision when the config could not be read', async () => {
    expect(await dispatchAutonomous({ ...BASE, status: 'open', cfg: null })).toBe(false);
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
  });

  it('mints neither a run nor a job at the entry status', async () => {
    expect(await dispatchAutonomous({ ...BASE, status: 'open', cfg: { enabled: true } })).toBe(
      true,
    );

    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
    expect(openIssueRun).not.toHaveBeenCalled();
  });

  it('owns the decision at every other status, and enqueues nothing there', async () => {
    for (const status of ['confirmed', 'developed', 'testing', 'closed'] as const) {
      expect(await dispatchAutonomous({ ...BASE, status, cfg: { enabled: true } })).toBe(true);
    }
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
    expect(openIssueRun).not.toHaveBeenCalled();
  });
});

describe('dispatchDriveManual', () => {
  it('releases the issue and wakes the boxes, minting nothing, and says what it did', async () => {
    dbExecute.mockResolvedValueOnce([{ n: 2 }]);
    wakeMastersForProject.mockResolvedValueOnce({ boxes: 2, delivered: 3, reached: 1 });
    await expect(
      dispatchDriveManual({ ...BASE, status: 'open', entryGated: true }),
    ).resolves.toEqual({ released: true, masters: 2, boxesHeard: 1, taken: 0 });

    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
    expect(openIssueRun).not.toHaveBeenCalled();
    expect(wakeMastersForProject).toHaveBeenCalledTimes(1);
    expect(dbExecute).toHaveBeenCalledTimes(3);
    expect(selectLimit).not.toHaveBeenCalled();
  });

  // ISS-1228 round 13: two boxes hearing the wake were read as two boxes having taken the issue.
  it('answers boxes that heard the offer apart from sessions that took it', async () => {
    dbExecute.mockResolvedValueOnce([{ n: 1 }]);
    dbExecute.mockResolvedValueOnce([]);
    dbExecute.mockResolvedValueOnce([]);
    wakeMastersForProject.mockResolvedValueOnce({ boxes: 2, delivered: 2, reached: 2 });
    await expect(
      dispatchDriveManual({ ...BASE, status: 'open', entryGated: false }),
    ).resolves.toEqual({ released: false, masters: 1, boxesHeard: 2, taken: 0 });
  });

  it('counts each live session holding the issue once, and no row core has let go', async () => {
    dbExecute.mockResolvedValueOnce([{ n: 1 }]);
    dbExecute.mockResolvedValueOnce([]);
    dbExecute.mockResolvedValueOnce([
      { session_id: 's-1', held: true },
      { session_id: 's-1', held: true },
      { session_id: 's-2', held: false },
    ]);
    await expect(
      dispatchDriveManual({ ...BASE, status: 'open', entryGated: false }),
    ).resolves.toMatchObject({ taken: 1 });
  });

  // ISS-1228 round 11: with no master the press was answered as though something would take it.
  it('refuses where no master runs on the project, before writing anything', async () => {
    dbExecute.mockResolvedValueOnce([{ n: 0 }]);
    await expect(
      dispatchDriveManual({ ...BASE, status: 'open', entryGated: false }),
    ).rejects.toThrow('No master is running on this project');
    expect(dbExecute).toHaveBeenCalledTimes(1);
    expect(wakeMastersForProject).not.toHaveBeenCalled();
  });

  it('says where the driver actually starts instead of silently doing nothing', async () => {
    await expect(
      dispatchDriveManual({ ...BASE, status: 'developed', entryGated: false }),
    ).rejects.toThrow('AUTONOMOUS_NOT_AT_ENTRY');
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
  });
});
