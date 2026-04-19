import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Issue Controller - create', () => {
  let controller: any;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    mockCreate = vi.fn().mockResolvedValue({
      documentId: 'issue-1',
      title: 'Bug',
      status: 'open',
      priority: 'none',
    });

    (globalThis as any).strapi = {
      documents: vi.fn().mockReturnValue({ create: mockCreate }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    // Mock @strapi/strapi factories
    vi.doMock('@strapi/strapi', () => ({
      factories: {
        createCoreController: (_uid: string, fn: any) => fn({ strapi: (globalThis as any).strapi }),
      },
    }));

    const mod = await import('../../../../strapi/src/api/issue/controllers/issue');
    controller = mod.default;
  });

  it('creates issue with title only, defaults status and priority', async () => {
    const ctx = {
      request: { body: { data: { title: 'Bug report' } } },
      state: {},
      badRequest: vi.fn(),
    };

    const result = await controller.create(ctx);

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: 'Bug report',
        status: 'open',
        priority: 'none',
      }),
    });
    expect(result).toEqual({ data: expect.objectContaining({ documentId: 'issue-1' }) });
  });

  it('returns badRequest when title is missing', async () => {
    const ctx = {
      request: { body: { data: { description: 'no title' } } },
      state: {},
      badRequest: vi.fn().mockReturnValue('bad'),
    };

    const result = await controller.create(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith('title is required');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('attaches project from forgeProject state (API key flow)', async () => {
    const ctx = {
      request: { body: { data: { title: 'Widget bug' } } },
      state: { forgeProject: { documentId: 'proj-abc' } },
      badRequest: vi.fn(),
    };

    await controller.create(ctx);

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ project: 'proj-abc' }),
    });
  });

  it('attaches project from request body (JWT flow)', async () => {
    const ctx = {
      request: { body: { data: { title: 'Auth bug', project: 'proj-xyz' } } },
      state: {},
      badRequest: vi.fn(),
    };

    await controller.create(ctx);

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ project: 'proj-xyz' }),
    });
  });

  it('forgeProject takes precedence over body project', async () => {
    const ctx = {
      request: { body: { data: { title: 'Bug', project: 'body-proj' } } },
      state: { forgeProject: { documentId: 'api-key-proj' } },
      badRequest: vi.fn(),
    };

    await controller.create(ctx);

    const createArg = mockCreate.mock.calls[0][0];
    expect(createArg.data.project).toBe('api-key-proj');
  });

  it('preserves custom status and priority from request', async () => {
    const ctx = {
      request: {
        body: { data: { title: 'Critical', status: 'confirmed', priority: 'high' } },
      },
      state: {},
      badRequest: vi.fn(),
    };

    await controller.create(ctx);

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'confirmed', priority: 'high' }),
    });
  });
});

describe('Issue Controller - enrich', () => {
  let controller: any;
  let mockFindOne: ReturnType<typeof vi.fn>;
  let mockEnrichIssue: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    mockFindOne = vi.fn();
    mockEnrichIssue = vi.fn().mockResolvedValue(undefined);

    (globalThis as any).strapi = {
      documents: vi.fn().mockReturnValue({
        findOne: mockFindOne,
        create: vi.fn(),
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    vi.doMock('@strapi/strapi', () => ({
      factories: {
        createCoreController: (_uid: string, fn: any) => fn({ strapi: (globalThis as any).strapi }),
      },
    }));

    vi.doMock('../../../../strapi/src/services/ai-enrichment', () => ({
      enrichIssue: mockEnrichIssue,
    }));

    const mod = await import('../../../../strapi/src/api/issue/controllers/issue');
    controller = mod.default;
  });

  it('returns processing status for valid issue with project', async () => {
    mockFindOne.mockResolvedValue({
      documentId: 'issue-1',
      title: 'Bug',
      project: { documentId: 'proj-1' },
    });

    const ctx = {
      params: { id: 'issue-1' },
      notFound: vi.fn(),
      badRequest: vi.fn(),
    };

    const result = await controller.enrich(ctx);

    expect(result).toEqual({ data: { documentId: 'issue-1', status: 'processing' } });
  });

  it('triggers enrichIssue via setImmediate', async () => {
    mockFindOne.mockResolvedValue({
      documentId: 'issue-2',
      project: { documentId: 'proj-1' },
    });

    const ctx = {
      params: { id: 'issue-2' },
      notFound: vi.fn(),
      badRequest: vi.fn(),
    };

    await controller.enrich(ctx);
    await new Promise((r) => setTimeout(r, 50));

    expect(mockEnrichIssue).toHaveBeenCalledWith(expect.anything(), 'issue-2');
  });

  it('returns notFound when issue does not exist', async () => {
    mockFindOne.mockResolvedValue(null);

    const ctx = {
      params: { id: 'missing' },
      notFound: vi.fn().mockReturnValue('not found'),
      badRequest: vi.fn(),
    };

    const result = await controller.enrich(ctx);

    expect(ctx.notFound).toHaveBeenCalledWith('Issue not found');
  });

  it('returns badRequest when issue has no project', async () => {
    mockFindOne.mockResolvedValue({
      documentId: 'issue-3',
      project: null,
    });

    const ctx = {
      params: { id: 'issue-3' },
      notFound: vi.fn(),
      badRequest: vi.fn().mockReturnValue('bad'),
    };

    const result = await controller.enrich(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith('Issue has no project');
  });
});
