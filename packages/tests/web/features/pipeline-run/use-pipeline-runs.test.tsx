import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';

const apiMock = {
  list: vi.fn(),
  get: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
};

vi.mock('@/features/pipeline-run/api/pipeline-run-api', () => ({
  pipelineRunApi: apiMock,
}));

const {
  pipelineRunKeys,
  useCancelPipelineRun,
  usePausePipelineRun,
  useProjectPipelineRuns,
  usePipelineRun,
  useResumePipelineRun,
} = await import('@/features/pipeline-run/hooks/use-pipeline-runs');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

beforeEach(() => {
  Object.values(apiMock).forEach((fn) => fn.mockReset());
});

describe('pipelineRunKeys', () => {
  it('list key is stable for identical params', () => {
    const a = pipelineRunKeys.list({ projectId: PROJECT_ID, limit: 10 });
    const b = pipelineRunKeys.list({ projectId: PROJECT_ID, limit: 10 });
    expect(a).toEqual(b);
  });

  it('detail key includes the run id', () => {
    expect(pipelineRunKeys.detail(RUN_ID)).toEqual(['pipeline-run', RUN_ID]);
  });
});

describe('useProjectPipelineRuns', () => {
  it('does not fetch when projectId is empty', () => {
    apiMock.list.mockResolvedValue({ items: [], totalCount: 0 });
    const qc = makeClient();
    renderHook(() => useProjectPipelineRuns({ projectId: '' }), {
      wrapper: wrapper(qc),
    });
    expect(apiMock.list).not.toHaveBeenCalled();
  });

  it('fetches via pipelineRunApi.list', async () => {
    apiMock.list.mockResolvedValue({ items: [{ id: RUN_ID }], totalCount: 1 });
    const qc = makeClient();
    const { result } = renderHook(
      () => useProjectPipelineRuns({ projectId: PROJECT_ID }),
      { wrapper: wrapper(qc) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMock.list).toHaveBeenCalledWith({ projectId: PROJECT_ID });
  });
});

describe('usePipelineRun', () => {
  it('skips the query when id is undefined', () => {
    const qc = makeClient();
    renderHook(() => usePipelineRun(undefined), { wrapper: wrapper(qc) });
    expect(apiMock.get).not.toHaveBeenCalled();
  });
});

describe('mutation invalidations', () => {
  it('pause invalidates the detail + list keys', async () => {
    apiMock.pause.mockResolvedValue({ status: 'paused' });
    const qc = makeClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => usePausePipelineRun(), {
      wrapper: wrapper(qc),
    });
    await result.current.mutateAsync(RUN_ID);
    const queryKeys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(queryKeys).toEqual(
      expect.arrayContaining([
        ['pipeline-run', RUN_ID],
        ['pipeline-runs', 'list'],
      ]),
    );
  });

  it('resume invalidates the detail + list keys', async () => {
    apiMock.resume.mockResolvedValue({ status: 'running' });
    const qc = makeClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useResumePipelineRun(), {
      wrapper: wrapper(qc),
    });
    await result.current.mutateAsync(RUN_ID);
    const queryKeys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(queryKeys).toEqual(
      expect.arrayContaining([
        ['pipeline-run', RUN_ID],
        ['pipeline-runs', 'list'],
      ]),
    );
  });

  it('cancel also invalidates jobs + agent-sessions', async () => {
    apiMock.cancel.mockResolvedValue({ run: { id: RUN_ID } });
    const qc = makeClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCancelPipelineRun(), {
      wrapper: wrapper(qc),
    });
    await result.current.mutateAsync(RUN_ID);
    const queryKeys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(queryKeys).toEqual(
      expect.arrayContaining([
        ['pipeline-run', RUN_ID],
        ['pipeline-runs', 'list'],
        ['jobs'],
        ['agent-sessions'],
      ]),
    );
  });
});
