import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn(async () => ({ ok: true, jobId: 'pm-1' }) as const);
vi.mock('./spawner.js', () => ({
  spawnPmSession: (...args: unknown[]) => spawnMock(...(args as [unknown])),
}));

const autoDisableMock = vi.fn(async () => undefined);
vi.mock('./auto-disable.js', () => ({
  handlePmJobFailedAutoDisable: (...args: unknown[]) =>
    autoDisableMock(...(args as [unknown])),
}));

const { HooksBus } = await import('../pipeline/hooks.js');
const { registerPmSubscribers } = await import('./subscribers.js');

beforeEach(() => {
  spawnMock.mockClear();
  autoDisableMock.mockClear();
});

describe('registerPmSubscribers', () => {
  it('jobFailed for non-pm types spawns with cause=job-failed', async () => {
    const bus = new HooksBus();
    registerPmSubscribers(bus);
    await bus.emit('jobFailed', {
      jobId: 'j-1',
      projectId: 'p-1',
      issueId: 'i-1',
      type: 'plan',
      failureKind: 'transient',
      failureReason: 'timeout',
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith({
      projectId: 'p-1',
      cause: 'job-failed',
      eventRef: { jobId: 'j-1', jobType: 'plan', failureKind: 'transient', issueId: 'i-1' },
    });
    expect(autoDisableMock).not.toHaveBeenCalled();
  });

  it('jobFailed with type=pm routes to auto-disable, never to spawn (no PM-on-PM loop)', async () => {
    const bus = new HooksBus();
    registerPmSubscribers(bus);
    await bus.emit('jobFailed', {
      jobId: 'j-1',
      projectId: 'p-1',
      issueId: null,
      type: 'pm',
      failureKind: 'transient',
      failureReason: null,
    });
    expect(autoDisableMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('transition to needs_info spawns cause=needs-info', async () => {
    const bus = new HooksBus();
    registerPmSubscribers(bus);
    await bus.emit('transition', {
      issueId: 'i-1',
      projectId: 'p-1',
      actor: { kind: 'user', id: 'u-1' } as never,
      from: 'in_progress',
      to: 'needs_info',
      reopenCount: 0,
    });
    expect(spawnMock).toHaveBeenCalledWith({
      projectId: 'p-1',
      cause: 'needs-info',
      eventRef: { issueId: 'i-1', from: 'in_progress' },
    });
  });

  it('transition to other statuses does not spawn', async () => {
    const bus = new HooksBus();
    registerPmSubscribers(bus);
    await bus.emit('transition', {
      issueId: 'i-1',
      projectId: 'p-1',
      actor: { kind: 'user', id: 'u-1' } as never,
      from: 'open',
      to: 'in_progress',
      reopenCount: 0,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('dependencyChanged spawns cause=graph-changed', async () => {
    const bus = new HooksBus();
    registerPmSubscribers(bus);
    await bus.emit('dependencyChanged', {
      projectId: 'p-1',
      edgeId: 'e-1',
      fromIssueId: 'i-from',
      toIssueId: 'i-to',
      kind: 'blocks',
    });
    expect(spawnMock).toHaveBeenCalledWith({
      projectId: 'p-1',
      cause: 'graph-changed',
      eventRef: { edgeId: 'e-1', from: 'i-from', to: 'i-to', kind: 'blocks' },
    });
  });
});
