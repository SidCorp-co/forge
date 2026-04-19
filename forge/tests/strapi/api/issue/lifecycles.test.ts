import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockBroadcast = vi.fn();
const mockSendWebhook = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../../strapi/src/services/websocket', () => ({
  broadcast: mockBroadcast,
}));

vi.mock('../../../../strapi/src/services/webhook', () => ({
  sendWebhook: mockSendWebhook,
}));

vi.mock('../../../../strapi/src/services/embeddings', () => ({
  upsertEmbedding: vi.fn().mockResolvedValue(undefined),
  removeEmbeddings: vi.fn().mockResolvedValue(undefined),
  sanitizeContent: vi.fn((t: string) => t),
}));

vi.mock('../../../../strapi/src/services/entity-index', () => ({
  enrichEntitiesWithLLM: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../strapi/src/services/knowledge-graph', () => ({
  extractIssueEdges: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../strapi/src/lifecycles/issue-relations', () => ({
  autoPopulateRelations: vi.fn().mockResolvedValue(undefined),
  unblockDependents: vi.fn().mockResolvedValue(undefined),
  syncInverseRelations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../strapi/src/services/pipeline-utils', () => ({
  DONE_ENOUGH_STATUSES: new Set(['developed', 'deploying', 'testing', 'staging', 'released', 'closed']),
}));

vi.mock('../../../../strapi/src/services/rolling-summary', () => ({
  recomputeRollingStats: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../strapi/src/lifecycles/preview-teardown', () => ({
  teardownPreviewOnClose: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../strapi/src/services/pipeline-orchestrator', () => ({
  onStatusChange: vi.fn().mockResolvedValue(undefined),
}));

const flushImmediate = () => new Promise((r) => setTimeout(r, 50));

describe('Issue Lifecycles', () => {
  let issueSubscription: any;
  let mockDbUpdate: ReturnType<typeof vi.fn>;
  let mockStrapi: any;

  beforeEach(async () => {
    vi.resetModules();

    mockDbUpdate = vi.fn().mockResolvedValue(undefined);

    const subscriptions: any[] = [];

    mockStrapi = {
      documents: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      requestContext: { get: vi.fn().mockReturnValue(null) },
      db: {
        lifecycles: {
          subscribe: (sub: any) => subscriptions.push(sub),
        },
        query: vi.fn().mockReturnValue({
          findOne: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([]),
          update: mockDbUpdate,
          count: vi.fn().mockResolvedValue(0),
        }),
      },
    };

    mockBroadcast.mockReset();
    mockSendWebhook.mockReset().mockResolvedValue(undefined);

    // Import directly — avoids full bootstrap
    const { subscribeIssueLifecycles } = await import(
      '../../../../strapi/src/lifecycles/issue-lifecycle'
    );
    subscribeIssueLifecycles(mockStrapi);

    issueSubscription = subscriptions.find((s) =>
      s.models.includes('api::issue.issue'),
    );
  });

  it('afterCreate should broadcast issue:created', async () => {
    const event = {
      result: { documentId: 'issue-1', title: 'New Issue' },
    };

    await issueSubscription.afterCreate(event);

    expect(mockBroadcast).toHaveBeenCalledWith('issue:created', {
      documentId: 'issue-1',
      title: 'New Issue',
    });
  });

  it('afterUpdate broadcasts issue:confirmed when status is confirmed', async () => {
    const event = {
      result: { documentId: 'issue-5', status: 'confirmed' },
    };

    await issueSubscription.afterUpdate(event);

    expect(mockBroadcast).toHaveBeenCalledWith('issue:confirmed', { documentId: 'issue-5' });
  });

  it('afterUpdate broadcasts issue:updated for any status', async () => {
    const event = {
      result: { documentId: 'issue-7', status: 'open' },
    };

    await issueSubscription.afterUpdate(event);

    expect(mockBroadcast).toHaveBeenCalledWith('issue:updated', {
      documentId: 'issue-7',
      status: 'open',
    });
  });

  it('afterUpdate defers change-history write via setImmediate', async () => {
    const event = {
      result: { id: 1, documentId: 'issue-10', status: 'confirmed' },
      state: { previous: { id: 1, documentId: 'issue-10', changeHistory: [], status: 'open' } },
      params: { data: { status: 'confirmed' }, where: { id: 1 } },
    };

    await issueSubscription.afterUpdate(event);

    // DB update should NOT be called synchronously
    expect(mockDbUpdate).not.toHaveBeenCalled();

    // After flushing setImmediate, it should be called
    await flushImmediate();
    expect(mockDbUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: { changeHistory: expect.arrayContaining([expect.objectContaining({ field: 'status', from: 'open', to: 'confirmed' })]) },
      }),
    );
  });

  it('afterUpdate runs webhook and history write in parallel via Promise.all', async () => {
    const event = {
      result: { id: 2, documentId: 'issue-11', status: 'confirmed' },
      state: { previous: { id: 2, documentId: 'issue-11', changeHistory: [], status: 'open' } },
      params: { data: { status: 'confirmed' }, where: { id: 2 } },
    };

    await issueSubscription.afterUpdate(event);
    await flushImmediate();

    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockSendWebhook).toHaveBeenCalledWith(
      expect.anything(),
      'issue-11',
      expect.objectContaining({ field: 'status', from: 'open', to: 'confirmed' }),
    );
  });

  it('webhook failure does not prevent history write', async () => {
    mockSendWebhook.mockRejectedValue(new Error('webhook down'));

    const event = {
      result: { id: 3, documentId: 'issue-12', status: 'confirmed' },
      state: { previous: { id: 3, documentId: 'issue-12', changeHistory: [], status: 'open' } },
      params: { data: { status: 'confirmed' }, where: { id: 3 } },
    };

    await issueSubscription.afterUpdate(event);
    await flushImmediate();

    // History write still completes despite webhook failure
    expect(mockDbUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 3 },
        data: { changeHistory: expect.any(Array) },
      }),
    );
  });
});
