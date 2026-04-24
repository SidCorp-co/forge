import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => {
  const select = vi.fn();
  const update = vi.fn();
  return {
    db: { select, update },
  };
});

vi.mock('./active-device.js', () => ({
  getActiveDeviceId: vi.fn(),
}));

vi.mock('../queue/boss.js', () => ({
  boss: {
    createQueue: vi.fn(async () => {}),
    work: vi.fn(async () => 'worker-id-1'),
    offWork: vi.fn(async () => {}),
    send: vi.fn(async () => 'msg-1'),
    schedule: vi.fn(async () => {}),
  },
}));

vi.mock('../ws/server.js', () => ({
  roomManager: {
    publish: vi.fn(() => 0),
  },
}));

const { db } = await import('../db/client.js');
const { getActiveDeviceId } = await import('./active-device.js');
const { handleDispatch, registerDispatcher, unregisterDispatcher, isDispatcherRegistered } =
  await import('./dispatcher.js');
const { boss } = await import('../queue/boss.js');
const { roomManager } = await import('../ws/server.js');

type Row = Record<string, unknown>;

function mockSelectOnce(rows: Row[]): void {
  // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
  (db as any).select.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({ limit: async () => rows }),
    }),
  }));
}

function mockUpdateReturn(rows: Row[]): void {
  // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
  (db as any).update.mockImplementationOnce(() => ({
    set: () => ({
      where: () => ({ returning: async () => rows }),
    }),
  }));
}

describe('jobs/dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('skips when job is missing', async () => {
    mockSelectOnce([]);
    const result = await handleDispatch({ jobId: 'missing' });
    expect(result).toBe('skipped');
  });

  it('skips when job is not queued', async () => {
    mockSelectOnce([{ id: 'j1', status: 'dispatched', projectId: 'p1' }]);
    const result = await handleDispatch({ jobId: 'j1' });
    expect(result).toBe('skipped');
    expect(getActiveDeviceId).not.toHaveBeenCalled();
  });

  it('leaves queued when no active device configured', async () => {
    mockSelectOnce([{ id: 'j1', status: 'queued', projectId: 'p1' }]);
    (getActiveDeviceId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const result = await handleDispatch({ jobId: 'j1' });
    expect(result).toBe('skipped');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    expect((db as any).update).not.toHaveBeenCalled();
  });

  it('leaves queued when active device is offline', async () => {
    mockSelectOnce([{ id: 'j1', status: 'queued', projectId: 'p1' }]);
    (getActiveDeviceId as ReturnType<typeof vi.fn>).mockResolvedValueOnce('d1');
    mockSelectOnce([{ id: 'd1', status: 'offline' }]);
    const result = await handleDispatch({ jobId: 'j1' });
    expect(result).toBe('skipped');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    expect((db as any).update).not.toHaveBeenCalled();
  });

  it('leaves queued when active device row is missing', async () => {
    mockSelectOnce([{ id: 'j1', status: 'queued', projectId: 'p1' }]);
    (getActiveDeviceId as ReturnType<typeof vi.fn>).mockResolvedValueOnce('d-missing');
    mockSelectOnce([]);
    const result = await handleDispatch({ jobId: 'j1' });
    expect(result).toBe('skipped');
  });

  it('transitions job to dispatched when device is online and publishes job.assigned', async () => {
    mockSelectOnce([{ id: 'j1', status: 'queued', projectId: 'p1', type: 'plan', payload: {} }]);
    (getActiveDeviceId as ReturnType<typeof vi.fn>).mockResolvedValueOnce('d1');
    mockSelectOnce([{ id: 'd1', status: 'online' }]);
    mockUpdateReturn([{ id: 'j1' }]);

    const result = await handleDispatch({ jobId: 'j1' });
    expect(result).toBe('dispatched');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
    expect((db as any).update).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    expect((roomManager as any).publish).toHaveBeenCalledWith(
      'device:d1',
      expect.objectContaining({
        event: 'job.assigned',
        data: expect.objectContaining({ jobId: 'j1', projectId: 'p1', type: 'plan' }),
      }),
    );
  });

  it('skips when racing UPDATE returns zero rows and does NOT publish', async () => {
    mockSelectOnce([{ id: 'j1', status: 'queued', projectId: 'p1', type: 'plan', payload: {} }]);
    (getActiveDeviceId as ReturnType<typeof vi.fn>).mockResolvedValueOnce('d1');
    mockSelectOnce([{ id: 'd1', status: 'online' }]);
    mockUpdateReturn([]);

    const result = await handleDispatch({ jobId: 'j1' });
    expect(result).toBe('skipped');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    expect((roomManager as any).publish).not.toHaveBeenCalled();
  });

  it('register/unregister is idempotent and toggles state', async () => {
    await registerDispatcher();
    await registerDispatcher();
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    expect((boss as any).work).toHaveBeenCalledTimes(1);
    expect(isDispatcherRegistered()).toBe(true);

    await unregisterDispatcher();
    await unregisterDispatcher();
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    expect((boss as any).offWork).toHaveBeenCalledTimes(1);
    expect(isDispatcherRegistered()).toBe(false);
  });
});
