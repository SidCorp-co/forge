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
vi.mock('../lifecycle/index.js', () => ({
  transition: vi.fn(async () => ({ rows: [{ id: 'r-9', projectId: 'p-9' }] })),
}));
vi.mock('../runners/runner-events.js', () => ({ insertRunnerEvent: vi.fn() }));
vi.mock('../pipeline/index.js', () => ({
  emitPipelineWedge: vi.fn(),
  resolvePipelineWedge: vi.fn(),
}));
vi.mock('../agent-sessions/index.js', () => ({
  sessionAudienceById: vi.fn(async (id: string) =>
    id === 's-private'
      ? { projectWide: false, userIds: ['u-owner', 'u-admin'] }
      : { projectWide: true, userIds: [] },
  ),
}));

const { registerWsBroadcastSubscribers } = await import('./broadcast-subscribers.js');
const { broadcastRunnerChanged } = await import('../runners/apply-runner-limit.js');
const { pushDevice } = await import('../devices/push.js');
const { runRunnerStaleSweep } = await import('../runners/stale-detector.js');
const { jobEphemeralTarget, pushJobCancel, pushJobChanged } = await import('../jobs/job-push.js');

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
      data: { runnerId: 'r-1', projectId: 'p-1', status: 'offline', reason: 'stale' },
      runnerRoom: true,
    });
    expect(published.map((p) => p.room)).toEqual(['runner:r-1', 'project:p-1']);
  });

  it('names the project in the frame the stale sweep publishes, so its runner list refreshes', async () => {
    await runRunnerStaleSweep();
    await deliver();
    expect(published).toEqual([
      {
        room: 'runner:r-9',
        event: 'runner.status',
        data: { runnerId: 'r-9', projectId: 'p-9', status: 'offline', reason: 'stale' },
      },
      {
        room: 'project:p-9',
        event: 'runner.status',
        data: { runnerId: 'r-9', projectId: 'p-9', status: 'offline', reason: 'stale' },
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

  it('tells an open thread each comment move, as the frame web routes', async () => {
    for (const type of ['comment.created', 'comment.updated', 'comment.deleted']) {
      await handlers.get(type)?.({ issueId: 'i-1', projectId: 'p-1', commentId: 'c-1', body: 'x' });
    }
    expect(published).toEqual(
      ['comment.created', 'comment.updated', 'comment.deleted'].map((event) => ({
        room: 'project:p-1',
        event,
        data: { issueId: 'i-1', projectId: 'p-1', commentId: 'c-1' },
      })),
    );
  });

  it('names the project in every job frame, so the Agents run list refreshes', async () => {
    const job = { id: 'j-1', projectId: 'p-1', deviceId: 'd-1', agentSessionId: null };
    await pushJobChanged(job, 'job.completed', {
      jobId: 'j-1',
      projectId: 'p-1',
      status: 'done',
      exitCode: 0,
    });
    await deliver();
    expect(published).toEqual([
      {
        room: 'project:p-1',
        event: 'job.completed',
        data: { jobId: 'j-1', projectId: 'p-1', status: 'done', exitCode: 0 },
      },
    ]);
  });

  it("tells a job of a person's own chat to its readers by name, never to the project room", async () => {
    const job = { id: 'j-2', projectId: 'p-1', deviceId: 'd-1', agentSessionId: 's-private' };
    await pushJobChanged(job, 'job.failed', { jobId: 'j-2', projectId: 'p-1', status: 'failed' });
    await deliver();
    expect(published.map((p) => p.room)).toEqual(['user:u-owner', 'user:u-admin']);
    expect(await jobEphemeralTarget(job)).toEqual({ userIds: ['u-owner', 'u-admin'] });
    expect(await jobEphemeralTarget({ ...job, agentSessionId: null })).toEqual({
      projectId: 'p-1',
    });
  });

  it("asks only the job's box to stop it", async () => {
    await pushJobCancel(
      { id: 'j-3', projectId: 'p-1', deviceId: 'd-1' },
      { jobId: 'j-3', projectId: 'p-1', reason: 'loop' },
    );
    await deliver();
    expect(published).toEqual([
      {
        room: 'device:d-1',
        event: 'job.cancel',
        data: { jobId: 'j-3', projectId: 'p-1', reason: 'loop' },
      },
    ]);
  });

  it('refuses by name a job frame written before its audience was recorded', async () => {
    expect(() =>
      handlers.get('job.changed')?.({
        projectId: 'p-1',
        jobId: 'j-4',
        deviceId: null,
        event: 'job.completed',
        data: { jobId: 'j-4' },
        rooms: ['project'],
      }),
    ).toThrow(/SESSION_FRAME_AUDIENCE_MISSING: job.completed carries no userIds/);
    expect(published).toEqual([]);
  });
});
