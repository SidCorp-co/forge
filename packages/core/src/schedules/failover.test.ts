// The schedule failover meeting a device the project never bound: it reports `device-not-bound`
// and runs nothing, rather than handing the turn a path that is not that device's (ISS-1236).

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** What each `select(...).from(...).where(...).limit(1)` answers, in the order the code asks. */
let selected: unknown[][] = [];
const updateSet = vi.fn((_values: unknown) => ({ where: vi.fn(async () => undefined) }));
vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => selected.shift() ?? [] }) }),
    })),
    update: vi.fn(() => ({ set: updateSet })),
  },
}));

const createChatSessionRow = vi.fn();
const dispatchChatTurn = vi.fn();
const remoteChatClient = vi.fn();
vi.mock('../agent-sessions/chat-turn.js', () => ({
  createChatSessionRow: (...args: unknown[]) => createChatSessionRow(...args),
  dispatchChatTurn: (...args: unknown[]) => dispatchChatTurn(...args),
  remoteChatClient: (...args: unknown[]) => remoteChatClient(...args),
}));

const findAvailableDeviceForProject = vi.fn();
vi.mock('../lib/device-pool.js', async () => ({
  DeviceNotBoundError: (
    await vi.importActual<typeof import('../lib/device-pool.js')>('../lib/device-pool.js')
  ).DeviceNotBoundError,
  findAvailableDeviceForProject: (...args: unknown[]) => findAvailableDeviceForProject(...args),
}));
vi.mock('../notifications/emit.js', () => ({ emitNotification: vi.fn() }));
vi.mock('../logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const { DeviceNotBoundError } =
  await vi.importActual<typeof import('../lib/device-pool.js')>('../lib/device-pool.js');
const { redispatchScheduleSessionOnFailover } = await import('./failover.js');

beforeEach(() => {
  vi.clearAllMocks();
  selected = [
    [
      {
        id: 'failed-session',
        projectId: 'proj-1',
        userId: 'user-1',
        deviceId: 'device-1',
        title: 'Nightly sweep',
        messages: [{ role: 'user', content: 'sweep the board' }],
        metadata: { source: 'schedule.run', scheduleId: 'sched-1' },
        claudeSessionId: null,
      },
    ],
    [{ id: 'proj-1', slug: 'shop' }],
  ];
  findAvailableDeviceForProject.mockResolvedValue('device-2');
  remoteChatClient.mockRejectedValue(
    new DeviceNotBoundError({
      deviceId: 'device-2',
      deviceName: null,
      projectId: 'proj-1',
      projectSlug: 'shop',
    }),
  );
});

describe('schedule failover onto a device the project never bound', () => {
  it('reports device-not-bound and opens no session, so nothing runs in another checkout', async () => {
    const result = await redispatchScheduleSessionOnFailover('failed-session', {
      failureClass: 'runner_lost',
    });

    expect(result).toEqual({ ok: false, status: 'device-not-bound' });
    expect(remoteChatClient).toHaveBeenCalledWith('proj-1', 'device-2');
    expect(createChatSessionRow).not.toHaveBeenCalled();
    expect(dispatchChatTurn).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith({
      failureDetail:
        'runner_lost → no failover (the device picked has no runner bound to this project, so no checkout to run in)',
    });
  });
});
