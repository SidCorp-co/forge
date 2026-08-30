import { describe, expect, it, vi } from 'vitest';

const resolveMock = vi.fn(async (_entityId: string) => 1);
vi.mock('./wedge.js', () => ({
  resolvePipelineWedge: (id: string) => resolveMock(id),
  pausedRunWedgeEntityId: (runId: string) => `paused:${runId}`,
}));

const warn = vi.fn();
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
}));

const { registerPausedRunWedgeResolve } = await import('./paused-run-wedge-resolve.js');

type Handler = (p: Record<string, unknown>) => Promise<void>;

function busWith(): { fire: Handler } {
  let handler: Handler = async () => undefined;
  const bus = {
    on: (_event: string, fn: Handler) => {
      handler = fn;
    },
  };
  registerPausedRunWedgeResolve(bus as never);
  return { fire: (p) => handler(p) };
}

describe('registerPausedRunWedgeResolve (ISS-879)', () => {
  it('resolves when the run resumes', async () => {
    resolveMock.mockClear();
    const { fire } = busWith();

    await fire({ runId: 'run-1', toStatus: 'running' });

    expect(resolveMock).toHaveBeenCalledWith('paused:run-1');
  });

  // cm:guard the terminal cases are the reason this keys on `toStatus` — `emitCloseHook` in runs.ts hardcodes `fromStatus: 'running'` even on a paused→terminal close, so a `fromStatus === 'paused'` test would resolve the resumes and leave every cancelled run's wedge in the bell forever
  it.each(['completed', 'failed', 'cancelled'])('resolves when the run closes %s', async (to) => {
    resolveMock.mockClear();
    const { fire } = busWith();

    await fire({ runId: 'run-2', toStatus: to });

    expect(resolveMock).toHaveBeenCalledWith('paused:run-2');
  });

  it('does nothing while the run is still paused', async () => {
    resolveMock.mockClear();
    const { fire } = busWith();

    await fire({ runId: 'run-3', toStatus: 'paused' });

    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('swallows a resolve failure rather than breaking the hook chain', async () => {
    resolveMock.mockClear();
    resolveMock.mockRejectedValueOnce(new Error('boom'));
    const { fire } = busWith();

    await expect(fire({ runId: 'run-4', toStatus: 'running' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
