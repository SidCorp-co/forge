import { beforeEach, describe, expect, it, vi } from 'vitest';

// db.update().set().where().returning() returns the resumed rows.
const updateReturning = vi.fn();
const dbUpdate = vi.fn(() => ({
  set: () => ({ where: () => ({ returning: updateReturning }) }),
}));

// db.select().from().where().limit() — used by the per-row issue status lookup.
const selectQueue: unknown[][] = [];
function pushSelect(rows: unknown[]) {
  selectQueue.push(rows);
}
function buildSelectChain() {
  const rows = selectQueue.shift() ?? [];
  return {
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  };
}

vi.mock('../db/client.js', () => ({
  db: {
    update: dbUpdate,
    select: () => buildSelectChain(),
  },
}));

const reEnqueueMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./orchestrator.js', () => ({
  reEnqueueForIssue: (...a: unknown[]) => reEnqueueMock(...(a as [])),
}));

// The shared pause writer (run-pause.ts) broadcasts to the project room and
// pulls in ws/server → auth/cookie → env validation; stub it.
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

const { HooksBus } = await import('./hooks.js');
const { registerMissingSkillResume } = await import('./missing-skill-resume.js');

beforeEach(() => {
  updateReturning.mockReset();
  dbUpdate.mockClear();
  selectQueue.length = 0;
  reEnqueueMock.mockReset();
  reEnqueueMock.mockResolvedValue(undefined);
});

describe('registerMissingSkillResume (ISS-238)', () => {
  it('is a no-op when the skillRegistered payload has stage=null (unbind)', async () => {
    const bus = new HooksBus();
    registerMissingSkillResume(bus);
    await bus.emit('skillRegistered', {
      projectId: 'proj-1',
      skillId: 'skill-1',
      actorUserId: 'u-1',
      stage: null,
    });
    expect(dbUpdate).not.toHaveBeenCalled();
    expect(reEnqueueMock).not.toHaveBeenCalled();
  });

  it('does nothing when no paused runs match the registered stage', async () => {
    updateReturning.mockResolvedValueOnce([]);

    const bus = new HooksBus();
    registerMissingSkillResume(bus);
    await bus.emit('skillRegistered', {
      projectId: 'proj-1',
      skillId: 'skill-1',
      actorUserId: 'u-1',
      stage: 'developed',
    });

    expect(dbUpdate).toHaveBeenCalledTimes(1);
    expect(reEnqueueMock).not.toHaveBeenCalled();
  });

  it('flips matching paused runs back to running and re-enqueues their issues', async () => {
    updateReturning.mockResolvedValueOnce([
      { id: 'run-1', issueId: 'iss-1', currentStep: 'developed' },
      { id: 'run-2', issueId: 'iss-2', currentStep: 'developed' },
    ]);
    // Per-row issue status lookups (one each).
    pushSelect([{ status: 'developed' }]);
    pushSelect([{ status: 'developed' }]);

    const bus = new HooksBus();
    registerMissingSkillResume(bus);
    await bus.emit('skillRegistered', {
      projectId: 'proj-1',
      skillId: 'skill-1',
      actorUserId: 'u-1',
      stage: 'developed',
    });

    expect(dbUpdate).toHaveBeenCalledTimes(1);
    expect(reEnqueueMock).toHaveBeenCalledTimes(2);
    expect(reEnqueueMock.mock.calls[0]?.[0]).toMatchObject({
      issueId: 'iss-1',
      status: 'developed',
      reason: expect.objectContaining({ stage: 'developed' }),
    });
  });

  it('skips re-enqueue for resumed runs whose issueId is null (defensive)', async () => {
    updateReturning.mockResolvedValueOnce([
      { id: 'run-1', issueId: null, currentStep: 'developed' },
    ]);

    const bus = new HooksBus();
    registerMissingSkillResume(bus);
    await bus.emit('skillRegistered', {
      projectId: 'proj-1',
      skillId: 'skill-1',
      actorUserId: 'u-1',
      stage: 'developed',
    });

    expect(reEnqueueMock).not.toHaveBeenCalled();
  });
});
