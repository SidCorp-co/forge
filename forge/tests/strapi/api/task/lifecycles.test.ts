import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockBroadcast = vi.fn();
const mockInitWebSocket = vi.fn();
const mockSeedApiPermissions = vi.fn().mockResolvedValue(undefined);
const mockEnrichIssue = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../../strapi/src/services/websocket', () => ({
  broadcast: mockBroadcast,
  initWebSocket: mockInitWebSocket,
}));

vi.mock('../../../../strapi/src/services/ai-enrichment', () => ({
  enrichIssue: mockEnrichIssue,
}));

vi.mock('../../../../strapi/src/bootstrap/seeds/api-permissions', () => ({
  seedApiPermissions: mockSeedApiPermissions,
}));

vi.mock('../../../../strapi/src/services/mcp-server', () => ({
  mcpMiddleware: () => (_ctx: any, next: any) => next(),
}));

describe('Task Lifecycles', () => {
  let taskSubscription: any;
  let mockFindOne: ReturnType<typeof vi.fn>;
  let mockFindMany: ReturnType<typeof vi.fn>;
  let mockUpdate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    mockFindOne = vi.fn();
    mockFindMany = vi.fn();
    mockUpdate = vi.fn().mockResolvedValue({});

    const subscriptions: any[] = [];
    const mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: mockFindOne,
        findMany: mockFindMany,
        update: mockUpdate,
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      server: { use: vi.fn() },
      db: {
        lifecycles: {
          subscribe: (sub: any) => subscriptions.push(sub),
        },
      },
    };

    mockBroadcast.mockReset();

    const mod = await import('../../../../strapi/src/index');
    await mod.default.bootstrap({ strapi: mockStrapi as any });

    taskSubscription = subscriptions.find((s) =>
      s.models.includes('api::task.task'),
    );
  });

  it('afterCreate should broadcast task:created with documentId and title', async () => {
    await taskSubscription.afterCreate({
      result: { documentId: 'task-1', title: 'Task One' },
    });

    expect(mockBroadcast).toHaveBeenCalledWith('task:created', {
      documentId: 'task-1',
      title: 'Task One',
    });
  });

  it('afterUpdate should broadcast task:updated with documentId and status', async () => {
    await taskSubscription.afterUpdate({
      result: { documentId: 'task-2', status: 'in_progress' },
    });

    expect(mockBroadcast).toHaveBeenCalledWith('task:updated', {
      documentId: 'task-2',
      status: 'in_progress',
    });
  });

  it('afterUpdate with agentStatus completed should broadcast agent:completed', async () => {
    await taskSubscription.afterUpdate({
      result: {
        documentId: 'task-3',
        status: 'done',
        title: 'Agent Task',
        isAgentTask: true,
        agentStatus: 'completed',
      },
    });

    expect(mockBroadcast).toHaveBeenCalledWith('agent:completed', {
      documentId: 'task-3',
      title: 'Agent Task',
    });
  });

  it('checkIssueResolution: all tasks done + non-pipeline issue -> close', async () => {
    mockFindOne
      .mockResolvedValueOnce({
        documentId: 'task-4',
        issue: { documentId: 'issue-1' },
      })
      .mockResolvedValueOnce({ status: 'approved' });
    mockFindMany.mockResolvedValue([
      { status: 'done' },
      { status: 'done' },
    ]);

    await taskSubscription.afterUpdate({
      result: { documentId: 'task-4', status: 'done' },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: { issue: { documentId: { $eq: 'issue-1' } } },
      }),
    );

    expect(mockUpdate).toHaveBeenCalledWith({
      documentId: 'issue-1',
      data: { status: 'closed' },
    });
    expect(mockBroadcast).toHaveBeenCalledWith('issue:closed', { documentId: 'issue-1' });
  });

  it('checkIssueResolution: all tasks done + pipeline-active issue -> no auto-close', async () => {
    mockFindOne
      .mockResolvedValueOnce({
        documentId: 'task-6',
        issue: { documentId: 'issue-3' },
      })
      .mockResolvedValueOnce({ status: 'deploying' });
    mockFindMany.mockResolvedValue([
      { status: 'done' },
      { status: 'done' },
    ]);

    await taskSubscription.afterUpdate({
      result: { documentId: 'task-6', status: 'done' },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('checkIssueResolution: some tasks not done -> no change', async () => {
    mockFindOne.mockResolvedValue({
      documentId: 'task-5',
      issue: { documentId: 'issue-2' },
    });
    mockFindMany.mockResolvedValue([
      { status: 'done' },
      { status: 'in_progress' },
    ]);

    await taskSubscription.afterUpdate({
      result: { documentId: 'task-5', status: 'done' },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
