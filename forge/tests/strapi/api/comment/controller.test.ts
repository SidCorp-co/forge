import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Comment Controller - create', () => {
  let controller: any;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    mockCreate = vi.fn().mockResolvedValue({
      documentId: 'comment-1',
      body: 'Test comment',
    });

    (globalThis as any).strapi = {
      documents: vi.fn().mockReturnValue({ create: mockCreate }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    vi.doMock('@strapi/strapi', () => ({
      factories: {
        createCoreController: (_uid: string, fn: any) => fn({ strapi: (globalThis as any).strapi }),
      },
    }));

    const mod = await import('../../../../strapi/src/api/comment/controllers/comment');
    controller = mod.default;
  });

  it('creates comment with body and issue relation', async () => {
    const ctx = {
      request: {
        body: { data: { body: 'This is broken', author: 'user1', issue: 'issue-abc' } },
      },
      state: {},
      badRequest: vi.fn(),
    };

    const result = await controller.create(ctx);

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        body: 'This is broken',
        author: 'user1',
        isAI: undefined,
        issue: 'issue-abc',
      },
    });
    expect(result).toEqual({ data: expect.objectContaining({ documentId: 'comment-1' }) });
  });

  it('returns badRequest when body is missing', async () => {
    const ctx = {
      request: { body: { data: { author: 'user1' } } },
      state: {},
      badRequest: vi.fn().mockReturnValue('bad'),
    };

    await controller.create(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith('body is required');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('creates comment without issue relation', async () => {
    const ctx = {
      request: { body: { data: { body: 'Orphan comment' } } },
      state: {},
      badRequest: vi.fn(),
    };

    await controller.create(ctx);

    const createArg = mockCreate.mock.calls[0][0];
    expect(createArg.data.issue).toBeUndefined();
  });

  it('passes isAI flag through', async () => {
    const ctx = {
      request: { body: { data: { body: 'AI says hi', isAI: true, author: 'AI' } } },
      state: {},
      badRequest: vi.fn(),
    };

    await controller.create(ctx);

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ isAI: true }),
    });
  });
});
