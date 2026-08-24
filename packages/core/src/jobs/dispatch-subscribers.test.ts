import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchTickForProject = vi.fn();
vi.mock('./dispatch-tick.js', () => ({
  dispatchTickForProject: (id: string) => dispatchTickForProject(id),
}));

const { HooksBus } = await import('../pipeline/hooks.js');
const { registerDispatchSubscribers } = await import('./dispatch-subscribers.js');

describe('registerDispatchSubscribers', () => {
  beforeEach(() => {
    dispatchTickForProject.mockReset();
  });

  // cm:guard this is the whole point of the indirection: heartbeat-ws announces, and the tick has to still happen. If this passes while the real bus has no subscriber, a runner coming online stops waking its queued jobs and only the sweeper's backstop notices — a delay, which is why it would go unreported.
  it('ticks the project a runner came online for', async () => {
    const bus = new HooksBus();
    registerDispatchSubscribers(bus);

    await bus.emit('runnerOnline', { projectId: 'p-1', runnerId: 'r-1' });

    expect(dispatchTickForProject).toHaveBeenCalledWith('p-1');
  });

  it('does not tick on an unrelated topic', async () => {
    const bus = new HooksBus();
    registerDispatchSubscribers(bus);

    await bus.emit('runnerProvisionRequested', {
      projectId: 'p-1',
      deviceId: 'd-1',
      runnerId: 'r-1',
    });

    expect(dispatchTickForProject).not.toHaveBeenCalled();
  });

  // cm:guard a bus with no registration must be inert — otherwise this suite would pass on module import side effects and could not tell a wired bus from an unwired one, which is exactly the failure it exists to detect
  it('leaves an unregistered bus silent', async () => {
    const bus = new HooksBus();

    await bus.emit('runnerOnline', { projectId: 'p-1', runnerId: 'r-1' });

    expect(dispatchTickForProject).not.toHaveBeenCalled();
  });

  it('reports the subscriber under a name a failure can be traced to', async () => {
    const bus = new HooksBus();
    registerDispatchSubscribers(bus);

    const result = await bus.emit('runnerOnline', { projectId: 'p-2', runnerId: 'r-2' });

    expect(result.failures).toEqual([]);
    expect(dispatchTickForProject).toHaveBeenCalledWith('p-2');
  });
});
