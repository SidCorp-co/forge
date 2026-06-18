import { beforeEach, describe, expect, it, vi } from 'vitest';

// db.select(...).from(...).where(...).limit(...) → resolves the queued issue row.
const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

// notify-transitions routes through emit.ts (ISS-510), which delegates to the
// mocked createNotification — so assertions on createNotification still hold,
// and we additionally see the severity/resolutionKey emit.ts/notify add.
const createNotification = vi.fn(async () => ({ id: 'notif-1' }));
vi.mock('./routes.js', () => ({ createNotification }));

const resolveNotifications = vi.fn(async () => 0);
vi.mock('./auto-resolve.js', () => ({ resolveNotifications }));

const { registerTransitionNotifications } = await import('./notify-transitions.js');
const { HooksBus } = await import('../pipeline/hooks.js');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ASSIGNEE_ID = '33333333-3333-4333-8333-333333333333';
const CREATOR_ID = '44444444-4444-4444-8444-444444444444';

function makeBus() {
  const bus = new HooksBus();
  registerTransitionNotifications(bus);
  return bus;
}

function queueIssue(row: Record<string, unknown> | null) {
  selectLimit.mockResolvedValueOnce(row ? [row] : []);
}

function transition(to: string, actorId: string | null = 'someone-else') {
  return {
    issueId: ISSUE_ID,
    projectId: PROJECT_ID,
    actor: actorId ? { type: 'user' as const, id: actorId } : { type: 'system' as const },
    from: 'developed',
    to,
    reopenCount: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  createNotification.mockResolvedValue({ id: 'notif-1' });
  resolveNotifications.mockResolvedValue(0);
});

describe('notify-transitions', () => {
  it.each(['tested', 'reopen', 'waiting', 'closed'])(
    'creates a notification for the assignee on transition to %s',
    async (to) => {
      queueIssue({ assigneeId: ASSIGNEE_ID, createdById: CREATOR_ID, issSeq: 42, title: 'Fix it' });
      const bus = makeBus();
      await bus.emit('transition', transition(to) as never);
      expect(createNotification).toHaveBeenCalledTimes(1);
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: ASSIGNEE_ID,
          type: 'issue_status_changed',
          issueId: ISSUE_ID,
          projectId: PROJECT_ID,
          title: expect.stringContaining(`ISS-42`),
        }),
      );
    },
  );

  it('falls back to the creator when there is no assignee', async () => {
    queueIssue({ assigneeId: null, createdById: CREATOR_ID, issSeq: 7, title: 'No assignee' });
    const bus = makeBus();
    await bus.emit('transition', transition('tested') as never);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CREATOR_ID }),
    );
  });

  it('does not notify for a non-listed status', async () => {
    const bus = makeBus();
    await bus.emit('transition', transition('in_progress') as never);
    expect(selectLimit).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('sets error severity + a status resolution key on reopen', async () => {
    queueIssue({ assigneeId: ASSIGNEE_ID, createdById: CREATOR_ID, issSeq: 11, title: 'Regressed' });
    const bus = makeBus();
    await bus.emit('transition', transition('reopen') as never);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        resolutionKey: `issue:${ISSUE_ID}:status`,
      }),
    );
  });

  it('sets warning severity but NO resolution key on tested (informational gate)', async () => {
    queueIssue({ assigneeId: ASSIGNEE_ID, createdById: CREATOR_ID, issSeq: 12, title: 'Ready' });
    const bus = makeBus();
    await bus.emit('transition', transition('tested') as never);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warning', resolutionKey: null }),
    );
  });

  it('auto-resolves the status problem notification on a healthy transition', async () => {
    // `developed` is healthy but NOT in NOTIFY_ON_STATUS: it clears the problem
    // notification without creating a new one.
    const bus = makeBus();
    await bus.emit('transition', transition('developed') as never);
    expect(resolveNotifications).toHaveBeenCalledWith(`issue:${ISSUE_ID}:status`);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('does not auto-resolve for a non-healthy, non-listed status', async () => {
    const bus = makeBus();
    await bus.emit('transition', transition('in_progress') as never);
    expect(resolveNotifications).not.toHaveBeenCalled();
  });

  it('skips self-notify when the actor is the recipient', async () => {
    queueIssue({ assigneeId: ASSIGNEE_ID, createdById: CREATOR_ID, issSeq: 9, title: 'Mine' });
    const bus = makeBus();
    await bus.emit('transition', transition('tested', ASSIGNEE_ID) as never);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('skips when there is no recipient at all', async () => {
    queueIssue({ assigneeId: null, createdById: null, issSeq: 1, title: 'Orphan' });
    const bus = makeBus();
    await bus.emit('transition', transition('closed') as never);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('does not throw when createNotification fails', async () => {
    queueIssue({ assigneeId: ASSIGNEE_ID, createdById: CREATOR_ID, issSeq: 5, title: 'Boom' });
    createNotification.mockRejectedValueOnce(new Error('db down'));
    const bus = makeBus();
    await expect(bus.emit('transition', transition('reopen') as never)).resolves.toBeUndefined();
  });
});
