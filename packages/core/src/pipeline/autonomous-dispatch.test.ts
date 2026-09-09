import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectLimit = vi.fn();
const dbExecute = vi.fn(async () => []);
const insertAndEnqueueJob = vi.fn(async (_args: Record<string, unknown>) => ({ jobId: 'job-1' }));
const openIssueRun = vi.fn(async () => ({ id: 'run-1', startedAt: new Date() }));
const wakeMastersForProject = vi.fn(async () => 1);

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
  projectCreatedBy: 'user-1',
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
  // cm:guard `null` and "a config that parsed" are NOT one case, and this is where that is proved. ISS-897 left one lane, so `mode` is gone and the only question left is whether the config could be read at all — `null` is a missing, archived or unparseable project and must answer false, because rewriting parks and cascading children on a project nobody can see is broken is the worse direction.
  it('answers false only for an unreadable config', () => {
    expect(isAutonomous(null)).toBe(false);
    expect(isAutonomous({ enabled: true } as never)).toBe(true);
    expect(isAutonomous({ enabled: false } as never)).toBe(true);
  });
});

describe('dispatchAutonomous', () => {
  // cm:guard the one `false` this function still returns, and the caller relies on it: an unreadable config must produce no job at all rather than a drive session against a project whose settings nobody could parse.
  it('declines the decision when the config could not be read', async () => {
    expect(await dispatchAutonomous({ ...BASE, status: 'open', cfg: null })).toBe(false);
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
  });

  // cm:guard the entry status is where core used to mint, and it must now mint NOTHING. A wake is already published by `ws/master-wake.ts` on this arrival, so the only thing left for core to do here is stay out of the way (ISS-933 criteria 4 and 23).
  it('mints neither a run nor a job at the entry status', async () => {
    expect(await dispatchAutonomous({ ...BASE, status: 'open', cfg: { enabled: true } })).toBe(
      true,
    );

    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
    expect(openIssueRun).not.toHaveBeenCalled();
  });

  // cm:guard the property the whole branch exists for: falling through at a non-entry status makes the staged resolver report "no skill registered", which pauses the run and comments on the issue every time the agent moves it
  it('owns the decision at every other status, and enqueues nothing there', async () => {
    for (const status of ['confirmed', 'developed', 'testing', 'closed'] as const) {
      expect(await dispatchAutonomous({ ...BASE, status, cfg: { enabled: true } })).toBe(true);
    }
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
    expect(openIssueRun).not.toHaveBeenCalled();
  });
});

describe('dispatchDriveManual', () => {
  // cm:guard a human's Run OFFERS the issue and mints nothing. Minting here would be the second live path this wave removes: core's job and the box's run session both claiming one issue, with the ledger able to see only one of them (ISS-933 criterion 4).
  it('releases the issue and wakes the boxes, minting nothing', async () => {
    await expect(dispatchDriveManual({ ...BASE, status: 'open' })).resolves.toEqual({
      released: true,
    });

    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
    expect(openIssueRun).not.toHaveBeenCalled();
    expect(wakeMastersForProject).toHaveBeenCalledTimes(1);
    expect(dbExecute).toHaveBeenCalledTimes(1);
    expect(selectLimit).not.toHaveBeenCalled();
  });

  it('says where the driver actually starts instead of silently doing nothing', async () => {
    await expect(dispatchDriveManual({ ...BASE, status: 'developed' })).rejects.toThrow(
      'AUTONOMOUS_NOT_AT_ENTRY',
    );
    expect(insertAndEnqueueJob).not.toHaveBeenCalled();
  });
});
