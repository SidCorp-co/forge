import { beforeEach, describe, expect, it, vi } from 'vitest';

const addBreadcrumbMock = vi.fn();
const isSentryEnabledMock = vi.fn(() => true);

vi.mock('../observability/sentry.js', () => ({
  Sentry: { addBreadcrumb: (...args: unknown[]) => addBreadcrumbMock(...args) },
  isSentryEnabled: () => isSentryEnabledMock(),
}));

const { HooksBus } = await import('./hooks.js');
const { registerPipelineSentryBreadcrumbs } = await import('./sentry-breadcrumbs.js');

function basePayload(over: Partial<Record<string, unknown>> = {}) {
  return {
    runId: 'r-1',
    projectId: 'p-1',
    issueId: 'i-1',
    kind: 'issue' as const,
    fromStatus: 'running' as const,
    toStatus: 'completed' as const,
    currentStep: 'code',
    ...over,
  };
}

beforeEach(() => {
  addBreadcrumbMock.mockReset();
  isSentryEnabledMock.mockReset();
  isSentryEnabledMock.mockReturnValue(true);
});

describe('registerPipelineSentryBreadcrumbs', () => {
  it('does nothing when sentry is disabled', async () => {
    isSentryEnabledMock.mockReturnValue(false);
    const bus = new HooksBus();
    registerPipelineSentryBreadcrumbs(bus);
    await bus.emit('pipelineRunStatusChanged', basePayload());
    await bus.emit('pipelineRunStatusChanged', basePayload({ toStatus: 'failed' }));
    expect(addBreadcrumbMock).not.toHaveBeenCalled();
  });

  it('records one breadcrumb per emitted event with category and message', async () => {
    const bus = new HooksBus();
    registerPipelineSentryBreadcrumbs(bus);
    await bus.emit('pipelineRunStatusChanged', basePayload());
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
    const arg = addBreadcrumbMock.mock.calls[0]?.[0];
    expect(arg.category).toBe('pipeline_run.status_changed');
    expect(arg.level).toBe('info');
    expect(arg.message).toBe('running -> completed');
    expect(arg.data).toEqual({
      runId: 'r-1',
      issueId: 'i-1',
      projectId: 'p-1',
      kind: 'issue',
      fromStatus: 'running',
      toStatus: 'completed',
      currentStep: 'code',
    });
  });

  it('renders null fromStatus as "null" in the breadcrumb message', async () => {
    const bus = new HooksBus();
    registerPipelineSentryBreadcrumbs(bus);
    await bus.emit(
      'pipelineRunStatusChanged',
      basePayload({ fromStatus: null, toStatus: 'running' }),
    );
    expect(addBreadcrumbMock.mock.calls[0]?.[0].message).toBe('null -> running');
  });

  it('preserves emit order across multiple events', async () => {
    const bus = new HooksBus();
    registerPipelineSentryBreadcrumbs(bus);
    await bus.emit('pipelineRunStatusChanged', basePayload({ toStatus: 'completed' }));
    await bus.emit('pipelineRunStatusChanged', basePayload({ toStatus: 'failed' }));
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(2);
    expect(addBreadcrumbMock.mock.calls[0]?.[0].data.toStatus).toBe('completed');
    expect(addBreadcrumbMock.mock.calls[1]?.[0].data.toStatus).toBe('failed');
  });
});
