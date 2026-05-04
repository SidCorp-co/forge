import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const publishMock = vi.fn();
vi.mock('./server.js', () => ({
  roomManager: { publish: (...args: unknown[]) => publishMock(...args) },
}));

const { HooksBus } = await import('../pipeline/hooks.js');
const { registerWsBroadcastSubscribers } = await import('./broadcast-subscribers.js');
const { projectRoom, userRoom } = await import('./rooms.js');

let bus: InstanceType<typeof HooksBus>;

beforeEach(() => {
  publishMock.mockClear();
  bus = new HooksBus();
  registerWsBroadcastSubscribers(bus);
});
afterEach(() => {
  bus.reset();
});

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const NOTIFICATION_ID = '33333333-3333-4333-8333-333333333333';
const DECISION_ID = '44444444-4444-4444-8444-444444444444';

describe('notificationCreated WS bridge', () => {
  it('publishes pm.escalation to the project room (in addition to user room) for pm_escalation', async () => {
    await bus.emit('notificationCreated', {
      notificationId: NOTIFICATION_ID,
      userId: USER_ID,
      projectId: PROJECT_ID,
      type: 'pm_escalation',
      title: 'Need a call on flaky deploy',
      issueId: null,
      agentSessionId: null,
      decisionId: DECISION_ID,
    });

    expect(publishMock).toHaveBeenCalledTimes(2);
    const rooms = publishMock.mock.calls.map((c) => c[0]);
    expect(rooms).toContain(userRoom(USER_ID));
    expect(rooms).toContain(projectRoom(PROJECT_ID));

    const projectCall = publishMock.mock.calls.find((c) => c[0] === projectRoom(PROJECT_ID));
    expect(projectCall?.[1]).toEqual({
      event: 'pm.escalation',
      data: {
        notificationId: NOTIFICATION_ID,
        projectId: PROJECT_ID,
        decisionId: DECISION_ID,
        title: 'Need a call on flaky deploy',
        userId: USER_ID,
      },
    });
  });

  it('does NOT publish pm.escalation for non-escalation notification types', async () => {
    await bus.emit('notificationCreated', {
      notificationId: NOTIFICATION_ID,
      userId: USER_ID,
      projectId: PROJECT_ID,
      type: 'mention',
      title: '@you',
      issueId: null,
      agentSessionId: null,
    });

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock.mock.calls[0]?.[0]).toBe(userRoom(USER_ID));
    expect((publishMock.mock.calls[0]?.[1] as { event: string }).event).toBe(
      'notification.created',
    );
  });

  it('does NOT publish pm.escalation when projectId is null (defensive — escalations are always project-scoped)', async () => {
    await bus.emit('notificationCreated', {
      notificationId: NOTIFICATION_ID,
      userId: USER_ID,
      projectId: null,
      type: 'pm_escalation',
      title: 'orphan',
      issueId: null,
      agentSessionId: null,
    });

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock.mock.calls[0]?.[0]).toBe(userRoom(USER_ID));
  });
});
