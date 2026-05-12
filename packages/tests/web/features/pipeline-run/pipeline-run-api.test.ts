import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiClientMock = vi.fn();
const apiClientListMock = vi.fn();

vi.mock('@/lib/api/client', () => ({
  apiClient: (...args: unknown[]) => apiClientMock(...args),
  apiClientList: (...args: unknown[]) => apiClientListMock(...args),
}));

const { pipelineRunApi } = await import('@/features/pipeline-run/api/pipeline-run-api');

beforeEach(() => {
  apiClientMock.mockReset();
  apiClientListMock.mockReset();
});

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const ISSUE_ID = '33333333-3333-4333-8333-333333333333';

describe('pipelineRunApi', () => {
  it('list builds a projects-scoped URL with status/issueId/limit/offset', async () => {
    apiClientListMock.mockResolvedValueOnce({ items: [], totalCount: 0 });
    await pipelineRunApi.list({
      projectId: PROJECT_ID,
      status: 'running',
      issueId: ISSUE_ID,
      limit: 10,
      offset: 20,
    });
    const url = apiClientListMock.mock.calls[0]?.[0] as string;
    expect(url.startsWith(`/projects/${PROJECT_ID}/pipeline-runs?`)).toBe(true);
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=20');
    expect(url).toContain('status=running');
    expect(url).toContain(`issueId=${ISSUE_ID}`);
  });

  it('list applies default limit/offset when omitted', async () => {
    apiClientListMock.mockResolvedValueOnce({ items: [], totalCount: 0 });
    await pipelineRunApi.list({ projectId: PROJECT_ID });
    const url = apiClientListMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('limit=50');
    expect(url).toContain('offset=0');
    expect(url).not.toContain('status=');
    expect(url).not.toContain('issueId=');
  });

  it('get hits /pipeline-runs/:id with no body', async () => {
    apiClientMock.mockResolvedValueOnce({ id: RUN_ID });
    await pipelineRunApi.get(RUN_ID);
    expect(apiClientMock).toHaveBeenCalledWith(`/pipeline-runs/${RUN_ID}`);
  });

  it.each(['pause', 'resume', 'cancel'] as const)(
    '%s sends POST without body',
    async (verb) => {
      apiClientMock.mockResolvedValueOnce({});
      await pipelineRunApi[verb](RUN_ID);
      expect(apiClientMock).toHaveBeenCalledWith(`/pipeline-runs/${RUN_ID}/${verb}`, {
        method: 'POST',
      });
    },
  );
});
