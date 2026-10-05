import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (payload: unknown) => unknown>();
const emitted: Array<{ type: string; payload: unknown }> = [];
const published: Array<{ room: string; event: string; data: unknown }> = [];

vi.mock('../outbox/index.js', () => ({
  consume: (type: string, consumer: { handle: (payload: unknown) => unknown }) => {
    handlers.set(type, consumer.handle);
  },
  emitEvent: vi.fn(async (_tx: unknown, type: string, payload: unknown) => {
    emitted.push({ type, payload });
  }),
}));
vi.mock('../lib/rooms.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/rooms.js')>();
  return {
    ...real,
    roomManager: {
      publish: (room: string, msg: { event: string; data: unknown }) => {
        published.push({ room, event: msg.event, data: msg.data });
        return 1;
      },
    },
  };
});
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../pipeline/index.js', () => ({
  emitPipelineWedge: vi.fn(),
  resolvePipelineWedge: vi.fn(),
}));

const { registerWsBroadcastSubscribers } = await import('./broadcast-subscribers.js');
const { broadcastRunnerChanged } = await import('../runners/apply-runner-limit.js');
const { pushDevice } = await import('../devices/push.js');

/** Hands every event written so far to the consumer registered for its type, as the worker would. */
async function deliver(): Promise<void> {
  for (const e of emitted.splice(0)) await handlers.get(e.type)?.(e.payload);
}

describe('a runner push reaches its room only through the outbox', () => {
  beforeEach(() => {
    handlers.clear();
    emitted.length = 0;
    published.length = 0;
    registerWsBroadcastSubscribers();
  });

  it('writes an outbox event and publishes nothing itself', async () => {
    await broadcastRunnerChanged('p-1', 'r-1');
    expect(published).toEqual([]);
    expect(emitted).toEqual([
      {
        type: 'runner.changed',
        payload: {
          projectId: 'p-1',
          runnerId: 'r-1',
          event: 'runner.status',
          data: { runnerId: 'r-1', projectId: 'p-1' },
          runnerRoom: false,
        },
      },
    ]);
  });

  it('arrives in the project room once the ws-broadcast consumer handles it', async () => {
    await broadcastRunnerChanged('p-1', 'r-1');
    await deliver();
    expect(published).toEqual([
      { room: 'project:p-1', event: 'runner.status', data: { runnerId: 'r-1', projectId: 'p-1' } },
    ]);
  });

  it('tells the runner room first when the event asks for it', async () => {
    await handlers.get('runner.changed')?.({
      projectId: 'p-1',
      runnerId: 'r-1',
      event: 'runner.status',
      data: { runnerId: 'r-1', status: 'offline', reason: 'stale' },
      runnerRoom: true,
    });
    expect(published.map((p) => p.room)).toEqual(['runner:r-1', 'project:p-1']);
  });

  it('turns one stored batch of job lines into one job.event per line, in seq order', async () => {
    await handlers.get('job.eventsAppended')?.({
      projectId: 'p-1',
      jobId: 'j-1',
      events: [
        { seq: 1, kind: 'stdout', ts: '2026-10-05T00:00:00.000Z', data: 'a' },
        { seq: 2, kind: 'stdout', ts: '2026-10-05T00:00:01.000Z', data: 'b' },
      ],
    });
    expect(published).toEqual([
      {
        room: 'project:p-1',
        event: 'job.event',
        data: { jobId: 'j-1', seq: 1, kind: 'stdout', ts: '2026-10-05T00:00:00.000Z', data: 'a' },
      },
      {
        room: 'project:p-1',
        event: 'job.event',
        data: { jobId: 'j-1', seq: 2, kind: 'stdout', ts: '2026-10-05T00:00:01.000Z', data: 'b' },
      },
    ]);
  });

  it('names a token change as the pat.* event web listens for', async () => {
    await handlers.get('credential.tokenChanged')?.({
      userId: 'u-1',
      tokenId: 't-1',
      change: 'revoked',
      ts: '2026-10-05T00:00:00.000Z',
    });
    expect(published).toEqual([
      {
        room: 'user:u-1',
        event: 'pat.revoked',
        data: { tokenId: 't-1', userId: 'u-1', ts: '2026-10-05T00:00:00.000Z' },
      },
    ]);
  });

  it('tells a revoked device to its owner first, then to the box, only once delivered', async () => {
    await pushDevice({
      deviceId: 'd-1',
      userId: 'u-1',
      event: 'device.revoked',
      data: { deviceId: 'd-1' },
    });
    expect(published).toEqual([]);
    await deliver();
    expect(published).toEqual([
      { room: 'user:u-1', event: 'device.revoked', data: { deviceId: 'd-1' } },
      { room: 'device:d-1', event: 'device.revoked', data: { deviceId: 'd-1' } },
    ]);
  });
});
