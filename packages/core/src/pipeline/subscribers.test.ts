import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeRecordActivity = vi.fn();
vi.mock('./activity.js', () => ({
  safeRecordActivity,
}));

const loggerError = vi.fn();
vi.mock('../logger.js', () => ({
  logger: { error: loggerError },
}));

const { HooksBus } = await import('./hooks.js');
const { registerActivitySubscribers } = await import('./subscribers.js');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const COMMENT_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR = { type: 'user' as const, id: USER_ID };

function newBus() {
  const bus = new HooksBus();
  registerActivitySubscribers(bus);
  return bus;
}

beforeEach(() => {
  safeRecordActivity.mockReset();
  safeRecordActivity.mockResolvedValue(undefined);
});

describe('registerActivitySubscribers', () => {
  it('issueCreated → records issue.created with snapshot', async () => {
    const bus = newBus();
    const snapshot = {
      title: 't',
      description: 'd',
      priority: 'high',
      category: null,
      assigneeId: null,
      labels: [],
    };
    await bus.emit('issueCreated', {
      issueId: ISSUE_ID,
      projectId: PROJECT_ID,
      actor: ACTOR,
      snapshot,
    });
    expect(safeRecordActivity).toHaveBeenCalledWith({
      issueId: ISSUE_ID,
      actor: ACTOR,
      action: 'issue.created',
      payload: { snapshot },
    });
  });

  it('issueUpdated with non-assignee fields → records issue.updated only', async () => {
    const bus = newBus();
    await bus.emit('issueUpdated', {
      issueId: ISSUE_ID,
      projectId: PROJECT_ID,
      actor: ACTOR,
      fields: ['title', 'priority'],
      before: { title: 'a', priority: 'low' },
      after: { title: 'b', priority: 'high' },
    });
    expect(safeRecordActivity).toHaveBeenCalledTimes(1);
    expect(safeRecordActivity).toHaveBeenCalledWith({
      issueId: ISSUE_ID,
      actor: ACTOR,
      action: 'issue.updated',
      payload: {
        fields: ['title', 'priority'],
        before: { title: 'a', priority: 'low' },
        after: { title: 'b', priority: 'high' },
      },
    });
  });

  it('issueUpdated with assigneeId → records issue.assigned only (no issue.updated for assignee)', async () => {
    const bus = newBus();
    await bus.emit('issueUpdated', {
      issueId: ISSUE_ID,
      projectId: PROJECT_ID,
      actor: ACTOR,
      fields: ['assigneeId'],
      before: { assigneeId: null },
      after: { assigneeId: USER_ID },
    });
    expect(safeRecordActivity).toHaveBeenCalledTimes(1);
    expect(safeRecordActivity).toHaveBeenCalledWith({
      issueId: ISSUE_ID,
      actor: ACTOR,
      action: 'issue.assigned',
      payload: { before: null, after: USER_ID },
    });
  });

  it('issueUpdated with mixed fields → records both issue.updated (non-assignee) and issue.assigned', async () => {
    const bus = newBus();
    await bus.emit('issueUpdated', {
      issueId: ISSUE_ID,
      projectId: PROJECT_ID,
      actor: ACTOR,
      fields: ['title', 'assigneeId'],
      before: { title: 'a', assigneeId: null },
      after: { title: 'b', assigneeId: USER_ID },
    });
    expect(safeRecordActivity).toHaveBeenCalledTimes(2);
    expect(safeRecordActivity.mock.calls[0]?.[0]).toMatchObject({
      action: 'issue.updated',
      payload: { fields: ['title'] },
    });
    expect(safeRecordActivity.mock.calls[1]?.[0]).toMatchObject({
      action: 'issue.assigned',
    });
  });

  it('transition → records issue.statusChanged with reopenCount', async () => {
    const bus = newBus();
    await bus.emit('transition', {
      issueId: ISSUE_ID,
      projectId: PROJECT_ID,
      actor: ACTOR,
      from: 'open',
      to: 'confirmed',
      reopenCount: 0,
      reason: 'triage done',
    });
    expect(safeRecordActivity).toHaveBeenCalledWith({
      issueId: ISSUE_ID,
      actor: ACTOR,
      action: 'issue.statusChanged',
      payload: { from: 'open', to: 'confirmed', reopenCount: 0, reason: 'triage done' },
    });
  });

  it('transition without reason omits the reason key', async () => {
    const bus = newBus();
    await bus.emit('transition', {
      issueId: ISSUE_ID,
      projectId: PROJECT_ID,
      actor: ACTOR,
      from: 'open',
      to: 'confirmed',
      reopenCount: 0,
    });
    const call = safeRecordActivity.mock.calls[0]?.[0];
    expect(call?.payload).toEqual({ from: 'open', to: 'confirmed', reopenCount: 0 });
  });

  it('commentCreated → records comment.created with 240-char snippet', async () => {
    const bus = newBus();
    const body = 'a'.repeat(400);
    await bus.emit('commentCreated', {
      issueId: ISSUE_ID,
      projectId: PROJECT_ID,
      actor: ACTOR,
      commentId: COMMENT_ID,
      body,
    });
    const call = safeRecordActivity.mock.calls[0]?.[0];
    expect(call?.action).toBe('comment.created');
    expect((call?.payload as { body: string }).body.length).toBe(240);
  });

  it('commentUpdated → records comment.updated with truncated before/after', async () => {
    const bus = newBus();
    await bus.emit('commentUpdated', {
      issueId: ISSUE_ID,
      projectId: PROJECT_ID,
      actor: ACTOR,
      commentId: COMMENT_ID,
      before: 'old',
      after: 'new',
    });
    expect(safeRecordActivity).toHaveBeenCalledWith({
      issueId: ISSUE_ID,
      actor: ACTOR,
      action: 'comment.updated',
      payload: { commentId: COMMENT_ID, before: 'old', after: 'new' },
    });
  });

  it('commentDeleted → records comment.deleted', async () => {
    const bus = newBus();
    await bus.emit('commentDeleted', {
      issueId: ISSUE_ID,
      projectId: PROJECT_ID,
      actor: ACTOR,
      commentId: COMMENT_ID,
    });
    expect(safeRecordActivity).toHaveBeenCalledWith({
      issueId: ISSUE_ID,
      actor: ACTOR,
      action: 'comment.deleted',
      payload: { commentId: COMMENT_ID },
    });
  });
});
