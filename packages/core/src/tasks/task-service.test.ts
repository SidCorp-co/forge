import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectOrderBy = vi.fn();
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const deleteWhere = vi.fn(async () => undefined);

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => ({ where: deleteWhere })),
  },
}));

const emit = vi.fn(async (_name: string, _payload: Record<string, unknown>) => undefined);
vi.mock('../pipeline/hooks.js', () => ({
  hooks: { emit: (name: string, payload: Record<string, unknown>) => emit(name, payload) },
}));

const { db: dbMock } = await import('../db/client.js');
const { createTask, deleteTask, listTasksForIssue, updateTask } = await import('./task-service.js');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR = {
  type: 'device' as const,
  id: '22222222-2222-4222-8222-222222222222',
  agency: 'agent' as const,
};

const TASK = {
  id: '44444444-4444-4444-8444-444444444444',
  issueId: ISSUE_ID,
  projectId: PROJECT_ID,
  title: 'a task',
  description: null,
  status: 'backlog',
  priority: 'none',
  assigneeId: null,
  isAgentTask: false,
  agentStatus: null,
  agentLog: null,
  acceptanceCriteria: null,
  sortOrder: 3,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function emitted(name: string): Record<string, unknown>[] {
  return emit.mock.calls.filter(([n]) => n === name).map(([, payload]) => payload);
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockResolvedValue([{ max: 4 }]);
  insertReturning.mockResolvedValue([TASK]);
  updateReturning.mockResolvedValue([TASK]);
});

describe('createTask', () => {
  /**
   * The MCP copy this service replaced set neither of these. Every agent-created
   * task landed at the column default 0 — ahead of the human's ordering — and no
   * `taskCreated` frame reached the board, so the task appeared only on reload.
   */
  it('appends after the last task on the issue when no sortOrder is given', async () => {
    await createTask({ issueId: ISSUE_ID, projectId: PROJECT_ID, title: 't', actor: ACTOR });

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 5 }));
  });

  it('starts at 0 on an issue with no tasks yet', async () => {
    selectLimit.mockResolvedValue([{ max: null }]);

    await createTask({ issueId: ISSUE_ID, projectId: PROJECT_ID, title: 't', actor: ACTOR });

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 0 }));
  });

  it('honours an explicit sortOrder without querying for the max', async () => {
    await createTask({
      issueId: ISSUE_ID,
      projectId: PROJECT_ID,
      title: 't',
      sortOrder: 9,
      actor: ACTOR,
    });

    expect(selectLimit).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 9 }));
  });

  it('emits taskCreated so the board updates without a reload', async () => {
    await createTask({ issueId: ISSUE_ID, projectId: PROJECT_ID, title: 't', actor: ACTOR });

    expect(emitted('taskCreated')).toEqual([
      { taskId: TASK.id, issueId: ISSUE_ID, projectId: PROJECT_ID, actor: ACTOR },
    ]);
  });
});

describe('updateTask', () => {
  it('names only the columns whose value actually changed', async () => {
    await updateTask(TASK as never, { title: 'renamed', priority: 'none' }, ACTOR);

    expect(emitted('taskUpdated')[0]?.fields).toEqual(['title']);
  });

  it('emits nothing when every supplied value matches what is already stored', async () => {
    await updateTask(TASK as never, { title: 'a task' }, ACTOR);

    expect(emitted('taskUpdated')).toEqual([]);
  });

  it('reports a jsonb column changed on any explicit set, since its identity always differs', async () => {
    await updateTask(TASK as never, { acceptanceCriteria: null }, ACTOR, ['acceptanceCriteria']);

    expect(emitted('taskUpdated')[0]?.fields).toEqual(['acceptanceCriteria']);
  });

  it('returns null instead of emitting when the row is gone', async () => {
    updateReturning.mockResolvedValue([]);

    expect(await updateTask(TASK as never, { title: 'renamed' }, ACTOR)).toBeNull();
    expect(emitted('taskUpdated')).toEqual([]);
  });
});

describe('deleteTask', () => {
  it('emits taskDeleted carrying the parent issue and project', async () => {
    await deleteTask(TASK as never, ACTOR);

    expect(emitted('taskDeleted')).toEqual([
      { taskId: TASK.id, issueId: ISSUE_ID, projectId: PROJECT_ID, actor: ACTOR },
    ]);
  });
});

describe('listTasksForIssue', () => {
  /**
   * The MCP copy ordered by createdAt alone, so an agent browsing a reordered
   * issue read a different sequence than the human was looking at.
   */
  /**
   * ISS-562 — the projection is asserted on the query, not on the returned rows:
   * the db mock bypasses drizzle column selection, so a row-shape assertion stays
   * green while the query loads every heavy TOAST column from disk.
   */
  it('never selects the description column', async () => {
    selectOrderBy.mockResolvedValue([]);

    await listTasksForIssue(ISSUE_ID);

    const projection = vi.mocked(dbMock.select).mock.lastCall?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(projection).toBeDefined();
    for (const light of [
      'id',
      'issueId',
      'projectId',
      'title',
      'status',
      'priority',
      'assigneeId',
      'isAgentTask',
      'agentStatus',
      'acceptanceCriteria',
      'createdAt',
      'updatedAt',
    ]) {
      expect(projection).toHaveProperty(light);
    }
    expect(projection).not.toHaveProperty('description');
  });

  it('orders by the board order, not by creation time', async () => {
    selectOrderBy.mockResolvedValue([]);

    await listTasksForIssue(ISSUE_ID);

    expect(selectOrderBy).toHaveBeenCalledTimes(1);
    const columns = (selectOrderBy.mock.calls[0] as { queryChunks?: unknown[] }[]).map(
      (chunk) =>
        (chunk.queryChunks?.find((c) => (c as { name?: string })?.name) as { name: string })?.name,
    );
    expect(columns).toEqual(['sort_order', 'created_at']);
  });
});
